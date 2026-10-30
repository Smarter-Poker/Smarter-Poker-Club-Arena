"""Real Node/TCP/deadline cases for the maintained readiness shell helper.

Only docker-exec transport is substituted; no Docker or production access.
"""
import os
import json
from pathlib import Path
import shutil
import shlex
import socket
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
HELPER = SOURCE[SOURCE.index('legacy_inspector_is_closed() {'):SOURCE.index('\nrequest_recovery_window() {')]
CHECKPOINT = (ROOT / 'server/scripts/legacy-engine-checkpoint.sh').read_text()
RUNTIME_START = CHECKPOINT[CHECKPOINT.index('checkpoint_entry_read timeout 3s docker exec "$CONTAINER_ID"'):CHECKPOINT.index("' checkpoint-runtime -e '") + len("' checkpoint-runtime")]
TRANSPORT_START = next(line.split('| ', 1)[1] for line in CHECKPOINT.splitlines(keepends=True)
                       if '| checkpoint_final_read docker exec -i' in line)


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='legacy-probe-', dir=ROOT.parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        docker = self.root / 'docker'
        docker.write_text('#!/bin/sh\n[ "$1" = exec ] || exit 95\nshift\nif [ "$1" = -i ]; then shift; fi\n[ "$1" = fixture ] || exit 95\nshift\nexec "$@"\n')
        docker.chmod(0o700)
        # Never touch an existing local listener. Fail before invoking Node if
        # this fixed production port is unavailable to the isolated fixture.
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(('127.0.0.1', 9229))
        self.addCleanup(self.listener.close)

    def probe(self, options='', listening=False):
        if listening:
            self.listener.listen()
            self.listener.settimeout(2)
        else:
            self.listener.close()
        env = dict(os.environ, NODE_OPTIONS=options, NODE_PATH=str(self.root),
                   PATH=str(self.root) + os.pathsep + os.environ['PATH'])
        result = subprocess.run(['bash', '-c', HELPER + '\nCONTAINER=fixture\nlegacy_inspector_is_closed\n'],
                                env=env, text=True, capture_output=True, timeout=5)
        if listening:
            connection, _ = self.listener.accept()
            with connection:
                connection.settimeout(2)
                self.assertEqual(connection.recv(1), b'')
            self.assertGreaterEqual(self.listener.fileno(), 0)
        return result

    def test_closed_port_is_positive_absence(self):
        result = self.probe()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))

    def test_inherited_inspect_cannot_open_the_observers_own_listener(self):
        result = self.probe('--inspect=127.0.0.1:9229')
        # Preserve the checkpoint's existing incompatible-option refusal, now
        # before announcement and without ever starting the observer Node.
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', ''))

    def test_inherited_preload_never_executes(self):
        marker = self.root / 'preload-ran'
        preload = self.root / 'preload.cjs'
        preload.write_text('require("node:fs").writeFileSync(' + repr(str(marker)) + ', "ran");')
        result = self.probe('--require=' + str(preload))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
        self.assertFalse(marker.exists())

    def test_genuine_listener_stays_open_and_receives_no_payload(self):
        result = self.probe(listening=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', ''))

    def test_child_transport_failure_cannot_prove_absence(self):
        (self.root / 'docker').write_text('#!/bin/sh\nexit 2\n')
        result = self.probe()
        self.assertEqual(result.returncode, 2)

    def start_checkpoint_child(self, options, transport=False):
        self.listener.close()
        marker = self.root / 'preload-ran'
        preload = self.root / 'preload.cjs'
        preload.write_text('require("node:fs").writeFileSync(' + repr(str(marker)) + ', "ran");')
        env = dict(os.environ, NODE_OPTIONS=options.replace('PRELOAD', str(preload)),
                   NODE_PATH=str(self.root), INTERNAL_API_KEY='isolated-fixture-only',
                   PATH=str(self.root) + os.pathsep + os.environ['PATH'])
        # Actual child launch commands, synthetic Node payload instead of any
        # production runtime/inspector/custody operation. Proves startup only.
        payload = ('if(process.env.NODE_OPTIONS!==undefined||process.env.NODE_PATH!==undefined'
                   '||process.env.INTERNAL_API_KEY!=="isolated-fixture-only")process.exit(91);'
                   'process.stdout.write(JSON.stringify(process.argv.slice(2)));')
        setup = ('checkpoint_entry_read() { "$@"; }; checkpoint_final_read() { "$@"; }; '
                 'CONTAINER_ID=fixture; INSTANCE=fixture-instance; LEGACY_SHA=fixture-sha; '
                 'CHECKPOINT_INTENT=fixture-intent; CHECKPOINT_DEADLINE_MS=40000;\n')
        command = TRANSPORT_START if transport else RUNTIME_START + ' -e ' + shlex.quote(payload)
        result = subprocess.run(['bash', '-c', setup + command], env=env, input=payload,
                                text=True, capture_output=True, timeout=5)
        self.assertFalse(marker.exists())
        return result

    def test_runtime_start_preserves_inspect_and_debug_refusal_before_node(self):
        for flag in ['--inspect=127.0.0.1:9229', '--inspect-brk', '--debug']:
            with self.subTest(flag=flag):
                result = self.start_checkpoint_child('--require=PRELOAD ' + flag)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', ''))

    def test_runtime_start_ignores_application_preload_and_preserves_auth(self):
        result = self.start_checkpoint_child('--require=PRELOAD')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '[]', ''))

    def test_runtime_start_accepts_previously_allowed_options(self):
        result = self.start_checkpoint_child('--dns-result-order=ipv4first')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '[]', ''))

    def test_stdin_transport_cannot_open_its_own_inspector_or_run_preloads(self):
        result = self.start_checkpoint_child('--inspect=127.0.0.1:9229 --require=PRELOAD', transport=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertEqual(json.loads(result.stdout), ['fixture-instance', 'fixture-sha', 'fixture-intent', '40000'])


if __name__ == '__main__':
    assert shutil.which('node') and shutil.which('timeout'), 'Node and GNU timeout required'
    unittest.main()
