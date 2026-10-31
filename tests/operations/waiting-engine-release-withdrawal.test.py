#!/usr/bin/env python3
"""Finite qualification of the original transaction-only terminal boundary."""
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
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


class AnnouncedCancellation(unittest.TestCase):
    def test_thaw_requires_exact_complete_owned_release(self):
        stamp = 1793429586934
        iso = lambda ms: module.datetime.datetime.fromtimestamp(ms / 1000, module.datetime.timezone.utc).isoformat()
        row = {'contract_version': 3, 'announced_at': iso(stamp), 'freeze_started_at': iso(stamp + 120000),
               'release_target_at': iso(stamp + 420000), 'thawed_at': iso(stamp + 410000),
               'ownership_token': '12345678-1234-1234-1234-123456789abc', 'release_generation': 1,
               'shifted': dict.fromkeys(module.THAW_STEPS, 0) | {'complete': True, '_targets_snapshotted': True, '_target_counts': dict.fromkeys(module.THAW_STEPS, 0)}, 'frozen_seconds': 300}
        self.assertEqual(module.prove_thaw([row], [], stamp, stamp + 430000)['announcedAtMs'], stamp)
        bad = [{'contract_version': 2}, {'announced_at': iso(stamp + 1)}, {'freeze_started_at': iso(stamp)},
               {'release_target_at': iso(stamp + 440000)}, {'shifted': {'complete': True}},
               {'ownership_token': None}, {'release_generation': 0}, {'frozen_seconds': 200}]
        for change in bad:
            with self.subTest(change=change), self.assertRaises((ValueError, TypeError)):
                module.prove_thaw([row | change], [], stamp, stamp + 430000)
        for rows, active in [([], []), ([row, row], []), ([row], [{'id': True}])]:
            with self.assertRaises(ValueError): module.prove_thaw(rows, active, stamp, stamp + 430000)

    def test_durable_records_are_create_once_and_symlinks_refuse(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder:
            path = Path(folder) / 'intent'
            # The host requires root ownership; fixture reads its own immutable bytes.
            with patch.object(module, 'regular', side_effect=lambda p, mode=None: Path(p).read_text()):
                module.save_once(path, {'value': 1})
                module.save_once(path, {'value': 1})
                with self.assertRaises(ValueError): module.save_once(path, {'value': 2})
                self.assertEqual(json.loads(path.read_text()), {'value': 1})

    def harness(self, folder, patches):
        root = Path(folder); state = root / 'state'; state.mkdir()
        systemd = root / 'systemd'; systemd.mkdir(); (systemd / 'multi-user.target.wants').mkdir()
        proc = root / 'proc'; proc.mkdir(); parent = root / 'control'; parent.mkdir()
        lock = root / 'engine.lock'; lock.touch()
        request = {'runKey': '41177442979-1', 'releaseSha': module.CANCEL_CONTROL,
                   'controlSha': module.CANCEL_CONTROL, 'desiredSha': 'c' * 40,
                   'instanceId': '1-1234abcd', 'mode': 'cancel_expired_announcement'}
        key = request['runKey']; units = module.cancel_units(key); group = '/system.slice/' + units[0]
        original = {'MainPID': '12', 'InvocationID': 'f' * 32, 'ActiveState': 'activating',
                    'SubState': 'start', 'Result': 'success', 'ExecMainCode': '0', 'ExecMainStatus': '0', 'ControlGroup': group}
        ended = original | {'MainPID': '0', 'ActiveState': 'failed', 'SubState': 'failed',
                            'Result': 'exit-code', 'ExecMainCode': '1', 'ExecMainStatus': '75', 'ControlGroup': ''}
        idle = ended | {'Result': 'success', 'ExecMainStatus': '0'}
        generation = parent / 'engine-control-generations' / module.CANCEL_CONTROL
        processes = {12: {'pid': 12, 'parent': 1, 'start': '100', 'argv': ['bash', str(parent / 'engine-release-unit-wrapper-v1.sh'), 'start', key]},
                     13: {'pid': 13, 'parent': 12, 'start': '101', 'argv': ['bash', str(generation / 'engine-release-transaction.sh'), '--run-id', key]}}
        for pid in [12, 13, 14]:
            (proc / str(pid)).mkdir(); (proc / str(pid) / 'cgroup').write_text('0::' + (group if pid != 14 else '/engine') + '\n')
        (proc / '12/task/12').mkdir(parents=True); (proc / '12/task/12/children').write_text('13')
        originals = {}
        for directory, suffix in [('engine-release-requests', 'request'), ('engine-release-requests', 'intent'),
                                  ('engine-release-requests', 'awaiting-certificate'), ('engine-release-generation-pins', 'generation'),
                                  ('engine-intake-requests', 'request'), ('engine-image-leases', 'lease')]:
            path = state / directory / (key + '.' + suffix); path.parent.mkdir(exist_ok=True); path.write_text(suffix)
            originals[str(path.relative_to(state))] = module.digest(path.read_bytes())
        entry = state / 'engine-release-requests' / (key + '.activation-entry'); entry.write_text('announcement')
        reservation = state / ('engine-recovery-window-' + key + '.json'); reservation.write_text('original')
        released = state / 'engine-release-requests' / (key + '.lightning-hold.json.released'); released.write_text('released')
        evidence = {'releasedHoldHash': module.digest(released.read_bytes()), 'originals': originals, 'entryHash': module.digest(entry.read_bytes()),
                    'reservationHash': module.digest(reservation.read_bytes()), 'thaw': {'released': True}}
        control = {'stopped': False, 'stopCount': 0, 'unknownStop': False, 'cgroupEmpty': True,
                   'evidenceFails': False, 'commands': [], 'container': {'id': 'a' * 64, 'image': 'sha256:' + 'b' * 64, 'startedAt': 'original'}}
        def command(args, timeout=5):
            control['commands'].append(args)
            if args[:3] == ['systemctl', 'stop', '--no-block']:
                control['stopCount'] += 1
                if control['unknownStop']: raise subprocess.TimeoutExpired(args, 5)
                control['stopped'] = True; return ''
            if args[:2] == ['systemctl', 'show']: return 'masked'
            if args[:3] == ['docker', 'container', 'inspect']: return '14'
            return ''
        def check_evidence(_, after_stop=False):
            if control['evidenceFails']: raise ValueError('runtime promotion')
            return evidence
        for name, value in [('ROOT', state), ('PARENT', parent), ('SYSTEMD', systemd), ('PROC', proc), ('ENGINE_LOCK', lock)]:
            patches.enter_context(patch.object(module, name, value))
        patches.enter_context(patch.object(os, 'getuid', return_value=0))
        patches.enter_context(patch.object(module, 'cancellation_directory', side_effect=lambda p: p.mkdir(exist_ok=True)))
        patches.enter_context(patch.object(module, 'regular', side_effect=lambda p, mode=None: Path(p).read_text()))
        patches.enter_context(patch.object(module, 'announcement_evidence', side_effect=check_evidence))
        patches.enter_context(patch.object(module, 'container_identity', side_effect=lambda _: control['container']))
        patches.enter_context(patch.object(module, 'health_pair'))
        patches.enter_context(patch.object(module, 'loaded_stop_contract', return_value={'qualified': True}))
        patches.enter_context(patch.object(module, 'process', side_effect=lambda pid: processes[pid]))
        patches.enter_context(patch.object(module, 'unit_snapshot', side_effect=lambda unit: (ended if control['stopped'] else original).copy() if unit == units[0] else idle.copy()))
        patches.enter_context(patch.object(module, 'cgroup_empty', side_effect=lambda _: control['cgroupEmpty']))
        patches.enter_context(patch.object(module, 'command', side_effect=command))
        patches.enter_context(patch.object(module.time, 'sleep'))
        clock = iter(range(0, 100000, 70)); patches.enter_context(patch.object(module.time, 'monotonic', side_effect=lambda: next(clock)))
        return request, control, state, entry, reservation, units

    def test_actual_exit_is_retained_and_repeat_only_reads(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder, ExitStack() as patches:
            request, control, state, entry, reservation, units = self.harness(folder, patches)
            answer = module.cancel_announced(request)
            module.validate_cancellation_reply(answer, request)
            self.assertEqual(answer['actualUnitStates'][0]['ExecMainStatus'], '75')
            self.assertEqual(control['stopCount'], 1)
            self.assertEqual(module.cancel_announced(request), answer)
            self.assertEqual(control['stopCount'], 1)
            self.assertTrue(entry.exists()); self.assertTrue(reservation.exists())
            self.assertFalse((state / 'engine-release-requests' / (request['runKey'] + '.request')).exists())
            self.assertFalse(any('record-failure' in args for args in control['commands']))

    def test_unknown_stop_never_reissues_and_can_finish_from_quiescence(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder, ExitStack() as patches:
            request, control, state, *_ = self.harness(folder, patches)
            control['unknownStop'] = True
            for _ in range(2):
                with self.assertRaises(ValueError): module.cancel_announced(request)
            self.assertEqual(control['stopCount'], 1)
            self.assertTrue((state / 'engine-release-requests' / (request['runKey'] + '.request')).exists())
            control['stopped'] = True
            answer = module.cancel_announced(request)
            self.assertTrue(answer['quiescent']); self.assertEqual(control['stopCount'], 1)

    def test_nonempty_cgroup_never_retires(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder, ExitStack() as patches:
            request, control, state, *_ = self.harness(folder, patches)
            control['cgroupEmpty'] = False
            with self.assertRaises(ValueError): module.cancel_announced(request)
            self.assertTrue((state / 'engine-release-requests' / (request['runKey'] + '.request')).exists())
            self.assertFalse((state / 'engine-release-cancellations' / (request['runKey'] + '.receipt.json')).exists())

    def test_source_or_runtime_proof_refusal_has_no_stop_or_mask(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder, ExitStack() as patches:
            request, control, state, _, _, units = self.harness(folder, patches)
            control['evidenceFails'] = True
            with self.assertRaises(ValueError): module.cancel_announced(request)
            self.assertEqual(control['stopCount'], 0)
            self.assertFalse(any((module.SYSTEMD / unit).exists() for unit in units))

    def test_crashes_at_each_durable_edge_preserve_one_stop_and_history(self):
        for edge in ['intent.json', 'stop-issued.json', 'quiescent.json', 'receipt.json']:
            with self.subTest(edge=edge), tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder, ExitStack() as patches:
                request, control, state, entry, reservation, units = self.harness(folder, patches)
                original_save = module.save_once
                def crashed(path, value):
                    original_save(path, value)
                    if path.name.endswith(edge): raise OSError('crash after durable create')
                with patch.object(module, 'save_once', side_effect=crashed), self.assertRaises(OSError):
                    module.cancel_announced(request)
                if edge == 'stop-issued.json':
                    with self.assertRaises(ValueError): module.cancel_announced(request)
                    self.assertEqual(control['stopCount'], 0)  # Unknown issue gap is never replayed.
                    control['stopped'] = True
                answer = module.cancel_announced(request)
                self.assertTrue(answer['quiescent']); self.assertLessEqual(control['stopCount'], 1)
                self.assertTrue(entry.exists()); self.assertTrue(reservation.exists())

    def test_partial_mask_and_foreign_mask_fail_closed(self):
        for foreign in [False, True]:
            with self.subTest(foreign=foreign), tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder, ExitStack() as patches:
                request, control, state, _, _, units = self.harness(folder, patches)
                path = module.SYSTEMD / units[0]
                if foreign:
                    path.symlink_to('/foreign')
                    with self.assertRaises(ValueError): module.cancel_announced(request)
                else:
                    symlink = os.symlink
                    def interrupted(src, dst, **kwargs):
                        symlink(src, dst, **kwargs)
                        raise OSError('mask crash')
                    with patch.object(os, 'symlink', side_effect=interrupted), self.assertRaises(OSError): module.cancel_announced(request)
                    self.assertEqual(control['stopCount'], 0)
                    self.assertTrue(module.cancel_announced(request)['quiescent'])
                self.assertLessEqual(control['stopCount'], 1)


    def test_original_announced_recovery_exits_before_engine_lock_or_supervisor(self):
        source = (ROOT / 'server/scripts/engine-release-recover.sh').read_text()
        branch = source.split('case "$FLOOR_DISPOSITION" in', 1)[1].split('\nif [ "$RECOVERY_MODE"', 1)[0]
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            lock = Path(directory) / 'must-not-open'
            result = subprocess.run(['bash', '-c', 'set -eu\nFLOOR_DISPOSITION=announced\nENGINE_LOCK="$1"\ncase "$FLOOR_DISPOSITION" in' + branch, 'fixture', str(lock)], capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 75, result.stderr)
            self.assertIn('announcement-only owner retained', result.stderr)
            self.assertFalse(lock.exists())

    def test_admission_checks_real_announcement_files_and_refuses_changed_custody(self):
        for failure in [None, 'runtime', 'foreign', 'manifest', 'checkpoint', 'hold', 'pending', 'source']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder, ExitStack() as patches:
                root = Path(folder); state = root / 'state'; state.mkdir(); parent = root / 'parent'; parent.mkdir()
                generation = parent / 'engine-control-generations' / module.CANCEL_CONTROL; generation.mkdir(parents=True)
                request = {'runKey': '41177442979-1', 'releaseSha': module.CANCEL_CONTROL, 'controlSha': module.CANCEL_CONTROL,
                           'desiredSha': 'c' * 40, 'instanceId': '1-1234abcd', 'mode': 'cancel_expired_announcement'}
                key = request['runKey']; reqroot = state / 'engine-release-requests'; reqroot.mkdir()
                lines = '\n'.join([module.CANCEL_CONTROL, 'url', 'actor', str(generation), module.CANCEL_CONTROL, '1793440868']) + '\n'
                for suffix, raw in [('request', lines), ('intent', lines), ('awaiting-certificate', module.CANCEL_CONTROL + '\n')]:
                    (reqroot / (key + '.' + suffix)).write_text(raw)
                # The expected manifest is derived from the exact retained source blob.
                manifest = subprocess.check_output(['git', 'show', module.CANCEL_CONTROL + ':server/release/activation-floor.json'], cwd=ROOT)
                entry = {'schema': 'engine-release-activation-floor/v2-owner-window', 'runId': key,
                         'targetSha': module.CANCEL_CONTROL, 'controlSha': module.CANCEL_CONTROL,
                         'manifestSha256': module.digest(manifest), 'phase': 'announcement'}
                if failure == 'runtime': entry['phase'] = 'runtime'
                if failure == 'foreign': entry['runId'] = '1-1'
                if failure == 'manifest': entry['manifestSha256'] = '0' * 64
                (reqroot / (key + '.activation-entry')).write_text(json.dumps(entry))
                (reqroot / (key + '.lightning-hold.json.released')).write_text('released')
                (generation / 'engine-release-lightning-hold.py').write_text("def own_record(path, key): return {'phase': 'released'}\n")
                stamp = 1793429586934
                (state / ('engine-recovery-window-' + key + '.json')).write_text(json.dumps({'runId': key, 'sha': module.CANCEL_CONTROL, 'announcedAt': stamp, 'cause': 'urgent'}))
                pin = state / 'engine-release-generation-pins'; pin.mkdir(); (pin / (key + '.generation')).write_text(str(generation) + '\n' + module.CANCEL_CONTROL + '\n')
                if failure in {'checkpoint', 'hold'}:
                    (reqroot / (key + ('.legacy-checkpoint-intent' if failure == 'checkpoint' else '.lightning-hold.json'))).write_text('present')
                def command(args, timeout=5):
                    if 'reservation' in args: return str(stamp)
                    if 'pending-owner' in args: return 'other' if failure == 'pending' else 'none'
                    return request['desiredSha']
                patches.enter_context(patch.object(module, 'ROOT', state)); patches.enter_context(patch.object(module, 'PARENT', parent))
                patches.enter_context(patch.object(module, 'regular', side_effect=lambda p, mode=None: Path(p).read_text()))
                patches.enter_context(patch.object(module, 'source_hash', side_effect=lambda p: '0' * 64 if failure == 'source' else module.WRAPPER_HASH if p.name == 'engine-release-unit-wrapper-v1.sh' else module.CANCEL_HASHES[p.name]))
                patches.enter_context(patch.object(module, 'command', side_effect=command))
                patches.enter_context(patch.object(module, 'own_thaw', return_value={'verified': True}))
                patches.enter_context(patch.object(module.time, 'time', return_value=stamp / 1000 + 500))
                if failure:
                    with self.assertRaises(ValueError): module.announcement_evidence(request)
                else: self.assertEqual(module.announcement_evidence(request)['thaw'], {'verified': True})

    def test_partial_retirement_resumes_without_another_stop(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder, ExitStack() as patches:
            request, control, state, entry, reservation, units = self.harness(folder, patches)
            original_unlink = Path.unlink; fired = False
            def interrupted(path, *args, **kwargs):
                nonlocal fired
                original_unlink(path, *args, **kwargs)
                if path.name == request['runKey'] + '.intent' and not fired:
                    fired = True; raise OSError('crash after partial retirement')
            with patch.object(Path, 'unlink', interrupted), self.assertRaises(OSError): module.cancel_announced(request)
            answer = module.cancel_announced(request)
            self.assertTrue(answer['quiescent']); self.assertEqual(control['stopCount'], 1)
            self.assertTrue(entry.exists()); self.assertTrue(reservation.exists())


    def test_loaded_stop_authority_refuses_foreign_commands_and_propagation(self):
        key = '41177442979-1'; unit = module.cancel_units(key)[0]
        wrapper = str(module.PARENT / 'engine-release-unit-wrapper-v1.sh')
        command = lambda argv: '{ path=' + wrapper + ' ; argv[]=' + argv + ' ; ignore_errors=no ; start_time=n/a ; stop_time=n/a ; pid=0 ; code=(null) ; status=0/0 }'
        config = {'ExecStart': command(wrapper + ' start ' + key), 'ExecStop': '',
                  'ExecStopPost': command(wrapper + ' recover ' + key + ' ${SERVICE_RESULT} ${EXIT_CODE} ${EXIT_STATUS}'),
                  'KillMode': 'control-group', 'FragmentPath': str(module.SYSTEMD / 'club-arena-engine-release-v1@.service'),
                  'DropInPaths': '', 'RequiredBy': '', 'RequisiteOf': '', 'BoundBy': '', 'ConsistsOf': '', 'PropagatesStopTo': ''}
        render = lambda value: '\n'.join(k + '=' + v for k, v in value.items())
        with patch.object(module, 'command', return_value=render(config)):
            module.loaded_stop_contract(unit, key)
        for field in config:
            bad = config | {field: 'foreign'}
            with self.subTest(field=field), patch.object(module, 'command', return_value=render(bad)), self.assertRaises(ValueError):
                module.loaded_stop_contract(unit, key)
        empty = config | {'FragmentPath': '/dev/null', 'ExecStart': '', 'ExecStopPost': ''}
        with patch.object(module, 'command', return_value=render(empty)):
            self.assertEqual(module.loaded_stop_contract(unit, key, allow_masked=True), {'maskedEmpty': True})
            with self.assertRaises(ValueError): module.loaded_stop_contract(unit, key)
        with patch.object(module, 'command', return_value=render(config | {'ExecStopPost': config['ExecStopPost'] + config['ExecStopPost']})), self.assertRaises(ValueError):
            module.loaded_stop_contract(unit, key)

    def test_pre_stop_interruption_with_positive_quiescence_needs_no_stop(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder, ExitStack() as patches:
            request, control, state, entry, reservation, units = self.harness(folder, patches)
            original_save = module.save_once
            def crash(path, value):
                original_save(path, value)
                if path.name.endswith('.intent.json'): raise OSError('interrupted before masks/stop')
            with patch.object(module, 'save_once', side_effect=crash), self.assertRaises(OSError): module.cancel_announced(request)
            control['stopped'] = True  # Original may have exited while the helper was absent.
            answer = module.cancel_announced(request)
            self.assertTrue(answer['quiescent']); self.assertEqual(control['stopCount'], 0)
            self.assertFalse((state / 'engine-release-requests' / (request['runKey'] + '.request')).exists())
            self.assertTrue(entry.exists()); self.assertTrue(reservation.exists())


    @unittest.skipUnless(sys.platform.startswith('linux'), 'Real systemd qualification requires Linux; required Linux CI never skips')
    def test_real_linux_mask_reload_and_stop_contract(self):
        result = subprocess.run(['sudo', '-n', sys.executable, '-B', str(ROOT / 'tests/operations/withdrawal-systemd-fixture.py')], capture_output=True, text=True, timeout=50)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('owned fixture retired', result.stdout)


if __name__ == '__main__':
    unittest.main()
