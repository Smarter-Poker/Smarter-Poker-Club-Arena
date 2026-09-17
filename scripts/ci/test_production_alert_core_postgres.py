"""Finite source, sequence-precision and cleanup regressions for the PG17 check.

These do not replace the native SQL invocation in the same required check.
"""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    'owner_notification_postgres',
    Path(__file__).with_name('test-production-alert-core-postgres.py'))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class OwnerNotificationPostgresGuards(unittest.TestCase):
    def test_current_checkout_bytes_must_match_the_qualified_pin(self):
        data = b'original real component\n'
        pin = {'sha256': runner.digest(data), 'bytes': len(data)}
        runner.check_blob('component', data, pin)
        for changed in (data + b' ', b'changed real component\n'):
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                runner.check_blob('component', changed, pin)

    def test_manifest_cannot_omit_a_real_fixture_dependency(self):
        with self.assertRaisesRegex(RuntimeError, 'fixed fixture manifest'):
            runner.pinned_sources(Path('/unused'), {'schemaVersion': 1, 'fixtureFiles': {}})

    def test_component_binding_cannot_point_to_a_fixture_copy(self):
        manifest = {
            'schemaVersion': 1,
            'fixtureFiles': {str(runner.FIXTURE / p): {} for p in runner.LEAVES},
            'checkoutInputs': {
                key: {'path': value} for key, value in runner.CHECKOUT_INPUTS.items()
            },
        }
        manifest['checkoutInputs']['component']['path'] = 'fixture-copy.sql'
        with self.assertRaisesRegex(RuntimeError, 'checkout binding path drift'):
            runner.pinned_sources(Path('/unused'), manifest)

    def test_cash_connected_chain_cannot_be_omitted_from_fixed_inputs(self):
        for removed in ('cash_connected','cash_preimage','cash_component','cash_rollback'):
            manifest={
                'schemaVersion':1,
                'fixtureFiles':{str(runner.FIXTURE / p):{} for p in runner.LEAVES},
                'checkoutInputs':{k:{'path':v} for k,v in runner.CHECKOUT_INPUTS.items() if k!=removed},
            }
            with self.subTest(removed=removed),self.assertRaisesRegex(RuntimeError,'checkout binding set drift'):
                runner.pinned_sources(Path('/unused'),manifest)

    def test_direct_source_chain_cannot_omit_an_executed_input(self):
        direct = [key for key in runner.CHECKOUT_INPUTS if key.startswith(('direct_', 'legacy_envelope_'))]
        self.assertEqual(len(direct), 18)
        for removed in direct:
            manifest = {
                'schemaVersion': 1,
                'fixtureFiles': {str(runner.FIXTURE / p): {} for p in runner.LEAVES},
                'checkoutInputs': {k: {'path': v} for k, v in runner.CHECKOUT_INPUTS.items() if k != removed},
            }
            with self.subTest(removed=removed), self.assertRaisesRegex(RuntimeError, 'checkout binding set drift'):
                runner.pinned_sources(Path('/unused'), manifest)

    def test_race_requires_exact_distinct_live_backend_blocker(self):
        observed = {'holder': 41, 'waiter': 42, 'blockers': [41],
                    'holder_state': 'idle in transaction', 'waiter_state': 'active', 'wait_type': 'Lock'}
        self.assertTrue(runner.exact_blocker(observed, 41, 42))
        for delta in ({'blockers': []}, {'blockers': [99]}, {'blockers': [41, 99]},
                      {'holder': 99}, {'waiter': 99}, {'holder_state': 'idle'},
                      {'waiter_state': 'idle'}, {'wait_type': 'Client'}):
            with self.subTest(delta=delta):
                self.assertFalse(runner.exact_blocker(dict(observed, **delta), 41, 42))
        self.assertFalse(runner.exact_blocker(observed, 41, 41))
        self.assertFalse(runner.exact_blocker({}, 41, 42))

    def test_legacy_race_requires_specific_refusal_not_arbitrary_failure(self):
        expected = 'psql:race.sql:90: ERROR:  P0001: operational source exact receipt collision\nCONTEXT:  actual function\n'
        runner.race_exit('finite_first', 0, 3, expected)
        for holder, waiter, stderr in ((1, 3, expected), (0, 0, expected),
                                        (0, 3, expected.replace('P0001', '55P03')),
                                        (0, 3, expected.replace('exact receipt collision', 'different failure'))):
            with self.subTest(holder=holder, waiter=waiter, stderr=stderr), self.assertRaises(RuntimeError):
                runner.race_exit('finite_first', holder, waiter, stderr)
        for case in ('capture_first', 'reversed_batch', 'financial_first'):
            runner.race_exit(case, 0, 0, '')
            with self.subTest(case=case), self.assertRaises(RuntimeError):
                runner.race_exit(case, 0, 3, expected)

    def test_bigint_sequence_rounding_regression(self):
        exact = {'type': 'bigint', 'start': '1', 'increment': '1', 'minimum': '1',
                 'maximum': '9223372036854775807', 'cache': '1', 'cycle': False}
        self.assertIn('MAXVALUE 9223372036854775807', runner.check_sequence(exact))
        for bad in (9223372036854776000, float(9223372036854775807),
                    '9223372036854776000', None, '9.223372036854776e18'):
            with self.subTest(maximum=bad), self.assertRaises(RuntimeError):
                runner.check_sequence(dict(exact, maximum=bad))

    def test_principal_restore_cannot_cross_an_earlier_trigger(self):
        schema = b'CREATE TABLE example(id int);\n' + runner.MARKER + b'\n'
        prefix, suffix = runner.split_schema(schema)
        self.assertEqual(prefix + suffix, schema)
        for changed in (schema + runner.MARKER,
                        b'CREATE TRIGGER earlier AFTER INSERT ON example;\n' + schema):
            with self.subTest(schema=changed), self.assertRaises(RuntimeError):
                runner.split_schema(changed)

    def test_all_cleanup_commands_share_the_original_deadline(self):
        self.assertEqual(runner.command_budget(30, 0, 12), 12)
        self.assertEqual(runner.command_budget(30, 20, 10), 7)
        with self.assertRaises(TimeoutError):
            runner.command_budget(30, 27, 10)

    def test_signal_during_cleanup_records_failure_without_interrupting_stop(self):
        receipt = {'failure': None, 'passed': True}
        runner.record_interruption(receipt, 15, during_cleanup=True)
        self.assertFalse(receipt['passed'])
        self.assertEqual(receipt['failure']['type'], 'Interrupted')
        first = receipt['failure']
        runner.record_interruption(receipt, 2, during_cleanup=True)
        self.assertIs(receipt['failure'], first)

    def test_signal_during_work_still_interrupts_and_preserves_original_failure(self):
        failure = {'type': 'OriginalSqlFailure', 'message': 'original SQL error'}
        receipt = {'failure': failure, 'passed': False}
        with self.assertRaisesRegex(RuntimeError, 'interrupted by signal 15'):
            runner.record_interruption(receipt, 15, during_cleanup=False)
        self.assertIs(receipt['failure'], failure)
        self.assertFalse(receipt['passed'])

    def test_observed_terminal_cannot_erase_failure_or_missing_sql_proof(self):
        passed = {'sql_slice_passed': True, 'terminal_observed': True,
                  'source_stable': True, 'cleanup_errors': []}
        self.assertTrue(runner.qualifies(passed))
        for key in ('sql_slice_passed', 'terminal_observed', 'source_stable'):
            with self.subTest(key=key):
                self.assertFalse(runner.qualifies(dict(passed, **{key: False})))
        self.assertFalse(runner.qualifies(dict(passed, failure={'message': 'original SQL failure'})))
        self.assertFalse(runner.qualifies(dict(passed, cleanup_errors=['original fast-stop failure'])))


if __name__ == '__main__':
    unittest.main()
