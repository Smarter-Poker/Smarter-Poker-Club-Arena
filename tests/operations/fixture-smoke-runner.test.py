import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('fixture_smoke', ROOT / 'operations/release/ci/fixture-smoke.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SHA = 'a' * 40
IMAGE = 'sha256:' + 'b' * 64
LABELS = {'org.opencontainers.image.revision': SHA,
          'org.opencontainers.image.source': 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena',
          'com.smarter-poker.scope': 'isolated-component-fixture',
          'com.smarter-poker.control-revision': SHA,
          'com.smarter-poker.source-revision': SHA}
RECORDS = [dict(scope='native-service-smoke', observer='passed', browser='chromium', retries=0,
                observation_bridge='native-synthetic-protocol', postgres_socket='denied'),
           dict(scope='native-service-smoke', postgres='17.11', extensions=7,
                cron=dict(source='9490f9cc9803f75105f2f7d89839a998f011f8d8',
                          extension_version='1.6.4', native_functions=7,
                          metadata_api='schedule-alter-unschedule-rollback',
                          application_ddl='denied', background_jobs='disabled',
                          production_binary_parity=False, complete_cron_acl_parity=False), auth='2.196.0', mfa='aal2',
                safeupdate={'library': 'safeupdate-1.4', 'source': '104f78d27b607076b49f22927ba33828fd0a98a0', 'fresh_session': 'authenticator-native-loaded', 'protected_setting_read': 'sql-and-http-42501', 'sql_refusals': 'update-delete-cte-21000', 'ordinary_disable': '42501', 'http': 'unfiltered-denied-filtered-committed', 'probe_cleanup': 'rows-restored-objects-absent', 'production_binary_parity': False, 'complete_role_graph_parity': False, 'production_pre_request_parity': False},
                ledger_attribution='banned-without-session',
                service_roles=dict(auth_admin_inheritance='disabled',
                                   auth_claim_helpers='service-owned-and-http-verified',
                                   authenticator_membership='set-without-inherit',
                                   auth_schema_owner='supabase_admin',
                                   auth_schema_create='auth-admin-only-among-application-callers',
                                   bootstrap_postgres='non-superuser-managed-owner',
                                   initdb_identity='supabase_admin',
                                   production_application_privilege_parity=False),
                managed_postgres=dict(library='supautils-3.4.3',
                                      source='e35f8affc4467202ff0d98f8dd14cb955bc13c75',
                                      application_superuser=False,
                                      owned_event_trigger='created-altered-fired',
                                      ordinary_role='trigger-fired-create-denied',
                                      rollback='schema-trigger-role-absent',
                                      production_binary_version_parity=False,
                                      complete_application_acl_parity=False),
                postgrest='14.5', realtime='2.134.10', change='observed', retries=0,
                realtime_listener='127.0.0.1:4000', realtime_gateway='authenticated-change-observed',
                realtime_rls='two-users-causal-isolation',
                observation_bridge='native-synthetic-protocol'),
           dict(scope='native-service-smoke', peer='passed', gateway='reachable',
                realtime_direct='refused', tenant_administration='refused')]
ROLE_ALIGNMENT = {'scope': 'native-full-role-installer', 'status': 'passed', 'stage': 'complete', 'template_sha256': '75de4863de9a9276e701526389a6fbe0a033589d60844b71dd42eb44fbdf31db', 'install_submitted': True, 'commit_acknowledged': True, 'catalog_outcome': 'committed', 'rollback_acknowledged': False, 'separate_read_only_observers': 4, 'graph_assertion': True, 'membership_assertion': True, 'actual_login_and_default_acl_tests': False, 'post_alignment_services': False, 'full_schema_ready': False, 'funded_or_production_complete': False, 'installer_backend_absent': True, 'all_driver_clients_closed': True, 'original_catalog_sha256': 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'aligned_catalog_sha256': 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'}
ROLE_FAULTS = dict(scope='native-role-fault-matrix', status='passed', stage='complete',
    all_clients_closed=True, production_or_funded=False, commit_transport_faults_qualified=False,
    cases=[dict(name=name, expected_refusal=True, rollback_acknowledged=True,
        original_catalog_sha256='c'*64, password_catalog_restored=True, backends_absent=True)
        for name in m.ROLE_FAULT_NAMES])


def failed_role_faults():
    row = json.loads(json.dumps(ROLE_FAULTS))
    row.update(status='failed', stage=m.ROLE_FAULT_NAMES[2], cases=row['cases'][:2],
        failure_step='fault-injection', failure_type='error', sqlstate='42501')
    return row

ROLE_ACCESS = dict(scope='native-role-access-defaults', status='passed', stage='complete',
    all_clients_closed=True, production_or_funded=False, set_role_pairs=250,
    administrative_denials=5, expired_cli_scram_denied=True, wrong_password_denied=True,
    read_only_write_denied=True, ordinary_creations=24, instrumented_default_materializations=3,
    storage_create_denials=3, temporary_schema_grants_restored=True, failure_cleanup_observed=False,
    privilege_checks=1080, actual_object_reads=270, all_objects_removed=True,
    original_aligned_catalog_restored=True, post_alignment_services=False, full_schema_ready=False,
    login_roles=[dict(name=name, authentication='peer' if name=='postgres' else 'scram-sha-256') for name in m.ROLE_LOGIN_NAMES],
    future_objects=[dict(creator=creator,schema=schema,type=kind,
        creation='instrumented-latent-default' if creator=='postgres' and schema=='storage' else 'ordinary',
        direct_acl_sha256='d'*64) for creator,schema in m.ROLE_DEFAULT_GROUPS for kind in ('S','f','r')])
PROVIDER_SEMANTICS = {
    'scope': 'native-five-provider-semantics', 'status': 'passed', 'stage': 'complete',
    'versions': {'http': '1.6', 'pg_net': '0.19.5', 'plpgsql_check': '2.7', 'postgis': '3.3.7', 'supabase_vault': '0.3.1'},
    'build_sha256': 'e' * 64, 'catalog_sha256': 'f' * 64,
    **{key: True for key in ('genuine_symbols', 'role_acl_catalog', 'actual_anon_vault_denial',
        'postgis_geometry_geography_gist', 'http_private_response', 'pg_net_worker_identity',
        'pg_net_commit_only', 'pg_net_rollback_absent', 'vault_encrypt_update_rollback',
        'plpgsql_valid_invalid', 'dummy_objects_removed', 'all_probe_clients_closed', 'private_http_closed')},
    **{key: False for key in ('production_binary_parity', 'complete_catalog_parity',
        'actual_login_and_default_acl_tests', 'post_alignment_services', 'full_schema_ready', 'funded_or_production_complete')},
}
POST_ALIGNMENT_AUTH = dict(scope='native-post-alignment-auth', status='passed',
    database='club_arena_qualification', postmaster_started_at='2026-09-14 00:00:00.123456+00',
    aligned_catalog_sha256='d'*64, provider_build_sha256='e'*64, provider_catalog_sha256='f'*64,
    fresh_application_client=True, auth_role='supabase_auth_admin', genuine_users=3,
    signed_in_sessions=3, persisted_aal1_sessions=2, persisted_aal2_sessions=1,
    persisted_verified_totp_factors=1, application_owner_boundary=True, auth_helper_boundary=True,
    genuine_migration_set=True, retries=0, post_alignment_auth=True, post_alignment_services=False,
    full_schema_ready=False, production_or_funded=False, fixture_resources_closed=True)

SMOKE = '\n'.join(map(json.dumps, RECORDS)) + '\nNative service smoke and container/network cleanup passed (not a product certificate).\n'


def catalog_fixture():
    def role(name, superuser=False):
        return dict(name=name, superuser=superuser, inherit=True, create_role=superuser,
                    create_db=superuser, login=True, replication=False, bypass_rls=False,
                    connection_limit=-1, valid_until=None, configuration=None)
    return dict(version=1, scope='owned-post-service-preimage', observed_at='2026-09-12T18:00:00+00:00',
                database='club_arena_qualification',
                role_scope='all roles including unconnected builtin and fixture roles',
                roles=[role('postgres'), role('supabase_admin', True), role('authenticator')],
                memberships=[dict(role='postgres', member='supabase_admin', grantor='supabase_admin',
                                  admin=True, inherit=False, set=True)], role_settings=None, default_acl=None,
                schemas=[dict(name='public', owner='postgres', acl=['postgres=UC/postgres'])],
                extensions=[dict(name='plpgsql', version='1.0', schema='pg_catalog', owner='supabase_admin')],
                production_parity=False, contains_passwords_or_user_rows=False)


def preimage_material(catalog=None, raw=None):
    catalog = catalog_fixture() if catalog is None else catalog
    raw = (json.dumps(catalog) + '\n').encode() if raw is None else raw
    proof = dict(scope='native-service-preimage', status='captured',
                 catalog_sha256=hashlib.sha256(raw).hexdigest(),
                 production_parity=False, application_schema_restored=False)
    proof.update({k: len(catalog[k] or []) for k in
                  ('roles', 'memberships', 'schemas', 'extensions', 'role_settings', 'default_acl')})
    return raw, proof


class RunnerTests(unittest.TestCase):
    def test_role_fault_receipt_requires_all36_and_original_cleanup(self):
        self.assertEqual(m.role_native_record(json.dumps(ROLE_FAULTS), 'faults'), ROLE_FAULTS)
        for mutate in [lambda row: row['cases'].pop(),
                       lambda row: row['cases'][0].update(expected_refusal=False),
                       lambda row: row['cases'][0].update(password_catalog_restored=False),
                       lambda row: row['cases'][0].update(name='invented-case'),
                       lambda row: row.update(status='failed'),
                       lambda row: row.update(commit_transport_faults_qualified=True)]:
            row=json.loads(json.dumps(ROLE_FAULTS));mutate(row)
            with self.assertRaises(RuntimeError):m.role_native_record(json.dumps(row),'faults')
        with self.assertRaises(RuntimeError):m.role_native_record(json.dumps(ROLE_FAULTS)+'\n'+json.dumps(ROLE_FAULTS),'faults')

    def test_role_access_receipt_never_labels_instrumented_objects_ordinary(self):
        self.assertEqual(m.role_native_record(json.dumps(ROLE_ACCESS),'access'),ROLE_ACCESS)
        for mutate in [lambda row:row.update(ordinary_creations=27),
                       lambda row:row.update(storage_create_denials=0),
                       lambda row:row.update(temporary_schema_grants_restored=False),
                       lambda row:row.update(failure_cleanup_observed=True),
                       lambda row:row['future_objects'][3].update(creation='ordinary'),
                       lambda row:row['future_objects'][0].update(direct_acl_sha256=''),
                       lambda row:row.update(privilege_checks=1079),
                       lambda row:row.update(post_alignment_services=True)]:
            row=json.loads(json.dumps(ROLE_ACCESS));mutate(row)
            with self.assertRaises(RuntimeError):m.role_native_record(json.dumps(row),'access')

    def test_role_native_receipts_reject_duplicate_keys_and_extra_fields(self):
        raw=json.dumps(ROLE_ACCESS)
        with self.assertRaises(RuntimeError):m.role_native_record(raw.replace('"status": "passed"','"status": "passed", "status": "passed"'),'access')
        with self.assertRaises(RuntimeError):m.role_native_record(json.dumps(dict(ROLE_ACCESS, token='PRIVATE')),'access')


    def test_safeupdate_proof_requires_native_http_and_cleanup(self):
        for transform in [lambda rows: rows[1].pop('safeupdate'),
                          lambda rows: rows[1]['safeupdate'].update(http='configuration-only'),
                          lambda rows: rows[1]['safeupdate'].pop('protected_setting_read'),
                          lambda rows: rows[1]['safeupdate'].update(protected_setting_read='allowed'),
                          lambda rows: rows[1]['safeupdate'].update(probe_cleanup='retained'),
                          lambda rows: rows[1]['safeupdate'].update(production_pre_request_parity=True)]:
            rows = json.loads(json.dumps(RECORDS))
            transform(rows)
            with self.assertRaisesRegex(RuntimeError, 'native_fixture_smoke_requirement_failed'):
                m.smoke_records('\n'.join(map(json.dumps, rows)) + '\nNative service smoke and container/network cleanup passed (not a product certificate).\n')

    def test_cron_provider_proof_is_mandatory_and_cannot_claim_background_execution(self):
        for transform in [lambda rows: rows[1].pop('cron'),
                          lambda rows: rows[1]['cron'].update(background_jobs='running'),
                          lambda rows: rows[1]['cron'].update(native_functions=3),
                          lambda rows: rows[1]['cron'].update(production_binary_parity=True)]:
            rows = json.loads(json.dumps(RECORDS))
            transform(rows)
            with self.assertRaisesRegex(RuntimeError, 'native_fixture_smoke_requirement_failed'):
                m.smoke_records('\n'.join(map(json.dumps, rows)) + '\nNative service smoke and container/network cleanup passed (not a product certificate).\n')

    def test_failed_actual_build_preserves_bounded_build_diagnostics(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / m.PREFIX / 'build-image.sh'
            script.parent.mkdir(parents=True)
            script.write_text("printf 'Reviewed build dependency missing\\n' >&2\nexit 7\n")
            diagnostic = root / 'native-build.log'
            env = {'PATH': os.environ['PATH'], 'FIXTURE_SMOKE_BUILD_LOG': str(diagnostic)}
            with self.assertRaises(RuntimeError):
                m.command(['bash', m.PREFIX + 'build-image.sh'], root, env)
            self.assertIn('Reviewed build dependency missing', diagnostic.read_text())
            self.assertEqual(diagnostic.stat().st_mode & 0o777, 0o600)

    def test_actual_native_service_failure_never_creates_build_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / m.PREFIX / 'smoke-image.sh'
            script.parent.mkdir(parents=True)
            script.write_text("printf 'PRIVATE RUNTIME TOKEN\\n' >&2\nexit 7\n")
            diagnostic = root / 'native-build.log'
            env = {'PATH': os.environ['PATH'], 'FIXTURE_SMOKE_BUILD_LOG': str(diagnostic)}
            with self.assertRaises(RuntimeError) as raised:
                m.command(['bash', m.PREFIX + 'smoke-image.sh'], root, env)
            self.assertFalse(diagnostic.exists())
            self.assertNotIn('PRIVATE RUNTIME', str(raised.exception))

    def test_actual_native_service_failure_retains_only_fixed_stage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / m.PREFIX / 'smoke-image.sh'
            script.parent.mkdir(parents=True)
            row = {'status': 'failed', 'stage': 'gotrue-genuine-migrations-and-mfa', 'error': 'Error'}
            script.write_text("printf '%s\\n' 'PRIVATE RUNTIME TOKEN' '" + json.dumps(row) + "' >&2\nexit 7\n")
            with self.assertRaises(m.NativeSmokeFailure) as raised:
                m.command(['bash', m.PREFIX + 'smoke-image.sh'], root, {'PATH': os.environ['PATH']})
            self.assertEqual(raised.exception.diagnostics, [{'stage': row['stage'], 'category': 'Error'}])
            self.assertNotIn('PRIVATE RUNTIME', repr(vars(raised.exception)))

    def test_native_diagnostics_reject_arbitrary_data(self):
        valid = {'status': 'failed', 'stage': 'initialization', 'reason': 'deadline'}
        rows = [valid, {**valid, 'extra': 'PRIVATE TOKEN'}, {**valid, 'stage': 'PRIVATE TOKEN'},
                {**valid, 'reason': 'PRIVATE TOKEN'},
                {'status': 'failed', 'stage': 'initialization', 'error': 'PRIVATE TOKEN'},
                {'status': 'failed', 'stage': 'initialization', 'error': ['Error']},
                {'status': 'failed', 'stage': ['initialization'], 'reason': 'deadline'},
                [], None, 'PRIVATE TOKEN']
        self.assertEqual(m.native_failures('\n'.join(map(json.dumps, rows))),
                         [{'stage': 'initialization', 'category': 'deadline'}])

    def test_native_postgres_error_name_retains_stage_without_query(self):
        row = {'status': 'failed', 'stage': 'postgresql-wal2json-native-slot', 'error': 'error'}
        self.assertEqual(m.native_failures(json.dumps(row)),
                         [{'stage': row['stage'], 'category': 'error'}])

    def exercise(self, fault=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / m.PREFIX
            fixture.mkdir(parents=True)
            for file in m.FILES:
                (fixture / file).write_text('committed fixture source')
            for relative in m.CONTROL_FILES:
                helper = root / relative
                helper.parent.mkdir(parents=True, exist_ok=True)
                helper.write_text('committed observation helper')
            if fault == 'symlink':
                (fixture / 'Dockerfile').unlink()
                (fixture / 'Dockerfile').symlink_to(fixture / 'package.json')
            calls = []
            present = set()
            network_present = False
            def run(args, cwd, env, timeout=120):
                nonlocal network_present
                calls.append(args)
                self.assertNotIn('GH_TOKEN', env)
                if args[:3] == ['git', 'rev-parse', 'HEAD']:
                    return 'c' * 40 if fault == 'revision' else SHA
                if args[:3] == ['docker', 'image', 'inspect']:
                    labels = dict(LABELS)
                    if fault == 'labels': labels['com.smarter-poker.control-revision'] = 'd' * 40
                    return json.dumps([{'Id': IMAGE, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Labels': labels}}])
                if args[:2] == ['bash', m.PREFIX + 'smoke-image.sh']:
                    if fault == 'timeout':
                        present.update((env['FIXTURE_SMOKE_CONTAINER'], env['FIXTURE_SMOKE_CONTAINER'] + '-peer', env['FIXTURE_SMOKE_CONTAINER'] + '-preimage'))
                        network_present = True
                        raise TimeoutError('PRIVATE TOKEN MUST NOT LEAK')
                    if fault == 'native-stage':
                        raise m.NativeSmokeFailure(json.dumps({'status': 'failed', 'stage': 'initialization', 'error': 'Error'}) + '\nPRIVATE TOKEN', 7)
                    if fault == 'native-role-stage':
                        raise m.NativeSmokeFailure(json.dumps(failed_role_faults()) + '\nPRIVATE TOKEN', 7)
                    if fault == 'native-provider-stage':
                        provider = dict(PROVIDER_SEMANTICS, status='failed', stage='postgis',
                            failure_type='error', sqlstate='42501')
                        raise m.NativeSmokeFailure(json.dumps(provider) + '\nPRIVATE TOKEN', 7)
                    raw, proof = preimage_material()
                    private = Path(env['FIXTURE_SERVICE_PREIMAGE_PATH'])
                    self.assertNotEqual(private.parent, root / 'evidence')
                    if fault == 'preimage-content':
                        raw = raw.replace(b'"superuser": false', b'"password": "PRIVATE TOKEN", "superuser": false', 1)
                        proof['catalog_sha256'] = hashlib.sha256(raw).hexdigest()
                    if fault != 'missing-preimage-file':
                        private.write_bytes(raw)
                    if fault == 'preimage-leftover':
                        present.add(env['FIXTURE_SMOKE_CONTAINER'] + '-preimage')
                    result = SMOKE if fault != 'missing-service' else json.dumps(RECORDS[0])
                    if fault != 'missing-role-proof':
                        result += json.dumps(ROLE_ALIGNMENT) + '\n'
                        result += json.dumps(ROLE_FAULTS) + '\n' + json.dumps(ROLE_ACCESS) + '\n'
                    if fault != 'missing-provider-proof':
                        result += json.dumps(PROVIDER_SEMANTICS) + '\n'
                    if fault != 'missing-auth-proof':
                        result += json.dumps(POST_ALIGNMENT_AUTH) + '\n'
                    return result if fault == 'missing-preimage-proof' else result + json.dumps(proof) + '\n'
                if args[:3] == ['docker', 'container', 'ls']:
                    owned = args[-1].removeprefix('name=^/').removesuffix('$')
                    return 'container-id' if owned in present else ''
                if args[:3] == ['docker', 'container', 'rm']:
                    present.discard(args[-1])
                if args[:3] == ['docker', 'network', 'ls']:
                    return env['FIXTURE_SMOKE_CONTAINER'] + '-network' if network_present else ''
                if args[:3] == ['docker', 'network', 'rm']:
                    network_present = False
                return ''
            code = m.execute(root, root / 'evidence', SHA, run)
            text = (root / 'evidence/native-smoke-receipt.json').read_text()
            self.assertNotIn('PRIVATE TOKEN', text)
            self.assertFalse(list(root.glob('.ca-fixture-smoke-*-preimage.json')))
            artifact = root / 'evidence/native-service-preimage.json'
            if fault in {'missing-preimage-file', 'missing-preimage-proof', 'preimage-content'}:
                self.assertFalse(artifact.exists())
            if code == 0:
                self.assertEqual(artifact.read_bytes(), preimage_material()[0])
            return code, json.loads(text), calls

    def test_complete_native_result(self):
        code, receipt, _ = self.exercise()
        self.assertEqual(code, 0)
        self.assertFalse(receipt['product_certificate'])
        self.assertTrue(all(receipt['cleanup'].values()))

    def test_provider_semantic_receipt_is_mandatory(self):
        self.assertEqual(self.exercise('missing-provider-proof')[0], 1)
        code, receipt, _ = self.exercise()
        self.assertEqual(code, 0)
        self.assertEqual(receipt['provider_semantics'], PROVIDER_SEMANTICS)

    def test_post_alignment_auth_is_mandatory_after_provider_success(self):
        code, receipt, _ = self.exercise('missing-auth-proof')
        self.assertEqual(code, 1)
        self.assertTrue(all(receipt['cleanup'].values()))
        code, receipt, _ = self.exercise()
        self.assertEqual(code, 0)
        self.assertEqual(receipt['post_alignment_auth'], POST_ALIGNMENT_AUTH)

    def test_provider_failure_survives_controller_and_cannot_admit_fixture(self):
        code, receipt, calls = self.exercise('native-provider-stage')
        self.assertEqual(code, 1)
        failure = receipt['provider_semantic_failure']
        self.assertEqual(failure['scope'], 'native-five-provider-semantics-failure')
        self.assertEqual(failure['stage'], 'postgis')
        self.assertEqual(failure['sqlstate'], '42501')
        self.assertEqual(failure['status'], 'failed')
        self.assertNotIn('provider_semantics', receipt)
        self.assertNotIn('PRIVATE', json.dumps(receipt))
        self.assertTrue(all(receipt['cleanup'].values()))
        with self.assertRaises(RuntimeError):
            m.provider_semantic_record(json.dumps(failure))

    def test_provider_failure_refuses_forged_unbounded_or_duplicate_fields(self):
        original = dict(PROVIDER_SEMANTICS, status='failed', stage='install',
            failure_type='error', sqlstate='42501', catalog_sha256=None)
        mutations = [('status','passed'), ('stage','PRIVATE SQL'), ('failure_type','PRIVATE KEY'),
            ('sqlstate','PRIVATE SQL'), ('all_probe_clients_closed',1), ('full_schema_ready',True),
            ('versions',{}), ('build_sha256','PRIVATE'), ('catalog_sha256','PRIVATE'), ('token','PRIVATE')]
        for key, value in mutations:
            with self.subTest(key=key):
                self.assertIsNone(m.provider_failure_record(json.dumps(dict(original, **{key:value}))))
        raw = json.dumps(original)
        self.assertIsNotNone(m.provider_failure_record(raw))
        self.assertIsNone(m.provider_failure_record(raw+'\n'+raw))
        self.assertIsNone(m.provider_failure_record(raw.replace('"status": "failed"', '"status": "failed", "status": "failed"')))
        self.assertIsNone(m.provider_failure_record('{'+(' '*4097)+'}'))

    def test_provider_semantic_receipt_refuses_incomplete_or_overclaimed_results(self):
        for key, value in [('status', 'failed'), ('private_http_closed', False),
                           ('all_probe_clients_closed', False), ('dummy_objects_removed', False),
                           ('pg_net_commit_only', False), ('pg_net_rollback_absent', False),
                           ('vault_encrypt_update_rollback', False), ('genuine_symbols', 1),
                           ('build_sha256', 'wrong'), ('catalog_sha256', None),
                           ('production_binary_parity', True), ('funded_or_production_complete', True)]:
            with self.subTest(key=key):
                changed = dict(PROVIDER_SEMANTICS, **{key: value})
                with self.assertRaises(RuntimeError): m.provider_semantic_record(json.dumps(changed))
        changed = dict(PROVIDER_SEMANTICS)
        changed.pop('private_http_closed')
        with self.assertRaises(RuntimeError): m.provider_semantic_record(json.dumps(changed))
        with self.assertRaises(RuntimeError): m.provider_semantic_record(json.dumps(PROVIDER_SEMANTICS) + '\n' + json.dumps(PROVIDER_SEMANTICS))
        with self.assertRaises(RuntimeError): m.provider_semantic_record(json.dumps(PROVIDER_SEMANTICS).replace('"status": "passed"', '"status": "passed", "status": "passed"'))
        self.assertEqual(m.provider_semantic_record(json.dumps(PROVIDER_SEMANTICS)), PROVIDER_SEMANTICS)

    def test_role_installer_native_receipt_is_mandatory(self):
        self.assertEqual(self.exercise('missing-role-proof')[0], 1)

    def test_role_installer_native_receipt_refuses_incomplete_or_overclaimed_results(self):
        for key, value in [('status', 'failed'), ('commit_acknowledged', False),
                           ('catalog_outcome', 'original'), ('rollback_acknowledged', True),
                           ('separate_read_only_observers', 3), ('separate_read_only_observers', True),
                           ('graph_assertion', False), ('membership_assertion', False),
                           ('all_driver_clients_closed', False), ('installer_backend_absent', False),
                           ('actual_login_and_default_acl_tests', True), ('post_alignment_services', True),
                           ('full_schema_ready', True), ('funded_or_production_complete', True),
                           ('template_sha256', 'a'*64), ('aligned_catalog_sha256', 'bad')]:
            with self.subTest(key=key, value=value):
                changed = dict(ROLE_ALIGNMENT); changed[key] = value
                with self.assertRaises(RuntimeError): m.role_alignment_record(json.dumps(changed))
        with self.assertRaises(RuntimeError):
            m.role_alignment_record(json.dumps(ROLE_ALIGNMENT) + '\n' + json.dumps(ROLE_ALIGNMENT))
        changed = dict(ROLE_ALIGNMENT); changed['secret'] = 'PRIVATE'
        with self.assertRaises(RuntimeError): m.role_alignment_record(json.dumps(changed))
        with self.assertRaises(RuntimeError):
            m.role_alignment_record(json.dumps(ROLE_ALIGNMENT).replace('"status": "passed"', '"status": "passed", "status": "passed"'))
        with self.assertRaises(RuntimeError):
            m.role_alignment_record(json.dumps(ROLE_ALIGNMENT).replace('"status": "passed"', '"status": "passed", "status": "passed"') + '\n' + json.dumps(ROLE_ALIGNMENT))
        self.assertEqual(m.role_alignment_record(json.dumps(ROLE_ALIGNMENT)), ROLE_ALIGNMENT)

    def test_source_revision_mismatch_prevents_build(self):
        code, _, calls = self.exercise('revision')
        self.assertEqual(code, 1)
        self.assertFalse(any(call[0] == 'bash' for call in calls))

    def test_symlink_context_refused(self):
        self.assertEqual(self.exercise('symlink')[0], 1)

    def test_wrong_control_label_prevents_smoke(self):
        code, _, calls = self.exercise('labels')
        self.assertEqual(code, 1)
        self.assertFalse(any(call[:2] == ['bash', m.PREFIX + 'smoke-image.sh'] for call in calls))

    def test_missing_service_observation_refused(self):
        self.assertEqual(self.exercise('missing-service')[0], 1)

    def test_native_failure_receipt_includes_only_safe_stage_and_cleanup(self):
        code, receipt, _ = self.exercise('native-stage')
        self.assertEqual(code, 1)
        self.assertEqual(receipt['native_failures'], [{'stage': 'initialization', 'category': 'Error'}])
        self.assertEqual(receipt['native_command_exit_code'], 7)
        self.assertTrue(all(receipt['cleanup'].values()))

    def test_role_failure_reaches_final_receipt_without_raw_output_or_pass_credit(self):
        code, receipt, _ = self.exercise('native-role-stage')
        self.assertEqual(code,1)
        self.assertEqual(receipt['role_native_fault_failure'],dict(
            scope='native-role-fault-matrix-failure',status='failed',stage=m.ROLE_FAULT_NAMES[2],
            failure_step='fault-injection',failure_type='error',sqlstate='42501',
            completed_cases=2,all_clients_closed=True))
        self.assertNotIn('role_native_faults',receipt)
        self.assertTrue(all(receipt['cleanup'].values()))

    def test_role_failure_parser_refuses_forged_or_unbounded_metadata(self):
        mutations=[lambda r:r.update(status='passed'),lambda r:r.update(stage='PRIVATE TOKEN'),
            lambda r:r.update(failure_step='PRIVATE SQL'),lambda r:r.update(failure_type='PRIVATE ERROR'),
            lambda r:r.update(sqlstate='PRIVATE TOKEN'),lambda r:r.update(token='PRIVATE TOKEN'),
            lambda r:r.update(all_clients_closed=1),lambda r:r.update(production_or_funded=True),
            lambda r:r.update(cases=r['cases'][::-1]),lambda r:r['cases'][0].update(rollback_acknowledged=False),
            lambda r:r['cases'][0].update(original_catalog_sha256='PRIVATE TOKEN'),
            lambda r:r.update(cases=ROLE_FAULTS['cases']*2)]
        for change in mutations:
            with self.subTest(change=change):
                row=failed_role_faults();change(row)
                self.assertIsNone(m.role_fault_failure(json.dumps(row)))
        raw=json.dumps(failed_role_faults())
        self.assertIsNone(m.role_fault_failure(raw+'\n'+raw))
        self.assertIsNone(m.role_fault_failure(raw.replace('"status": "failed"','"status": "failed", "status": "failed"')))
        self.assertIsNone(m.role_fault_failure('{'+(' '*20001)+'}'))

    def test_failed_role_diagnostic_can_never_satisfy_positive_fault_proof(self):
        with self.assertRaises(RuntimeError):
            m.role_native_record(json.dumps(failed_role_faults()),'faults')

    def test_timeout_cleans_exact_container_without_success(self):
        code, receipt, calls = self.exercise('timeout')
        self.assertEqual(code, 1)
        removals = [call for call in calls if call[:3] == ['docker', 'container', 'rm']]
        self.assertEqual(removals, [['docker', 'container', 'rm', '--force', receipt['preimage']],
                                   ['docker', 'container', 'rm', '--force', receipt['peer']],
                                   ['docker', 'container', 'rm', '--force', receipt['container']]])
        self.assertIn(['docker', 'network', 'rm', receipt['network']], calls)
        self.assertTrue(receipt['cleanup']['container_absent'])
        self.assertTrue(receipt['cleanup']['peer_absent'])
        self.assertTrue(receipt['cleanup']['preimage_absent'])
        self.assertTrue(receipt['cleanup']['network_absent'])

    def test_missing_peer_or_old_service_evidence_cannot_pass(self):
        for missing in (RECORDS[1], RECORDS[2]):
            with self.assertRaises(RuntimeError):
                m.smoke_records(SMOKE.replace(json.dumps(missing), ''))

    def test_duplicate_smoke_observation_refused(self):
        with self.assertRaises(RuntimeError):
            m.smoke_records(SMOKE + json.dumps(RECORDS[0]))

    def test_older_single_user_evidence_cannot_prove_two_user_isolation(self):
        old = dict(RECORDS[1])
        del old['realtime_rls']
        with self.assertRaises(RuntimeError):
            m.smoke_records(SMOKE.replace(json.dumps(RECORDS[1]), json.dumps(old)))

    def test_new_isolation_failure_retains_only_fixed_stage(self):
        for stage in ['realtime-two-user-causal-isolation', 'postgrest-two-user-isolation']:
            row = {'status': 'failed', 'stage': stage, 'error': 'AssertionError'}
            self.assertEqual(m.native_failures(json.dumps(row)),
                             [{'stage': stage, 'category': 'AssertionError'}])
            self.assertEqual(m.native_failures(json.dumps({**row, 'token': 'PRIVATE'})), [])

    def test_preimage_required_and_unvalidated_bytes_never_published(self):
        for fault in ('missing-preimage-file', 'missing-preimage-proof', 'preimage-content'):
            with self.subTest(fault=fault):
                self.assertEqual(self.exercise(fault)[0], 1)

    def test_preimage_rescue_cleanup_cannot_pass(self):
        code, receipt, calls = self.exercise('preimage-leftover')
        self.assertEqual(code, 1)
        self.assertTrue(receipt['cleanup']['preimage_absent'])
        self.assertIn(['docker', 'container', 'rm', '--force', receipt['preimage']], calls)


class PreimageTests(unittest.TestCase):
    def validate(self, catalog=None, proof_edit=None, raw=None, path_kind=None, duplicate=False):
        raw, proof = preimage_material(catalog, raw)
        if proof_edit:
            proof_edit(proof)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'catalog.json'
            if path_kind == 'symlink':
                target = Path(temporary) / 'target'
                target.write_bytes(raw)
                path.symlink_to(target)
            elif path_kind == 'fifo':
                os.mkfifo(path)
            else:
                path.write_bytes(raw)
            line = json.dumps(proof)
            return m.service_preimage(line + ('\n' + line if duplicate else ''), path)

    def test_exact_capture_hash_and_metadata(self):
        proof, raw = self.validate()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), proof['catalog_sha256'])
        self.assertFalse(proof['production_parity'])
        self.assertFalse(proof['application_schema_restored'])

    def test_hash_count_and_claim_mutations_refused(self):
        for edit in (lambda p: p.update(catalog_sha256='f' * 64),
                     lambda p: p.update(roles=1), lambda p: p.update(roles=True),
                     lambda p: p.update(production_parity=True),
                     lambda p: p.update(application_schema_restored=True),
                     lambda p: p.update(password='PRIVATE TOKEN')):
            with self.assertRaises(RuntimeError):
                self.validate(proof_edit=edit)
        with self.assertRaises(RuntimeError):
            self.validate(duplicate=True)

    def test_private_file_must_be_regular_bounded_and_not_symlink(self):
        for kind in ('symlink', 'fifo'):
            with self.subTest(kind=kind), self.assertRaises((RuntimeError, OSError)):
                self.validate(path_kind=kind)
        with self.assertRaises(RuntimeError):
            self.validate(raw=b' ' * (1024 * 1024 + 1))

    def test_unknown_fields_and_duplicate_catalog_keys_refused(self):
        mutations = [lambda c: c.update(password='PRIVATE TOKEN'),
                     lambda c: c['roles'][0].update(password='PRIVATE TOKEN'),
                     lambda c: c['roles'][0].update(superuser='false'),
                     lambda c: c.update(database='postgres'),
                     lambda c: c['memberships'][0].update(grantor='unknown'),
                     lambda c: c['memberships'].append(dict(c['memberships'][0])),
                     lambda c: c['schemas'].append(dict(c['schemas'][0])),
                     lambda c: c.update(extensions=[])]
        for edit in mutations:
            catalog = catalog_fixture()
            edit(catalog)
            with self.assertRaises(RuntimeError):
                self.validate(catalog)
        raw, _ = preimage_material()
        with self.assertRaises(RuntimeError):
            self.validate(raw=raw.replace(b'"version": 1', b'"version": "PRIVATE TOKEN", "version": 1'))

    def test_only_reviewed_configuration_values_visible(self):
        c = catalog_fixture()
        known = dict(key='search_path', value='"\\$user", public, extensions')
        known['value_md5'] = hashlib.md5(known['value'].encode()).hexdigest()
        hidden = dict(key='unreviewed.key', value=None, value_md5='a' * 32)
        c['roles'][0]['configuration'] = [known, hidden]
        c['role_settings'] = [dict(role='ALL', database='OWNED_DATABASE', settings=[dict(
            key='app.settings.jwt_exp', value='3600', value_md5=hashlib.md5(b'3600').hexdigest())])]
        self.validate(c)
        for edit in (lambda: hidden.update(value='PRIVATE TOKEN'),
                     lambda: known.update(value_md5='a' * 32),
                     lambda: known.update(value=None)):
            edit()
            with self.assertRaises(RuntimeError):
                self.validate(c)
            hidden['value'] = None
            known.update(value='"\\$user", public, extensions')
            known['value_md5'] = hashlib.md5(known['value'].encode()).hexdigest()

    def test_default_acl_full_shape_and_grantor_are_required(self):
        c = catalog_fixture()
        c['default_acl'] = [dict(creator='postgres', schema='GLOBAL', type='f', acl=[dict(
            grantor='postgres', grantee='PUBLIC', privilege='EXECUTE', grantable=False)])]
        self.validate(c)
        c['default_acl'][0]['acl'][0]['grantor'] = 'unknown'
        with self.assertRaises(RuntimeError):
            self.validate(c)


class AttachedAuthReceiptTests(unittest.TestCase):
    def check(self, output, alignment=ROLE_ALIGNMENT, providers=PROVIDER_SEMANTICS):
        return m.post_alignment_auth_record(output, alignment, providers)

    def test_exact_auth_proof_keeps_larger_scope_unqualified(self):
        self.assertEqual(self.check(json.dumps(POST_ALIGNMENT_AUTH)), POST_ALIGNMENT_AUTH)
        self.assertFalse(POST_ALIGNMENT_AUTH['full_schema_ready'])

    def test_refuses_missing_duplicate_or_extra_credential_fields(self):
        row = json.dumps(POST_ALIGNMENT_AUTH)
        for output in ['', row+'\n'+row, row[:-1]+', "status":"passed"}',
                       json.dumps(dict(POST_ALIGNMENT_AUTH, access_token='PRIVATE'))]:
            with self.subTest(output_shape=len(output)), self.assertRaises(RuntimeError):
                self.check(output)

    def test_refuses_every_incomplete_or_overclaimed_observation(self):
        for key, original in POST_ALIGNMENT_AUTH.items():
            if key == 'postmaster_started_at': changed = 'PRIVATE'
            elif isinstance(original, bool): changed = not original
            elif isinstance(original, int): changed = original + 1
            else: changed = 'wrong'
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.check(json.dumps(dict(POST_ALIGNMENT_AUTH, **{key:changed})))

    def test_refuses_other_role_or_provider_instance_evidence(self):
        for alignment, providers in [(dict(ROLE_ALIGNMENT, aligned_catalog_sha256='a'*64), PROVIDER_SEMANTICS),
                                     (ROLE_ALIGNMENT, dict(PROVIDER_SEMANTICS, build_sha256='a'*64)),
                                     (ROLE_ALIGNMENT, dict(PROVIDER_SEMANTICS, catalog_sha256='a'*64))]:
            with self.assertRaises(RuntimeError):
                self.check(json.dumps(POST_ALIGNMENT_AUTH), alignment, providers)

if __name__ == '__main__':
    unittest.main()
