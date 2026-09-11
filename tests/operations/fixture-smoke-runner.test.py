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
           dict(scope='native-service-smoke', postgres='17.11', extensions=6, auth='2.196.0', mfa='aal2',
                postgrest='14.5', realtime='2.134.10', change='observed', retries=0,
                observation_bridge='native-synthetic-protocol')]
SMOKE = '\n'.join(map(json.dumps, RECORDS)) + '\nNative service smoke and container cleanup passed (not a product certificate).\n'


class RunnerTests(unittest.TestCase):
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
            present = fault == 'timeout'
            def run(args, cwd, env, timeout=120):
                nonlocal present
                calls.append(args)
                self.assertNotIn('GH_TOKEN', env)
                if args[:3] == ['git', 'rev-parse', 'HEAD']:
                    return 'c' * 40 if fault == 'revision' else SHA
                if args[:3] == ['docker', 'image', 'inspect']:
                    labels = dict(LABELS)
                    if fault == 'labels': labels['com.smarter-poker.control-revision'] = 'd' * 40
                    return json.dumps([{'Id': IMAGE, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Labels': labels}}])
                if args[:2] == ['bash', m.PREFIX + 'smoke-image.sh']:
                    if fault == 'timeout': raise TimeoutError('PRIVATE TOKEN MUST NOT LEAK')
                    return SMOKE if fault != 'missing-service' else json.dumps(RECORDS[0])
                if args[:3] == ['docker', 'container', 'ls']:
                    return 'container-id' if present else ''
                if args[:3] == ['docker', 'container', 'rm']:
                    present = False
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

    def test_timeout_cleans_exact_container_without_success(self):
        code, receipt, calls = self.exercise('timeout')
        self.assertEqual(code, 1)
        removals = [call for call in calls if call[:3] == ['docker', 'container', 'rm']]
        self.assertEqual(removals, [['docker', 'container', 'rm', '--force', receipt['container']]])
        self.assertTrue(receipt['cleanup']['container_absent'])

    def test_duplicate_smoke_observation_refused(self):
        with self.assertRaises(RuntimeError):
            m.smoke_records(SMOKE + json.dumps(RECORDS[0]))


if __name__ == '__main__':
    unittest.main()
