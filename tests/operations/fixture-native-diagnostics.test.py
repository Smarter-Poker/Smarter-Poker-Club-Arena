import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('fixture_smoke', ROOT / 'operations/release/ci/fixture-smoke.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NativeDiagnosticsTests(unittest.TestCase):
    def test_actual_node_failure_survives_private_child_capture(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / m.PREFIX / 'smoke-image.sh'
            script.parent.mkdir(parents=True)
            child = root / 'diagnostic.mjs'
            module = (ROOT / 'operations/release/fixture/runtime-files.mjs').as_uri()
            child.write_text('import {nativeFailureDiagnostic} from ' + json.dumps(module) + ';\n'
                             'console.error("PRIVATE SERVICE CREDENTIAL");\n'
                             'console.error(JSON.stringify(nativeFailureDiagnostic("postgresql-bootstrap-roles",'
                             '{name:"error",code:"42710",position:"194",message:"PRIVATE PASSWORD"})));\n'
                             'process.exitCode=1;\n')
            script.write_text('exec node diagnostic.mjs\n')
            with self.assertRaises(m.NativeSmokeFailure) as caught:
                m.command(['bash', m.PREFIX + 'smoke-image.sh'], root, {'PATH': os.environ['PATH']})
            self.assertEqual(caught.exception.diagnostics, [{
                'stage': 'postgresql-bootstrap-roles', 'category': 'error', 'sqlstate': '42710', 'position': 194,
            }])
            self.assertNotIn('PRIVATE', repr(vars(caught.exception)))

    def test_malformed_or_extra_error_data_is_refused(self):
        valid = {'status': 'failed', 'stage': 'postgresql-extension-vector', 'error': 'error', 'sqlstate': '58P01'}
        rows = [{**valid, 'message': 'PRIVATE SQL'}, {**valid, 'sqlstate': 'SECRET TOKEN'},
                {**valid, 'sqlstate': '42P01\n'}, {**valid, 'sqlstate': ['42P01']},
                {**valid, 'error': 'Error'}, {**valid, 'error': ['error']},
                {**valid, 'stage': 'PRIVATE TOKEN'}]
        rows += [{**valid, 'position': value} for value in [True, False, 0, -1, 1000000, 1.5, '1', ['1'], None]]
        self.assertEqual(m.native_failures('\n'.join(map(json.dumps, rows))), [])
        self.assertEqual(m.native_failures(json.dumps(valid)), [{
            'stage': valid['stage'], 'category': 'error', 'sqlstate': '58P01',
        }])


if __name__ == '__main__':
    unittest.main()
