"""Negative controls for the native race acceptance parser, not native evidence."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('alert_evidence_driver',
    Path(__file__).with_name('test-alert-evidence-postgres.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

# Deliberately synthetic parser input. This is never saved as a native receipt.
ORDERED = '''Parsed test spec with 2 sessions
starting permutation: claim_begin claim_write repair_call claim_commit repair_assert restore_preimage
step claim_begin: BEGIN;
step claim_write: UPDATE fixture;
step repair_call: INSERT fixture; <waiting ...>
step claim_commit: COMMIT;
step repair_call: <... completed>
step repair_assert: SELECT 'spin-repair-evidence-cas-race';
step restore_preimage: DO fixture;
'''


class NativeRaceAcceptance(unittest.TestCase):
    def test_exact_native_tool_and_server_release_required(self):
        for value in ('postgres (PostgreSQL) 17.11 (Ubuntu 17.11-1.pgdg24.04+2)',
                      'PostgreSQL 17.11 (Ubuntu 17.11-1.pgdg24.04+2)',
                      'PostgreSQL 17.11\n',
                      'isolationtester (PostgreSQL) 17.11\n'):
            driver.validate_version(value, 'test')
        for value in ('postgres (PostgreSQL) 17.10', 'isolationtester (PostgreSQL) 17.110',
                      'postgres (PostgreSQL) 18.1', 'postgres (PostgreSQL) 17',
                      'unknown binary', 'postgres (PostgreSQL) 17.11evil',
                      'PostgreSQL 17.10', 'PostgreSQL 17.110',
                      'PostgreSQL 17', 'PostgreSQL 17.11evil'):
            with self.subTest(version=value), self.assertRaises(RuntimeError):
                driver.validate_version(value, 'test')

    def test_accepts_only_the_expected_observed_order(self):
        driver.validate_race_output(ORDERED, '')

    def test_zero_exit_with_sql_error_is_still_a_failure(self):
        for channel in ('stdout', 'stderr'):
            with self.subTest(channel=channel), self.assertRaises(RuntimeError):
                driver.validate_race_output(ORDERED + ('ERROR: assertion failed\n' if channel == 'stdout' else ''),
                                            'ERROR: assertion failed\n' if channel == 'stderr' else '')

    def test_a_nonblocking_serial_result_cannot_certify_the_race(self):
        with self.assertRaises(RuntimeError):
            driver.validate_race_output(ORDERED.replace(' <waiting ...>', ''), '')

    def test_commit_after_completion_is_rejected(self):
        with self.assertRaises(RuntimeError):
            driver.validate_race_output(ORDERED.replace(
                'step claim_commit: COMMIT;\nstep repair_call: <... completed>',
                'step repair_call: <... completed>\nstep claim_commit: COMMIT;'), '')

    def test_missing_restore_or_repeated_permutation_is_rejected(self):
        for bad in (ORDERED.replace('step restore_preimage: DO fixture;\n', ''), ORDERED + ORDERED):
            with self.subTest(trace=bad), self.assertRaises(RuntimeError):
                driver.validate_race_output(bad, '')

    def test_cancellation_and_missing_terminal_witness_are_rejected(self):
        for bad in (ORDERED + 'isolationtester: canceling step repair_call after 30 seconds\n',
                    ORDERED.replace('spin-repair-evidence-cas-race', 'unrelated')):
            with self.subTest(trace=bad), self.assertRaises(RuntimeError):
                driver.validate_race_output(bad, '')


if __name__ == '__main__':
    unittest.main()
