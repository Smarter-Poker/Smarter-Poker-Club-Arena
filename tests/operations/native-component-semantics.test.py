import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('semantics', ROOT / 'operations/release/native/qualify-components.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class NativeArtifactBoundary(unittest.TestCase):
    def web(self, directory, *, tamper=False, extra=False, symlink=False):
        documents = {'index.html': b'<script src="/assets/a.js"></script>',
                     'assets/a.js': b'globalThis.fixture = "https://kuklfnapbkmacvwxktbh.supabase.co"',
                     'build-info.json': json.dumps({'ca_sha': 'a' * 40}).encode()}
        manifest = ''.join(f'{MODULE.digest(body)}  {name}\n' for name, body in documents.items()).encode()
        expected = {'source_sha': 'a' * 40, 'manifest_digest': MODULE.digest(manifest),
                    'identity': 'sha256:' + MODULE.digest(manifest)}
        documents['.release-manifest.sha256'] = manifest
        if tamper:
            documents['assets/a.js'] = b'globalThis.fixture = "substituted bytes"'
        if extra:
            documents['unlisted.js'] = b'unmanifested executable'
        path = Path(directory) / 'web.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, body in documents.items():
                archive.writestr(name, body)
            if symlink:
                info = zipfile.ZipInfo('escape')
                info.external_attr = 0o120777 << 16
                archive.writestr(info, '/etc/passwd')
        return path, expected

    def test_actual_archive_bytes_and_complete_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            path, expected = self.web(directory)
            MODULE.validate_web(path, expected)
            MODULE.validate_web(path, expected, 'kuklfnapbkmacvwxktbh.supabase.co')
            with self.assertRaises(RuntimeError):
                MODULE.validate_web(path, expected, 'aaaaaaaaaaaaaaaaaaaa.supabase.co')
        for mutation in ['tamper', 'extra', 'symlink']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                path, expected = self.web(directory, **{mutation: True})
                with self.assertRaises(RuntimeError):
                    MODULE.validate_web(path, expected)

    def test_supabase_routing_is_one_lowercase_project_hostname_not_an_egress_address(self):
        self.assertEqual(MODULE.supabase_hostname('kuklfnapbkmacvwxktbh.supabase.co'),
                         'kuklfnapbkmacvwxktbh.supabase.co')
        for value in ['https://kuklfnapbkmacvwxktbh.supabase.co', 'KUKLFNAPBKMACVWXKTBH.supabase.co',
                      'kuklfnapbkmacvwxktbh.supabase.co:443', 'kuklfnapbkmacvwxktbh.supabase.co/path',
                      'user@kuklfnapbkmacvwxktbh.supabase.co', '127.0.0.1', '*.supabase.co',
                      'kuklfnapbkmacvwxktbh.supabase.co.evil', ['kuklfnapbkmacvwxktbh.supabase.co']]:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                MODULE.supabase_hostname(value)

    def test_native_pass_requires_product_cases_no_skip_no_retry_no_fabricated_artifact_scope(self):
        schema = {'fixture_sha256': 'a' * 64, 'catalogue_digest': 'b' * 64}
        expected = {'scope': 'club-arena-product', 'product_suite': 'live-table-schema-v1',
                    'tuple': {'club-arena-engine': {'source_sha': 'a' * 40}}, 'runtime_image': 'immutable-test-runtime',
                    'schema_fixture_sha256': schema['fixture_sha256'],
                    'schema_catalogue_digest': schema['catalogue_digest'],
                    'success': True, 'executed': len(MODULE.CASES), 'failed': 0, 'skipped': 0, 'retries': 0,
                    'cases': [{'name': name, 'passed': True} for name in MODULE.CASES],
                    'engine_readiness': {'timeout_ms': 90000, 'elapsed_ms': 400,
                                         'observations': 3, 'source_sha': 'a' * 40, 'running': True}}
        MODULE.validate_native(expected, expected['tuple'], schema, expected['runtime_image'])
        for change in [{'scope': 'native-boundary-only'}, {'skipped': 1}, {'retries': 1}, {'executed': 0},
                       {'cases': []}, {'tuple': {'substituted': True}}, {'schema_catalogue_digest': 'c' * 64}]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                MODULE.validate_native({**expected, **change}, expected['tuple'], schema, expected['runtime_image'])
        for change in [{'timeout_ms': 240000}, {'elapsed_ms': 90001}, {'observations': 0},
                       {'source_sha': 'b' * 40}, {'running': False}]:
            with self.subTest(readiness=change), self.assertRaises(RuntimeError):
                MODULE.validate_native({**expected, 'engine_readiness': {**expected['engine_readiness'], **change}},
                                       expected['tuple'], schema, expected['runtime_image'])

    def test_sequential_matrix_cannot_skip_or_substitute_the_intermediate_tuple(self):
        before = {'club-arena-engine': {'identity': 'old-engine'}, 'club-arena-web': {'identity': 'old-web'}}
        after = {'club-arena-engine': {'identity': 'new-engine'}, 'club-arena-web': {'identity': 'new-web'}}
        middle = {**before, 'club-arena-engine': after['club-arena-engine']}
        plan = {'version': 1, 'tuples': [before, middle, after],
                'cutover_order': ['club-arena-engine', 'club-arena-web'], 'component_builds': after,
                'artifact_inputs': {MODULE.fact_digest({'target': target, **value}): {'target': target, **value}
                                    for item in [before, middle, after] for target, value in item.items()}}
        MODULE.validate_plan(plan)
        for tuples in [[before, after], [before, after, after], [after, middle, after]]:
            with self.subTest(tuples=tuples), self.assertRaises(RuntimeError):
                MODULE.validate_plan({**plan, 'tuples': tuples})

    def test_financial_receipt_cannot_be_promoted_to_product_or_claim_early_cleanup(self):
        schema = {'fixture_sha256': 'b' * 64, 'catalogue_digest': 'c' * 64}
        component = {'club-arena-engine': {'source_sha': 'a' * 40}}
        result = {'version': 1, 'scope': 'club-arena-financial-route', 'product_certificate': False,
                  'tuple': component, 'runtime_image': 'fixture-test',
                  'schema_fixture_sha256': schema['fixture_sha256'], 'schema_catalogue_digest': schema['catalogue_digest'],
                  'success': True, 'executed': 3, 'failed': 0, 'skipped': 0, 'retries': 0,
                  'cases': [{'name': name, 'passed': True} for name in MODULE.FINANCIAL_CASES],
                  'engine_readiness': {'timeout_ms': 90000, 'elapsed_ms': 1, 'observations': 1,
                                       'source_sha': 'a' * 40, 'running': True},
                  'financial': {'scope': 'independent-financial-route-observations', 'product_certificate': False,
                                'owner': {'sourceSha': 'a' * 40}, 'checkpoints': [{'entry': {'phase': phase}} for phase in [
                                    'topup.before', 'topup.malformed_refused', 'topup.accepted', 'topup.replayed',
                                    'insurance.offered', 'insurance.malformed_refused', 'insurance.accepted', 'settlement.observed']]},
                  'cleanup': {'complete': False, 'owner': 'outer-native-driver'}}
        MODULE.validate_financial_native(result, component, schema, 'fixture-test')
        with self.assertRaisesRegex(RuntimeError, 'PRODUCT_EXECUTION_REQUIRED'):
            MODULE.validate_native(result, component, schema, 'fixture-test')
        for change in [{'product_certificate': True}, {'scope': 'club-arena-product'}, {'skipped': 1},
                       {'retries': 1}, {'executed': 5}, {'cleanup': {'complete': True}}, {'financial': {}}]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                MODULE.validate_financial_native({**result, **change}, component, schema, 'fixture-test')

    def test_schema_readiness_refuses_absent_partial_or_excluded_contract(self):
        valid = {'version': 1, 'source_sha': 'e' * 40,
                 'current_database_contract_ready': True, 'exclusions': []}
        self.assertEqual(MODULE.validate_source_contract(valid), 'e' * 40)
        for value in [None, {}, [], {**valid, 'version': True},
                      {**valid, 'current_database_contract_ready': False},
                      {**valid, 'exclusions': ['application-role-acl-baseline']},
                      {**valid, 'source_sha': 'not-a-sha'}, {**valid, 'unexpected': True}]:
            with self.subTest(contract=value), self.assertRaises(RuntimeError):
                MODULE.validate_source_contract(value)

    def test_driver_uses_separate_fixture_and_oracle_users_with_owned_writable_scratch(self):
        # Drive the actual Python orchestration through verified local ZIPs.
        # Docker/provider calls are explicit test doubles and stop before the
        # oracle: this test cannot manufacture a passing product receipt.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            web_path, web = self.web(directory)
            schema_sql = b'-- isolated driver-boundary fixture only\n'
            schema_path = root / 'schema.zip'
            with zipfile.ZipFile(schema_path, 'w') as archive:
                archive.writestr('schema.sql', schema_sql)
                archive.writestr('fixture.json', json.dumps({'supabase_host': 'kuklfnapbkmacvwxktbh.supabase.co', 'source_contract': {'version': 1, 'source_sha': 'e' * 40, 'current_database_contract_ready': True, 'exclusions': []}}))
            engine = {'source_sha': 'a' * 40, 'identity': 'sha256:' + 'b' * 64}
            components = {'club-arena-engine': engine, 'club-arena-web': web}
            plan = {'version': 1, 'tuples': [components, components],
                    'cutover_order': ['club-arena-web'], 'component_builds': {'club-arena-web': web},
                    'schema': {'artifact_id': 'schema', 'fixture_sha256': MODULE.digest(schema_sql), 'catalogue_digest': 'f' * 64},
                    'artifact_inputs': {MODULE.fact_digest({'target': target, **value}):
                                        {'target': target, **value, 'artifact_id': target}
                                        for target, value in components.items()}}
            request = {'phase': 'COMPATIBILITY', 'repository': MODULE.REPO,
                       'runtime_image': 'fixture@sha256:' + 'c' * 64, 'control_sha': 'd' * 40,
                       'qualification': plan}
            operation = '12345678-1234-1234-1234-123456789012'
            calls = []

            def command(args, **kwargs):
                calls.append(args)
                value = b''
                if args[:3] == ['docker', 'run', '-d'] and 'start' in args:
                    mount = next(args[i + 1] for i, arg in enumerate(args)
                                 if arg == '--mount' and 'target=/inputs,' in args[i + 1])
                    inputs = Path(next(part.removeprefix('source=') for part in mount.split(',')
                                       if part.startswith('source=')))
                    self.assertEqual(inputs.stat().st_mode & 0o777, 0o755)
                    self.assertTrue(all(item.stat().st_mode & 0o777 == 0o444 for item in inputs.iterdir()))
                    self.assertEqual(json.loads((inputs / 'observation-control.json').read_text()), {'version': 1, 'control_sha': request['control_sha']})
                if args[0] == 'git':
                    value = request['control_sha'].encode()
                elif args[-1] == 'capabilities':
                    value = json.dumps({'version': 1, 'scope': 'isolated-club-arena-fixture',
                                        'product_suite': 'live-table-schema-v1',
                                        'services': ['auth', 'postgresql', 'postgrest', 'realtime', 'tls-proxy'],
                                        'browser': 'chromium', 'fixture_credentials': 'synthetic-local-only'}).encode()
                elif args[:3] == ['docker', 'network', 'inspect']:
                    value = b'[{"Internal":true}]'
                elif args[-1] == 'engine-environment':
                    value = json.dumps({'SUPABASE_URL': 'http://fixture:8000',
                                        'SUPABASE_SERVICE_ROLE_KEY': 'synthetic-local-fixture-value',
                                        'PORT': '8080', 'NODE_ENV': 'production'}).encode()
                elif args[:2] == ['docker', 'inspect']:
                    value = json.dumps([{'Image': engine['identity']}]).encode()
                elif '/opt/qualification/node_modules/.bin/tsx' in args:
                    raise RuntimeError('RELEASE_TEST_STOP_BEFORE_ORACLE')
                return subprocess.CompletedProcess(args, 0, stdout=value, stderr=b'')

            def download(provenance, output):
                if provenance['artifact_id'] == 'schema':
                    shutil.copyfile(schema_path, output)
                elif provenance['artifact_id'] == 'club-arena-web':
                    shutil.copyfile(web_path, output)
                else:
                    output.write_bytes(b'engine image is not executed by this boundary test')

            environment = {'GITHUB_REPOSITORY': MODULE.REPO, 'GITHUB_RUN_ATTEMPT': '1',
                           'GITHUB_RUN_ID': '123', 'GITHUB_SHA': request['control_sha'],
                           'GH_TOKEN': 'provider-value-must-never-enter-candidate-command'}
            output = root / 'evidence'
            for scenario in ('product', 'financial'):
                with patch.dict(os.environ, environment), patch.object(MODULE, 'command', side_effect=command), \
                        patch.object(MODULE, 'provider', return_value={'total_count': 1, 'jobs': [
                            {'id': 456, 'name': 'qualify', 'status': 'in_progress'}]}), \
                        patch.object(MODULE, 'download_artifact', side_effect=download), \
                        patch.object(MODULE, 'unpack_engine'):
                    selected_output = output if scenario == 'product' else root / 'financial-evidence'
                    with self.assertRaisesRegex(RuntimeError, 'RELEASE_TEST_STOP_BEFORE_ORACLE'):
                        MODULE.qualify(request, operation, root / 'controls', selected_output, scenario=scenario)
                self.assertFalse((selected_output / 'receipt.json').exists())
                self.assertFalse((selected_output / 'financial-route-observations.json').exists())
                self.assertTrue(json.loads((selected_output / 'cleanup/receipt.json').read_text())['complete'])

            financial_run = next(args for args in calls if '--scenario=financial' in args)
            self.assertEqual(financial_run[financial_run.index('--user') + 1], '1000:1000')
            financial_oracle = next(args for args in calls if any(arg.endswith('/financial-route-suite.mjs') for arg in args))
            self.assertEqual(financial_oracle[financial_oracle.index('--user') + 1], 'qualification')
            self.assertNotIn('--scenario=financial', next(args for args in calls if args[:3] == ['docker', 'run', '-d'] and 'start' in args))

            fixture_run = next(args for args in calls if args[:3] == ['docker', 'run', '-d'] and 'start' in args)
            self.assertEqual(fixture_run[fixture_run.index('--user') + 1], '1000:1000')
            self.assertIn('--read-only', fixture_run)
            self.assertIn('--cap-drop=ALL', fixture_run)
            self.assertEqual(fixture_run[fixture_run.index('--sysctl') + 1],
                             'net.ipv4.ip_unprivileged_port_start=0')
            self.assertIn('--security-opt=no-new-privileges', fixture_run)
            tmpfs = [fixture_run[i + 1] for i, arg in enumerate(fixture_run) if arg == '--tmpfs']
            self.assertEqual(len(tmpfs), 4)
            parsed = {mount.split(':', 1)[0]: set(mount.split(':', 1)[1].split(',')) for mount in tmpfs}
            self.assertEqual(set(parsed), {'/tmp', '/run', '/var/lib/postgresql', '/run/fixture-observer'})
            for name, options in parsed.items():
                if name == '/run/fixture-observer':
                    self.assertTrue({'uid=1000', 'gid=1001', 'rw', 'nosuid', 'noexec', 'mode=2750'} <= options)
                else:
                    self.assertTrue({'uid=1000', 'gid=1000', 'rw', 'nosuid'} <= options)
            self.assertIn('mode=1777', parsed['/tmp'])
            oracle = next(args for args in calls if '/opt/qualification/node_modules/.bin/tsx' in args)
            self.assertEqual(oracle[oracle.index('--user') + 1], 'qualification')
            self.assertEqual([oracle[i + 1] for i, arg in enumerate(oracle) if arg == '--env'],
                             ['HOME=/tmp/qualification', 'TMPDIR=/tmp',
                              'XDG_CACHE_HOME=/tmp/qualification/cache'])
            self.assertFalse(any('--group-add' in args for args in calls))
            for verb in ('capabilities', 'start', 'ready', 'engine-environment'):
                invocation = next(args for args in calls if verb in args)
                self.assertEqual(invocation[invocation.index(verb) - 1], '/usr/local/bin/fixture-server')
            self.assertNotIn(environment['GH_TOKEN'], repr(calls))
            self.assertFalse((output / 'receipt.json').exists())
            self.assertTrue(json.loads((output / 'cleanup/receipt.json').read_text())['complete'])

            # Explicit native-result doubles exercise only driver artifact and
            # cleanup routing. They are not genuine Auth/engine evidence.
            def financial_command(args, **kwargs):
                if '/opt/qualification/node_modules/.bin/tsx' not in args:
                    return command(args, **kwargs)
                index = int(args[-2])
                native = {'version': 1, 'scope': 'club-arena-financial-route', 'product_certificate': False,
                          'tuple': plan['tuples'][index], 'runtime_image': request['runtime_image'],
                          'schema_fixture_sha256': plan['schema']['fixture_sha256'], 'schema_catalogue_digest': 'f' * 64,
                          'success': True, 'executed': 3, 'failed': 0, 'skipped': 0, 'retries': 0,
                          'cases': [{'name': name, 'passed': True} for name in MODULE.FINANCIAL_CASES],
                          'engine_readiness': {'timeout_ms': 90000, 'elapsed_ms': 1, 'observations': 1,
                                               'source_sha': 'a' * 40, 'running': True},
                          'financial': {'scope': 'independent-financial-route-observations', 'product_certificate': False,
                                        'owner': {'sourceSha': 'a' * 40}, 'checkpoints': [{'entry': {'phase': phase}} for phase in [
                                            'topup.before', 'topup.malformed_refused', 'topup.accepted', 'topup.replayed',
                                            'insurance.offered', 'insurance.malformed_refused', 'insurance.accepted', 'settlement.observed']]},
                          'cleanup': {'complete': False, 'owner': 'outer-native-driver'}}
                return subprocess.CompletedProcess(args, 0, stdout=('FINANCIAL_ROUTE_RESULT:' + json.dumps(native)).encode(), stderr=b'')

            financial_output = root / 'financial-complete-boundary'
            with patch.dict(os.environ, environment), patch.object(MODULE, 'command', side_effect=financial_command), \
                    patch.object(MODULE, 'provider', return_value={'total_count': 1, 'jobs': [
                        {'id': 456, 'name': 'qualify', 'status': 'in_progress'}]}), \
                    patch.object(MODULE, 'download_artifact', side_effect=download), patch.object(MODULE, 'unpack_engine'):
                MODULE.qualify(request, operation, root / 'controls', financial_output, scenario='financial')
            scoped = json.loads((financial_output / 'financial-route-observations.json').read_text())
            self.assertFalse((financial_output / 'receipt.json').exists())
            self.assertFalse(scoped['product_certificate'])
            self.assertEqual(scoped['scope'], 'isolated-financial-route-observations')
            self.assertTrue(scoped['cleanup']['complete'])
            self.assertEqual(len(scoped['combinations']), len(plan['tuples']))
            self.assertTrue(all(item['cleanup']['complete'] for item in scoped['combinations']))

            # An explicitly unready donor never reaches candidate image loading,
            # fixture start, SQL execution or the oracle, even with valid ZIPs.
            with zipfile.ZipFile(schema_path, 'w') as archive:
                archive.writestr('schema.sql', schema_sql)
                archive.writestr('fixture.json', json.dumps({
                    'supabase_host': 'kuklfnapbkmacvwxktbh.supabase.co',
                    'source_contract': {'version': 1, 'source_sha': 'e' * 40,
                        'current_database_contract_ready': False,
                        'exclusions': ['application-role-acl-baseline']}}))
            calls.clear()
            with patch.dict(os.environ, environment), patch.object(MODULE, 'command', side_effect=command), \
                    patch.object(MODULE, 'provider', return_value={'total_count': 1, 'jobs': [
                        {'id': 456, 'name': 'qualify', 'status': 'in_progress'}]}), \
                    patch.object(MODULE, 'download_artifact', side_effect=download), \
                    patch.object(MODULE, 'unpack_engine') as unpack:
                with self.assertRaisesRegex(RuntimeError, 'CURRENT_DATABASE_CONTRACT_REQUIRED'):
                    MODULE.qualify(request, operation, root / 'controls', root / 'unready-evidence')
                unpack.assert_not_called()
            self.assertFalse(any(args[:3] == ['docker', 'run', '-d'] for args in calls))
            self.assertFalse(any('/opt/qualification/node_modules/.bin/tsx' in args for args in calls))



if __name__ == '__main__':
    unittest.main()
