#!/usr/bin/env python3
"""Run only the original PKO runners' setup/cleanup against disposable PG17."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get('PKO_PROBE_SOURCE_DIR', str(ROOT / 'scripts/dev')))
PG = Path(os.environ.get('POKER_AUDIT_PG_BIN', '/usr/lib/postgresql/17/bin'))
RUNNERS = ('probe-causal-pko-predecessors-pg17.sh',
           'probe-terminal-bounty-candidate-coverage-pg17.sh')


class CleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        version = subprocess.check_output([str(PG / 'postgres'), '--version'], text=True)
        if not re.search(r'\b17\.', version):
            raise RuntimeError('This test requires existing PostgreSQL17 tools')

    def run_probe(self, runner, original_status=0, fault='', timeout=120, disposal=None):
        # Load the actual runner through its setup and EXIT trap, stopping at
        # the first SQL wrapper. No financial SQL or alternative cleanup copy.
        source = (SOURCE / runner).read_text()
        self.assertEqual(source.count('\nP() {'), 1)
        prefix = source.split('\nP() {', 1)[0]
        # Retain the exact cluster identity before initdb/start can fail or time
        # out. The cluster itself lives outside TemporaryDirectory so an
        # uncertain independent stop never deletes its data automatically.
        prefix, count = re.subn(r'^(TMP=.*)$',
                               lambda match: match.group(1) + '\nprintf "%s" "$TMP" > "$PKO_TEST_RECORD"',
                               prefix, flags=re.MULTILINE)
        self.assertEqual(count, 1)
        with tempfile.TemporaryDirectory(prefix='pko-cleanup-', dir='/tmp') as work:
            work = Path(work)
            binary = work / 'bin'
            binary.mkdir()
            for name in ('postgres', 'initdb', 'psql'):
                (binary / name).symlink_to(PG / name)
            if fault == 'version':
                (binary / 'postgres').unlink()
                (binary / 'postgres').write_text('#!/bin/sh\nprintf "postgres (PostgreSQL) 16.9\\n"\n')
                (binary / 'postgres').chmod(0o755)
            # This transport fault shim affects only our temporary cluster's
            # pg_ctl calls; all successful starts/status/stops use real PG.
            shim = binary / 'pg_ctl'
            shim.write_text('''#!/usr/bin/env python3
import os, pathlib, signal, subprocess, sys
args = sys.argv[1:]
with open(os.environ['CONTROL_CALLS'], 'a') as out:
    out.write(args[-1] + '\\n')
fault = os.environ['CONTROL_FAULT']
mark = pathlib.Path(os.environ['CONTROL_STOPPED'])
if args[-1] == 'stop' and fault == 'stop':
    # Stop the real server, then model an unsuccessful stop result. This
    # safely reproduces the old ignored-status bug even if it deletes data.
    stopped = subprocess.run([os.environ['REAL_PG_CTL'], *args])
    if stopped.returncode != 0:
        sys.exit(stopped.returncode)
    print('injected stop refusal', file=sys.stderr)
    sys.exit(71)
if args[-1] == 'status' and fault == 'status' and mark.exists():
    print('injected status readback refusal', file=sys.stderr)
    sys.exit(1)
result = subprocess.run([os.environ['REAL_PG_CTL'], *args])
if args[-1] == 'start' and result.returncode == 0:
    if fault == 'start':
        print('injected startup result refusal', file=sys.stderr)
        sys.exit(71)
    if fault == 'timeout':
        # Pause only this fixture's parent bash after the real server starts.
        # subprocess.run's deadline kills that child; independent finally
        # disposal must stop the server even though no result was returned.
        os.kill(os.getppid(), signal.SIGSTOP)
if args[-1] == 'stop' and result.returncode == 0:
    mark.write_text('stopped')
sys.exit(result.returncode)
''')
            shim.chmod(0o755)
            record = work / 'cluster-path'
            script = work / runner
            script.write_text(prefix + '\nexit ' + str(original_status) + '\n')
            env = dict(os.environ, POKER_AUDIT_PG_BIN=str(binary), TMPDIR='/tmp',
                       PKO_TEST_RECORD=str(record), CONTROL_CALLS=str(work / 'calls'),
                       CONTROL_FAULT=fault, CONTROL_STOPPED=str(work / 'stopped'),
                       REAL_PG_CTL=str(PG / 'pg_ctl'))
            result = None
            cluster = None
            try:
                result = subprocess.run(['bash', str(script)], env=env,
                                        text=True, capture_output=True, timeout=timeout)
                if record.exists():
                    cluster = Path(record.read_text())
                else:
                    match = re.search(r'diagnostics retained at (.+)', result.stderr)
                    if match:
                        cluster = Path(match.group(1))
                exists = cluster is not None and cluster.exists()
                state = None
                if exists and (cluster / 'data' / 'PG_VERSION').exists():
                    state = subprocess.run([str(PG / 'pg_ctl'), '-D', str(cluster / 'data'),
                                            'status'], capture_output=True).returncode
                calls = (work / 'calls').read_text().splitlines() if (work / 'calls').exists() else []
                return result, exists, state, calls
            finally:
                # Test-owned disposal after collecting the runner observations.
                if cluster is None and record.exists():
                    cluster = Path(record.read_text())
                if cluster is not None and cluster.exists():
                    if disposal is not None:
                        disposal['cluster'] = str(cluster)
                    if (cluster / 'data' / 'PG_VERSION').exists():
                        state = subprocess.run([str(PG / 'pg_ctl'), '-D', str(cluster / 'data'),
                                                'status'], capture_output=True).returncode
                        if disposal is not None:
                            disposal['before_state'] = state
                        if state == 0:
                            subprocess.run([str(PG / 'pg_ctl'), '-D', str(cluster / 'data'),
                                            '-m', 'immediate', '-w', '-t', '60', 'stop'],
                                           check=True, capture_output=True, timeout=70)
                        state = subprocess.run([str(PG / 'pg_ctl'), '-D', str(cluster / 'data'),
                                                'status'], capture_output=True).returncode
                        if disposal is not None:
                            disposal['after_state'] = state
                        if state != 3:
                            raise AssertionError('Test-owned PostgreSQL cleanup was not confirmed: ' + str(cluster))
                    shutil.rmtree(cluster)

    def test_success_stops_then_removes_cluster(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                result, exists, _, calls = self.run_probe(runner)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(exists)
                self.assertEqual(calls[-3:], ['status', 'stop', 'status'])

    def test_original_failure_stays_failed_and_keeps_diagnostics(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                result, exists, state, _ = self.run_probe(runner, original_status=23)
                self.assertEqual(result.returncode, 23, result.stderr)
                self.assertTrue(exists)
                self.assertEqual(state, 3)
                self.assertIn('probe status=23 cleanup_failed=0', result.stderr)
                self.assertIn('initdb.log', result.stderr)

    def test_failed_stop_status_cannot_report_success_or_delete_diagnostics(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                result, exists, state, _ = self.run_probe(runner, fault='stop')
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertTrue(exists)
                self.assertEqual(state, 3)
                self.assertIn('injected stop refusal', result.stderr)

    def test_unconfirmed_stop_readback_retains_diagnostics(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                result, exists, state, _ = self.run_probe(runner, fault='status')
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertTrue(exists)
                self.assertEqual(state, 3)
                self.assertIn('injected status readback refusal', result.stderr)

    def test_start_failure_after_real_start_retains_stopped_diagnostics(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                result, exists, state, calls = self.run_probe(runner, fault='start')
                self.assertEqual(result.returncode, 71, result.stderr)
                self.assertTrue(exists)
                self.assertEqual(state, 3)
                self.assertEqual(calls[-4:], ['start', 'status', 'stop', 'status'])

    def test_timeout_after_real_start_is_independently_stopped_before_disposal(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                disposal = {}
                with self.assertRaises(subprocess.TimeoutExpired):
                    self.run_probe(runner, fault='timeout', timeout=10, disposal=disposal)
                self.assertEqual(disposal['before_state'], 0)
                self.assertEqual(disposal['after_state'], 3)
                self.assertFalse(Path(disposal['cluster']).exists())

    def test_wrong_server_version_never_starts_or_stops_cluster(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                result, _, _, calls = self.run_probe(runner, fault='version')
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
