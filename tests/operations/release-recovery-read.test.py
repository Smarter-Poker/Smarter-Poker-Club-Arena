#!/usr/bin/env python3
"""Actual fixed file reader on isolated native files; no host or provider calls."""
import importlib.util
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
        self.assertNotIn('journalctl', source)
        self.assertNotIn('docker', source)
        self.assertNotIn('systemctl', source)

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
