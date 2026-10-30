"""Isolated real-filesystem/pipe qualification of the maintained host authority."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('retirement_host', REPO / 'server/scripts/main-inspector-retirement.py')
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)
RUN = '41022533688-1'
INVOCATION = 'e23da38ae7f14f1a846f1212c30415c9'
CONTROL_SHA = 'a' * 40
TARGET_SHA = 'b' * 40
CONTAINER = 'c' * 64
IDENTITY = f'{CONTAINER} {HOST.IMAGE} true 2026-10-28T00:00:00Z 2345'


class HostTests(unittest.TestCase):
    def setUp(self):
        base = REPO / 'work' if sys.platform == 'darwin' else Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='main-inspector-host-', dir=base)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.control = self.root / 'control'
        self.control.mkdir()
        (self.control / 'control-sha').write_text(CONTROL_SHA)
        for name in ('retire-owned-main-inspector.mjs', 'main-inspector-socket-qualification.mjs', 'main-inspector-retirement-entry.mjs'):
            (self.control / name).write_text('// immutable isolated fixture\n')
        self.lock = self.root / 'engine.lock'
        self.lock.touch()
        self.request = self.root / (RUN + '.request')
        self.expiry = int(time.time()) + 60
        self.request.write_text('\n'.join([TARGET_SHA, 'fixture-image', 'fixture-source', str(self.control), CONTROL_SHA, str(self.expiry)]) + '\n')
        self.intent = self.root / (RUN + '.main-inspector-retirement-intent')
        self.receipt = self.root / (RUN + '.main-inspector-retirement-receipt')
        self.proposal = {'schema': 'main-inspector-retirement/v1',
                         'endpoint': 'ws://127.0.0.1:9229/11111111-1111-1111-1111-111111111111',
                         'binding': {'schema': 'main-inspector-socket-binding/v1', 'pid': 1}}
        self.proposal_bytes = json.dumps(self.proposal, separators=(',', ':')).encode()
        self.outcome = {'ok': True, 'closeRequested': True, 'closeAcknowledged': True,
                        'connectionClosed': True, 'listenerAbsent': True, 'retryAllowed': False}
        self.mode = 'success'
        self.events = []
        self.inspections = 0
        self.unit_reads = 0
        self.health_reads = 0
        self.acks = []
        self.child = None
        self.real_time = time.time
        self.expired = False

    def command(self, args, **kwargs):
        self.assertGreater(kwargs['timeout'], 0)
        if args[0] == 'systemctl':
            self.unit_reads += 1
            invocation = 'd' * 32 if self.mode == 'unit_drift' and self.unit_reads > 1 else INVOCATION
            if self.mode == 'foreign_unit':
                invocation = 'd' * 32
            return SimpleNamespace(stdout=(f'InvocationID={invocation}\nActiveState=activating\nSubState=start\n').encode())
        if args[0].endswith('engine-release-seal.py'):
            value = HOST.SOURCE if args[-1] == 'desired-sha' else HOST.IMAGE
            if self.mode == 'wrong_seal':
                value = 'wrong'
            return SimpleNamespace(stdout=(value + '\n').encode())
        self.assertEqual(args[:2], ['docker', 'inspect'])
        self.inspections += 1
        drift = ((self.mode == 'container_drift' and self.inspections == 2) or
                 (self.mode == 'post_container_drift' and self.inspections == 4))
        return SimpleNamespace(stdout=((IDENTITY.replace('2345', '2346') if drift else IDENTITY) + '\n').encode())

    def popen(self, args, **kwargs):
        self.events.append('spawn')
        self.assertEqual(args[:4], ['docker', 'exec', '-i', CONTAINER])
        self.assertIn('--no-inspect', args[6])
        self.native_deadline = int(args[-1])
        read_fd, write_fd = os.pipe()
        stdout = os.fdopen(read_fd, 'rb', buffering=0)
        state = {'exit': None, 'write_fd': write_fd}
        os.write(write_fd, self.proposal_bytes + b'\n')
        if self.mode == 'request_drift':
            self.request.write_text(self.request.read_text().replace(TARGET_SHA, 'e' * 40))
        owner = self

        class Input:
            def write(self, data):
                owner.events.append('ack')
                owner.assertTrue(owner.intent.is_file(), 'claim must exist before attach ACK')
                owner.assertGreaterEqual(owner.events.count('fsync'), 2, 'file and directory fsync precede ACK')
                claim = json.loads(owner.intent.read_text())
                owner.assertEqual(claim['proposal'], owner.proposal)
                owner.assertEqual(claim['runId'], RUN)
                owner.assertEqual(claim['invocationId'], INVOCATION)
                owner.assertEqual(claim['containerIdentity'], IDENTITY)
                owner.assertEqual(claim['target'], TARGET_SHA)
                owner.assertEqual(claim['requestSha256'], hashlib.sha256(owner.request.read_bytes()).hexdigest())
                owner.assertEqual(data, hashlib.sha256(owner.proposal_bytes).hexdigest().encode() + b'\n')
                owner.acks.append(data)
                if owner.mode == 'unknown':
                    os.close(state['write_fd']); state['write_fd'] = None
                else:
                    os.write(state['write_fd'], json.dumps(owner.outcome).encode() + b'\n')
                return len(data)

            def flush(self):
                pass

            def close(self):
                pass

        def kill():
            owner.events.append('own_client_killed')
            state['exit'] = -9
            if state['write_fd'] is not None:
                os.close(state['write_fd']); state['write_fd'] = None

        def wait(timeout):
            owner.assertGreater(timeout, 0)
            state['exit'] = 0
            if state['write_fd'] is not None:
                os.close(state['write_fd']); state['write_fd'] = None
            return 0

        self.child = SimpleNamespace(stdin=Input(), stdout=stdout, poll=lambda: state['exit'], kill=kill, wait=wait)
        return self.child

    def execute(self):
        actual_fstat, actual_lstat, actual_fsync = os.fstat, Path.lstat, os.fsync

        def lstat(path, *args, **kwargs):
            value = actual_lstat(path, *args, **kwargs)
            if path == self.request:
                return SimpleNamespace(st_mode=value.st_mode, st_uid=0)
            return value

        def fsync(fd):
            actual_fsync(fd)
            self.events.append('fsync')
            if self.mode == 'expire_before_ack' and self.events.count('fsync') >= 2:
                self.expired = True

        def read_health(*args, **kwargs):
            self.health_reads += 1
            health = {'status': 'ok', 'liveness': 'ok', 'uptime': 12345 + self.health_reads,
                      'releaseSha': HOST.SOURCE, 'running': True, 'instanceId': '1-7231d1c5',
                      'maintenance': {'active': False, 'phase': 'idle'}}
            if self.mode == 'bad_status': health['status'] = 'degraded'
            if self.mode == 'bad_liveness': health['liveness'] = 'degraded'
            if self.mode == 'negative_uptime': health['uptime'] = -1
            if self.mode == 'invalid_uptime': health['uptime'] = 'unknown'
            if self.mode == 'changed_instance' and self.health_reads > 1:
                health['instanceId'] = '1-1234abcd'
            if self.mode == 'regressed_uptime' and self.health_reads > 1:
                health['uptime'] = 1
            return io.BytesIO(json.dumps(health).encode())
        with contextlib.ExitStack() as stack:
            for target, value in [('CONTROL', self.control)]:
                stack.enter_context(patch.object(HOST, target, value))
            stack.enter_context(patch.object(sys, 'argv', ['host.py', RUN, INVOCATION]))
            stack.enter_context(patch.object(sys, 'platform', 'linux'))
            stack.enter_context(patch.dict(os.environ, {'ENGINE_LOCK_FILE': str(self.lock),
                'ENGINE_RELEASE_REQUEST_ROOT': str(self.root), 'CONTAINER': 'club-arena-engine'}))
            stack.enter_context(patch.object(os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(os, 'fstat', side_effect=lambda fd: self.lock.stat() if fd == 9 else actual_fstat(fd)))
            stack.enter_context(patch.object(Path, 'lstat', lstat))
            stack.enter_context(patch.object(HOST.fcntl, 'flock'))
            stack.enter_context(patch.object(os, 'fsync', side_effect=fsync))
            stack.enter_context(patch.object(time, 'time', side_effect=lambda: self.expiry + 1 if self.expired else self.real_time()))
            stack.enter_context(patch.object(subprocess, 'run', side_effect=self.command))
            stack.enter_context(patch.object(subprocess, 'Popen', side_effect=self.popen))
            stack.enter_context(patch.object(HOST.urllib.request, 'urlopen', side_effect=read_health))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            return HOST.retire()

    def test_success_requires_durable_claim_before_ack_and_persists_exact_receipt(self):
        self.assertEqual(self.execute(), 0)
        self.assertEqual(len(self.acks), 1)
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual(receipt['outcome'], self.outcome)
        self.assertEqual(receipt['claim'], json.loads(self.intent.read_text()))
        self.assertFalse(receipt['claim']['retryAllowed'])
        self.assertNotIn('own_client_killed', self.events)

    def test_unknown_after_ack_retains_intent_and_never_receipts_success(self):
        self.mode = 'unknown'
        self.assertEqual(self.execute(), 1)
        self.assertTrue(self.intent.is_file())
        self.assertFalse(self.receipt.exists())
        self.assertEqual(len(self.acks), 1)

    def test_request_control_unit_container_drift_refuse_without_ack(self):
        for mode in ['request_drift', 'container_drift', 'foreign_unit', 'unit_drift', 'wrong_seal']:
            with self.subTest(mode=mode):
                self.mode = mode
                self.assertEqual(self.execute(), 1)
                self.assertEqual(self.acks, [])
                self.assertFalse(self.receipt.exists())
                if self.intent.exists(): self.intent.unlink()
                self.request.write_text('\n'.join([TARGET_SHA, 'fixture-image', 'fixture-source', str(self.control), CONTROL_SHA, str(self.expiry)]) + '\n')
                self.inspections = 0; self.unit_reads = 0; self.events.clear()

    def test_wrong_control_refuses_before_native_start(self):
        (self.control / 'control-sha').write_text('f' * 40)
        self.assertEqual(self.execute(), 1)
        self.assertNotIn('spawn', self.events)

    def test_existing_and_dangling_intents_refuse_without_native_start(self):
        for suffix in ['legacy-checkpoint-intent', 'main-inspector-retirement-intent']:
            for dangling in [False, True]:
                with self.subTest(suffix=suffix, dangling=dangling):
                    path = self.root / (RUN + '.' + suffix)
                    if dangling: path.symlink_to(self.root / 'missing')
                    else: path.write_text('retained')
                    self.assertEqual(self.execute(), 1)
                    self.assertNotIn('spawn', self.events)
                    path.unlink()

    def test_expiry_after_claim_fsync_never_grants_attach_ack(self):
        self.mode = 'expire_before_ack'
        self.assertEqual(self.execute(), 1)
        self.assertTrue(self.intent.is_file())
        self.assertEqual(self.acks, [])
        self.assertFalse(self.receipt.exists())

    def test_native_deadline_is_capped_to_request_expiry(self):
        self.expiry = int(time.time()) + 5
        self.request.write_text(self.request.read_text().rsplit('\n', 2)[0] + '\n' + str(self.expiry) + '\n')
        self.assertEqual(self.execute(), 0)
        self.assertLessEqual(self.native_deadline, self.expiry * 1000)

    def test_all_native_flags_and_final_same_container_are_mandatory(self):
        for key in ['ok', 'closeAcknowledged', 'connectionClosed', 'listenerAbsent']:
            with self.subTest(key=key):
                self.outcome[key] = False
                self.assertEqual(self.execute(), 1)
                self.assertTrue(self.intent.exists()); self.assertFalse(self.receipt.exists())
                self.intent.unlink(); self.acks.clear(); self.events.clear(); self.inspections = 0
                self.outcome[key] = True
        self.mode = 'post_container_drift'
        self.assertEqual(self.execute(), 1)
        self.assertEqual(len(self.acks), 1, 'final host identity is checked after native action')
        self.assertTrue(self.intent.exists()); self.assertFalse(self.receipt.exists())

    def test_health_requires_ok_liveness_stable_instance_and_monotonic_uptime(self):
        for mode in ['bad_status', 'bad_liveness', 'negative_uptime', 'invalid_uptime',
                     'changed_instance', 'regressed_uptime']:
            with self.subTest(mode=mode):
                self.mode = mode
                try:
                    self.assertEqual(self.execute(), 1)
                    self.assertFalse(self.receipt.exists())
                    if mode in ['changed_instance', 'regressed_uptime']:
                        self.assertEqual(len(self.acks), 1)
                        self.assertTrue(self.intent.is_file())
                    else:
                        self.assertEqual(self.acks, [])
                        self.assertNotIn('spawn', self.events)
                finally:
                    if self.intent.exists(): self.intent.unlink()
                    if self.receipt.exists(): self.receipt.unlink()
                    self.acks.clear(); self.events.clear(); self.inspections = 0
                    self.unit_reads = 0; self.health_reads = 0

    def test_close_qualification_reserves_full_five_seconds_after_kernel_capture(self):
        entry = (REPO / 'server/scripts/main-inspector-retirement-entry.mjs').read_text()
        callback = entry.split('qualify: async (stage)', 1)[1].split('return true;', 1)[0]
        capture = callback.index('captureMainInspectorBinding(')
        reserve = callback.index("if (stage === 'close' && retirementRemaining() <= 5000) return false;")
        self.assertGreater(reserve, capture)


if __name__ == '__main__':
    unittest.main()
