#!/usr/bin/env python3
"""Finite qualification of the original transaction-only terminal boundary."""
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('withdrawal', ROOT / 'scripts/ci/withdraw-waiting-engine-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Withdrawal(unittest.TestCase):
    def setUp(self):
        self.request = {'runKey': '39902613436-2', 'releaseSha': 'a' * 40,
                        'controlSha': 'b' * 40, 'desiredSha': 'c' * 40,
                        'instanceId': '1-8c0c99a7'}
        self.health = {'releaseSha': 'c' * 40, 'instanceId': '1-8c0c99a7',
                       'running': True, 'liveness': 'ok',
                       'maintenance': {'active': False, 'phase': 'idle'}}

    def test_exact_attempt_is_required(self):
        self.assertEqual(module.selection(self.request), self.request)
        for key, bad in [('runKey', '39902613436'), ('runKey', '../39902613436-2'),
                         ('runKey', '39902613436-0'), ('releaseSha', 'a' * 8),
                         ('releaseSha', 'A' * 40), ('controlSha', None),
                         ('desiredSha', 'a' * 40), ('instanceId', '1-*')]:
            with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):
                module.selection({**self.request, key: bad})
        for key in self.request:
            bad = dict(self.request)
            del bad[key]
            with self.subTest(missing=key), self.assertRaises(ValueError):
                module.selection(bad)
        with self.assertRaises(ValueError):
            module.selection({**self.request, 'command': 'restart'})

    def test_new_generation_or_break_refuses(self):
        module.healthy(self.health, self.request)
        for change in [{'releaseSha': 'a' * 40}, {'instanceId': '1-deadbeef'},
                       {'running': False}, {'running': 1}, {'liveness': 'dead'},
                       {'maintenance': {'active': True, 'phase': 'last_hand'}},
                       {'maintenance': {'active': False, 'phase': 'counting_down'}},
                       {'maintenance': {}}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                module.healthy({**self.health, **change}, self.request)

    def test_exact_child_command_only(self):
        expected = ['/managed/control/engine-release-transaction.sh', '--run-id', '39902613436-2']
        self.assertTrue(module.bash_command(['bash', *expected], expected))
        for args in [['bash', *expected, '--force'], ['sh', *expected],
                     ['bash', expected[0], '--run-id', '39902613436-1'],
                     ['bash', '/managed/engine-release-unit-wrapper-v1.sh', 'start', '39902613436-2']]:
            self.assertFalse(module.bash_command(args, expected))

    def test_container_read_never_selects_runtime_environment(self):
        value = {'id': 'a' * 64, 'image': 'sha256:' + 'c' * 64,
                 'running': True, 'startedAt': 'original', 'releaseSha': self.request['desiredSha']}
        with patch.object(module, 'command', return_value=json.dumps(value)) as command:
            self.assertEqual(module.container_identity(self.request)['id'], 'a' * 64)
            args = command.call_args.args[0]
            self.assertEqual(args[:4], ['docker', 'container', 'inspect', '--format'])
            self.assertNotIn('Env', args[4])
            self.assertNotIn('{{json .Config}}', args[4])
            self.assertEqual(args[-1], 'club-arena-engine')

    def test_lost_ack_reads_terminal_without_a_second_signal(self):
        with patch.object(os.path, 'lexists', return_value=True), \
             patch.object(os, 'getuid', return_value=0), \
             patch.object(module, 'terminal', return_value={'result': 'terminal'}) as terminal, \
             patch.object(os, 'pidfd_open', create=True) as opened, \
             patch.object(signal, 'pidfd_send_signal', create=True) as sent:
            self.assertEqual(module.remote(self.request), {'result': 'terminal'})
            terminal.assert_called_once_with(self.request)
            opened.assert_not_called()
            sent.assert_not_called()

    def test_current_sources_keep_original_recovery_authority(self):
        transaction = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        wrapper = (ROOT / 'server/scripts/engine-release-unit-wrapper.sh').read_text()
        self.assertIn("trap 'exit 130' INT", transaction)
        self.assertIn('[ "$TRANSACTION_RC" -eq 75 ] && exit 75', wrapper)
        start = wrapper.index('# A permanent proof/application failure first restores')
        tail = wrapper[start:]
        self.assertLess(tail.index('--mode retryable'), tail.index('record-failure'))
        self.assertLess(tail.index('record-failure'), tail.index('attest-failure'))
        self.assertLess(tail.index('attest-failure'), tail.index('--mode terminal'))

    def test_receiver_separates_withdrawal_from_image_authority(self):
        workflow = (ROOT / '.github/workflows/auto-deploy-hetzner.yml').read_text()
        job = workflow.split('  withdraw-waiting-release:', 1)[1].split('\n  preflight:', 1)[0]
        self.assertIn("if: github.event.action == 'withdraw-club-arena-engine'", job)
        self.assertIn('waiting-engine-release-withdrawal.test.py', job)
        self.assertIn('withdraw-waiting-engine-release.py', job)
        self.assertIn('group: club-arena-engine-withdrawal-${{ github.event.client_payload.withdrawal.runKey }}', job)
        self.assertIn('cancel-in-progress: false', job)
        for prohibited in ['docker ', 'engine-up', 'stage-engine', 'DATABASE_URL', 'deploy-club-arena-engine']:
            self.assertNotIn(prohibited, job)
        preflight = workflow.split('\n  preflight:', 1)[1].split('\n  engine-doors:', 1)[0]
        self.assertIn("if: github.event.action == 'deploy-club-arena-engine'", preflight)

    def test_remote_has_no_record_rewrite_or_unit_signal(self):
        source = (ROOT / 'scripts/ci/withdraw-waiting-engine-release.py').read_text()
        remote = source.split('def remote(request):', 1)[1].split('\ndef main():', 1)[0]
        self.assertIn('signal.pidfd_send_signal(pid_fd, signal.SIGINT)', remote)
        for forbidden in ['os.kill(', 'SIGTERM', 'SIGKILL', 'systemctl stop', 'systemctl kill',
                          '.write_text(', '.unlink(', 'record-failure', 'prepare', 'commit']:
            self.assertNotIn(forbidden, remote)

    def test_connected_admission_signal_and_original_receipt_readback(self):
        for refusal in (None, 'pending', 'foreign-marker', 'foreign-parent', 'active-break',
                        'unit-race', 'database-refusal', 'changed-container'):
            with self.subTest(refusal=refusal), tempfile.TemporaryDirectory(
                    prefix='withdrawal-owner-', dir=os.environ.get('TMPDIR')) as directory, ExitStack() as patches:
                root = Path(directory) / 'state'
                parent = Path(directory) / 'control'
                proc = Path(directory) / 'proc'
                generation = parent / 'engine-control-generations' / self.request['controlSha']
                generation.mkdir(parents=True)
                (generation / 'control-sha').write_text(self.request['controlSha'] + '\n')
                request_root = root / 'engine-release-requests'
                pin_root = root / 'engine-release-generation-pins'
                result_root = root / 'engine-release-results'
                for d in (request_root, pin_root, result_root):
                    d.mkdir(parents=True)
                key = self.request['runKey']
                request_file = request_root / (key + '.request')
                request_file.write_text('\n'.join([self.request['releaseSha'], 'url', 'actor', str(generation), self.request['controlSha'], '1999999999']) + '\n')
                request_file.chmod(0o600)
                pin_file = pin_root / (key + '.generation')
                pin_file.write_text(str(generation) + '\n' + self.request['controlSha'] + '\n')
                pin_file.chmod(0o600)
                marker = request_root / (key + '.awaiting-certificate')
                marker.write_text(('d' * 40 if refusal == 'foreign-marker' else self.request['releaseSha']) + '\n')
                task = proc / '12/task/12'
                task.mkdir(parents=True)
                (task / 'children').write_text('13')
                engine_lock = Path(directory) / 'lock'
                engine_lock.touch()
                invocation = 'f' * 32
                state = {'MainPID': '12', 'InvocationID': invocation, 'ActiveState': 'active', 'Result': 'success', 'ExecMainStatus': '0'}
                withdrawn = []
                property_calls = []

                def properties(_unit):
                    property_calls.append(_unit)
                    if withdrawn:
                        return {**state, 'MainPID': '0', 'ActiveState': 'inactive'}
                    return {**state, 'MainPID': '14' if refusal == 'unit-race' and len(property_calls) > 1 else '12'}

                def process(pid):
                    return {'pid': pid, 'parent': 9 if refusal == 'foreign-parent' else (1 if pid == 12 else 12), 'start': '100',
                            'argv': ['bash', str(parent / 'engine-release-unit-wrapper-v1.sh'), 'start', key] if pid == 12 else
                                    ['bash', str(generation / 'engine-release-transaction.sh'), '--run-id', key]}

                def command(args, timeout=5):
                    if 'pending-owner' in args:
                        return 'active other false 1999999999' if refusal == 'pending' else 'none'
                    if 'desired-sha' in args:
                        return self.request['desiredSha']
                    if args[0].endswith('engine-release-database-proof.py'):
                        if refusal == 'database-refusal':
                            raise ValueError('Database leader differs')
                        return 'proved'
                    if 'attest-failure' in args:
                        self.assertTrue(withdrawn)
                        return 'failed'
                    if args[0] == 'systemctl' and args[-1] == '--value':
                        return 'inactive'
                    raise AssertionError('Unexpected command ' + str(args))

                container_reads = []

                def identity(_request):
                    container_reads.append(True)
                    return {'id': 'b' * 64 if refusal == 'changed-container' and len(container_reads) > 1 else 'a' * 64,
                            'startedAt': 'original', 'image': 'sha256:' + 'c' * 64}

                def health(_request):
                    if refusal == 'active-break':
                        raise ValueError('Maintenance active')

                def original_wrapper(fd, sent_signal):
                    self.assertEqual(sent_signal, signal.SIGINT)
                    self.assertFalse(withdrawn)
                    withdrawn.append(True)
                    result = {'result': 'failed', 'transactionExitStatus': 130, 'runId': key,
                              'sha': self.request['releaseSha'], 'controlSha': self.request['controlSha'],
                              'recoveredDesiredSha': self.request['desiredSha'], 'invocationId': invocation}
                    (result_root / (key + '.json')).write_text(json.dumps(result))
                    for path in (request_file, pin_file, marker):
                        path.unlink()

                original_fstat = os.fstat

                def root_owned(fd):
                    data = list(original_fstat(fd))
                    data[4] = 0
                    return os.stat_result(data)

                for name, value in [('ROOT', root), ('PARENT', parent), ('PROC', proc), ('ENGINE_LOCK', engine_lock),
                                    ('properties', properties), ('process', process), ('command', command),
                                    ('health_pair', health), ('container_identity', identity)]:
                    patches.enter_context(patch.object(module, name, value))
                patches.enter_context(patch.object(os, 'getuid', return_value=0))
                patches.enter_context(patch.object(os, 'fstat', side_effect=root_owned))
                patches.enter_context(patch.object(os, 'pidfd_open', create=True, side_effect=lambda pid: os.open(os.devnull, os.O_RDONLY)))
                sent = patches.enter_context(patch.object(signal, 'pidfd_send_signal', create=True, side_effect=original_wrapper))
                if refusal:
                    with self.assertRaises(ValueError):
                        module.remote(self.request)
                    sent.assert_not_called()
                else:
                    answer = module.remote(self.request)
                    self.assertEqual(answer['result'], 'withdrawn-before-mutation')
                    self.assertTrue(answer['originalTerminalEdgesRetired'])
                    self.assertTrue(answer['servingInstanceUnchanged'])
                    sent.assert_called_once()
                    self.assertEqual(module.remote(self.request), answer)
                    sent.assert_called_once()

    def test_native_transaction_int_exits_through_the_terminal_boundary(self):
        # The maintained production INT trap is exercised in a real child;
        # Linux additionally exercises the exact pidfd signal primitive.
        transaction = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        trap = next(line for line in transaction.splitlines() if line == "trap 'exit 130' INT")
        with tempfile.TemporaryDirectory(prefix='withdrawal-signal-', dir=os.environ.get('TMPDIR')) as directory:
            path = Path(directory) / 'transaction.sh'
            path.write_text(trap + "\nprintf 'ready\\n'\nwhile :; do sleep 0.05; done\n")
            process = subprocess.Popen(['bash', str(path)], stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(process.stdout.readline(), 'ready\n')
                if hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'):
                    fd = os.pidfd_open(process.pid)
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGINT)
                    finally:
                        os.close(fd)
                else:
                    os.kill(process.pid, signal.SIGINT)
                self.assertEqual(process.wait(timeout=3), 130)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
                process.stdout.close()


if __name__ == '__main__':
    unittest.main()
