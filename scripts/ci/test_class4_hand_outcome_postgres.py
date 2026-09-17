"""Direct wrapper/oracle regression checks; these do not qualify PostgreSQL."""
import importlib.util
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
SPEC = importlib.util.spec_from_file_location('class4_driver', HERE / 'test-class4-hand-outcome-postgres.py')
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)

SCHEDULES = [
    (['change_begin', 'change_identity', 'a_begin', 'a_resolve_unknown', 'change_commit', 'a_commit', 'assert_unknown'], 'a_resolve_unknown', 'change_commit'),
    (['a_begin', 'a_resolve_one', 'b_begin', 'b_resolve_zero', 'a_commit', 'b_commit', 'assert_once'], 'b_resolve_zero', 'a_commit'),
]


def transcript():
    # Parser test input follows upstream17.11 printing syntax; never a live receipt.
    chunks = ['Parsed test spec with 3 sessions\n']
    for steps, waiter, releaser in SCHEDULES:
        chunks.append('starting permutation: ' + ' '.join(steps) + '\n')
        for step in steps:
            chunks.append('step ' + step + ':\n  DO $$BEGIN NULL; END$$;'
                          + (' <waiting ...>' if step == waiter else '') + '\n')
            if step == releaser:
                chunks.append('step ' + waiter + ': <... completed>\n')
    return ''.join(chunks)


class Class4TranscriptContract(unittest.TestCase):
    def test_exact_multiline_two_waits_are_recognized(self):
        self.assertTrue(DRIVER.validate_isolation(transcript(), ''))

    def test_missing_wait_is_not_sequential_concurrency_proof(self):
        with self.assertRaisesRegex(RuntimeError, 'blocked/unblocked'):
            DRIVER.validate_isolation(transcript().replace(' <waiting ...>', '', 1), '')

    def test_premature_completion_does_not_prove_owner_commit_order(self):
        text = transcript()
        completed = 'step a_resolve_unknown: <... completed>\n'
        text = text.replace(completed, '', 1).replace('step change_commit:', completed + 'step change_commit:', 1)
        with self.assertRaisesRegex(RuntimeError, 'blocked/unblocked'):
            DRIVER.validate_isolation(text, '')

    def test_isolation_sql_error_fails_even_if_tool_exit_is_zero(self):
        for out, err in [(transcript() + 'ERROR: assertion failed\n', ''),
                         (transcript(), 'FATAL: peer disconnected\n')]:
            with self.assertRaisesRegex(RuntimeError, 'SQL error'):
                DRIVER.validate_isolation(out, err)

    def test_missing_second_schedule_and_extra_step_fail(self):
        with self.assertRaisesRegex(RuntimeError, 'two original permutations'):
            DRIVER.validate_isolation(transcript().split('starting permutation: a_begin')[0], '')
        with self.assertRaisesRegex(RuntimeError, 'blocked/unblocked'):
            DRIVER.validate_isolation(transcript() + 'step unexpected: SELECT 1;\n', '')

    def test_cleanup_or_concurrency_failure_never_qualifies(self):
        receipt = {'sql_slice_passed': True, 'concurrency_passed': True,
                   'terminal_observed': True, 'source_stable': True,
                   'failure': None, 'cleanup_errors': []}
        self.assertTrue(DRIVER.qualifies(receipt))
        for delta in [{'concurrency_passed': False}, {'terminal_observed': False},
                      {'source_stable': False}, {'cleanup_errors': ['stop failed']},
                      {'failure': {'message': 'interrupted'}}]:
            self.assertFalse(DRIVER.qualifies(dict(receipt, **delta)))

    def test_original_deadline_is_not_refreshed_per_command(self):
        self.assertEqual(DRIVER.command_budget(100, 92, 60), 5)
        with self.assertRaises(TimeoutError):
            DRIVER.command_budget(100, 98, 60)


if __name__ == '__main__':
    unittest.main()
