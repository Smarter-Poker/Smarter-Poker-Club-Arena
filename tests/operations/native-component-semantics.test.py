import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
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
                    'tuple': {'exact': 'fixture'}, 'runtime_image': 'immutable-test-runtime',
                    'schema_fixture_sha256': schema['fixture_sha256'],
                    'schema_catalogue_digest': schema['catalogue_digest'],
                    'success': True, 'executed': len(MODULE.CASES), 'failed': 0, 'skipped': 0, 'retries': 0,
                    'cases': [{'name': name, 'passed': True} for name in MODULE.CASES]}
        MODULE.validate_native(expected, expected['tuple'], schema, expected['runtime_image'])
        for change in [{'scope': 'native-boundary-only'}, {'skipped': 1}, {'retries': 1}, {'executed': 0},
                       {'cases': []}, {'tuple': {'substituted': True}}, {'schema_catalogue_digest': 'c' * 64}]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                MODULE.validate_native({**expected, **change}, expected['tuple'], schema, expected['runtime_image'])

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


if __name__ == '__main__':
    unittest.main()
