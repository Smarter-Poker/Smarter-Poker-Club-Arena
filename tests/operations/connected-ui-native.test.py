import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('connected', ROOT / 'operations/release/native/observe-connected-ui.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class NativeObservationAuthority(unittest.TestCase):
    def test_protected_same_job_identity_and_every_negative_boundary(self):
        sha = 'a' * 40
        env = {'GITHUB_WORKFLOW_REF': MODULE.CALLER, 'GITHUB_EVENT_NAME': 'workflow_dispatch',
               'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY_ID': str(MODULE.native.REPOSITORY_ID),
               'GITHUB_REPOSITORY': MODULE.REPO, 'GITHUB_SHA': sha,
               'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
        def provider(route):
            if route == '/repos/' + MODULE.REPO:
                return {'id': MODULE.native.REPOSITORY_ID, 'full_name': MODULE.REPO}
            if route.endswith('/actions/runs/123'):
                return {'id': 123, 'run_attempt': 1, 'repository': {'id': MODULE.native.REPOSITORY_ID},
                        'head_repository': {'id': MODULE.native.REPOSITORY_ID}, 'head_sha': sha,
                        'head_branch': 'main', 'event': 'workflow_dispatch', 'status': 'in_progress',
                        'path': '.github/workflows/schema-manifest-refresh.yml'}
            self.assertTrue(route.endswith('/actions/runs/123/attempts/1/jobs?per_page=100'))
            return {'total_count': 1, 'jobs': [{'id': 456,
                'name': 'isolated-connected-ui / native-smoke', 'status': 'in_progress'}]}
        with patch.dict(os.environ, env, clear=True), patch.object(MODULE.native, 'provider', provider):
            self.assertEqual(MODULE.context(sha)['job_id'], '456')
            for key, value in [('DATABASE_URL', 'redacted'), ('SUPABASE_DB_PASSWORD', 'redacted'),
                    ('SUPABASE_SERVICE_ROLE_KEY', 'redacted'), ('GITHUB_REF', 'refs/heads/unsafe'),
                    ('GITHUB_WORKFLOW_REF', MODULE.CALLER.replace('schema-manifest-refresh', 'other')),
                    ('GITHUB_EVENT_NAME', 'pull_request'), ('GITHUB_REPOSITORY_ID', '42'),
                    ('GITHUB_SHA', 'b' * 40)]:
                with self.subTest(key=key), patch.dict(os.environ, {key: value}), self.assertRaises(RuntimeError):
                    MODULE.context(sha)

    def test_candidate_uses_actual_producer_build_run_key_and_exact_original_bytes(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {'RUNNER_TEMP': temporary}):
            folder = Path(temporary) / 'isolated-schema-candidate'
            folder.mkdir(mode=0o700)
            files = {}
            for name in MODULE.CAPTURE_FILES - {'schema-capture-manifest.json'}:
                path = folder / name
                path.write_bytes(b'private test bytes')
                path.chmod(0o600)
                files[name] = {'bytes': path.stat().st_size, 'sha256': MODULE.native.file_digest(path)}
            manifest = {'source_sha': 'a' * 40, 'build_run_id': '123', 'run_attempt': 1,
                'transaction': 'REPEATABLE READ READ ONLY', 'private_same_job_only': True,
                'public_artifact_permitted': False, 'current_database_contract_ready': False,
                'production_writes': False, 'files': files, 'original_schema_sha256': files['schema.sql']['sha256']}
            target = folder / 'schema-capture-manifest.json'
            target.write_text(json.dumps(manifest)); target.chmod(0o600)
            provenance = {'control_sha': 'a' * 40, 'run_id': '123', 'run_attempt': 1}
            self.assertEqual(MODULE.validate_capture(folder, provenance), manifest)
            (folder / 'schema.sql').write_bytes(b'tampered private bytes')
            with self.assertRaises(RuntimeError): MODULE.validate_capture(folder, provenance)
            MODULE.cleanup_private(folder)
            self.assertFalse(folder.exists())
            self.assertTrue(json.loads((folder.parent / 'isolated-ui-evidence/private-cleanup.json').read_text())['complete'])

    def test_occupied_container_name_is_never_armed_for_cleanup(self):
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, b'preexisting-container\n', b'')
        with patch.object(MODULE.native, 'command', command), self.assertRaises(RuntimeError):
            MODULE.private_bootstrap('sha256:' + 'a' * 64, ROOT, None, ROOT,
                                     'schema-preimage', 9999999999)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('rm', calls[0])

    def test_connected_cases_share_live_smoke_image_but_cannot_pass_before_outer_cleanup(self):
        spec = importlib.util.spec_from_file_location('smoke_lifetime', ROOT / 'operations/release/ci/fixture-smoke.py')
        smoke = importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
        for cleanup_fails, callback_fails in ((False, False), (True, False), (False, True)):
            with self.subTest(cleanup_fails=cleanup_fails), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                for relative in tuple(smoke.PREFIX + name for name in smoke.FILES) + smoke.CONTROL_FILES:
                    path = root / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('boundary fixture')
                image = 'sha256:' + 'b' * 64
                sha = 'a' * 40
                state = {'image': True}
                def run(args, cwd, env, **kwargs):
                    self.assertNotIn('GH_TOKEN', env); self.assertNotIn('DATABASE_URL', env)
                    if args[:3] == ['git','rev-parse','HEAD']: return sha
                    if args[:3] == ['docker','image','inspect']:
                        return json.dumps([{'Id':image,'Os':'linux','Architecture':'amd64','Config':{'Labels':{
                          'org.opencontainers.image.revision':sha,
                          'org.opencontainers.image.source':'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena',
                          'com.smarter-poker.scope':'isolated-component-fixture',
                          'com.smarter-poker.control-revision':sha,'com.smarter-poker.source-revision':sha}}}])
                    if args[:2] == ['python3','tests/fixtures/ev-cashout-lifecycle/run-native.py']:
                        (root/'evidence/ev-cashout-lifecycle.json').write_text('{"status":"passed"}')
                    if args[:3] == ['docker','image','ls']: return image if state['image'] else ''
                    if args[:3] == ['docker','image','rm'] and not cleanup_fails: state['image'] = False
                    return ''
                def connected(*args, **kwargs):
                    self.assertTrue(state['image'])
                    self.assertGreater(kwargs['work_deadline'], 0)
                    report = {'version':1,'scope':'isolated-connected-ui-observations','product_certificate':False,
                        'runtime_image':image,'provenance':{'control_sha':sha},'success':False,
                        'stage':'preflight-failed' if callback_fails else 'outer-runtime-cleanup','cleanup':{'complete':True}}
                    if callback_fails:
                        (root/'evidence/connected-ui-observations.json').write_text(json.dumps(report))
                        raise RuntimeError('PRIVATE FAILURE MUST NOT BE UPLOADED')
                    return {'cases_complete':True,'report':report}
                with patch.object(smoke,'smoke_records',return_value={}), patch.object(smoke,'role_alignment_record',return_value={}), \
                     patch.object(smoke,'service_preimage',return_value=({'catalog_sha256':'c'*64},b'{}')):
                    result = smoke.execute(root,root/'evidence',sha,run,connected=connected)
                receipt = json.loads((root/'evidence/connected-ui-observations.json').read_text())
                self.assertEqual(result, 1 if cleanup_fails or callback_fails else 0)
                self.assertEqual(receipt['success'], not cleanup_fails and not callback_fails)
                self.assertNotIn('PRIVATE FAILURE',json.dumps(receipt))
                self.assertEqual(receipt['cleanup']['runtime_image_removed'], not cleanup_fails)


if __name__ == '__main__':
    unittest.main()
