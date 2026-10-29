#!/usr/bin/env python3
"""Actual fixed file reader on isolated native files; no host or provider calls."""
import importlib.util
import base64
import contextlib
import io
import ast
import json
import os
import subprocess
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('reader', ROOT / 'scripts/ci/read-scoped-release-recovery.py')
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)
REQUEST = {'runKey': '38268897283-1', 'releaseSha': 'a' * 40}
WINDOW = {'runId': REQUEST['runKey'], 'sha': REQUEST['releaseSha'],
          'announcedAt': 1791821651724, 'cause': 'engine-degraded'}
RESULT = {'schema': 1, 'runId': REQUEST['runKey'], 'sha': REQUEST['releaseSha'],
          'result': 'sealed', 'completedAt': 1791821800,
          'private_metadata': {'never_export': 'secret fixture'}}


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-recovery-', dir=ROOT.parent)
        self.root = Path(self.temp.name)
        (self.root / 'engine-release-results').mkdir()
        self.window = self.root / ('engine-recovery-window-' + REQUEST['runKey'] + '.json')
        self.result = self.root / 'engine-release-results' / (REQUEST['runKey'] + '.json')
        self.window.write_text(json.dumps(WINDOW))
        self.result.write_text(json.dumps(RESULT))
        self.patcher = patch.object(R, 'STATE_ROOT', self.root)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.temp.cleanup()

    def test_real_files_export_only_bound_identity_cause_and_times(self):
        answer = R.remote(REQUEST)
        self.assertEqual(answer['cause'], 'engine-degraded')
        self.assertEqual(answer['freezeAtMs'], 1791821771724)
        self.assertEqual(answer['windowEndsAtMs'], 1791822071724)
        self.assertNotIn('secret fixture', json.dumps(answer))
        self.assertNotIn('private_metadata', answer)
        self.assertEqual(answer['emergencyBasisStatus'], 'unknown_not_retained_in_selected_receipts')
        self.assertEqual(R.validate_reply(answer, REQUEST), answer)

    def test_pending_transaction_reads_exact_request_without_requiring_a_seal(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        directory = self.root / 'engine-release-requests'
        directory.mkdir()
        raw = '\n'.join([REQUEST['releaseSha'],
            'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
            'private actor fixture', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
            'b' * 40, '1791829999']) + '\n'
        (directory / (REQUEST['runKey'] + '.request')).write_text(raw)
        (directory / (REQUEST['runKey'] + '.intent')).write_text(raw)
        (directory / (REQUEST['runKey'] + '.awaiting-certificate')).write_text(REQUEST['releaseSha'] + '\n')
        for metadata in directory.iterdir(): metadata.chmod(0o600)
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        with patch.object(R, 'pending_unit', return_value=unit, create=True), patch.object(R, 'pending_journal', return_value=[], create=True):
            answer = R.remote(request)
        self.assertEqual(answer['stage'], 'awaiting_certificate_marker_retained')
        self.assertEqual(answer['requestDeadlineEpoch'], 1791829999)
        self.assertEqual(answer['controlSha'], 'b' * 40)
        self.assertNotIn('private actor fixture', json.dumps(answer))
        self.assertNotIn('/opt/', json.dumps(answer))
        self.assertEqual(R.validate_reply(answer, request), answer)

    def test_pending_remote_failure_reports_fixed_stage_without_private_detail(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        with self.assertRaises(R.ScopedRefusal) as caught:
            R.remote(request)
        self.assertEqual((caught.exception.phase, caught.exception.code),
                         ('pending_directory', 'records_absent'))
        directory = self.root / 'engine-release-requests'
        directory.mkdir()
        with self.assertRaises(R.ScopedRefusal) as caught:
            R.remote(request)
        self.assertEqual((caught.exception.phase, caught.exception.code),
                         ('pending_request_read', 'records_absent'))
        raw = '\n'.join([REQUEST['releaseSha'],
            'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
            'private actor fixture', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
            'b' * 40, '1791829999']) + '\n'
        for suffix in ('.request', '.intent'):
            path = directory / (REQUEST['runKey'] + suffix)
            path.write_text(raw); path.chmod(0o600)
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        cases = [('read_lines', 'request_read'), ('pending_metadata', 'request_binding'),
                 ('pending_unit', 'unit')]
        for function, stage in cases:
            with self.subTest(stage=stage), \
                    patch.object(R, 'pending_unit', return_value=unit), \
                    patch.object(R, 'pending_journal', return_value=[]), \
                    patch.object(R, function, side_effect=ValueError('private fixture detail')):
                with self.assertRaises(R.ScopedRefusal) as caught:
                    R.remote(request)
                exported = R.refusal(request, caught.exception)
                validated = R.validate_refusal(exported, request)
                self.assertEqual((validated.phase, validated.code),
                                 ('pending_' + stage, 'evidence_unavailable'))
                self.assertNotIn('private fixture detail', json.dumps(exported))
        with patch.object(R, 'pending_unit', side_effect=[unit, {**unit, 'invocationId': '2' * 32}]), \
                patch.object(R, 'pending_journal', return_value=[]):
            with self.assertRaises(R.ScopedRefusal) as caught:
                R.remote(request)
            self.assertEqual(caught.exception.phase, 'pending_recheck_unit')

    def test_pending_journal_failure_preserves_only_rechecked_metadata_as_unknown(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        directory = self.root / 'engine-release-requests'; directory.mkdir()
        rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
                'private actor fixture', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
                'b' * 40, '1791829999']
        for suffix in ('.request', '.intent'):
            path = directory / (REQUEST['runKey'] + suffix)
            path.write_text('\n'.join(rows) + '\n'); path.chmod(0o600)
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        with patch.object(R, 'pending_unit', return_value=unit) as reads, \
                patch.object(R, 'pending_journal', side_effect=ValueError('private journal detail')):
            answer = R.remote(request)
        self.assertEqual(reads.call_count, 2)
        self.assertEqual(answer['journalStatus'], 'unavailable')
        self.assertIsNone(answer['journalSigns'])
        self.assertEqual(answer['journalFailure'], {'phase': 'pending_journal', 'code': 'evidence_unavailable'})
        self.assertEqual(R.validate_reply(answer, request), answer)
        self.assertNotIn('private', json.dumps(answer))
        failures = [(ValueError('Recovery witness output refused'), 'output_bound'),
                    (ValueError('Pending journal unavailable'), 'command_nonzero'),
                    (ValueError('Pending journal ownership refused'), 'ownership_refused'),
                    (ValueError('Pending journal shape refused'), 'shape_refused'),
                    (ValueError('Duplicate persisted field'), 'fields_refused'),
                    (subprocess.TimeoutExpired('private command', 5), 'command_deadline'),
                    (OSError('private command'), 'command_unavailable'),
                    (json.JSONDecodeError('private', 'private', 0), 'json_refused')]
        for error, code in failures:
            with self.subTest(code=code), self.assertRaises(R.ScopedRefusal) as caught:
                R.pending_stage('journal', lambda: (_ for _ in ()).throw(error))
            self.assertEqual((caught.exception.phase, caught.exception.code), ('pending_journal', code))
        with self.assertRaises(RuntimeError):
            R.pending_stage('journal', lambda: (_ for _ in ()).throw(RuntimeError('unexpected')))
        for mutation in [{'journalSigns': []}, {'journalStatus': 'observed'},
                         {'journalFailure': {'phase': 'pending_unit', 'code': 'evidence_unavailable'}},
                         {'journalFailure': {'phase': 'pending_journal', 'code': 'private detail'}},
                         {'schema': 'existing-release-pending-observation/v1'}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.validate_reply({**answer, **mutation}, request)
        for target in ('unit', 'requests'):
            def journal(*args):
                if target == 'requests':
                    path = directory / (REQUEST['runKey'] + '.request')
                    path.write_text('changed')
                raise ValueError('private journal detail')
            with patch.object(R, 'pending_unit', side_effect=[unit, {**unit, 'invocationId': '2' * 32}] if target == 'unit' else None, return_value=unit), \
                    patch.object(R, 'pending_journal', side_effect=journal), self.assertRaises(R.ScopedRefusal):
                R.remote(request)

    def test_pending_mode_refuses_unknown_modes_and_export_forgery(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        for mode in ['pending', 'status', None, True, '$(id)']:
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                R.selection({**REQUEST, 'mode': mode})
        rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
                'actor', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
                'b' * 40, '1791829999']
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        answer = R.pending_observation(request, rows, rows, None, None, unit, [])
        for mutation in [{'stage': 'ready'}, {'controlSha': 'secret'}, {'requestDeadlineEpoch': True},
                         {'unit': {**unit, 'invocationId': 'bad'}}, {'raw': 'private'},
                         {'journalSigns': [{'category': 'arbitrary', 'observedAtMs': WINDOW['announcedAt']}]},
                         {'journalSigns': [{'category': 'certificate_shut', 'observedAtMs': True}]}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.validate_reply({**answer, **mutation}, request)
        for index, value in [(0, 'c' * 40), (1, 'https://other.invalid'), (3, '/etc/keys'), (4, 'bad'), (5, '0')]:
            bad = [*rows]; bad[index] = value
            with self.subTest(index=index), self.assertRaises(ValueError):
                R.pending_observation(request, bad, bad, None, None, unit, [])
        with self.assertRaises(ValueError):
            R.pending_observation(request, rows, rows, ['c' * 40], None, unit, [])
        with self.assertRaises(ValueError):
            R.pending_observation(request, rows, rows, None, ['0'], unit, [])

    def test_pending_native_unit_and_journal_are_exact_readonly_and_sanitized(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        calls = []
        def show(args):
            calls.append(args)
            return types.SimpleNamespace(returncode=0, stdout=b'SubState=running\nActiveState=active\nInvocationID=' + b'1' * 32 + b'\n')
        with patch.object(R, 'bounded_journal', side_effect=show):
            self.assertEqual(R.pending_unit(request), unit)
        self.assertEqual(calls[0][:3], ['systemctl', 'show', 'club-arena-engine-release-v1@38268897283-1.service'])
        row = {'_SYSTEMD_INVOCATION_ID': unit['invocationId'],
               '_SYSTEMD_UNIT': calls[0][2], '__REALTIME_TIMESTAMP': '1791821800000000',
               'MESSAGE': '[engine-release-transaction] the restart certificate is shut with 299000ms of the break left: unparkedTables=66 unparkedReasons={cards_in_air:66} handsInFlightTotal=0',
               'ignored_metadata': 'private fixture'}
        def journal(args):
            calls.append(args)
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(row).encode())
        with patch.object(R, 'bounded_journal', side_effect=journal):
            signs = R.pending_journal(request, unit)
        self.assertEqual(signs, [{'category': 'certificate_shut', 'observedAtMs': 1791821800000}])
        self.assertNotIn('private', json.dumps(signs))
        self.assertIn('_SYSTEMD_INVOCATION_ID=' + '1' * 32, calls[-1])
        self.assertIn('_SYSTEMD_UNIT=' + calls[0][2], calls[-1])
        self.assertIn('--lines=12', calls[-1])
        for mutation in [{'_SYSTEMD_INVOCATION_ID': '2' * 32}, {'_SYSTEMD_UNIT': 'other.service'},
                         {'__REALTIME_TIMESTAMP': 'bad'}, {'MESSAGE': ['private']}]:
            with patch.object(R, 'bounded_journal', return_value=types.SimpleNamespace(returncode=0, stdout=json.dumps({**row, **mutation}).encode())), self.assertRaises(ValueError):
                R.pending_journal(request, unit)
        row['MESSAGE'] = 'arbitrary private message'
        with patch.object(R, 'bounded_journal', side_effect=journal):
            self.assertEqual(R.pending_journal(request, unit), [])

    def test_pending_native_files_refuse_links_fifo_changed_and_oversized_bytes(self):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            path = self.root / 'pending'
            self.assertIsNone(R.read_lines(fd, 'pending', optional=True))
            path.symlink_to(self.window)
            with self.assertRaises(OSError): R.read_lines(fd, 'pending', optional=True)
            path.unlink(); os.mkfifo(path)
            with self.assertRaises(ValueError): R.read_lines(fd, 'pending')
            path.unlink(); path.write_bytes(b'x' * 4097)
            with self.assertRaises(ValueError): R.read_lines(fd, 'pending')
            path.write_text('one\n'); path.chmod(0o644)
            with self.assertRaises(ValueError): R.read_lines(fd, 'pending')
            path.chmod(0o600)
            before = os.fstat
            calls = 0
            def changed(value):
                nonlocal calls
                row = before(value); calls += 1
                if calls == 2:
                    return types.SimpleNamespace(st_dev=row.st_dev, st_ino=row.st_ino, st_size=row.st_size,
                                                 st_mtime_ns=row.st_mtime_ns + 1, st_ctime_ns=row.st_ctime_ns,
                                                 st_uid=row.st_uid, st_gid=row.st_gid, st_mode=row.st_mode)
                return row
            with patch.object(R.os, 'fstat', side_effect=changed), self.assertRaises(ValueError):
                R.read_lines(fd, 'pending')
        finally:
            os.close(fd)

    def test_provenance_fixed_hash_only_census_covers_original_custody_modules(self):
        spec = importlib.util.spec_from_file_location('provenance', ROOT / 'scripts/ci/read-scoped-operator-hold-provenance.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        needed = {'engine/HandController.js', 'engine/HandContinuationLane.js',
            'engine/PrivateHandContinuation.js', 'engine/TimeBankEngine.js',
            'engine/DisconnectEngine.js', 'engine/ServerTableEngineTurns.js',
            'services/F06HandPermit.js', 'services/TournamentRetirementCustody.js',
            'services/supabase/handContinuation.js', 'services/supabase/snapshots.js'}
        self.assertTrue(needed <= set(module.FILES))
        self.assertEqual(len(module.FILES), 24)
        self.assertEqual(len(set(module.FILES)), 24)
        self.assertTrue(all(path.endswith('.js') and '..' not in path for path in module.FILES))
        self.assertNotIn('process.env', module.NODE_READ)
        self.assertIn("return {path,bytes:bytes.length,sha256:", module.NODE_READ)

    def test_selection_refuses_paths_commands_wrong_types_and_unbounded_ids(self):
        for request in [None, {}, {**REQUEST, 'command': 'cat /app/.env'},
                        {**REQUEST, 'runKey': '../../keys'}, {**REQUEST, 'runKey': '1;id-1'},
                        {**REQUEST, 'runKey': '1' * 100 + '-1'},
                        {**REQUEST, 'releaseSha': '$(id)'}, {**REQUEST, 'releaseSha': True}]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                R.selection(request)

    def test_wrong_window_run_sha_cause_time_or_extra_fields_fail_closed(self):
        for field, value in [('runId', '1-1'), ('sha', 'b' * 40), ('cause', 'missed-window'),
                             ('cause', None), ('announcedAt', True), ('announcedAt', -1)]:
            bad = {**WINDOW, field: value}
            self.window.write_text(json.dumps(bad))
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                R.remote(REQUEST)
        self.window.write_text(json.dumps({**WINDOW, 'arbitrary_detail': 'never export'}))
        with self.assertRaises(ValueError):
            R.remote(REQUEST)

    def test_wrong_terminal_run_sha_outcome_schema_or_outside_window_refused(self):
        for field, value in [('runId', '1-1'), ('sha', 'b' * 40), ('result', 'already-released'),
                             ('result', 'pending'), ('schema', True), ('completedAt', True),
                             ('completedAt', WINDOW['announcedAt']),
                             ('completedAt', (WINDOW['announcedAt'] + 119000) // 1000),
                             ('completedAt', (WINDOW['announcedAt'] + 421000) // 1000)]:
            self.result.write_text(json.dumps({**RESULT, field: value}))
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                R.remote(REQUEST)

    def test_all_named_causes_require_existing_seal_inside_window(self):
        for cause in sorted(R.CAUSES):
            self.window.write_text(json.dumps({**WINDOW, 'cause': cause}))
            self.assertEqual(R.remote(REQUEST)['cause'], cause)

    def test_missing_evidence_never_infers_ordinary_or_emergency_cause(self):
        self.window.unlink()
        with self.assertRaises(FileNotFoundError):
            R.remote(REQUEST)

    def test_malformed_duplicate_truncated_and_large_json_are_refused(self):
        for raw in [b'{', b'null', b'{"cause":"urgent","cause":"deadline"}', b'x' * 65537]:
            self.window.write_bytes(raw)
            with self.subTest(raw=raw[:20]), self.assertRaises((ValueError, json.JSONDecodeError)):
                R.remote(REQUEST)

    def test_symlink_file_and_directory_and_fifo_refused(self):
        self.window.unlink()
        self.window.symlink_to(self.result)
        with self.assertRaises(OSError):
            R.remote(REQUEST)
        self.window.unlink()
        os.mkfifo(self.window)
        with self.assertRaises(ValueError):
            R.remote(REQUEST)
        self.window.unlink()
        self.window.write_text(json.dumps(WINDOW))
        self.result.unlink()
        (self.root / 'engine-release-results').rmdir()
        (self.root / 'engine-release-results').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            R.remote(REQUEST)

    def test_changed_second_read_refused(self):
        original = R.read_json
        calls = 0

        def changed(fd, name):
            nonlocal calls
            value = original(fd, name)
            calls += 1
            if calls == 3:
                value['cause'] = 'deadline'
            return value

        with patch.object(R, 'read_json', changed), self.assertRaises(ValueError):
            R.remote(REQUEST)

    def test_unapproved_export_field_or_boolean_readonly_or_wrong_time_refused(self):
        answer = R.remote(REQUEST)
        for mutation in [{'raw': 'no'}, {'readOnly': False}, {'readOnly': 1}, {'windowEndsAtMs': 0}, {'cause': 'missed'},
                         {'emergencyBasisStatus': 'passed'}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.validate_reply({**answer, **mutation}, REQUEST)

    def test_event_and_scheduled_invocation_refuse_before_transport(self):
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'schedule'}), patch.object(R.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                R.main()
            run.assert_not_called()

    def test_actual_client_uses_pinned_fixed_command_and_cleans_private_transport(self):
        event = self.root / 'event.json'
        event.write_text(json.dumps({'action': 'audit-production-integrity',
                                    'client_payload': {'release_recovery_observation': REQUEST}}))
        answer = R.remote(REQUEST)
        calls = []

        def execute(args, **kwargs):
            calls.append(args)
            if args[0] == 'ssh-keygen':
                return types.SimpleNamespace(returncode=0)
            self.assertEqual(args[0], 'ssh')
            self.assertIn('StrictHostKeyChecking=yes', args)
            self.assertIn('GlobalKnownHostsFile=/dev/null', args)
            self.assertEqual(args[-2], 'root@configured.example')
            self.assertTrue(args[-1].startswith("python3 - --remote '"))
            encoded = args[-1].split("'")[1]
            self.assertEqual(json.loads(R.base64.b64decode(encoded)), REQUEST)
            self.assertEqual(kwargs['input'], Path(R.__file__).read_bytes())
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(answer).encode())

        environment = {'GITHUB_EVENT_NAME': 'repository_dispatch', 'GITHUB_EVENT_PATH': str(event),
                       'HETZNER_HOST': 'configured.example', 'HETZNER_SSH_PRIVATE_KEY': 'opaque-test-key',
                       'HETZNER_HOST_KEY': 'opaque-test-pin', 'RUNNER_TEMP': str(self.root)}
        old = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, environment), patch.object(R.subprocess, 'run', execute):
                R.main()
            exported = (self.root / 'artifacts/release-recovery-observation/observation.json').read_text()
            self.assertNotIn('opaque-test', exported)
            self.assertEqual(len(calls), 3)
            self.assertEqual(list(self.root.glob('release-recovery-read-*')), [])
        finally:
            os.chdir(old)

    def test_existing_workflow_reader_is_explicit_pinned_readonly_and_enforced(self):
        workflow = (ROOT / '.github/workflows/production-integrity-audit.yml').read_text()
        job = workflow.split('\n  scoped_release_recovery:', 1)[1].split('\n  scoped_operator_hold_image:', 1)[0]
        self.assertIn("github.event_name == 'repository_dispatch'", job)
        self.assertIn('github.event.client_payload.release_recovery_observation != null', job)
        self.assertIn('contents: read', job)
        self.assertNotIn('contents: write', job)
        self.assertIn('python3 -B tests/operations/release-recovery-read.test.py', job)
        self.assertIn('python3 -B scripts/ci/read-scoped-release-recovery.py', job)
        self.assertIn('actions/upload-artifact@v4', job)
        source = (ROOT / 'scripts/ci/read-scoped-release-recovery.py').read_text()
        self.assertIn('StrictHostKeyChecking=yes', source)
        self.assertIn("'_SYSTEMD_INVOCATION_ID=' + invocation", source)
        self.assertIn("'_SYSTEMD_UNIT=club-arena-engine-release-v1@' + request['runKey'] + '.service'", source)
        self.assertIn("'--lines=2'", source)
        self.assertIn('8193 - len(raw)', source)
        self.assertNotIn('shell=True', source)
        # This explicit inspector mode admits only immutable Docker reads and
        # its scalar-only helper, not lifecycle operations or a publisher.
        for forbidden in ["'restart'", "'stop'", "'kill'", "'rm'", "'run'"]:
            self.assertNotIn(forbidden, source[source.index('def inspector_identity'):source.index('def remote(')])
        for forbidden in ['Runtime.queryObjects', "SIGUSR1", 'inspector.close(', 'global.gc(', 'GameServer.']:
            self.assertNotIn(forbidden, R.INSPECTOR_NODE)
        self.assertEqual(R.INSPECTOR_NODE.count("method:'Runtime.evaluate'"), 1)
        self.assertIn("hostname:'127.0.0.1',port:9229", R.INSPECTOR_NODE)
        self.assertNotIn('process.env', R.INSPECTOR_NODE)
        # The only systemd operation is a bounded exact-unit metadata show.
        tree = ast.parse(source)
        lists = [node for node in ast.walk(tree) if isinstance(node, ast.List)
                 and node.elts and isinstance(node.elts[0], ast.Constant)
                 and node.elts[0].value == 'systemctl']
        self.assertEqual(len(lists), 1)
        self.assertEqual(lists[0].elts[1].value, 'show')
        self.assertIn('--property=ActiveState,SubState,InvocationID', source)

    def witness_fixture(self):
        invocation = 'd' * 32
        result = {**RESULT, 'invocationIds': [invocation],
                  'completionRuntime': {'invocationId': invocation}}
        row = {'__CURSOR': 's=abc;i=1;b=' + 'f' * 32, '__MONOTONIC_TIMESTAMP': '12345',
               '_BOOT_ID': 'f' * 32, 'MESSAGE': R.REASON_PREFIX + 'engine-degraded breaksSinceRestartCertified=1,liveness=dead',
               '_SYSTEMD_INVOCATION_ID': invocation,
               '_SYSTEMD_UNIT': 'club-arena-engine-release-v1@' + REQUEST['runKey'] + '.service',
               '__REALTIME_TIMESTAMP': str((WINDOW['announcedAt'] + 50) * 1000)}
        return result, row

    def test_actual_remote_handler_recovers_original_reason_without_raw_export(self):
        result, row = self.witness_fixture()
        self.result.write_text(json.dumps(result))
        before = R.observation(REQUEST, WINDOW, result)
        self.assertEqual(before['emergencyBasisStatus'], 'unknown_not_retained_in_selected_receipts')
        calls = []
        def journal(args):
            calls.append(args)
            self.assertIn('_SYSTEMD_INVOCATION_ID=' + row['_SYSTEMD_INVOCATION_ID'], args)
            self.assertIn('_SYSTEMD_UNIT=' + row['_SYSTEMD_UNIT'], args)
            self.assertIn('--lines=2', args)
            self.assertIn('--since=@' + str(WINDOW['announcedAt'] // 1000), args)
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(row).encode())
        with patch.object(R, 'bounded_journal', journal):
            after = R.remote(REQUEST)
        self.assertEqual(len(calls), 1)
        self.assertEqual(after['emergencyBasis']['signs'], {'breaksSinceRestartCertified': 1, 'liveness': 'dead'})
        self.assertEqual(after['emergencyBasisStatus'], 'retained_exact_invocation_producer_signs')
        self.assertNotIn('MESSAGE', json.dumps(after))
        self.assertNotIn('secret fixture', json.dumps(after))
        self.assertEqual(R.validate_reply(after, REQUEST), after)

    def test_real_v255_profile_passes_actual_handler_and_discards_sequence_metadata(self):
        result, row = self.witness_fixture()
        row.update({'__SEQNUM': '18446744073709551615', '__SEQNUM_ID': 'a' * 32})
        self.result.write_text(json.dumps(result))
        with patch.object(R, 'bounded_journal', return_value=types.SimpleNamespace(returncode=0, stdout=json.dumps(row).encode())):
            answer = R.remote(REQUEST)
        self.assertEqual(answer['emergencyBasis']['signs']['liveness'], 'dead')
        self.assertNotIn('__SEQNUM', json.dumps(answer))
        self.assertEqual(R.validate_reply(answer, REQUEST), answer)

    def test_sequence_pair_must_be_complete_typed_positive_uint64_and_native_id(self):
        result, row = self.witness_fixture()
        pair = {'__SEQNUM': '1', '__SEQNUM_ID': 'a' * 32}
        mutations = [{'__SEQNUM': '1'}, {'__SEQNUM_ID': 'a' * 32}]
        mutations += [{**pair, '__SEQNUM': x} for x in [0, True, [], '0', '-1', '01', '18446744073709551616', '1' * 21]]
        mutations += [{**pair, '__SEQNUM_ID': x} for x in [None, [], 'g' * 32, 'a' * 31]]
        mutations += [{**pair, 'secret': 'never-export'}]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.reason_from_rows(json.dumps({**row, **mutation}).encode(), REQUEST, WINDOW, result)

    def test_refusal_protocol_exports_only_literal_codes_never_exception_detail(self):
        for error, expected in [(ValueError('Recovery journal fields refused'), ('journal', 'fields_refused')),
                                (ValueError('/private/secret unknown'), ('remote', 'evidence_refused'))]:
            answer = R.refusal(REQUEST, error)
            refusal = R.validate_refusal(answer, REQUEST)
            self.assertEqual((refusal.phase, refusal.code), expected)
            self.assertNotIn('secret', json.dumps(answer))
        answer = R.refusal(REQUEST, ValueError('Recovery journal fields refused'))
        for mutation in [{'runKey': '1-1'}, {'releaseSha': 'b' * 40}, {'readOnly': 1},
                         {'schema': 'other'}, {'code': '/private/secret'}, {'phase': []},
                         {'raw': 'never export'}, {'phase': 'remote'}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.validate_refusal({**answer, **mutation}, REQUEST)

    def test_actual_remote_main_emits_only_bounded_refusal_on_native_failure(self):
        encoded = base64.b64encode(json.dumps(REQUEST).encode()).decode()
        output = io.StringIO()
        self.window.write_text(json.dumps({**WINDOW, 'secret': 'never-export'}))
        with patch.object(R.sys, 'argv', ['reader', '--remote', encoded]), contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as exit_code:
            R.main()
        self.assertEqual(exit_code.exception.code, 1)
        exported = json.loads(output.getvalue())
        self.assertNotIn('secret', output.getvalue())
        self.assertEqual(R.validate_refusal(exported, REQUEST).code, 'evidence_refused')

    def test_actual_client_rejects_untrusted_failure_output_and_preserves_scoped_code(self):
        event = self.root / 'event.json'
        event.write_text(json.dumps({'action': 'audit-production-integrity', 'client_payload': {'release_recovery_observation': REQUEST}}))
        environment = {'GITHUB_EVENT_NAME': 'repository_dispatch', 'GITHUB_EVENT_PATH': str(event),
                       'HETZNER_HOST': 'configured.example', 'HETZNER_SSH_PRIVATE_KEY': 'opaque-test-key',
                       'HETZNER_HOST_KEY': 'opaque-test-pin', 'RUNNER_TEMP': str(self.root)}
        known = R.refusal(REQUEST, ValueError('Recovery journal fields refused'))
        for payload, exception in [(json.dumps(known).encode(), R.ScopedRefusal),
                                   (b'raw private host failure', ValueError),
                                   (json.dumps({**known, 'releaseSha': 'b' * 40}).encode(), ValueError),
                                   (b'x' * 4097, ValueError)]:
            def execute(args, **kwargs):
                return types.SimpleNamespace(returncode=0) if args[0] == 'ssh-keygen' else types.SimpleNamespace(returncode=1, stdout=payload, stderr=b'never-export-secret')
            with patch.dict(os.environ, environment), patch.object(R.subprocess, 'run', execute), self.assertRaises(exception) as failed:
                R.main()
            self.assertNotIn('secret', str(failed.exception))
            self.assertEqual(list(self.root.glob('release-recovery-read-*')), [])

    def test_wrong_invocation_unit_time_cause_and_extra_journal_fields_refused(self):
        result, row = self.witness_fixture()
        for mutation in [{'_SYSTEMD_INVOCATION_ID': 'e' * 32}, {'_SYSTEMD_UNIT': 'other.service'},
                         {'__REALTIME_TIMESTAMP': str((WINDOW['announcedAt'] - 1) * 1000)},
                         {'__REALTIME_TIMESTAMP': str((WINDOW['announcedAt'] + 120001) * 1000)},
                         {'MESSAGE': R.REASON_PREFIX + 'deadline something'}, {'secret': 'never export'},
                         {'MESSAGE': R.REASON_PREFIX + 'engine-degraded liveness=dead,arbitrary=secret'}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.reason_from_rows(json.dumps({**row, **mutation}).encode(), REQUEST, WINDOW, result)

    def test_missing_journal_is_unknown_and_ambiguous_or_malformed_is_not_pass(self):
        result, row = self.witness_fixture()
        self.result.write_text(json.dumps(result))
        for reply in [types.SimpleNamespace(returncode=0, stdout=b''),
                      types.SimpleNamespace(returncode=1, stdout=b'private error')]:
            with patch.object(R, 'bounded_journal', return_value=reply):
                self.assertIsNone(R.remote(REQUEST)['emergencyBasis'])
        for raw in [b'{', json.dumps(row).encode() + b'\n' + json.dumps(row).encode(), b'x' * 8193]:
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                R.reason_from_rows(raw, REQUEST, WINDOW, result)

    def test_replay_invocation_and_corrupt_allowlist_refuse_before_journal(self):
        result, row = self.witness_fixture()
        for mutation in [{'invocationIds': ['e' * 32]}, {'invocationIds': ['d' * 32] * 2},
                         {'invocationIds': ['d' * 32, 'bad']},
                         {'completionRuntime': {'invocationId': 'e' * 32}}]:
            self.result.write_text(json.dumps({**result, **mutation}))
            with patch.object(R, 'bounded_journal') as journal, self.assertRaises(ValueError):
                R.remote(REQUEST)
            journal.assert_not_called()

    def test_sign_thresholds_types_duplicates_and_export_forgery_refused(self):
        result, row = self.witness_fixture()
        for tail in ['breaksSinceRestartCertified=0', 'tournamentManagersQuarantined=99',
                     'tournamentManagersQuarantined=2147483648', 'liveness=ok',
                     'wholeFleetStalled,wholeFleetStalled', 'liveness=dead,liveness=dead']:
            with self.subTest(tail=tail), self.assertRaises(ValueError):
                R.reason_from_rows(json.dumps({**row, 'MESSAGE': R.REASON_PREFIX + 'engine-degraded ' + tail}).encode(), REQUEST, WINDOW, result)
        answer = R.observation(REQUEST, WINDOW, result)
        with self.assertRaises(ValueError):
            R.validate_reply({**answer, 'emergencyBasisStatus': 'retained_exact_invocation_producer_signs'}, REQUEST)

    def test_bounded_native_process_never_collects_unbounded_journal(self):
        # Execute the actual bounded subprocess read in isolation; the host
        # selector is already pinned by the handler fixture above.
        reply = R.bounded_journal(['python3', '-c', 'print("native witness")'])
        self.assertEqual(reply.returncode, 0)
        self.assertEqual(reply.stdout, b'native witness\n')
        with self.assertRaises(ValueError):
            R.bounded_journal(['python3', '-c', 'print("x" * 9000)'])

    def test_actual_reservation_and_terminal_producer_contracts_stay_bound(self):
        tree = ast.parse((ROOT / 'server/scripts/engine-release-seal.py').read_text())
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        reserve = functions['cmd_reserve_recovery_window']
        dictionaries = [node for node in ast.walk(reserve) if isinstance(node, ast.Dict)]
        self.assertTrue(any({key.value for key in node.keys if isinstance(key, ast.Constant)} ==
                            {'runId', 'sha', 'announcedAt', 'cause'} for node in dictionaries))
        self.assertTrue(any(isinstance(node, ast.Call) and ast.unparse(node) == 'int(time.time() * 1000)'
                            for node in ast.walk(reserve)))
        # The terminal result owner must keep schema 1 and epoch-second completion.
        owners = [node for node in functions.values() if any(
            isinstance(child, ast.Dict) and any(isinstance(key, ast.Constant) and key.value == 'completionRuntime'
                                               for key in child.keys) for child in ast.walk(node))]
        self.assertTrue(owners)
        producer = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        self.assertIn('INVOCATION_ID="${INVOCATION_ID:-}"', producer)
        self.assertIn('off-cycle recovery window reason: $reason', producer)
        self.assertIn('--control-sha "$CONTROL_SHA" --invocation-id "$INVOCATION_ID"', producer)
        # Historical journal witnesses above retain their original signs; the
        # current producer must not promote a missed certificate to an emergency.
        reason = producer[producer.index('recovery_window_reason() {'):producer.index('newer_release_in_flight() {')]
        self.assertNotIn('breaksSinceRestartCertified', reason)
        self.assertIn('RECOVERY_QUARANTINED_MANAGERS=100', producer)
        wrapper = (ROOT / 'server/scripts/engine-release-unit-wrapper.sh').read_text()
        self.assertIn('env ENGINE_CONTROL_DIR="$GENERATION"', wrapper)
        self.assertIn('"$GENERATION/engine-release-transaction.sh" --run-id "$RUN_KEY"', wrapper)
        for owner in owners:
            results = [node for node in ast.walk(owner) if isinstance(node, ast.Dict) and
                       any(isinstance(key, ast.Constant) and key.value == 'completedAt' for key in node.keys)]
            self.assertTrue(results)
            for result in results:
                fields = {key.value: value for key, value in zip(result.keys, result.values)
                          if isinstance(key, ast.Constant)}
                self.assertEqual(ast.literal_eval(fields['schema']), 1)
                self.assertEqual(ast.unparse(fields['completedAt']), 'int(time.time())')




class InspectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='owned-inspector-', dir=ROOT.parent)
        self.root = Path(self.temp.name)
        d = self.root / 'engine-release-requests'; d.mkdir(); self.d = d
        self.request = {**REQUEST, 'mode': 'legacy_checkpoint_inspector'}
        self.intent = {'instance':'1-1234abcd','container':'c'*64,'startedAt':'2026-10-29T20:00:00.000Z',
            'hostPid':1234,'source':R.EED,'runId':REQUEST['runKey'],'controlSha':'b'*40,'at':1793307300.0,'retryAllowed':False}
        self.identity = {'container':'c'*64,'image':'sha256:'+'d'*64,'running':'true',
            'startedAt':self.intent['startedAt'],'hostPid':'1234','restarts':'0'}
        self.health = {'source':R.EED,'instance':self.intent['instance']}
        self.url = 'ws://127.0.0.1:9229/12345678-1234-1234-1234-123456789abc'
        self.digest = R.hashlib.sha256(self.url.encode()).hexdigest()
        self.native = {'pid':1,'usedHeapBytes':100000000,'availableHeapBytes':200000000,
            'heapLimitBytes':4000000000,'availableProcessBytes':1000000000}
        self.write_intent()
        rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
            'private actor', '/usr/local/lib/club-arena/engine-control-generations/'+'b'*40,'b'*40,'1793399999']
        for suffix in ['.request','.intent']:
            p=d/(REQUEST['runKey']+suffix);p.write_text('\n'.join(rows)+'\n');p.chmod(0o600)
        self.patches = [patch.object(R,'STATE_ROOT',self.root),patch.object(R,'inspector_identity',return_value=self.identity),
            patch.object(R,'inspector_health',return_value=self.health)]
        for p in self.patches:p.start()
        self.calls=[]
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def write_intent(self):
        self.path=self.d/(REQUEST['runKey']+'.legacy-checkpoint-intent')
        self.path.write_text(json.dumps(self.intent));self.path.chmod(0o600)
    def command(self,args,deadline,**kwargs):
        self.calls.append(args)
        if args[1:3]==['image','inspect']:return (R.EED+'\n').encode()
        if args[1]=='logs':return ('2026-10-29T20:55:01.000000000Z Debugger listening on '+self.url+'\nprivate ignored log\n').encode()
        raise AssertionError(args)
    def run_probe(self, probes):
        with patch.object(R,'inspector_command',side_effect=self.command),patch.object(R,'inspector_probe',side_effect=probes) as probe:
            result=R.remote(self.request)
        self.assertEqual(R.validate_reply(result,self.request),result)
        return result,probe
    def test_closed_proves_only_absence_without_logs_or_websocket(self):
        v,p=self.run_probe([{'state':'closed','endpointSha256':None}])
        self.assertEqual(v['status'],'closed');self.assertIsNone(v['nativeMemory']);self.assertEqual(p.call_count,1)
        self.assertFalse(any(x[1]=='logs' for x in self.calls))
    def test_owned_exact_original_endpoint_exports_only_scalar_provenance(self):
        v,p=self.run_probe([{'state':'open','endpointSha256':self.digest},{'state':'owned','endpointSha256':self.digest,'native':self.native}])
        self.assertEqual(v['status'],'owned');self.assertTrue(v['nativeMemory']['predicateSatisfied'])
        self.assertEqual(p.call_args.args[-1],self.digest)
        for text in [self.url,'private','1234','c'*64,'/app']:
            if text=='1234':continue
            self.assertNotIn(text,json.dumps(v))
        self.assertEqual(v['readiness'],'unknown_not_certified_by_metadata')
    def test_foreign_endpoint_never_attaches(self):
        v,p=self.run_probe([{'state':'open','endpointSha256':'e'*64}]);self.assertEqual(v['status'],'foreign');self.assertEqual(p.call_count,1)
    def test_foreign_client_never_exports_memory(self):
        v,_=self.run_probe([{'state':'open','endpointSha256':self.digest},{'state':'foreign','endpointSha256':self.digest}]);self.assertEqual(v['reason'],'established_inspector_client');self.assertIsNone(v['nativeMemory'])
    def test_missing_log_is_unproved_and_never_attaches(self):
        with patch.object(R,'inspector_endpoint',side_effect=ValueError('missing')):
            v,p=self.run_probe([{'state':'open','endpointSha256':self.digest}])
        self.assertEqual(v['status'],'unproved');self.assertEqual(v['reason'],'historical_endpoint_unavailable');self.assertEqual(p.call_count,1)
    def test_missing_intent_is_refused_not_empty(self):
        self.path.unlink()
        with self.assertRaises(R.ScopedRefusal) as caught:R.remote(self.request)
        self.assertEqual((caught.exception.phase,caught.exception.code),('inspector','intent_unavailable'))
    def test_intent_candidate_control_and_original_identity_mismatch_refuse(self):
        for key,value in [('runId','1-1'),('source','a'*40),('controlSha','e'*40),('retryAllowed',True),('hostPid',True),('at',float('nan'))]:
            original=dict(self.intent);self.intent[key]=value;self.write_intent()
            with self.subTest(key=key),self.assertRaises(ValueError):R.remote(self.request)
            self.intent=original
        self.write_intent()
    def test_changed_identity_rejects_even_closed_result(self):
        with patch.object(R,'inspector_identity',side_effect=[self.identity,{**self.identity,'hostPid':'5678'}]),self.assertRaises(ValueError):
            self.run_probe([{'state':'closed','endpointSha256':None}])
    def test_permissions_and_symlink_intent_refused(self):
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):R.remote(self.request)
        self.path.unlink();self.path.symlink_to(self.d/'other')
        with self.assertRaises(R.ScopedRefusal):R.remote(self.request)
    def test_historical_exact_line_ambiguous_foreign_oversize_and_time(self):
        line=('2026-10-29T20:55:01Z Debugger listening on '+self.url+'\n').encode()
        self.assertEqual(R.inspector_endpoint(line,self.intent['at']),self.digest)
        for raw in [b'',line+line,line.replace(b'127.0.0.1',b'evil.local'),b'x'*65537,line.replace(b'20:55:01',b'20:56:01')]:
            with self.subTest(raw=raw[:40]),self.assertRaises(ValueError):R.inspector_endpoint(raw,self.intent['at'])
    def test_missing_nonfinite_wrong_pid_and_overflow_memory_refuse(self):
        for key,value in [('pid',2),('pid',True),('availableProcessBytes',None),('usedHeapBytes',float('inf')),('availableHeapBytes',-1),('usedHeapBytes',9007199254740991)]:
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):R.inspector_memory({**self.native,key:value})
    def test_predicate_boundary_is_exact_32MiB_8x_but_not_readiness(self):
        n={**self.native,'availableHeapBytes':133554432,'availableProcessBytes':833554432}
        self.assertTrue(R.inspector_memory(n)['predicateSatisfied'])
        for key in ['availableHeapBytes','availableProcessBytes']:
            self.assertFalse(R.inspector_memory({**n,key:n[key]-1})['predicateSatisfied'])
    def test_scalar_forgery_extra_fields_and_unknown_as_owned_refused(self):
        v,_=self.run_probe([{'state':'closed','endpointSha256':None}])
        for change in [{'nativeMemory':self.native},{'status':'owned'},{'endpointSha256':self.digest},{'raw':'private'},{'readiness':'ready'},{'originalSourceSha':None},{'reason':'evidence_unavailable'}]:
            with self.subTest(change=change),self.assertRaises(ValueError):R.validate_reply({**v,**change},self.request)
    def test_bounded_native_child_deadline_and_oversize(self):
        with self.assertRaises(ValueError):R.inspector_command(['python3','-c','print("x"*1000)'],R.time.monotonic()+2,limit=100)
        with self.assertRaises(ValueError):R.inspector_command(['python3','-c','import time;time.sleep(1)'],R.time.monotonic()+.02)
    def test_probe_closed_unknown_and_native_payload_bound(self):
        for row in [{'state':'closed','endpointSha256':'a'*64},{'state':'open','endpointSha256':None},{'state':'whatever','endpointSha256':None},{'state':'owned','endpointSha256':'a'*64,'native':{},'raw':'private'}]:
            with patch.object(R,'inspector_command',return_value=json.dumps(row).encode()),self.subTest(row=row),self.assertRaises(ValueError):R.inspector_probe('c'*64,123)


    def test_inspector_known_boundaries_roundtrip_remote_refusal_without_private_text(self):
        # Exercise the actual remote selection and final refusal validator;
        # only maintained literal boundary messages may acquire typed codes.
        known = {message: code for message, (phase, code) in R.REFUSALS.items()
                 if phase == 'inspector'}
        self.assertEqual(len(known), 27)
        for message, code in known.items():
            with self.subTest(code=code), patch.object(R, 'inspector_remote', side_effect=ValueError(message)):
                with self.assertRaises(ValueError) as caught:
                    R.remote(self.request)
                exported = R.refusal(self.request, caught.exception)
                validated = R.validate_refusal(exported, self.request)
                self.assertEqual((validated.phase, validated.code), ('inspector', code))
                self.assertNotIn(message, json.dumps(exported))
                self.assertEqual(set(exported), {'schema','readOnly','runKey','releaseSha','mode','phase','code'})
        with patch.object(R, 'inspector_remote', side_effect=ValueError('/private/raw stderr secret')):
            with self.assertRaises(ValueError) as caught:
                R.remote(self.request)
            exported = R.refusal(self.request, caught.exception)
            self.assertEqual(R.validate_refusal(exported,self.request).code, 'evidence_refused')
            self.assertNotIn('secret', json.dumps(exported))

    def test_literal_command_stages_roundtrip_without_exporting_arguments(self):
        for stage in R.INSPECTOR_COMMAND_STAGES:
            for message, code in R.INSPECTOR_COMMAND_ERRORS.items():
                with self.subTest(stage=stage, code=code), patch.object(R, '_inspector_command', side_effect=ValueError(message)):
                    with patch.object(R, 'inspector_remote', side_effect=lambda *args: R.inspector_command(['private command secret'],123,stage=stage)):
                        with self.assertRaises(R.ScopedRefusal) as caught:
                            R.remote(self.request)
                    exported = R.refusal(self.request,caught.exception)
                    answer = R.validate_refusal(exported,self.request)
                    self.assertEqual((answer.phase,answer.code),('inspector_'+stage,code))
                    self.assertNotIn('private',json.dumps(exported))
        with patch.object(R,'_inspector_command') as child, self.assertRaises(ValueError):
            R.inspector_command(['secret'],123,stage='unreviewed_private')
        child.assert_not_called()

    def test_native_child_idle_poll_is_not_the_absolute_deadline(self):
        # A real child stays silent past the old three-second polling slice.
        started = R.time.monotonic()
        raw = R.inspector_command([R.sys.executable, '-c',
            'import time;time.sleep(3.1);print("bounded reply")'], started + 6)
        self.assertEqual(raw, b'bounded reply\n')
        self.assertGreaterEqual(R.time.monotonic() - started, 3.1)
        self.assertLess(R.time.monotonic() - started, 6)

    def test_native_command_refusals_roundtrip_deadline_size_and_nonzero(self):
        for code, command, seconds, limit in [
            ('command_deadline', 'import time;time.sleep(2)', .05, 100),
            ('command_size', 'print("x"*1000)', 2, 100),
            ('command_nonzero', 'import sys;sys.stderr.write("private secret");sys.exit(7)', 2, 100),
        ]:
            with self.subTest(code=code), self.assertRaises(ValueError) as caught:
                R.inspector_command([R.sys.executable, '-c', command], R.time.monotonic()+seconds, limit=limit)
            exported = R.refusal(self.request, caught.exception)
            self.assertEqual(R.validate_refusal(exported,self.request).code, code)
            self.assertNotIn('private',json.dumps(exported))

    def test_actual_native_scalar_read_and_proxy_environment_independence(self):
        # Actual native inspector evaluation in an isolated child. Linux PID 1
        # binding is separately pinned in the maintained transport; this local
        # process deliberately is not a production container or target.
        import re
        expression = re.search(r'const evaluate="(.*)";', R.INSPECTOR_NODE)[1]
        script = "import inspector from 'node:inspector';const s=new inspector.Session();s.connect();s.post('Runtime.evaluate'," + json.dumps({'expression':expression,'returnByValue':True,'timeout':500}) + ",(e,r)=>{if(e||r.exceptionDetails)process.exitCode=1;else console.log(JSON.stringify(r.result.value));s.disconnect()});"
        node = os.environ.get('RELEASE_RECOVERY_TEST_NODE', 'node')
        reply = R.subprocess.run([node,'--input-type=module','-e',script],capture_output=True,timeout=5,
            env={**os.environ,'HTTP_PROXY':'http://invalid.example:1','HTTPS_PROXY':'http://invalid.example:1','ALL_PROXY':'http://invalid.example:1'})
        self.assertEqual(reply.returncode,0,reply.stderr)
        value=json.loads(reply.stdout);self.assertGreater(value['pid'],0)
        self.assertTrue(all(type(v) is int and v>0 for v in value.values()))
        self.assertIn("agent:false,timeout:1000",R.INSPECTOR_NODE)
        self.assertNotIn('fetch(',R.INSPECTOR_NODE)
        self.assertIn("socket.close()",R.INSPECTOR_NODE)
        self.assertNotIn('node:inspector',R.INSPECTOR_NODE.split('finally{')[0])
        self.assertIn("if(connections()!==0)",R.INSPECTOR_NODE)
        self.assertIn("if(connections()!==1)",R.INSPECTOR_NODE)
        self.assertIn("Buffer.byteLength(event.data)>4096",R.INSPECTOR_NODE)
        self.assertIn("setTimeout(()=>reject(Error('deadline')),1500)",R.INSPECTOR_NODE)
        self.assertIn("if(await target()!==url||connections()!==1)",R.INSPECTOR_NODE)


    def test_actual_bounded_http_and_websocket_scalar_transport(self):
        # Real inspector HTTP/WS in our own tiny child; fixture substitutes the
        # ephemeral port/PID and Linux socket-table seam only. No live target.
        import re
        node=os.environ.get('RELEASE_RECOVERY_TEST_NODE', 'node')
        target=R.subprocess.Popen([node,'--input-type=module','-e',
            "import inspector from 'node:inspector';inspector.open(0,'127.0.0.1');console.log(JSON.stringify({url:inspector.url(),pid:process.pid}));process.stdin.resume();"],
            stdin=R.subprocess.PIPE,stdout=R.subprocess.PIPE,stderr=R.subprocess.DEVNULL)
        try:
            with R.selectors.DefaultSelector() as selector:
                selector.register(target.stdout,R.selectors.EVENT_READ)
                self.assertTrue(selector.select(2),'isolated target startup deadline')
                selected=json.loads(target.stdout.readline())
            port=int(selected['url'].split(':')[2].split('/')[0])
            source=R.INSPECTOR_NODE.replace(':9229',':'+str(port)).replace('v?.pid!==1','v?.pid!=='+str(selected['pid']))
            source=re.sub(r'const connections=\(\)=>\{.*?\n\};', 'let nativeConnectionReads=0;const connections=()=>Math.min(nativeConnectionReads++,1);',source,flags=re.S)
            digest=R.hashlib.sha256(selected['url'].encode()).hexdigest()
            reply=R.subprocess.run([node,'--experimental-websocket','--input-type=module','-','read',digest],input=source.encode(),capture_output=True,timeout=5,
                env={**os.environ,'HTTP_PROXY':'http://invalid.example:1','ALL_PROXY':'http://invalid.example:1'})
            self.assertEqual(reply.returncode,0,reply.stderr)
            value=json.loads(reply.stdout)
            self.assertEqual(value['state'],'owned');self.assertEqual(value['native']['pid'],selected['pid'])
            self.assertEqual(value['endpointSha256'],digest)
            self.assertGreater(value['native']['usedHeapBytes'],0)
            self.assertIsNone(target.poll(),'reader must not stop its target')
        finally:
            target.kill();target.wait(timeout=2);target.stdin.close();target.stdout.close()


    def retired(self):
        for suffix in ['.request','.intent']:(self.d/(REQUEST['runKey']+suffix)).unlink()
        directory=self.root/'engine-release-results';directory.mkdir()
        self.receipt=directory/(REQUEST['runKey']+'.json')
        self.failed={'schema':1,'runId':REQUEST['runKey'],'result':'failed','sha':REQUEST['releaseSha'],
            'controlSha':self.intent['controlSha'],'invocationId':'f'*32,'transactionExitStatus':1,
            'recoveredDesiredSha':R.EED,'recoveredDesiredImageId':self.identity['image'],'completedAt':int(self.intent['at'])+30}
        self.write_failed()
    def write_failed(self):
        self.receipt.write_text(json.dumps(self.failed));self.receipt.chmod(0o600)
    def test_retired_failure_preserves_original_closed_and_owned_read(self):
        self.retired()
        v,_=self.run_probe([{'state':'closed','endpointSha256':None}]);self.assertEqual(v['status'],'closed')
        v,_=self.run_probe([{'state':'open','endpointSha256':self.digest},{'state':'owned','endpointSha256':self.digest,'native':self.native}]);self.assertEqual(v['status'],'owned')
        self.assertNotIn('invocationId',json.dumps(v));self.assertNotIn('transactionExitStatus',json.dumps(v))
    def test_retired_missing_receipt_refuses_before_any_probe(self):
        self.retired();self.receipt.unlink()
        with patch.object(R,'inspector_probe') as probe,self.assertRaises(R.ScopedRefusal):R.remote(self.request)
        probe.assert_not_called()
    def test_retired_wrong_control_target_and_desired_refuse(self):
        self.retired()
        for key,value in [('controlSha','e'*40),('sha','e'*40),('runId','1-1'),('recoveredDesiredSha','e'*40),('result','sealed')]:
            original=dict(self.failed);self.failed[key]=value;self.write_failed()
            with patch.object(R,'inspector_probe') as probe,self.subTest(key=key),self.assertRaises(R.ScopedRefusal):R.remote(self.request)
            probe.assert_not_called();self.failed=original
    def test_retired_wrong_image_and_failure_metadata_refuse(self):
        self.retired()
        for key,value in [('recoveredDesiredImageId','sha256:'+'e'*64),('schema',True),('transactionExitStatus',0),('transactionExitStatus',True),('invocationId','bad'),('completedAt',self.intent['at']-1),('completedAt',4102444800),('raw','private')]:
            original=dict(self.failed);self.failed[key]=value;self.write_failed()
            with patch.object(R,'inspector_probe') as probe,self.subTest(key=key),self.assertRaises(R.ScopedRefusal):R.remote(self.request)
            probe.assert_not_called();self.failed=original
    def test_partial_request_records_never_fall_back_to_valid_failure(self):
        self.retired()
        for suffix in ['.request','.intent']:
            path=self.d/(REQUEST['runKey']+suffix);path.write_text('private invalid retained record');path.chmod(0o600)
            with patch.object(R,'inspector_probe') as probe,self.subTest(suffix=suffix),self.assertRaises(R.ScopedRefusal):R.remote(self.request)
            probe.assert_not_called();path.unlink()
    def test_changed_retired_receipt_invalidates_closed_observation(self):
        self.retired()
        def change(*args):
            self.failed['invocationId']='e'*32;self.write_failed()
            return {'state':'closed','endpointSha256':None}
        with patch.object(R,'inspector_command',side_effect=self.command),patch.object(R,'inspector_probe',side_effect=change),self.assertRaises(R.ScopedRefusal) as caught:R.remote(self.request)
        self.assertEqual(caught.exception.code,'identity_changed')
    def test_retired_receipt_permissions_symlinks_and_oversize_refuse(self):
        self.retired();self.receipt.chmod(0o644)
        with self.assertRaises(R.ScopedRefusal):R.remote(self.request)
        self.write_failed();self.receipt.write_text('x'*65537)
        with self.assertRaises(R.ScopedRefusal):R.remote(self.request)
        self.receipt.unlink();self.receipt.symlink_to(self.path)
        with self.assertRaises(R.ScopedRefusal):R.remote(self.request)


if __name__ == '__main__':
    unittest.main()
