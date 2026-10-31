"""Isolated real-filesystem/pipe qualification of the maintained host authority."""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import signal
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
        self.real_popen = subprocess.Popen
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
        if self.mode == 'actual_deadline_pipe':
            # Actual host selector/ACK/wait/alarm against an independently timed
            # child. No mocked clock or extra outer grace can deliver its line.
            source = """import json,sys,time
print(sys.argv[2],flush=True)
sys.stdin.readline()
time.sleep(max(0,int(sys.argv[1])/1000-time.time()))
print(json.dumps({'ok':False,'reason':'deadline_exhausted','stage':'native_close',
 'closeRequested':True,'closeAcknowledged':True,'connectionClosed':False,'retryAllowed':False}),flush=True)
sys.exit(1)
"""
            self.child = self.real_popen([sys.executable, '-B', '-c', source,
                str(self.native_deadline), self.proposal_bytes.decode()], **kwargs)
            return self.child
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
        actual_fstat, actual_lstat, actual_fsync, actual_write = os.fstat, Path.lstat, os.fsync, os.write

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
        def write(fd, value):
            if fd == 2:
                self.stderr.write(value.decode('ascii'))
                return len(value)
            return actual_write(fd, value)
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
            self.stdout, self.stderr = io.StringIO(), io.StringIO()
            stack.enter_context(contextlib.redirect_stdout(self.stdout))
            stack.enter_context(contextlib.redirect_stderr(self.stderr))
            stack.enter_context(patch.object(os, 'write', side_effect=write))
            return HOST.retire()

    def diagnostic(self):
        return json.loads(self.stderr.getvalue().splitlines()[0])

    def test_actual_host_receives_negative_child_before_unchanged_absolute_deadline(self):
        self.mode = 'actual_deadline_pipe'
        before = time.monotonic()
        self.assertEqual(self.execute(), 1)
        elapsed = time.monotonic() - before
        self.assertLess(elapsed, 19.7, 'host must have positive headroom inside20s')
        fact = self.diagnostic()
        self.assertEqual(fact['native'], {
            'ok': False, 'reason': 'deadline_exhausted', 'stage': 'native_close',
            'closeRequested': True, 'closeAcknowledged': True, 'connectionClosed': False,
            'listenerAbsent': None, 'entryStage': None, 'retryAllowed': False})
        self.assertEqual(fact['hostStage'], 'native_exit')
        self.assertEqual(fact['childExit'], 'nonzero')
        self.assertEqual(fact['intent'], 'durable')
        self.assertEqual(fact['ack'], 'flushed')
        self.assertTrue(self.intent.exists())
        self.assertFalse(self.receipt.exists())
        self.assertEqual(HOST.entry_state.__name__, 'entry_state')

    def test_actual_native_receipt_publisher_waits_for_pipe_or_exits_failure_inside_deadline(self):
        entry = (REPO / 'server/scripts/main-inspector-retirement-entry.mjs').read_text()
        publisher = entry.split('const retirementWorkDeadline =', 1)[1].split('\nsetTimeout(\n', 1)[0]
        source = "const retirementDeadline=Date.now()+500;const retirementWorkDeadline =" + publisher
        source += "\nprocess.once('exit',()=>process.stderr.write(JSON.stringify({remaining:retirementDeadline-Date.now()})));"
        source += "\nretirementPublish({ok:false,retryAllowed:false,payload:'x'.repeat(1048576)},75);"
        child = self.real_popen(['node', '--input-type=module', '-e', source],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output, error = child.communicate(timeout=2)
        self.assertEqual(child.returncode, 75, 'full publication preserves requested exit')
        self.assertEqual(len(json.loads(output)['payload']), 1048576)
        self.assertGreater(json.loads(error)['remaining'], 50)
        child = self.real_popen(['node', '--input-type=module', '-e', source],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(child.wait(timeout=2), 1, 'blocked pipe must fail normally')
        child.stdout.close()
        error = child.stderr.read(); child.stderr.close()
        self.assertGreater(json.loads(error)['remaining'], 50)
        read_fd, write_fd = os.pipe(); os.close(read_fd)
        try:
            child = self.real_popen(['node', '--input-type=module', '-e', source],
                                   stdout=write_fd, stderr=subprocess.PIPE)
        finally:
            os.close(write_fd)
        _, error = child.communicate(timeout=2)
        self.assertEqual(child.returncode, 1)
        self.assertGreater(json.loads(error)['remaining'], 50, error)

    def test_actual_composed_entry_preserves_preclaim_runtime_refusal_without_socket_calls(self):
        observer = """import * as fixtureHttp from 'node:http';
import {syncBuiltinESMExports as fixtureSync} from 'node:module';
import {writeSync as fixtureWrite} from 'node:fs';
let fixtureHttpCalls=0,fixtureWebSocketCalls=0;
const fixtureHttpNative=process.getBuiltinModule('node:http');
fixtureHttpNative.get=()=>{fixtureHttpCalls++;throw new Error('fixture_socket_forbidden')};
fixtureSync();
globalThis.WebSocket=class {constructor(){fixtureWebSocketCalls++;throw new Error('fixture_socket_forbidden')}};
process.once('exit',()=>fixtureWrite(2,JSON.stringify({http:fixtureHttpCalls,websocket:fixtureWebSocketCalls,version:process.version})));
"""
        source = observer + '\n'.join((REPO/'server/scripts'/name).read_text() for name in (
            'retire-owned-main-inspector.mjs','main-inspector-socket-qualification.mjs',
            'main-inspector-retirement-entry.mjs'))
        env = dict(os.environ)
        env['GIT_COMMIT_SHA'] = 'isolated-wrong-source'
        env.pop('NODE_OPTIONS', None); env.pop('NODE_PATH', None)
        child = self.real_popen(['node','--input-type=module','-e',source,
                                str(int(time.time()*1000)+5000)],
                               stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
        out,error = child.communicate(timeout=3)
        self.assertEqual(child.returncode, 1)
        observed = json.loads(error)
        self.assertEqual((observed['http'],observed['websocket']), (0,0))
        expected = 'runtime_source_unproved' if observed['version']=='v22.23.2' else 'runtime_version_unproved'
        outcome = json.loads(out)
        self.assertEqual(outcome['reason'], expected)
        self.assertEqual(outcome['entryStage'], 'runtime')
        self.assertFalse(outcome['ok']); self.assertFalse(outcome['retryAllowed'])
        self.assertNotIn('isolated-wrong-source', out.decode())
        projected = HOST.bounded_native_facts(outcome)
        self.assertEqual(projected['entryStage'], 'runtime')
        self.assertEqual(projected['reason'], expected)
        self.assertIsNone(projected['closeRequested'])
        self.assertIsNone(projected['closeAcknowledged'])

    def test_actual_host_failure_publication_handles_blocked_and_closed_pipe_inside_deadline(self):
        source = """import importlib.util,json,signal,sys,time
s=importlib.util.spec_from_file_location('h',sys.argv[1]);h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
def expired(*args): raise TimeoutError('not published')
signal.signal(signal.SIGALRM,expired)
deadline=time.monotonic()+0.5
ok=h.publish_failure({'ok':False,'retryAllowed':False,'native':None},deadline)
print(json.dumps({'published':ok,'remaining':deadline-time.monotonic()}),flush=True)
sys.exit(0 if ok else 1)
"""
        args = [sys.executable, '-B', '-c', source, str(REPO/'server/scripts/main-inspector-retirement.py')]
        child = self.real_popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, error = child.communicate(timeout=2)
        self.assertEqual(child.returncode, 0)
        self.assertEqual(json.loads(error), {'ok':False,'retryAllowed':False,'native':None})
        self.assertGreater(json.loads(out)['remaining'], 0.1)
        for mode in ['blocked', 'closed']:
            with self.subTest(mode=mode):
                read_fd, write_fd = os.pipe()
                if mode == 'blocked':
                    flags = fcntl.fcntl(write_fd, fcntl.F_GETFL)
                    fcntl.fcntl(write_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
                    try:
                        while True: os.write(write_fd, b'x'*4096)
                    except BlockingIOError: pass
                    finally: fcntl.fcntl(write_fd, fcntl.F_SETFL, flags)
                    # macOS normalizes status bits on F_SETFL; compare the
                    # actual prepared descriptor immediately before the child.
                    prepared_flags = fcntl.fcntl(write_fd, fcntl.F_GETFL)
                else:
                    os.close(read_fd)
                try:
                    child = self.real_popen(args, stdout=subprocess.PIPE, stderr=write_fd)
                    out, _ = child.communicate(timeout=2)
                    if mode == 'blocked':
                        self.assertEqual(fcntl.fcntl(write_fd, fcntl.F_GETFL), prepared_flags)
                    self.assertEqual(child.returncode, 1)
                    result = json.loads(out)
                    self.assertFalse(result['published'])
                    self.assertGreater(result['remaining'], 0.1)
                finally:
                    os.close(write_fd)
                    if mode == 'blocked': os.close(read_fd)

    def test_failure_diagnostic_distinguishes_unstarted_and_partial_writes_and_redacts(self):
        old_proposal_bytes = self.proposal_bytes
        self.proposal_bytes = json.dumps({'ok':False,'retryAllowed':False,
            'reason':'qualification_refused','stage':'attach','closeRequested':False}).encode()
        self.assertEqual(self.execute(), 1)
        self.assertEqual(self.diagnostic()['native']['reason'], 'qualification_refused')
        self.assertIsNone(self.diagnostic()['native']['closeAcknowledged'])
        self.assertEqual(self.diagnostic()['intent'], 'not_started')
        self.proposal_bytes = old_proposal_bytes
        self.mode = 'bad_status'
        self.assertEqual(self.execute(), 1)
        self.assertEqual(self.diagnostic()['intent'], 'not_started')
        self.assertEqual(self.diagnostic()['ack'], 'not_started')
        self.assertEqual(self.diagnostic()['native'], None)
        self.mode = 'success'
        actual_write = os.write
        def fail_intent(fd, value):
            if fd != 2 and self.intent.exists():
                raise OSError('SECRET /private/path ws://endpoint pid2345')
            return actual_write(fd, value)
        with patch.object(os, 'write', side_effect=fail_intent):
            self.assertEqual(self.execute(), 1)
        self.assertEqual(self.diagnostic()['intent'], 'write_started')
        self.assertEqual(self.diagnostic()['ack'], 'not_started')
        self.assertNotIn('SECRET', self.stderr.getvalue())
        self.assertFalse(self.receipt.exists())
        self.intent.unlink()
        self.mode = 'ack_failure'
        original = self.popen
        def broken_ack(args, **kwargs):
            child = original(args, **kwargs)
            child.stdin.write = lambda data: (_ for _ in ()).throw(OSError('SECRET'))
            return child
        with patch.object(self, 'popen', side_effect=broken_ack):
            self.assertEqual(self.execute(), 1)
        self.assertEqual(self.diagnostic()['intent'], 'durable')
        self.assertEqual(self.diagnostic()['ack'], 'write_started')
        self.assertFalse(self.receipt.exists())
        for value in [{'ok':False,'retryAllowed':False,'reason':['SECRET'],'stage':{'x':'SECRET'},
                       'closeRequested':1,'closeAcknowledged':'true','connectionClosed':None,
                       'endpoint':'SECRET','entryStage':['SECRET']}, {'ok':True}, None]:
            with self.subTest(value=value):
                result = HOST.bounded_native_facts(value)
                self.assertNotIn('SECRET', json.dumps(result))
                if result:
                    self.assertIsNone(result['stage']); self.assertIsNone(result['reason'])
                    self.assertIsNone(result['entryStage'])
                    self.assertIsNone(result['closeRequested']); self.assertIsNone(result['listenerAbsent'])

    def test_kernel_detail_is_a_closed_predicate_not_native_data(self):
        for step in ['clients', 'socket_rows', 'SECRET /proc/1/fd/3', ['clients'], None]:
            with self.subTest(step=step):
                value = {'ok': False, 'retryAllowed': False,
                         'reason': 'main_inspector_socket_unproved', 'kernelStep': step}
                result = HOST.bounded_native_facts(value)
                if step in ('clients', 'socket_rows'):
                    self.assertEqual(result['kernelStep'], step)
                else:
                    self.assertNotIn('kernelStep', result)
                self.assertNotIn('SECRET', json.dumps(result))

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

    def entry(self, owner_uid=0, run=RUN, docker_identity=IDENTITY):
        actual_fstat = os.fstat

        def owned_fstat(fd):
            value = actual_fstat(fd)
            return SimpleNamespace(st_mode=value.st_mode, st_uid=owner_uid)

        def metadata(args, **kwargs):
            self.assertEqual(args[:2], ['docker', 'inspect'])
            self.assertEqual(args[-1], 'club-arena-engine')
            self.assertLessEqual(kwargs['timeout'], 2)
            self.events.append('entry_metadata')
            return SimpleNamespace(stdout=(docker_identity + '\n').encode())

        with patch.object(HOST, 'CONTROL', self.control), \
                patch.dict(os.environ, {'ENGINE_RELEASE_REQUEST_ROOT': str(self.root)}), \
                patch.object(os, 'geteuid', return_value=0), \
                patch.object(os, 'fstat', side_effect=owned_fstat), \
                patch.object(subprocess, 'run', side_effect=metadata), \
                patch.object(subprocess, 'Popen', side_effect=AssertionError('entry gate cannot attach')):
            return HOST.entry_state(run)

    def foreign(self, run='999-1', identity=IDENTITY, complete=False):
        claim = {'schema': 'main-inspector-retirement-claim/v1', 'runId': run,
                 'containerIdentity': identity, 'retryAllowed': False}
        intent = self.root / (run + '.main-inspector-retirement-intent')
        receipt = self.root / (run + '.main-inspector-retirement-receipt')
        intent.write_text(json.dumps(claim))
        if complete:
            receipt.write_text(json.dumps({'claim': claim, 'outcome': self.outcome}))
        return intent, receipt

    def test_entry_gate_absence_unknown_orphan_and_dangling_history(self):
        self.assertEqual(self.entry(), 0)
        self.assertNotIn('entry_metadata', self.events, 'no foreign history performs no Docker read')
        for path in [self.intent, self.receipt]:
            path.write_text('{}')
            self.assertEqual(self.entry(), 1)
            path.unlink()
            path.symlink_to(self.root / 'missing')
            self.assertEqual(self.entry(), 1)
            path.unlink()
        self.intent.write_text('{malformed')
        self.receipt.write_text('{}')
        self.assertEqual(self.entry(), 1)

    def test_entry_gate_completed_exact_operation_only(self):
        self.assertEqual(self.execute(), 0)
        self.assertEqual(self.entry(), 0)
        claim_bytes, receipt_bytes = self.intent.read_bytes(), self.receipt.read_bytes()
        for key, value in [('runId', '999-1'), ('controlSha', 'f' * 40),
                           ('target', 'e' * 40), ('requestSha256', '0' * 64),
                           ('retryAllowed', True)]:
            with self.subTest(key=key):
                claim = json.loads(claim_bytes)
                claim[key] = value
                receipt = json.loads(receipt_bytes)
                receipt['claim'] = claim
                self.intent.write_text(json.dumps(claim))
                self.receipt.write_text(json.dumps(receipt))
                self.assertEqual(self.entry(), 1)
        self.intent.write_bytes(claim_bytes); self.receipt.write_bytes(receipt_bytes)
        self.assertEqual(self.entry(owner_uid=1), 1)
        self.request.write_text(self.request.read_text().replace(TARGET_SHA, 'd' * 40))
        self.assertEqual(self.entry(), 1)

    def test_entry_gate_requires_every_native_completion_flag_and_matching_claim(self):
        self.assertEqual(self.execute(), 0)
        receipt_bytes = self.receipt.read_bytes()
        for key in ['ok', 'closeRequested', 'closeAcknowledged', 'connectionClosed', 'listenerAbsent', 'retryAllowed']:
            with self.subTest(key=key):
                receipt = json.loads(receipt_bytes)
                receipt['outcome'][key] = key == 'retryAllowed'
                self.receipt.write_text(json.dumps(receipt))
                self.assertEqual(self.entry(), 1)
        receipt = json.loads(receipt_bytes)
        receipt['claim']['runId'] = '999-1'
        self.receipt.write_text(json.dumps(receipt))
        self.assertEqual(self.entry(), 1)

    def test_entry_gate_nonregular_and_oversized_history_fail_closed(self):
        self.receipt.write_text('{}')
        os.mkfifo(self.intent)
        self.assertEqual(self.entry(), 1)
        self.intent.unlink()
        self.intent.write_bytes(b'x' * 32769)
        self.assertEqual(self.entry(), 1)

    def test_new_run_cannot_skip_same_live_process_unknown_even_when_listener_closed(self):
        intent, receipt = self.foreign()
        self.assertEqual(self.entry(), 1)
        self.assertIn('entry_metadata', self.events)
        self.assertFalse(receipt.exists())
        self.assertEqual(self.events.count('entry_metadata'), 1)

    def test_foreign_same_process_complete_pair_resolves_uncertainty_without_replay(self):
        intent, receipt = self.foreign(complete=True)
        before = (intent.read_bytes(), receipt.read_bytes())
        self.assertEqual(self.entry(), 0)
        self.assertEqual((intent.read_bytes(), receipt.read_bytes()), before)
        self.assertNotIn('spawn', self.events)

    def test_wellformed_unknown_prior_process_does_not_block_new_live_process(self):
        self.foreign(identity=IDENTITY.replace(CONTAINER, 'd' * 64).replace('2345', '6789'))
        self.assertEqual(self.entry(), 0)

    def test_foreign_orphan_malformed_mismatched_false_and_symlink_history_refuse(self):
        intent, receipt = self.foreign(complete=True)
        good_intent, good_receipt = intent.read_bytes(), receipt.read_bytes()
        mutations = ['orphan_intent', 'orphan_receipt', 'malformed', 'null',
                     'mismatch', 'false_outcome', 'bad_identity', 'dangling', 'oversized']
        for mode in mutations:
            with self.subTest(mode=mode):
                for path in [intent, receipt]:
                    if os.path.lexists(path): path.unlink()
                intent.write_bytes(good_intent); receipt.write_bytes(good_receipt)
                if mode == 'orphan_intent': receipt.unlink()
                elif mode == 'orphan_receipt': intent.unlink()
                elif mode == 'malformed': intent.write_text('{broken')
                elif mode == 'null': intent.write_text('null')
                elif mode == 'mismatch':
                    value = json.loads(good_receipt); value['claim']['retryAllowed'] = True
                    receipt.write_text(json.dumps(value))
                elif mode == 'false_outcome':
                    value = json.loads(good_receipt); value['outcome']['closeAcknowledged'] = False
                    receipt.write_text(json.dumps(value))
                elif mode == 'bad_identity':
                    value = json.loads(good_intent); value['containerIdentity'] = 'unknown'
                    intent.write_text(json.dumps(value))
                elif mode == 'dangling':
                    intent.unlink(); intent.symlink_to(self.root / 'missing')
                elif mode == 'oversized': intent.write_bytes(b'x' * 32769)
                self.assertEqual(self.entry(), 1)

    def test_foreign_scan_rejects_bad_names_excess_pairs_and_unproved_live_metadata(self):
        bad = self.root / 'foreign.main-inspector-retirement-intent'
        bad.write_text('{}')
        self.assertEqual(self.entry(), 1)
        bad.unlink()
        self.foreign()
        self.assertEqual(self.entry(docker_identity='unproved'), 1)
        for n in range(1000, 1256): self.foreign(run=str(n))
        self.assertEqual(self.entry(), 1)

    def test_scheduled_locked_checkpoint_cannot_bypass_unknown_retirement_with_closed_listener(self):
        transaction = (REPO / 'server/scripts/engine-release-transaction.sh').read_text()
        # A scheduled/adopted countdown can reach this block without entering
        # request_recovery_window at all. Pin the common caller, not that helper.
        locked = transaction.split("acquire_engine_lock 'maintenance cutover'", 1)[1]
        checkpoint = locked.index('"$LEGACY_CHECKPOINT" "$RUN_ID"')
        predecessor = locked.index('CHECKPOINT_PREDECESSOR_SHA=')
        gate = locked.index('--entry-state "$RUN_ID"')
        self.assertLess(predecessor, gate)
        self.assertLess(gate, checkpoint)
        gate_start = locked.rfind('  if [ "$LEGACY_CHECKPOINT_REQUIRED" = 1 ]', predecessor, gate)
        self.assertGreater(gate_start, predecessor)
        gate_end = locked.index('\n  fi', gate)
        gate_context = locked[gate_start:gate_end]
        self.assertIn('"$CHECKPOINT_PREDECESSOR_SHA" = "$CHECKPOINT_EED_SHA"', gate_context)
        self.assertIn('legacy_entry_read timeout', gate_context)
        self.assertIn('3s', gate_context)
        self.assertIn('|| die', gate_context)
        self.assertNotIn('"$RUN_ID" "$INVOCATION_ID"', gate_context)

    def test_current_operation_rechecks_foreign_owner_before_inspector_action(self):
        source = (REPO / 'server/scripts/engine-release-transaction.sh').read_text()
        body = source.split('request_recovery_window() {', 1)[1]
        lock = body.index("acquire_engine_lock 'one recovery announcement'")
        owner = body.index('then refuse_foreign_floor_owner; fi', lock)
        history = body.index('--entry-state "$RUN_ID"', lock)
        action = body.index('"$RUN_ID" "$INVOCATION_ID"', lock)
        announcement = body.index('record_floor_runtime_entry announcement-entry', lock)
        self.assertLess(lock, owner)
        self.assertLess(owner, history)
        self.assertLess(history, action)
        self.assertLess(action, announcement)


if __name__ == '__main__':
    unittest.main()
