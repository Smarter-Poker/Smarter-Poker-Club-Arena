import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('qualification', ROOT / 'operations/release/native/qualify-candidate.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class QualificationBoundary(unittest.TestCase):
    def test_candidate_only_receives_read_only_archive_no_host_authority(self):
        request = dict(phase='VALIDATION', source_sha='a'*40, accepted_head_sha='b'*40,
                       expected_base_sha='c'*40, tested_tree_sha='d'*40, control_sha='e'*40,
                       runtime_image='node:22-slim@sha256:'+'f'*64, components=['club-arena-engine'])
        def read(args):
            if args[-1] == 'HEAD:server/Dockerfile':
                return 'FROM ' + request['runtime_image']
            if '--format=%P' in args:
                return request['expected_base_sha']+' '+request['accepted_head_sha']
            if args[-1] == 'HEAD^{tree}':
                return request['tested_tree_sha']
            if args[-1] == 'HEAD:server':
                return 'f'*40
            return request['control_sha'] if args[2].endswith('controls') else request['source_sha']
        executed = []
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'evidence'
            def execute(args, **kw):
                executed.append((args, kw))
                if args[0] == 'node':
                    Path(args[-1]).write_text(json.dumps({'names': ['example_function'], 'exceptions': {}}))
            with patch.object(MODULE, 'text', side_effect=read), patch.object(MODULE, 'run', side_effect=execute), patch.object(MODULE.subprocess, 'run'), patch.dict(os.environ, {'GITHUB_RUN_ID': '123', 'ACTIONS_RUNTIME_TOKEN': 'fixture-never-forward'}):
                MODULE.qualify(request, '12345678-1234-1234-1234-123456789012', Path(directory)/'source', Path(directory)/'controls', output)
            docker, options = next((a, o) for a, o in executed if a[:2] == ['docker', 'run'])
            self.assertEqual(options, {})
            self.assertIn('--read-only', docker)
            self.assertIn('--cap-drop=ALL', docker)
            self.assertIn('--user', docker)
            self.assertEqual([docker[i+1] for i, x in enumerate(docker) if x == '--env'], ['HOME=/tmp', 'CI=true'])
            mounts = [docker[i+1] for i, x in enumerate(docker) if x == '--mount']
            self.assertEqual(len(mounts), 1)
            self.assertTrue(mounts[0].endswith('target=/source.tar,readonly'))
            self.assertNotIn('fixture-never-forward', ' '.join(docker))
            self.assertNotIn('controls', ' '.join(docker))
            self.assertEqual(json.loads((output/'receipt.json').read_text())['request'], request)

    def test_unsupported_component_fails_before_any_process(self):
        request = dict(phase='BUILD', source_sha='a'*40, accepted_head_sha='b'*40,
                       expected_base_sha='c'*40, tested_tree_sha='d'*40, control_sha='e'*40,
                       runtime_image='node:22-slim@sha256:'+'f'*64, components=['world-hub-web'])
        with patch.object(MODULE, 'run') as run:
            with self.assertRaises(RuntimeError):
                MODULE.qualify(request, '12345678-1234-1234-1234-123456789012', Path('/source'), Path('/controls'), Path('/output'))
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
