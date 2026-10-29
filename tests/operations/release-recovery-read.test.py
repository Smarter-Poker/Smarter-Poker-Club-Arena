#!/usr/bin/env python3
"""Actual fixed file reader on isolated native files; no host or provider calls."""
import importlib.util
import inspect
import base64
import contextlib
import io
import ast
import json
import os
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
        self.assertNotIn('docker', source)
        # The sealed reader still has no unit-control or unit-state branch.
        # The separately admitted active mode qualifies its fixed show argv.
        self.assertNotIn('systemctl', inspect.getsource(R.remote))

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


if __name__ == '__main__':
    unittest.main()
