"""Execute the real smoke shell with a disposable Docker protocol simulator.

This checks copy/ack/shutdown ordering and owned cleanup, never native services.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
DOCKER = r'''
import json, os, sys
from pathlib import Path
a = sys.argv[1:]
p = Path(os.environ['SIM_STATE'])
s = json.loads(p.read_text())
s['calls'].append(a)
def end(output='', code=0):
    p.write_text(json.dumps(s))
    print(output)
    sys.exit(code)
if a[:2] == ['image', 'inspect']:
    end('sha256:' + 'b' * 64 if a[3] == '{{.Id}}' else os.environ['SIM_HEAD'])
if a[:2] == ['container', 'ls']: end('\n'.join(s['containers']))
if a[:2] == ['container', 'inspect']: end('{}', 0 if a[-1] in s['containers'] else 1)
if a[:2] == ['network', 'ls']: end('\n'.join(s['networks']))
if a[:2] == ['network', 'create']:
    s['networks'].append(a[-1]); end('network-id')
if a[:2] == ['network', 'inspect']:
    end('true' if '--format' in a else '{}', 0 if a[-1] in s['networks'] else 1)
if a[:2] == ['network', 'rm']:
    s['networks'].remove(a[-1]); end()
if a[0] == 'run':
    name = a[a.index('--name') + 1]
    s['containers'][name] = {'running': '--detach' in a, 'exit': 0}
    end('container-id')
if a[0] == 'exec':
    name = next(n for n in s['containers'] if n in a)
    if 'touch' in a:
        assert s['copied'] and s['containers'][name]['running']
        s['containers'][name].update(running=False, exit=7 if os.environ['SIM_FAULT'] == 'shutdown' else 0)
    end()
if a[0] == 'wait':
    s['containers'][a[1]]['running'] = False; end('0')
if a[0] == 'logs': end()
if a[0] == 'inspect':
    item = s['containers'][a[-1]]
    end(str(item['running']).lower() if 'Running' in a[2] else str(item['exit']))
if a[0] == 'cp':
    item = s['containers'][a[1].split(':')[0]]
    assert item['running'], 'tmpfs already gone'
    if os.environ['SIM_FAULT'] == 'copy': end('', 7)
    Path(a[2]).write_text('{"fixture_metadata": true}\n')
    s['copied'] = True; end()
if a[:2] == ['rm', '--force']:
    del s['containers'][a[-1]]; end()
end('unsupported simulated Docker command', 90)
'''


class LifecycleTests(unittest.TestCase):
    def exercise(self, fault=''):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bindir = root / 'bin'
            bindir.mkdir()
            docker = bindir / 'docker'
            docker.write_text('#!' + sys.executable + '\n' + DOCKER)
            docker.chmod(0o700)
            uname = bindir / 'uname'
            uname.write_text('#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n')
            uname.chmod(0o700)
            state = root / 'state.json'
            state.write_text(json.dumps(dict(containers={}, networks=[], calls=[], copied=False)))
            head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
            output = root / 'preimage.json'
            env = {**os.environ, 'PATH': str(bindir) + os.pathsep + os.environ['PATH'],
                   'SIM_STATE': str(state), 'SIM_HEAD': head, 'SIM_FAULT': fault,
                   'FIXTURE_SMOKE_CONTAINER': 'ca-fixture-smoke-' + 'a' * 32,
                   'FIXTURE_SERVICE_PREIMAGE_PATH': str(output)}
            result = subprocess.run(['bash', 'operations/release/fixture/smoke-image.sh',
                                     'sha256:' + 'b' * 64], cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=15)
            observed = json.loads(state.read_text())
            self.assertEqual(observed['containers'], {}, result.stderr)
            self.assertEqual(observed['networks'], [], result.stderr)
            return result, observed

    def test_copy_completes_while_tmpfs_is_live_before_ack_and_shutdown(self):
        result, state = self.exercise()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = state['calls']
        copy_index = next(i for i, c in enumerate(calls) if c[0] == 'cp')
        ack_index = next(i for i, c in enumerate(calls) if 'touch' in c)
        cleanup_index = next(i for i, c in enumerate(calls) if c[:2] == ['rm', '--force'])
        self.assertLess(copy_index, ack_index)
        self.assertLess(ack_index, cleanup_index)
        self.assertIn('cleanup passed (not a product certificate)', result.stdout)

    def test_copy_failure_never_acknowledges_or_claims_success(self):
        result, state = self.exercise('copy')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('touch' in c for c in state['calls']))
        self.assertNotIn('cleanup passed', result.stdout)

    def test_failed_service_shutdown_cannot_be_reported_as_capture_success(self):
        result, state = self.exercise('shutdown')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(state['copied'])
        self.assertNotIn('cleanup passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
