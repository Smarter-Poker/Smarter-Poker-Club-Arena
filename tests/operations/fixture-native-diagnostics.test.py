import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('fixture_smoke', ROOT / 'operations/release/ci/fixture-smoke.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NativeDiagnosticsTests(unittest.TestCase):
    def test_auth_diagnostics_accept_only_fixed_stages_and_http_status(self):
        row = {'status':'failed', 'stage':'gotrue-real-mfa-enrollment', 'error':'Error',
               'auth_stage':'mfa-verify', 'auth_http_status':422}
        self.assertEqual(m.native_failures(json.dumps(row)), [{
            'stage':row['stage'], 'category':'Error', 'auth_stage':'mfa-verify', 'auth_http_status':422}])
        for invalid in [99, 600, '422', True, None, [], 400.5]:
            self.assertEqual(m.native_failures(json.dumps({**row, 'auth_http_status':invalid})), [])
        for invalid in ['PRIVATE TOKEN', 'mfa-verify\n', True, None, []]:
            self.assertEqual(m.native_failures(json.dumps({**row, 'auth_stage':invalid})), [])

    def test_native_command_diagnostics_are_strict_and_bounded(self):
        row = {'status': 'failed', 'stage': 'gotrue-migrate-command', 'error': 'Error',
               'exit_code': 1, 'command_phase': 'auth-connect', 'command_sqlstate': '42501'}
        self.assertEqual(m.native_failures(json.dumps(row)), [{
            'stage': row['stage'], 'category': 'Error', 'exit_code': 1,
            'command_phase': 'auth-connect', 'command_sqlstate': '42501'}])
        for invalid in [True, None, '1', 0, 256, 1.5, ['1']]:
            self.assertEqual(m.native_failures(json.dumps({**row, 'exit_code': invalid})), [])
        for key in ['command_phase', 'command_sqlstate']:
            for invalid in ['PRIVATE CREDENTIAL', None, [], True]:
                self.assertEqual(m.native_failures(json.dumps({**row, key: invalid})), [])
        self.assertEqual(m.native_failures(json.dumps({**row, 'stderr': 'PRIVATE'})), [])

    def test_actual_node_failure_survives_private_child_capture(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / m.PREFIX / 'smoke-image.sh'
            script.parent.mkdir(parents=True)
            child = root / 'diagnostic.mjs'
            module = (ROOT / 'operations/release/fixture/runtime-files.mjs').as_uri()
            child.write_text('import {nativeFailureDiagnostic} from ' + json.dumps(module) + ';\n'
                             'console.error("PRIVATE SERVICE CREDENTIAL");\n'
                             'console.error(JSON.stringify(nativeFailureDiagnostic("postgresql-bootstrap-roles",'
                             '{name:"error",code:"42710",position:"194",message:"PRIVATE PASSWORD"})));\n'
                             'process.exitCode=1;\n')
            script.write_text('exec node diagnostic.mjs\n')
            with self.assertRaises(m.NativeSmokeFailure) as caught:
                m.command(['bash', m.PREFIX + 'smoke-image.sh'], root, {'PATH': os.environ['PATH']})
            self.assertEqual(caught.exception.diagnostics, [{
                'stage': 'postgresql-bootstrap-roles', 'category': 'error', 'sqlstate': '42710', 'position': 194,
            }])
            self.assertNotIn('PRIVATE', repr(vars(caught.exception)))

    def test_malformed_or_extra_error_data_is_refused(self):
        valid = {'status': 'failed', 'stage': 'postgresql-extension-vector', 'error': 'error', 'sqlstate': '58P01'}
        rows = [{**valid, 'message': 'PRIVATE SQL'}, {**valid, 'sqlstate': 'SECRET TOKEN'},
                {**valid, 'sqlstate': '42P01\n'}, {**valid, 'sqlstate': ['42P01']},
                {**valid, 'error': 'Error'}, {**valid, 'error': ['error']},
                {**valid, 'stage': 'PRIVATE TOKEN'}]
        rows += [{**valid, 'position': value} for value in [True, False, 0, -1, 1000000, 1.5, '1', ['1'], None]]
        self.assertEqual(m.native_failures('\n'.join(map(json.dumps, rows))), [])
        self.assertEqual(m.native_failures(json.dumps(valid)), [{
            'stage': valid['stage'], 'category': 'error', 'sqlstate': '58P01',
        }])

    def test_only_allowlisted_postgres_routines_can_be_retained(self):
        row = {'status': 'failed', 'stage': 'postgresql-wal2json-native-slot', 'error': 'error',
               'sqlstate': '42501', 'routine': 'CreateSlotOnDisk'}
        self.assertEqual(m.native_failures(json.dumps(row)), [{
            'stage': row['stage'], 'category': 'error', 'sqlstate': '42501', 'routine': 'CreateSlotOnDisk',
        }])
        for routine in ['PRIVATE SQL', ['CreateSlotOnDisk'], None, 'CreateSlotOnDisk\n']:
            self.assertEqual(m.native_failures(json.dumps({**row, 'routine': routine})), [])
        row['routine_sha256'] = 'a' * 64
        row['file_sha256'] = 'b' * 64
        self.assertEqual(m.native_failures(json.dumps(row))[0]['routine_sha256'], 'a' * 64)
        for invalid in ['PRIVATE FILE', 'a' * 63, 'A' * 64, ['b' * 64], None]:
            self.assertEqual(m.native_failures(json.dumps({**row, 'file_sha256': invalid})), [])

    def test_native_source_line_is_numeric_and_bounded(self):
        row = {'status': 'failed', 'stage': 'postgresql-start', 'error': 'AssertionError', 'native_line': 324}
        self.assertEqual(m.native_failures(json.dumps(row)), [{
            'stage': row['stage'], 'category': 'AssertionError', 'native_line': 324,
        }])
        for invalid in [True, None, '324', 0, 10000, ['324'], 'PRIVATE STACK']:
            self.assertEqual(m.native_failures(json.dumps({**row, 'native_line': invalid})), [])


if __name__ == '__main__':
    unittest.main()
