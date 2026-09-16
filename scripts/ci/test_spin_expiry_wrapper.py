"""Bounded source-specific adapter controls; no PostgreSQL or privileged commands.

Invoked by test-spin-expiry-postgres.py --self-test in the
same required step immediately before the actual PG qualifier. These controls
are not native SQL, systemd, provider installation or connected-service proof.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('spin_expiry_pg_wrapper', Path(__file__).with_name('test-spin-expiry-postgres.py'))
W = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(W)
EXECUTION = '00000000-0000-4000-8000-000000000001'
ORDINARY = '00000000-0000-4000-8000-000000000002'
TOURNAMENT = '00000000-0000-4000-8000-000000000003'
INVOCATION = 'a' * 32
MANIFEST_SHA = 'b' * 64
GROUP = '/system.slice/spin5-business-' + EXECUTION + '.service'


def terminal():
    return {'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
            'Result': 'success', 'ExecMainStatus': '0', 'MainPID': '0',
            'ControlGroup': '', 'InvocationID': INVOCATION}


def receipt(image='candidate'):
    # Tiny protocol observations only, never evidence that SQL or refunds passed.
    source = W.BASE / ('spin5-business-' + EXECUTION) / 'source'
    sql = [W.PG + '/psql', '-v', 'execution_uuid=' + EXECUTION,
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
        common = ['--psql', W.PG + '/psql', '--execution', EXECUTION, '--tournament', TOURNAMENT]
        if case == 'committed-refund':
            argv = ['/usr/bin/python3', str(source / 'scripts/qualification/spin-expiry-committed-refund.py')]
            argv += common + ['--journal', str(source.parent / 'work' / W.CASE_RESULTS[case])]
        else:
            argv = ['/usr/bin/python3', str(source / 'scripts/qualification/spin-expiry-business-races.py')]
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
            'systemd_invocation': INVOCATION, 'cgroup': GROUP, 'host_netns': 'net:[100]',
            'worker_netns': 'net:[101]', 'resource_controls': {'cpu.max': '100000 100000',
            'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '128'},
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
        self.assertEqual(args[0][:4], ['/protected/psql', '-X', '-w', '-qAt'])
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


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        # Content-only tiny fixture. Root filesystem authority is mocked only in
        # these tests; production load_provider always calls the real guard.
        self.files = {name: (name + '\n').encode() for name in W.REQUIRED}
        self.files['checkout-replacements.json'] = json.dumps(W.REPLACEMENTS).encode()
        self.manifest = {'source_owner_commit': 'old-provider-origin', 'resources': dict(W.RESOURCES),
                         'files': {name: W.pin(data) for name, data in self.files.items()}}
        for name, data in self.files.items():
            path = self.directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.raw = (json.dumps(self.manifest) + '\n').encode()
        (self.directory / 'manifest.json').write_bytes(self.raw)

    def load(self, sha=None):
        with patch.object(W, 'root_custody'):
            return W.load_provider(str(self.directory), sha or W.digest(self.raw))

    def test_valid_manifest_retains_every_fixed_byte(self):
        raw, manifest, files = self.load()
        self.assertEqual(raw, self.raw)
        self.assertEqual(files, self.files)
        changed = {name: b'actual committed qualification source\n' for name in W.REPLACEMENTS}
        provenance = {'provider_declared_source_owner_commit': 'old-provider-origin', 'attempt_source_commit': 'actual-checkout'}
        produced, copied = W.attempt_source(manifest, files, changed, provenance)
        self.assertEqual(produced['ci_provenance'], provenance)
        self.assertEqual(produced['source_owner_commit'], 'old-provider-origin')
        for name in files:
            self.assertEqual(copied[name], changed.get(name, files[name]))
            self.assertEqual(produced['files'][name], W.pin(copied[name]))
        self.assertEqual(manifest, self.manifest)

    def test_missing_config_or_wrong_manifest_never_defaults(self):
        for configured in ('', 'no-pin', 'A' * 64, '0' * 64):
            with self.subTest(pin=configured), self.assertRaises(RuntimeError):
                W.load_provider(str(self.directory), configured)

    def test_drift_unpinned_leaf_and_symlink_refuse(self):
        leaf = self.directory / 'run.py'
        leaf.write_bytes(b'drift')
        with self.assertRaisesRegex(RuntimeError, 'leaf mismatch'):
            self.load()
        leaf.write_bytes(self.files['run.py'])
        extra = self.directory / 'unexpected.py'
        extra.write_bytes(b'extra')
        with self.assertRaisesRegex(RuntimeError, 'unpinned'):
            self.load()
        extra.unlink()
        leaf.unlink(); leaf.symlink_to(self.directory / 'principals.sql')
        with self.assertRaisesRegex(RuntimeError, 'non-regular'):
            self.load()

    def test_duplicate_or_traversal_manifest_refuses(self):
        with self.assertRaisesRegex(RuntimeError, 'duplicate'):
            W.decode(b'{"files":{},"files":{}}')
        for name in ('../x', '/x', 'a/../x', 'a//x', 'manifest.json', 'a/./x'):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                W.safe_name(name)

    def test_no_replacement_for_provider_code(self):
        with self.assertRaises(RuntimeError):
            W.attempt_source(self.manifest, self.files, {'run.py': b'changed'}, {})

    def test_actual_business_fixture_oracle_and_provider_inputs_cannot_be_omitted(self):
        for name in ('scripts/qualification/spin-expiry-real-funded-fixture.sql',
                     'scripts/qualification/spin-expiry-committed-refund-oracle.py',
                     'inputs/entry-provider-supplement.sql', 'inputs/captured-financial-store-policy.sql'):
            manifest = copy.deepcopy(self.manifest); del manifest['files'][name]
            raw = json.dumps(manifest).encode()
            (self.directory / 'manifest.json').write_bytes(raw)
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'inventory incomplete'):
                self.load(W.digest(raw))

    def test_provider_cannot_remap_the_maintained_checkout_inputs(self):
        name = 'checkout-replacements.json'
        mapping = dict(W.REPLACEMENTS)
        mapping['run.py'] = 'scripts/untrusted-run.py'
        changed = json.dumps(mapping).encode()
        (self.directory / name).write_bytes(changed)
        manifest = copy.deepcopy(self.manifest); manifest['files'][name] = W.pin(changed)
        raw = json.dumps(manifest).encode(); (self.directory / 'manifest.json').write_bytes(raw)
        with self.assertRaisesRegex(RuntimeError, 'checkout mapping drift'):
            self.load(W.digest(raw))

    def test_root_custody_rejects_writable_or_foreign_paths(self):
        info = type('Info', (), {'st_mode': 0o100444, 'st_uid': 0})()
        with patch.object(Path, 'lstat', return_value=info):
            W.root_custody(Path('/provider/manifest.json'))
            for mode, uid in ((0o100664, 0), (0o100444, 1000), (0o120777, 0)):
                info.st_mode, info.st_uid = mode, uid
                with self.assertRaises(RuntimeError):
                    W.root_custody(Path('/provider/manifest.json'))

    def test_read_does_not_treat_access_time_as_source_mutation(self):
        leaf = self.directory / 'atime-control'
        leaf.write_bytes(b'unchanged pinned source')
        os.utime(leaf, ns=(1, 2_000_000_000))
        before = leaf.stat()
        self.assertLess(before.st_atime_ns, before.st_mtime_ns)
        self.assertEqual(W.read_regular(leaf, 100), b'unchanged pinned source')
        after = leaf.stat()
        self.assertEqual((after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                         (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns))
        # noatime filesystems may retain atime; either behavior must qualify.

    def test_replacement_during_read_is_rejected(self):
        leaf = self.directory / 'run.py'
        original_open = Path.open
        def replacing_open(path, *args, **kwargs):
            handle = original_open(path, *args, **kwargs)
            if path == leaf:
                replacement = self.directory / 'new-inode'
                with original_open(replacement, 'wb') as out: out.write(self.files['run.py'])
                os.replace(replacement, leaf)
            return handle
        with patch.object(Path, 'open', replacing_open), self.assertRaisesRegex(RuntimeError, 'source changed'):
            W.read_regular(leaf, 1000)


class ReceiptTests(unittest.TestCase):
    def validate(self, value, unit=None):
        return W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT, value.get('image'),
                                  MANIFEST_SHA, 'net:[100]', GROUP, unit or terminal())

    def test_separate_images_do_not_claim_full_qualification(self):
        self.validate(receipt('preimage'))
        self.validate(receipt())
        gc = terminal(); gc.update(LoadState='not-found', InvocationID='')
        self.validate(receipt(), gc)

    def test_wrong_identity_failed_unknown_or_overclaim_refuses(self):
        for key, value in [('execution', ORDINARY), ('source_manifest_sha256', 'c' * 64),
                           ('native_status', 'failed_or_unknown'), ('business_scenario_passed', False),
                           ('tournament', ORDINARY), ('business_qualified', True),
                           ('cleanup_verified', False), ('cleanup_errors', ['fast stop failed']),
                           ('source_stable', False), ('full_qualification', True),
                           ('connected_services_qualified', True), ('systemd_invocation', None),
                           ('cgroup', '/another.service'), ('host_netns', 'net:[999]'),
                           ('worker_netns', 'net:[100]')]:
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

    def test_live_unknown_wrong_invocation_or_failed_unit_refuses(self):
        for key, value in [('ActiveState', 'active'), ('MainPID', '23'), ('LoadState', 'error'), ('ControlGroup', '/foreign')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                W.terminal_unit(dict(terminal(), **{key: value}), GROUP)
        for key, value in [('InvocationID', 'c' * 32), ('InvocationID', ''), ('Result', 'timeout'), ('ExecMainStatus', '9')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate(receipt(), dict(terminal(), **{key: value}))

    def test_resources_and_namespaces_are_not_caller_success_flags(self):
        for namespace in ('', 'net:[0]', 'net:[10]\n', 'user:[100]', None):
            with self.subTest(namespace=namespace), self.assertRaises(RuntimeError): W.namespace(namespace)
        value = receipt(); value['resource_controls']['memory.swap.max'] = 'max'
        with self.assertRaises(RuntimeError): self.validate(value)


class LifecycleTests(unittest.TestCase):
    def attempt(self, output):
        item = object.__new__(W.Attempt)
        item.execution, item.ordinary, item.unit = EXECUTION, ORDINARY, 'spin5-business-' + EXECUTION + '.service'
        item.tournament, item.image = TOURNAMENT, 'candidate'
        item.allocation, item.cgroup, item.out = Path('/srv/ci-validation/spin5-business-' + EXECUTION), GROUP, output
        item.result = {'failures': [], 'cleanup_verified': False, 'source_manifest_sha256': MANIFEST_SHA, 'host_netns': 'net:[100]'}
        item.launched = False
        item.stop_requested = False
        item.clients = []
        item.persist = lambda: None
        item.prepare = lambda: (item.allocation / 'source', 'net:[100]')
        return item

    def test_exact_launch_is_nonroot_bounded_and_environment_isolated(self):
        cmd = W.launch_command('spin5-business-' + EXECUTION + '.service', Path('/source'), EXECUTION, ORDINARY, TOURNAMENT, 'candidate', 'net:[100]')
        for value in ('User=lima', 'Group=lima', 'CPUQuota=100%', 'MemoryMax=2G', 'MemorySwapMax=0',
                      'TasksMax=128', 'RuntimeMaxSec=270', 'TimeoutStopSec=25', 'KillMode=control-group', 'PrivateNetwork=yes'):
            self.assertIn(value, cmd)
        self.assertEqual(cmd[-10:], ['--execution', EXECUTION, '--ordinary-user', ORDINARY,
                                   '--host-netns', 'net:[100]', '--tournament', TOURNAMENT, '--image', 'candidate'])
        self.assertNotIn('--scope', cmd)
        self.assertEqual(set(W.CLEAN_ENV), {'PATH', 'LANG', 'LC_ALL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'})
        self.assertNotIn('os.environ.copy', W.WORKER_ENTRY)
        self.assertIn('os.environ.get("INVOCATION_ID", "")', W.WORKER_ENTRY)

    def test_original_failure_cancellation_and_stop_failure_remain_nonzero(self):
        for mode in ('success', 'launch-failed', 'cancelled', 'stop-failed', 'terminal-live', 'receipt-stale', 'client-live', 'case-bytes-drift'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                item = self.attempt(Path(folder)); called = []
                def command(name, argv, timeout, allow=(0,)):
                    called.append((name, argv, timeout))
                    if name == 'systemd_qualifier' and mode in ('launch-failed', 'stop-failed'):
                        raise RuntimeError('original launch failed')
                    if name == 'systemd_qualifier' and mode == 'cancelled':
                        raise W.AttemptCancelled('cancelled')
                    if name == 'stop_owned_unit' and mode == 'stop-failed':
                        raise RuntimeError('stop failed')
                    return b''
                item.command = command
                def observe(_deadline):
                    if mode == 'terminal-live': raise RuntimeError('group still populated')
                    return terminal()
                item.terminal = observe
                if mode == 'client-live':
                    def live_client(_deadline): raise RuntimeError('original client exit unknown')
                    item.observe_clients = live_client
                value = receipt()
                if mode == 'receipt-stale': value['execution'] = ORDINARY
                def read_original(path, _limit):
                    if path.name == 'receipt.json': return json.dumps(value).encode()
                    return b'drift' if mode == 'case-bytes-drift' else b'unit-test case bytes'
                with patch.object(W, 'read_regular', side_effect=read_original), patch.object(signal, 'signal'):
                    result = item.run()
                self.assertEqual(result, 0 if mode == 'success' else 1)
                self.assertEqual(item.result['passed'], mode == 'success')
                self.assertEqual(sum(name == 'systemd_qualifier' for name, _, _ in called), 1)
                for name, cmd, _ in called:
                    if name == 'stop_owned_unit': self.assertEqual(cmd[-1], item.unit)
                if mode == 'stop-failed': self.assertEqual(len(item.result['failures']), 2)

    def test_terminal_observation_uses_original_deadline_not_six_second_iteration_cap(self):
        with tempfile.TemporaryDirectory() as folder:
            item = self.attempt(Path(folder)); clock = [0.0]; observations = []
            item.stop_requested = True
            def command(name, argv, timeout, allow=(0,)):
                observations.append(clock[0]); clock[0] += min(0.01, timeout)
                state = terminal()
                if clock[0] < 26:
                    state.update(ActiveState='deactivating', MainPID='42', ControlGroup=GROUP)
                return '\n'.join(key + '=' + value for key, value in state.items()).encode()
            item.command = command
            def sleep(seconds): clock[0] += seconds
            with patch.object(W.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(W.time, 'sleep', side_effect=sleep), \
                    patch.object(Path, 'lstat', side_effect=FileNotFoundError):
                observed = item.terminal(30)
            self.assertEqual(observed['MainPID'], '0')
            self.assertGreater(clock[0], 25)
            self.assertLess(clock[0], 30)
            self.assertTrue(item.result['terminal_cgroup']['absent'])
            self.assertGreater(len(observations), 30)

    def test_live_group_cannot_receive_fresh_cleanup_budgets(self):
        with tempfile.TemporaryDirectory() as folder:
            item = self.attempt(Path(folder)); clock = [0.0]
            item.stop_requested = True
            def command(name, argv, timeout, allow=(0,)):
                clock[0] += min(1, timeout)
                state = terminal(); state.update(ActiveState='deactivating', MainPID='42', ControlGroup=GROUP)
                return '\n'.join(key + '=' + value for key, value in state.items()).encode()
            item.command = command
            def sleep(seconds): clock[0] += seconds
            with patch.object(W.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(W.time, 'sleep', side_effect=sleep), \
                    self.assertRaisesRegex(RuntimeError, 'original outer cleanup deadline exhausted'):
                item.terminal(30)
            self.assertLessEqual(clock[0], 30)
            self.assertNotIn('terminal_cgroup', item.result)

    def test_checkout_mapping_includes_catalog_forward_and_rollback_sources(self):
        self.assertEqual(len(W.REPLACEMENTS), 15)
        for name in ('scripts/qualification/spin-expiry-lock-order.sql',
                     'scripts/qualification/spin-expiry-lock-order.component-inputs.sql',
                     'supabase/components/spin-expiry-lock-order.sql',
                     'supabase/components/spin-expiry-lock-order.rollback.sql'):
            self.assertEqual(W.REPLACEMENTS[name], name)
        self.assertIn('spin-catalog-observer.sql', W.REQUIRED)
        self.assertEqual(W.RESOURCES['unit_stop_seconds'], 25)

    def test_two_separate_allocations_stop_after_first_failed_original(self):
        for fail_image in (None, 'preimage', 'candidate'):
            calls = []
            class OriginalAttempt:
                def __init__(self, image): self.image = image; calls.append(image)
                def run(self): return 1 if self.image == fail_image else 0
            with self.subTest(fail_image=fail_image), patch.object(W, 'Attempt', OriginalAttempt), \
                    patch.object(W.sys, 'argv', ['test-spin-expiry-postgres.py']), patch.object(signal, 'signal') as handler:
                result = W.main()
            self.assertEqual(calls, ['preimage'] if fail_image == 'preimage' else ['preimage', 'candidate'])
            self.assertEqual(result, 0 if fail_image is None else 1)
            self.assertEqual(handler.call_count, 2 * len(calls))
