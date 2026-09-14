"""Actual Git ancestry for an immutable release image; no install or Docker."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
subject = Path(os.environ.get('ENGINE_CI_PRODUCER_SUBJECT', ROOT / 'server/scripts/produce-engine-image-ci.py'))
spec = importlib.util.spec_from_file_location('image_producer_source', subject)
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class RealSourceHistory(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'source'
        self.remote = self.root / 'remote.git'
        self.env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull,
                    'GIT_CONFIG_SYSTEM': os.devnull, 'GIT_NO_REPLACE_OBJECTS': '1',
                    'GIT_AUTHOR_NAME': 'fixture', 'GIT_COMMITTER_NAME': 'fixture',
                    'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                    'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
        self.repo.mkdir()
        self.git('init', '--quiet', '--initial-branch=main')
        self.git('init', '--quiet', '--bare', str(self.remote))
        self.git('remote', 'add', 'origin', str(self.remote))
        (self.repo / 'server').mkdir()
        self.target = self.commit('server/index.ts', 'export const source = "original";\n')
        self.target_tree = self.git('rev-parse', self.target + ':server')
        self.control = self.commit('control.txt', 'captured workflow\n')
        self.later = self.commit('server/index.ts', 'export const source = "later";\n')
        self.git('push', '--quiet', 'origin', 'main')
        self.git('checkout', '--quiet', '--detach', self.control)
        self.identity = {'source_sha': self.target, 'workflow_control_sha': self.control}
        self.calls = []

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args):
        result = subprocess.run(['git', *args], cwd=self.repo, env=self.env,
                                capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise RuntimeError('ENGINE_CI_PRODUCER_COMMAND_FAILED')
        return result.stdout.strip()

    def commit(self, name, data):
        (self.repo / name).write_text(data)
        self.git('add', name)
        self.git('commit', '--quiet', '-m', name)
        return self.git('rev-parse', 'HEAD')

    def git_run(self, args, **kwargs):
        self.calls.append(args)
        self.assertEqual(args[0], 'git')
        return self.git(*args[1:])

    def test_later_main_preserves_the_original_admitted_server_tree(self):
        tree = producer.verify_git_source(self.identity, self.git_run)
        self.assertEqual(tree, self.target_tree)
        self.assertNotEqual(tree, self.git('rev-parse', self.later + ':server'))
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.control)

    def test_target_outside_protected_main_refuses(self):
        fork = self.commit('server/foreign.ts', 'export const foreign = true;\n')
        self.git('checkout', '--quiet', '--detach', self.control)
        with self.assertRaisesRegex(RuntimeError, 'COMMAND_FAILED'):
            producer.verify_git_source({**self.identity, 'source_sha': fork}, self.git_run)

    def test_executor_outside_protected_main_refuses(self):
        fork = self.commit('foreign-control.txt', 'unpublished executor\n')
        with self.assertRaisesRegex(RuntimeError, 'COMMAND_FAILED'):
            producer.verify_git_source({**self.identity, 'workflow_control_sha': fork}, self.git_run)

    def test_unknown_full_target_refuses(self):
        with self.assertRaisesRegex(RuntimeError, 'COMMAND_FAILED'):
            producer.verify_git_source({**self.identity, 'source_sha': 'f' * 40}, self.git_run)

    def test_checkout_cannot_substitute_for_the_captured_executor(self):
        self.git('checkout', '--quiet', '--detach', self.later)
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_CHECKOUT'):
            producer.verify_git_source(self.identity, self.git_run)

    def test_failed_protected_history_refresh_refuses(self):
        self.git('remote', 'set-url', 'origin', str(self.root / 'absent.git'))
        with self.assertRaisesRegex(RuntimeError, 'COMMAND_FAILED'):
            producer.verify_git_source(self.identity, self.git_run)


if __name__ == '__main__':
    unittest.main()
