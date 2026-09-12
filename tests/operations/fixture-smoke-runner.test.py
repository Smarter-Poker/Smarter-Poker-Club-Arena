import importlib.util
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
SMOKE = '\n'.join(map(json.dumps, RECORDS)) + '\nNative service smoke and container/network cleanup passed (not a product certificate).\n'


class RunnerTests(unittest.TestCase):
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
                        present.update((env['FIXTURE_SMOKE_CONTAINER'], env['FIXTURE_SMOKE_CONTAINER'] + '-peer'))
                        network_present = True
                        raise TimeoutError('PRIVATE TOKEN MUST NOT LEAK')
                    if fault == 'native-stage':
                        raise m.NativeSmokeFailure(json.dumps({'status': 'failed', 'stage': 'initialization', 'error': 'Error'}) + '\nPRIVATE TOKEN')
                    return SMOKE if fault != 'missing-service' else json.dumps(RECORDS[0])
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
            return code, json.loads(text), calls

    def test_complete_native_result(self):
        code, receipt, _ = self.exercise()
        self.assertEqual(code, 0)
        self.assertFalse(receipt['product_certificate'])
        self.assertTrue(all(receipt['cleanup'].values()))

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
        self.assertTrue(all(receipt['cleanup'].values()))

    def test_timeout_cleans_exact_container_without_success(self):
        code, receipt, calls = self.exercise('timeout')
        self.assertEqual(code, 1)
        removals = [call for call in calls if call[:3] == ['docker', 'container', 'rm']]
        self.assertEqual(removals, [['docker', 'container', 'rm', '--force', receipt['peer']],
                                   ['docker', 'container', 'rm', '--force', receipt['container']]])
        self.assertIn(['docker', 'network', 'rm', receipt['network']], calls)
        self.assertTrue(receipt['cleanup']['container_absent'])
        self.assertTrue(receipt['cleanup']['peer_absent'])
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


if __name__ == '__main__':
    unittest.main()
