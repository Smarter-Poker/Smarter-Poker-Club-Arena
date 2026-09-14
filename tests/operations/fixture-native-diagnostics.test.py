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
    def test_shell_and_preimage_steps_accept_only_fixed_categories(self):
        for stage in ['smoke-shell-preimage-copy', 'fixture-preimage-package']:
            row = dict(status='failed', stage=stage, error='Error', exit_code=7)
            self.assertEqual(m.native_failures(json.dumps(row)), [dict(stage=stage, category='Error', exit_code=7)])
            for edit in [dict(stage=stage + '-PRIVATE'), dict(exit_code=True), dict(exit_code=256),
                         dict(exit_code=0), dict(exit_code='7'), dict(command='PRIVATE TOKEN'),
                         dict(stderr='PRIVATE TOKEN')]:
                self.assertEqual(m.native_failures(json.dumps({**row, **edit})), [])

    def test_realtime_database_error_categories_cannot_export_log_text(self):
        row = {'status': 'failed', 'stage': 'realtime-postgres-subscription', 'error': 'Error',
               'realtime_log_markers': 0, 'realtime_frames': [],
               'realtime_database_errors': ['insufficient_privilege', 'undefined_column']}
        self.assertEqual(m.native_failures(json.dumps(row))[0]['realtime_database_errors'],
                         row['realtime_database_errors'])
        for value in [[], None, 'PRIVATE SQL', ['PRIVATE ROLE'], ['insufficient_privilege'] * 2,
                      [True], [[]], ['undefined_column\n']]:
            self.assertEqual(m.native_failures(json.dumps({**row, 'realtime_database_errors': value})), [])
        self.assertEqual(m.native_failures(json.dumps({**row, 'query': 'PRIVATE SQL'})), [])

    def test_realtime_crash_diagnostics_are_bounded_and_never_raw_text(self):
        row = {'status':'failed', 'stage':'realtime-server-ready', 'error':'Error',
               'realtime_log_markers': (2 ** 22) - 1, 'realtime_frames':['a' * 64 + ':42']}
        self.assertEqual(m.native_failures(json.dumps(row)), [{
            'stage':row['stage'], 'category':'Error', 'realtime_log_markers':row['realtime_log_markers'],
            'realtime_frames':row['realtime_frames']}])
        for value in [2 ** 22, -1, True, None, '1']:
            self.assertEqual(m.native_failures(json.dumps({**row, 'realtime_log_markers':value})), [])
        for value in ['PRIVATE', None, ['private.ex:42'], ['a' * 64 + ':0'], ['a' * 64 + ':42'] * 9]:
            self.assertEqual(m.native_failures(json.dumps({**row, 'realtime_frames':value})), [])
        self.assertEqual(m.native_failures(json.dumps({**row, 'stderr':'PRIVATE'})), [])

    def test_native_service_exit_diagnostics_are_strict(self):
        row={'status':'failed', 'stage':'realtime-server-ready', 'error':'Error',
             'native_service':'realtime', 'service_signal':'SIGKILL', 'service_oom_kills':1}
        self.assertEqual(m.native_failures(json.dumps(row)), [{
            'stage':row['stage'], 'category':'Error', 'native_service':'realtime',
            'service_signal':'SIGKILL', 'service_oom_kills':1}])
        for key in ['native_service', 'service_signal']:
            for invalid in ['PRIVATE TOKEN', [], None, True]:
                self.assertEqual(m.native_failures(json.dumps({**row, key:invalid})), [])
        for key, limit in [('service_exit_code',255),('service_oom_kills',999999999)]:
            for invalid in [-1,limit+1,True,None,'1',[]]:
                self.assertEqual(m.native_failures(json.dumps({**row,key:invalid})), [])

    def test_listener_diagnostics_reject_unreviewed_reasons_and_counts(self):
        row = {'status': 'failed', 'stage': 'realtime-loopback-and-gateway', 'error': 'Error',
               'listener_reason': 'listener-set', 'listener_loopback4': 0,
               'listener_other4': 1, 'listener_ipv6': 0,
               'listener_rows4': 20, 'listener_rows6': 0, 'listener_port4000': 3,
               'listener_http_port': 4000, 'listener_http_address': 'ipv4-loopback'}
        self.assertEqual(m.native_failures(json.dumps(row)), [{
            'stage': row['stage'], 'category': 'Error', 'listener_reason': 'listener-set',
            'listener_loopback4': 0, 'listener_other4': 1, 'listener_ipv6': 0,
            'listener_rows4': 20, 'listener_rows6': 0, 'listener_port4000': 3,
            'listener_http_port': 4000, 'listener_http_address': 'ipv4-loopback'}])
        for field in ['listener_loopback4', 'listener_other4', 'listener_ipv6',
                      'listener_rows4', 'listener_rows6', 'listener_port4000', 'listener_http_port']:
            for invalid in [-1, 65536, '1', True, None, [], 1.5]:
                self.assertEqual(m.native_failures(json.dumps({**row, field: invalid})), [])
        for invalid in ['PRIVATE ADDRESS', 'header\n', True, None, []]:
            self.assertEqual(m.native_failures(json.dumps({**row, 'listener_reason': invalid})), [])
            self.assertEqual(m.native_failures(json.dumps({**row, 'listener_http_address': invalid})), [])
        self.assertEqual(m.native_failures(json.dumps({**row, 'address': 'PRIVATE'})), [])

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
            self.assertEqual(caught.exception.exit_code, 1)

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
