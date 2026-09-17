"""Source-specific hosted adapter controls; not native financial qualification.

The normal wrapper runs these controls before its two authentic PG17 images.
No successful mocked protocol receipt establishes that SQL or refunds passed.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('spin_expiry_pg_wrapper', Path(__file__).with_name('test-spin-expiry-postgres.py'))
W = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(W)
EXECUTION = '00000000-0000-4000-8000-000000000001'
ORDINARY = '00000000-0000-4000-8000-000000000002'
TOURNAMENT = '00000000-0000-4000-8000-000000000003'
MANIFEST_SHA = 'b' * 64
PG = Path('/usr/lib/postgresql/17/bin')
SOURCE = Path('/tmp/spin5-protocol/source')


def receipt(image='candidate'):
    # Tiny protocol observations only, never evidence that SQL or refunds passed.
    source = SOURCE
    sql = [str(PG / 'psql'), '-v', 'execution_uuid=' + EXECUTION,
           '-v', 'ordinary_user_uuid=' + ORDINARY, '-v', 'tournament_uuid=' + TOURNAMENT]
    sql_inputs = {
        'spin_catalog_before': 'spin-catalog-observer.sql',
        'spin_catalog_rollback_qualification': 'scripts/qualification/spin-expiry-lock-order.sql',
        'spin_catalog_after': 'spin-catalog-observer.sql',
        'install_candidate': 'supabase/components/spin-expiry-lock-order.sql',
        'real_funded_paid_seat_fixture': 'scripts/qualification/spin-expiry-real-funded-fixture.sql',
    }
    catalog = ['spin_catalog_before', 'spin_catalog_rollback_qualification', 'spin_catalog_after']
    stages = [{'stage': name, 'returncode': 0, 'argv': sql + ['-f', str(source / sql_inputs[name])],
               'stdout_sha256': 'e' * 64}
              for name in (catalog + ['install_candidate'] if image == 'candidate' else []) + ['real_funded_paid_seat_fixture']]
    records = []
    for ordinal, case in enumerate(W.CASES[image], start=1):
        common = ['--psql', str(PG / 'psql'), '--execution', EXECUTION, '--tournament', TOURNAMENT]
        if case == 'committed-refund':
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-committed-refund.py')]
            argv += common + ['--journal', str(source.parent / 'work' / W.CASE_RESULTS[case])]
        else:
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-business-races.py')]
            argv += common + ['--image', image, '--case', case,
                              '--output', str(source.parent / 'work' / W.CASE_RESULTS[case])]
        stages.append({'stage': 'actual_business_' + case, 'returncode': 0, 'argv': argv})
        records.append({'case': case, 'execution': EXECUTION,
                        'case_identity': EXECUTION + ':' + str(ordinal) + ':' + case,
                        'state': 'passed', 'result_path': W.CASE_RESULTS[case],
                        'result_sha256': W.digest(b'unit-test case bytes')})
    return {'execution': EXECUTION, 'source_manifest_sha256': MANIFEST_SHA,
            'image': image, 'tournament': TOURNAMENT, 'catalog_slice_passed': image == 'candidate',
            'native_status': 'business_scenario_passed_cleanup_observed', 'business_scenario_passed': True,
            'business_qualified': False, 'cleanup_verified': True, 'cleanup_errors': [], 'source_stable': True,
            'full_qualification': False, 'connected_services_qualified': False,
            'execution_backend': 'hosted-owned-pg17-unix-socket',
            'hosted_cleanup_observed': True, 'original_clients_terminal': True,
            'stages': stages, 'business_cases': records}


class SessionEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.runners = Path(__file__).resolve().parents[2] / 'scripts' / 'qualification'
        spec = importlib.util.spec_from_file_location(
            'spin_expiry_session_controls', self.runners / 'spin-expiry-business-races.py')
        self.lib = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.lib)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root, self.home = self.allocation(self.temp.name)
        root_patch = patch.object(self.lib, 'ROOT', self.root)
        root_patch.start(); self.addCleanup(root_patch.stop)
        env_patch = patch.dict(os.environ, {
            'HOME': str(self.home), 'PGPASSWORD': 'host-secret-must-not-reach-child',
            'PGSERVICE': 'host-service', 'PGSERVICEFILE': '/host/service',
            'PGPASSFILE': '/host/password', 'PGOPTIONS': '-c role=host-role',
        }, clear=True)
        env_patch.start(); self.addCleanup(env_patch.stop)

    @staticmethod
    def allocation(folder):
        allocation = Path(folder).resolve()
        root = allocation / 'source'; root.mkdir()
        work = allocation / 'work'; work.mkdir(mode=0o700)
        home = work / 'home'; home.mkdir(mode=0o700)
        private = work / 'socket'; private.mkdir(mode=0o700)
        # Metadata-only Unix endpoint for transport preflight; no database runs.
        with socket.socket(socket.AF_UNIX) as endpoint:
            endpoint.bind(str(private / '.s.PGSQL.5432'))
        return root, home

    def test_empty_private_password_file_is_reused_without_inheriting_credentials(self):
        expected = {
            'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '2', 'PGAPPNAME': 'spin-control',
            'HOME': str(self.home), 'PGPASSFILE': str(self.home / '.spin-expiry.pgpass'),
            'PSQL_HISTORY': '/dev/null',
        }
        self.assertEqual(self.lib.psql_environment('spin-control'), expected)
        password_file = self.home / '.spin-expiry.pgpass'
        before = password_file.lstat()
        self.assertTrue(stat.S_ISREG(before.st_mode))
        self.assertEqual((before.st_uid, stat.S_IMODE(before.st_mode), before.st_size),
                         (os.geteuid(), 0o600, 0))
        self.assertEqual(password_file.read_bytes(), b'')
        self.assertEqual(self.lib.psql_environment('spin-control'), expected)
        after = password_file.lstat()
        self.assertEqual((before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns),
                         (after.st_dev, after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns))

    def test_actual_session_launch_uses_private_environment_and_preserves_diagnostics(self):
        with patch.object(self.lib.subprocess, 'Popen') as launch, \
                patch.object(self.lib.selectors, 'DefaultSelector'), \
                patch.object(self.lib.os, 'set_blocking'):
            self.lib.Session(Path('/protected/psql'), 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
                             'spin-control', 123)
        launch.assert_called_once()
        args, kwargs = launch.call_args
        self.assertEqual(args[0][:8], ['/protected/psql', '-X', '-w', '-qAt', '-h',
                                         str(self.root.parent / 'work/socket'), '-p', '5432'])
        self.assertEqual(kwargs['env'], self.lib.psql_environment('spin-control'))
        self.assertEqual(set(kwargs['env']), {'LC_ALL', 'PGCONNECT_TIMEOUT', 'PGAPPNAME',
                                             'HOME', 'PGPASSFILE', 'PSQL_HISTORY'})
        self.assertEqual(kwargs['stdin'], self.lib.subprocess.PIPE)
        self.assertEqual(kwargs['stdout'], self.lib.subprocess.PIPE)
        self.assertEqual(kwargs['stderr'], self.lib.subprocess.STDOUT)

    def test_unsafe_home_or_password_file_refuses_before_process_launch_without_truncation(self):
        for case in ('missing-home-env', 'relative-home', 'foreign-home', 'home-mode', 'home-symlink',
                     'password-symlink', 'password-directory', 'password-fifo',
                     'password-nonempty', 'password-mode'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                root, home = self.allocation(folder)
                password_file = home / '.spin-expiry.pgpass'
                env = {'HOME': str(home)}
                preserved = None
                if case == 'missing-home-env': env = {}
                if case == 'relative-home': env['HOME'] = 'work/home'
                if case == 'foreign-home': env['HOME'] = str(root)
                if case == 'home-mode': home.chmod(0o755)
                if case == 'home-symlink':
                    real_home = home.with_name('real-home'); home.rename(real_home)
                    home.symlink_to(real_home, target_is_directory=True)
                if case == 'password-symlink':
                    preserved = home / 'unrelated-password'
                    preserved.write_bytes(b'preserve-existing-content'); preserved.chmod(0o600)
                    password_file.symlink_to(preserved)
                if case == 'password-directory': password_file.mkdir(mode=0o700)
                if case == 'password-fifo': os.mkfifo(password_file, 0o600)
                if case == 'password-nonempty':
                    preserved = password_file
                    preserved.write_bytes(b'preserve-existing-content'); preserved.chmod(0o600)
                if case == 'password-mode':
                    password_file.write_bytes(b''); password_file.chmod(0o644)
                original_open = self.lib.os.open
                def bounded_open(path, flags, *args, **kwargs):
                    # Exercise the real FIFO refusal, but fail before a blocking
                    # open if the nonblocking guard regresses.
                    if case == 'password-fifo' and not flags & os.O_CREAT:
                        self.assertNotEqual(flags & os.O_NONBLOCK, 0)
                    return original_open(path, flags, *args, **kwargs)
                with patch.object(self.lib, 'ROOT', root), patch.dict(os.environ, env, clear=True), \
                        patch.object(self.lib.os, 'open', side_effect=bounded_open), \
                        patch.object(self.lib.subprocess, 'Popen') as launch, \
                        patch.object(self.lib.selectors, 'DefaultSelector'), \
                        self.assertRaises((RuntimeError, OSError)):
                    self.lib.Session(Path('/protected/psql'), 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
                                     'spin-control', 123)
                launch.assert_not_called()
                if preserved is not None:
                    self.assertEqual(preserved.read_bytes(), b'preserve-existing-content')
                if case == 'password-symlink': self.assertTrue(password_file.is_symlink())
                if case == 'password-fifo': self.assertTrue(stat.S_ISFIFO(password_file.lstat().st_mode))
                if case == 'password-mode': self.assertEqual(stat.S_IMODE(password_file.stat().st_mode), 0o644)

    def test_warning_prefixed_json_remains_a_failure(self):
        session = object.__new__(self.lib.Session)
        warning = "WARNING: password file '/dev/null' is not a plain file\n{\"ok\":true}"
        with patch.object(session, 'command', return_value=warning), \
                self.assertRaises(json.JSONDecodeError):
            session.json('SELECT original_observation;')
        with patch.object(session, 'command', return_value='ERROR: preserved diagnostic\n{"ok":true}'), \
                self.assertRaisesRegex(RuntimeError, 'unexpected SQL failure'):
            session.json('SELECT original_observation;')

    def test_begin_requires_observed_service_role_without_a_user_identity(self):
        session = object.__new__(self.lib.Session)
        original_transaction = ("BEGIN; SET LOCAL statement_timeout='8s'; "
            "SET LOCAL lock_timeout='4s'; SET LOCAL idle_in_transaction_session_timeout='12s'; "
            "SET LOCAL timezone='UTC'; SET LOCAL search_path=public,pg_temp; "
            "SET LOCAL request.jwt.claims='{}'; SET LOCAL request.jwt.claim.role=''; "
            "SET LOCAL request.jwt.claim.sub='';")
        with patch.object(session, 'command', return_value='') as command:
            session.begin()
        command.assert_called_once_with(original_transaction)
        self.assertNotIn('SET LOCAL ROLE', command.call_args.args[0])
        accepted = {'user': 'service_role', 'role': 'service_role', 'uid': None}
        with patch.object(session, 'command', side_effect=['', json.dumps(accepted)]) as command:
            session.begin(service_role=True)
        self.assertEqual(command.call_count, 2)
        transaction_sql = command.call_args_list[0].args[0]
        self.assertTrue(transaction_sql.startswith(original_transaction))
        for statement in ("SET LOCAL ROLE service_role;",
                          "SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';",
                          "SET LOCAL request.jwt.claim.role='service_role';",
                          "SET LOCAL request.jwt.claim.sub='';"):
            self.assertIn(statement, transaction_sql)
        observation_sql = ''.join(command.call_args_list[1].args[0].split())
        self.assertEqual(observation_sql,
                         "SELECTjsonb_build_object('user',current_user,'role',auth.role(),'uid',auth.uid());")
        invalid = [None, {}, [], {'role': 'service_role', 'uid': None}]
        for key, value in (('user', None), ('user', 'postgres'), ('user', 'authenticated'),
                           ('role', None), ('role', 'authenticated'), ('role', 'anon'),
                           ('uid', ORDINARY), ('uid', '')):
            invalid.append(dict(accepted, **{key: value}))
        for key in accepted:
            invalid.append({name: value for name, value in accepted.items() if name != key})
        for observed in invalid:
            with self.subTest(observed=observed), \
                    patch.object(session, 'command', side_effect=['', json.dumps(observed)]) as command, \
                    self.assertRaises(RuntimeError):
                session.begin(service_role=True)
            self.assertEqual(command.call_count, 2)
        with patch.object(session, 'command', return_value='ERROR: role setup refused') as command, \
                self.assertRaisesRegex(RuntimeError, 'unexpected SQL failure'):
            session.begin(service_role=True)
        command.assert_called_once()

    def test_refund_runner_binds_the_exact_session_implementation(self):
        spec = importlib.util.spec_from_file_location(
            'spin_expiry_refund_pin_control', self.runners / 'spin-expiry-committed-refund.py')
        refund = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(refund)
        self.assertEqual(refund.R1, self.runners / 'spin-expiry-business-races.py')
        self.assertEqual(refund.FROZEN[refund.R1], W.digest(refund.R1.read_bytes()))
        imported = refund.load(refund.R1, 'spin_expiry_refund_actual_dependency')
        with patch.object(imported, 'ROOT', self.root):
            self.assertEqual(imported.psql_environment('refund-control'),
                             self.lib.psql_environment('refund-control'))

    def test_private_socket_rejects_symlinks_permissions_foreign_owner_and_regular_endpoint(self):
        for case in ('permissive', 'symlink', 'foreign', 'regular', 'missing'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                root, home = self.allocation(folder)
                private = root.parent / 'work/socket'
                endpoint = private / '.s.PGSQL.5432'
                if case == 'permissive': private.chmod(0o755)
                if case == 'symlink':
                    real = private.with_name('original-socket'); private.rename(real)
                    private.symlink_to(real, target_is_directory=True)
                if case in ('regular', 'missing'):
                    endpoint.unlink()
                    if case == 'regular': endpoint.write_bytes(b'not a PostgreSQL socket')
                expected_uid = os.geteuid() + (1 if case == 'foreign' else 0)
                with patch.object(self.lib, 'ROOT', root), \
                        patch.object(self.lib.os, 'geteuid', return_value=expected_uid), \
                        self.assertRaises((RuntimeError, OSError)):
                    self.lib.private_socket()

    def test_endpoint_observation_rejects_tcp_listener_foreign_socket_database_and_identity(self):
        db = 'qual_spin_expiry_' + EXECUTION.replace('-', '')
        value = dict(database=db, user='postgres', session_user='postgres', port='5432',
                     address=None, listen_addresses='',
                     unix_socket_directories=str(self.root.parent / 'work/socket'),
                     version=170006, others=0)
        self.lib.require_private_endpoint(value, db)
        for key, changed in [('address','127.0.0.1'), ('listen_addresses','127.0.0.1'),
                             ('unix_socket_directories','/tmp'), ('database','postgres'),
                             ('user','fixture_bootstrap'), ('session_user','service_role'),
                             ('port','5433'), ('version',160000), ('others',1)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.lib.require_private_endpoint(dict(value, **{key: changed}), db)


class RelationAuthorityTests(unittest.TestCase):
    def setUp(self):
        directory = Path(__file__).resolve().parents[2] / 'scripts' / 'qualification'
        spec = importlib.util.spec_from_file_location(
            'spin_expiry_relation_controls', directory / 'spin-expiry-committed-refund.py')
        self.refund = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.refund)
        captures = json.loads((directory / 'spin-expiry-committed-refund.authority.json').read_text())['captures']
        self.rows = next(c['rows'] for c in captures
                         if c['origin'] == 'fifo5-R2-current-payment-relations-1409.json')
        self.roles = {'0': 'PUBLIC', '16481': 'authenticated', '16482': 'service_role'}

    def test_retained_capture_normalizes_only_column_gaps_and_observed_role_oids(self):
        original = copy.deepcopy(self.rows)
        actual = copy.deepcopy(self.rows)
        self.assertTrue(any(c['ordinal_position'] != index
                            for row in original for index, c in enumerate(row['columns'], 1)))
        for row in actual:
            for index, column in enumerate(row['columns'], 1):
                column['ordinal_position'] = index
            for policy in row['policies'] or []:
                policy['roles'] = policy['roles'].replace('16481', '16389').replace('16482', '16390')
        actual_before = copy.deepcopy(actual)
        observed = [{'oid': '16389', 'name': 'authenticated'}, {'oid': '16390', 'name': 'service_role'}]
        observed_before = copy.deepcopy(observed)
        actual_roles = self.refund.observed_policy_roles(observed)
        self.assertEqual(actual_roles, {'0': 'PUBLIC', '16389': 'authenticated', '16390': 'service_role'})
        self.assertEqual(self.refund.CAPTURED_POLICY_ROLES, self.roles)
        expected = self.refund.relation_authority(self.rows, self.roles)
        self.assertEqual(self.refund.relation_authority(actual, actual_roles), expected)
        self.assertEqual(self.rows, original)
        self.assertEqual(actual, actual_before)
        self.assertEqual(observed, observed_before)
        self.assertEqual(len(expected), len(original))
        self.assertEqual(expected[0]['policies'][0]['roles'], ['PUBLIC'])
        for before, after in zip(original, expected):
            self.assertEqual({k: v for k, v in before.items() if k not in ('columns', 'policies')},
                             {k: v for k, v in after.items() if k not in ('columns', 'policies')})
            self.assertEqual(len(before['columns']), len(after['columns']))
            self.assertEqual(before['policies'] is None, after['policies'] is None)
            self.assertEqual(len(before['policies'] or []), len(after['policies'] or []))
            for index, (old_column, new_column) in enumerate(zip(before['columns'], after['columns']), 1):
                self.assertEqual(new_column, dict(old_column, ordinal_position=index))
            for old_policy, new_policy in zip(before['policies'] or [], after['policies'] or []):
                names = sorted(self.roles[oid] for oid in old_policy['roles'][1:-1].split(','))
                self.assertEqual(new_policy, dict(old_policy, roles=names))

    def test_real_column_and_policy_drift_remains_distinct(self):
        expected = self.refund.relation_authority(self.rows, self.roles)
        for change in ('column-order', 'type', 'default', 'nullability', 'policy-role', 'policy-expression'):
            changed = copy.deepcopy(self.rows)
            columns = changed[0]['columns']
            if change == 'column-order':
                first, second = columns[0]['ordinal_position'], columns[1]['ordinal_position']
                columns[0], columns[1] = columns[1], columns[0]
                columns[0]['ordinal_position'], columns[1]['ordinal_position'] = first, second
            if change == 'type': columns[0]['data_type'] = 'text'
            if change == 'default': columns[0]['column_default'] = None
            if change == 'nullability': columns[0]['is_nullable'] = 'YES'
            if change == 'policy-role': changed[0]['policies'][0]['roles'] = '{16482}'
            if change == 'policy-expression': changed[0]['policies'][0]['using'] = 'true'
            with self.subTest(change=change):
                self.assertNotEqual(self.refund.relation_authority(changed, self.roles), expected)

    def test_malformed_ordinals_columns_or_policy_role_arrays_refuse(self):
        for ordinal in (0, -1, True, 1.5, '1', None):
            changed = copy.deepcopy(self.rows)
            changed[0]['columns'][0]['ordinal_position'] = ordinal
            with self.subTest(ordinal=ordinal), self.assertRaises(RuntimeError):
                self.refund.relation_authority(changed, self.roles)
        for change in ('duplicate-ordinal', 'decreasing-ordinal', 'duplicate-column', 'missing-column'):
            changed = copy.deepcopy(self.rows)
            columns = changed[0]['columns']
            if change == 'duplicate-ordinal': columns[1]['ordinal_position'] = columns[0]['ordinal_position']
            if change == 'decreasing-ordinal': columns[0]['ordinal_position'] = columns[1]['ordinal_position'] + 1
            if change == 'duplicate-column': columns[1]['column_name'] = columns[0]['column_name']
            if change == 'missing-column': del columns[0]['column_name']
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.refund.relation_authority(changed, self.roles)
        for roles in ('{99999}', '{0,0}', '{}', '{16481,}', '{-1}', '{NULL}', '[16481]', ['16481'], None):
            changed = copy.deepcopy(self.rows)
            changed[0]['policies'][0]['roles'] = roles
            with self.subTest(roles=roles), self.assertRaises(RuntimeError):
                self.refund.relation_authority(changed, self.roles)
        for mappings in ({'0': 'authenticated', '16481': 'authenticated', '16482': 'service_role'},
                         {'0': 'PUBLIC', '16481': 'PUBLIC', '16482': 'service_role'},
                         {'0': 'PUBLIC', '16481': '', '16482': 'service_role'}):
            with self.subTest(mappings=mappings), self.assertRaises(RuntimeError):
                self.refund.relation_authority(self.rows, mappings)

    def test_observed_roles_require_exact_unique_names_and_positive_oid_bindings(self):
        good = [{'oid': '16389', 'name': 'authenticated'}, {'oid': '16390', 'name': 'service_role'}]
        invalid = [[], good[:1], good + [good[0]],
                   [good[0], {'oid': '16390', 'name': 'authenticated'}],
                   [good[0], {'oid': '16389', 'name': 'service_role'}],
                   [good[0], {'oid': '16390', 'name': 'PUBLIC'}],
                   [good[0], {'oid': '16390'}],
                   [good[0], {'name': 'service_role'}]]
        for oid in ('0', '-1', '1.5', '', 'abc', None, True):
            invalid.append([good[0], {'oid': oid, 'name': 'service_role'}])
        for observed in invalid:
            with self.subTest(observed=observed), self.assertRaises(RuntimeError):
                self.refund.observed_policy_roles(observed)


class TerminalObservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / 'qualification/spin-expiry-committed-refund-oracle.py'
        spec = importlib.util.spec_from_file_location('terminal_refund_oracle', path)
        cls.oracle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.oracle)

    def reports(self):
        before = [dict(id='paid', related_entity_id=TOURNAMENT, terminal_closed_at=None, amount=1),
                  dict(id='other', related_entity_id='other-event', terminal_closed_at=None, amount=2)]
        after = copy.deepcopy(before)
        after[0]['terminal_closed_at'] = 'settled'
        after += [dict(id='refund1'), dict(id='refund2')]
        return before, after

    def test_only_exact_target_report_stamp_is_allowed(self):
        before, after = self.reports()
        original = copy.deepcopy(before)
        # The original immutable-only comparison reproduces the observed refusal.
        with self.assertRaisesRegex(RuntimeError, 'prior immutable row'):
            self.oracle.additions(before, after, 'id', 2)
        self.assertEqual(self.oracle.reporting_additions(before, after, TOURNAMENT, 'settled'), after[2:])
        self.assertEqual(before, original)

    def test_report_marker_event_money_and_unrelated_changes_refuse(self):
        for row, field, value in ((0, 'terminal_closed_at', None), (0, 'terminal_closed_at', 'wrong'),
                                  (0, 'related_entity_id', 'other-event'), (0, 'amount', 2),
                                  (1, 'terminal_closed_at', 'settled')):
            with self.subTest(row=row, field=field, value=value):
                before, after = self.reports()
                after[row][field] = value
                with self.assertRaisesRegex(RuntimeError, 'prior immutable row'):
                    self.oracle.reporting_additions(before, after, TOURNAMENT, 'settled')
        before, after = self.reports()
        with self.assertRaisesRegex(RuntimeError, 'prior immutable row'):
            self.oracle.reporting_additions(before, after[1:], TOURNAMENT, 'settled')
        before[0]['terminal_closed_at'] = 'already-closed'
        with self.assertRaisesRegex(RuntimeError, 'original report already closed'):
            self.oracle.reporting_additions(before, after, TOURNAMENT, 'settled')

    def test_elimination_sequence_requires_new_positive_unique_integer(self):
        before = [dict(id=str(i), status='playing', elimination_sequence=None) for i in range(2)]
        after = [dict(id=str(i), status='eliminated', elimination_sequence=i+10) for i in range(2)]
        self.oracle.elimination_sequences(before, after)
        for invalid in (None, 0, -1, True, '10', 1.5, 11):
            with self.subTest(invalid=invalid):
                damaged = copy.deepcopy(after)
                damaged[0]['elimination_sequence'] = invalid
                with self.assertRaisesRegex(RuntimeError, 'invalid database elimination sequence'):
                    self.oracle.elimination_sequences(before, damaged)
        for field, value in (('status', 'eliminated'), ('elimination_sequence', 4)):
            damaged = copy.deepcopy(before)
            damaged[0][field] = value
            with self.assertRaisesRegex(RuntimeError, 'original roster already eliminated'):
                self.oracle.elimination_sequences(damaged, after)
        with self.assertRaisesRegex(RuntimeError, 'elimination roster identity changed'):
            self.oracle.elimination_sequences(before, after[:1])


class FixtureSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.root.chmod(0o700)
        self.directory = self.root / 'scripts/ci/probes/spin-expiry'
        self.directory.mkdir(parents=True, mode=0o700)
        root_patch = patch.object(W, 'ROOT', self.root)
        root_patch.start(); self.addCleanup(root_patch.stop)
        # Parser/protocol bytes only. Never invoked as a native financial fixture.
        self.files = {name: ('unit input ' + name).encode() for name in W.FIXED_INPUTS}
        self.manifest = {'schemaVersion': 1, 'kind': 'spin-expiry-hosted-fixture',
                         'originManifestSha256': W.ORIGIN_MANIFEST,
                         'files': {name: W.pin(data) for name, data in self.files.items()}}
        for name, data in self.files.items():
            leaf = self.directory / name; leaf.parent.mkdir(parents=True, exist_ok=True)
            leaf.write_bytes(data)
        self.write_manifest()

    def write_manifest(self):
        self.raw = (json.dumps(self.manifest) + '\n').encode()
        (self.directory / 'manifest.json').write_bytes(self.raw)

    def test_exact_fixed_manifest_preserves_provenance_and_bytes(self):
        raw, manifest, files = W.load_fixture(self.directory)
        self.assertEqual((raw, manifest, files), (self.raw, self.manifest, self.files))
        self.assertEqual(len(files), 17)

    def test_missing_financial_authority_and_extra_leaf_refuse(self):
        for name in ('inputs/entry-sequence-authority.sql', 'inputs/settle-source-authority.sql',
                     'inputs/entry-provider-supplement.sql', 'inputs/captured-financial-store-policy.sql'):
            saved = self.manifest['files'].pop(name); self.write_manifest()
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'inventory'):
                W.load_fixture(self.directory)
            self.manifest['files'][name] = saved
        self.write_manifest()
        (self.directory / 'unreviewed.sql').write_bytes(b'no')
        with self.assertRaisesRegex(RuntimeError, 'unpinned'): W.load_fixture(self.directory)

    def test_manifest_duplicate_traversal_hash_and_origin_refuse(self):
        with self.assertRaisesRegex(RuntimeError, 'duplicate'): W.decode(b'{"files":{},"files":{}}')
        for name in ('../x', '/x', 'a/../x', 'a//x', 'manifest.json', 'a/./x'):
            with self.subTest(name=name), self.assertRaises(RuntimeError): W.safe_name(name)
        original = self.manifest['originManifestSha256']
        self.manifest['originManifestSha256'] = 'f' * 64; self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, 'provenance'): W.load_fixture(self.directory)
        self.manifest['originManifestSha256'] = original; self.write_manifest()
        (self.directory / 'principals.sql').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'leaf mismatch'): W.load_fixture(self.directory)

    def test_symlink_hardlink_foreign_and_writable_source_refuse(self):
        leaf = self.directory / 'principals.sql'
        leaf.unlink(); leaf.symlink_to(self.directory / 'provider-roles.sql')
        with self.assertRaises(RuntimeError): W.load_fixture(self.directory)
        leaf.unlink(); os.link(self.directory / 'provider-roles.sql', leaf)
        with self.assertRaises(RuntimeError): W.load_fixture(self.directory)
        leaf.unlink(); leaf.write_bytes(self.files['principals.sql']); leaf.chmod(0o666)
        with self.assertRaises(RuntimeError): W.load_fixture(self.directory)
        leaf.chmod(0o600)
        uid = os.geteuid()
        with patch.object(W.os, 'geteuid', return_value=uid + 1), self.assertRaises(RuntimeError):
            W.load_fixture(self.directory)

    def test_read_preserves_atime_and_rejects_inode_replacement(self):
        leaf = self.directory / 'principals.sql'; os.utime(leaf, ns=(1, 2_000_000_000))
        before = leaf.stat()
        self.assertEqual(W.read_regular(leaf, 1000), self.files['principals.sql'])
        after = leaf.stat()
        self.assertEqual((before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns),
                         (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns))
        original_open = Path.open
        def replacing_open(path, *args, **kwargs):
            handle = original_open(path, *args, **kwargs)
            if path == leaf:
                replacement = leaf.with_name('new-inode')
                with original_open(replacement, 'wb') as out: out.write(self.files['principals.sql'])
                os.replace(replacement, leaf)
            return handle
        with patch.object(Path, 'open', replacing_open), self.assertRaisesRegex(RuntimeError, 'source changed'):
            W.read_regular(leaf, 1000)

    def test_staged_inventory_and_postrun_bytes_are_bound(self):
        files = dict(self.files)
        files.update({name: ('current source '+name).encode() for name in W.REPLACEMENTS})
        manifest = {'files': {name: W.pin(data) for name,data in files.items()}}
        allocation = self.root / 'attempt'; allocation.mkdir(mode=0o700)
        raw = W.stage_packet(allocation, manifest, files)
        W.verify_packet(allocation / 'source', raw, manifest)
        leaf = allocation / 'source/inputs/schema.sql'; leaf.chmod(0o600); leaf.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'source changed'):
            W.verify_packet(allocation / 'source', raw, manifest)
        with self.assertRaises(FileExistsError): W.stage_packet(allocation, manifest, files)

    def test_omitted_or_extra_maintained_source_cannot_stage(self):
        allocation = self.root / 'attempt'; allocation.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, 'inventory'):
            W.stage_packet(allocation, {'files':{}}, {})
        self.assertIn('scripts/qualification/spin-expiry-committed-refund-oracle.py',W.REPLACEMENTS)
        self.assertIn('supabase/components/spin-expiry-lock-order.rollback.sql',W.REPLACEMENTS)


class ReceiptTests(unittest.TestCase):
    def validate(self, value):
        return W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT, value.get('image'),
                                  MANIFEST_SHA, SOURCE, PG)

    def test_separate_images_do_not_claim_full_qualification(self):
        self.validate(receipt('preimage'))
        self.validate(receipt())

    def test_wrong_identity_failed_unknown_or_overclaim_refuses(self):
        for key, value in [('execution', ORDINARY), ('source_manifest_sha256', 'c' * 64),
                           ('native_status', 'failed_or_unknown'), ('business_scenario_passed', False),
                           ('tournament', ORDINARY), ('business_qualified', True),
                           ('cleanup_verified', False), ('cleanup_errors', ['fast stop failed']),
                           ('source_stable', False), ('full_qualification', True),
                           ('connected_services_qualified', True),
                           ('execution_backend','retired-service'), ('hosted_cleanup_observed',False),
                           ('original_clients_terminal',False)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate(dict(receipt(), **{key: value}))

    def test_stage_identity_order_and_original_outcome_required(self):
        for mode in ('missing', 'repeated', 'wrong-user', 'failed', 'order'):
            value = receipt()
            if mode == 'missing': value['stages'].pop()
            if mode == 'repeated': value['stages'].append(copy.deepcopy(value['stages'][0]))
            if mode == 'wrong-user':
                argv = value['stages'][0]['argv']
                argv[argv.index('ordinary_user_uuid=' + ORDINARY)] = 'ordinary_user_uuid=' + EXECUTION
            if mode == 'failed': value['stages'][0]['returncode'] = 1
            if mode == 'order': value['stages'].reverse()
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_each_case_requires_original_identity_order_outcome_and_bytes(self):
        for mode in ('missing', 'failed', 'repeated', 'early', 'wrong-execution', 'wrong-case-id', 'path', 'hash'):
            value = receipt()
            if mode == 'missing': value['business_cases'].pop()
            if mode == 'failed': value['business_cases'][-1]['state'] = 'running'
            if mode == 'repeated': value['business_cases'].append(copy.deepcopy(value['business_cases'][-1]))
            if mode == 'early': value['business_cases'].reverse()
            if mode == 'wrong-execution': value['business_cases'][0]['execution'] = ORDINARY
            if mode == 'wrong-case-id': value['business_cases'][0]['case_identity'] = EXECUTION + ':2:order'
            if mode == 'path': value['business_cases'][-1]['result_path'] = '../receipt.json'
            if mode == 'hash': value['business_cases'][-1]['result_sha256'] = None
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_catalog_requires_one_success_before_install_and_equal_original_observers(self):
        for mode in ('flag', 'missing', 'repeated', 'late', 'failed', 'drift', 'wrong-source', 'preimage'):
            value = receipt()
            if mode == 'flag': value['catalog_slice_passed'] = False
            if mode == 'missing': value['stages'].pop(1)
            if mode == 'repeated': value['stages'].insert(2, copy.deepcopy(value['stages'][1]))
            if mode == 'late': value['stages'].insert(4, value['stages'].pop(1))
            if mode == 'failed': value['stages'][1]['returncode'] = 3
            if mode == 'drift': value['stages'][2]['stdout_sha256'] = 'd' * 64
            if mode == 'wrong-source': value['stages'][1]['argv'][-1] = '/old-provider/qualifier.sql'
            if mode == 'preimage': value = receipt('preimage'); value['catalog_slice_passed'] = True
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_original_business_cli_is_bound_to_exact_image_and_fixture(self):
        for marker, replacement in (('--execution', ORDINARY), ('--tournament', ORDINARY),
                                    ('--image', 'preimage'), ('--case', 'timeout')):
            value = receipt()
            stage = next(s for s in value['stages'] if s['stage'] == 'actual_business_order')
            stage['argv'][stage['argv'].index(marker) + 1] = replacement
            with self.subTest(marker=marker), self.assertRaises(RuntimeError): self.validate(value)
        value = receipt('preimage')
        value['stages'].insert(0, {'stage': 'install_candidate', 'returncode': 0, 'argv': []})
        with self.assertRaises(RuntimeError): self.validate(value)



class HostedLifecycleTests(unittest.TestCase):
    def test_cleanup_first_failure_and_original_deadline_are_sticky(self):
        W.cleanup_negative_controls()
        outcome=W.CleanupOutcome(); outcome.failed('first failure'); outcome.observed_stopped()
        self.assertFalse(outcome.qualifies()); self.assertEqual(outcome.errors,['first failure'])
        self.assertEqual(W.command_budget(30,20,10),7)
        with self.assertRaises(TimeoutError): W.command_budget(30,27,10)

    def test_forced_client_cleanup_never_erases_failure_and_reaps_original_handle(self):
        class Client:
            pid = 12345
            def __init__(self, code): self.returncode = code; self.waits = 0
            def poll(self): return self.returncode
            def wait(self, timeout): self.waits += 1; self.returncode = -9; return -9
        client = Client(None); entry = {}; outcome = W.CleanupOutcome()
        with patch.object(W.os, 'killpg') as kill, \
                patch.object(W, 'process_group_absent', return_value=True), \
                patch.object(W.time, 'monotonic', return_value=1):
            self.assertTrue(W.finish_clients([(client,entry)], 30, outcome))
        kill.assert_called_once_with(client.pid, signal.SIGKILL)
        self.assertEqual(client.waits, 1); self.assertEqual(entry['terminal_returncode'], -9)
        outcome.observed_stopped()
        self.assertFalse(outcome.qualifies()); self.assertEqual(len(outcome.errors),1)
        # A live group exhausts the original deadline; it never earns a new one.
        client = Client(0); outcome = W.CleanupOutcome()
        with patch.object(W.os,'killpg'),patch.object(W,'process_group_absent',return_value=False), \
                patch.object(W.time,'monotonic',return_value=30):
            self.assertFalse(W.finish_clients([(client,{})],30,outcome))
        self.assertFalse(outcome.qualifies())

    def test_sequence_numeric_authority_refuses_rounded_bigints(self):
        row={'start':'1','increment':'1','minimum':'1','maximum':'9223372036854775807',
             'cache':'1','type':'bigint','cycle':False}
        W.sequence_negative_controls(row)

    def test_uuid_collision_with_canonical_refund_actor_refuses(self):
        with patch.object(W.uuid,'uuid4',side_effect=[EXECUTION,ORDINARY,W.REFUND_ACTOR]), \
                self.assertRaisesRegex(RuntimeError,'collision'): W.new_identity('candidate')
        with patch.object(W.uuid,'uuid4',side_effect=[EXECUTION,ORDINARY,TOURNAMENT]):
            args=W.new_identity('candidate')
        self.assertEqual((args.execution,args.ordinary_user,args.tournament),(EXECUTION,ORDINARY,TOURNAMENT))

    def test_still_live_process_group_is_not_terminal_evidence(self):
        with patch.object(W.os,'killpg',return_value=None): self.assertFalse(W.process_group_absent(123))
        with patch.object(W.os,'killpg',side_effect=ProcessLookupError): self.assertTrue(W.process_group_absent(123))
        with patch.object(W.os,'killpg',side_effect=PermissionError), self.assertRaises(PermissionError):
            W.process_group_absent(123)

    def test_case_original_failure_identity_and_financial_state_refuse(self):
        good={'scenario_observed':True,'cleanup_verified':True,'source_stable':True,
              'execution':EXECUTION,'fixture_tournament':TOURNAMENT,'image':'candidate','case':'timeout',
              'selected_before':{'amount':'2.00'},'selected_after':{'amount':'2.00'},
              'authority_before':{'function':'exact'},'authority_after':{'function':'exact'}}
        W.validate_case_result('timeout',json.dumps(good).encode(),EXECUTION,TOURNAMENT,'candidate')
        for key,value in [('scenario_observed',False),('cleanup_verified',False),('execution',ORDINARY),
                          ('selected_after',{'amount':'2.01'}),('authority_after',{'function':'changed'})]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                W.validate_case_result('timeout',json.dumps(dict(good,**{key:value})).encode(),EXECUTION,TOURNAMENT,'candidate')
        records=[{'execution':EXECUTION,'tournament':TOURNAMENT},
                 {'event':'terminal_source_oracle_result','observed':True,
                  'client_and_server_cleanup':True,'source_stable':True}]
        raw=lambda rs:'\n'.join(json.dumps(x) for x in rs).encode()
        W.validate_case_result('committed-refund',raw(records),EXECUTION,TOURNAMENT,'candidate')
        for key,value in [('observed',False),('client_and_server_cleanup',False),('source_stable',False),
                          ('event','commit_intent')]:
            damaged=copy.deepcopy(records);damaged[-1][key]=value
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                W.validate_case_result('committed-refund',raw(damaged),EXECUTION,TOURNAMENT,'candidate')

    def test_evidence_never_exports_pgdata_private_home_or_unrelated_file(self):
        with tempfile.TemporaryDirectory() as folder:
            work=Path(folder).resolve()/'work';work.mkdir(mode=0o700)
            out=work.parent/'out';out.mkdir(mode=0o700)
            for name in ['receipt.json','postgres.log','business-order.json','native.stdout','native.stderr']:
                (work/name).write_bytes(b'bounded original evidence')
            (work/'data').mkdir();(work/'data/PG_VERSION').write_bytes(b'17')
            (work/'home').mkdir();(work/'home/.spin-expiry.pgpass').write_bytes(b'')
            (work/'unrelated').write_bytes(b'not uploaded')
            kept=W.retained_evidence(work,out,{'stages':[{'stage':'native'}]},b'{}')
            self.assertEqual(set(kept),{'receipt.json','postgres.log','business-order.json','native.stdout','native.stderr'})
            self.assertFalse((out/'data').exists());self.assertFalse((out/'home').exists());self.assertFalse((out/'unrelated').exists())

    def test_two_images_run_in_order_and_stop_after_first_failure(self):
        for outcomes,expected in [([1],['preimage']),([0,1],['preimage','candidate']),([0,0],['preimage','candidate'])]:
            with self.subTest(outcomes=outcomes),patch.object(W,'source_controls',return_value=True), \
                    patch.object(W,'find_pg',return_value=PG),patch.object(W,'run_image',side_effect=outcomes) as run, \
                    patch.object(W.sys,'argv',['wrapper']),patch.object(W.sys,'platform','linux'), \
                    patch.object(W.os,'geteuid',return_value=1000),patch.object(W.signal,'signal'):
                result=W.main()
                self.assertEqual([call.args[0] for call in run.call_args_list],expected)
                self.assertEqual(result,1 if 1 in outcomes else 0)

    def test_failed_source_controls_prevent_native_allocation(self):
        with patch.object(W,'source_controls',return_value=False),patch.object(W,'run_image') as run, \
                patch.object(W.sys,'argv',['wrapper']):
            self.assertEqual(W.main(),1)
        run.assert_not_called()
