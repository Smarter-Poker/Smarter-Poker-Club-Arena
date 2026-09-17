"""The native race consumer must prove effects, not accept echoed SQL or exit 0."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'satellite_qualifier_concurrency', ROOT / 'scripts/ci/satellite_qualifier_concurrency.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def transcript(mode='commit', negative=False):
    # Stock isolationtester prefixes real backend notices, while printing step
    # SQL separately. Preserve that distinction in these parser-only controls.
    lines = ['step resolve_outcome: SELECT resolve(); <waiting ...>']
    if negative:
        lines.append('ERROR:  SATELLITE_FINISH_LANE_WAIT_NOT_PROVEN')
    else:
        lines.append('payer: NOTICE:  SATELLITE_FINISH_LANE_WAIT_PROVEN')
    outcome = 'ROLLED_BACK' if negative or mode == 'rollback' else 'COMMITTED'
    lines += [f'resolver: NOTICE:  SATELLITE_RACE_OUTCOME_{outcome}',
              'step resolve_outcome: <... completed>',
              'resolver: NOTICE:  SATELLITE_RACE_EXACT_EFFECTS_PROVEN']
    return '\n'.join(lines) + '\n'


class SatelliteRaceEvidence(unittest.TestCase):
    def validate(self, stdout, *, mode='commit', negative=False, code=0, stderr=''):
        return MODULE.validate_result(code, stdout, stderr, mode, negative)

    def test_both_actual_outcomes_require_wait_and_exact_financial_effects(self):
        for mode in ['commit', 'rollback']:
            with self.subTest(mode=mode):
                self.assertEqual(self.validate(transcript(mode), mode=mode), {
                    'negative_control': False, 'observed_wait': True,
                    'financial_lane_wait_proven': True, 'exact_effects': True})

    def test_negative_control_requires_its_exact_refusal_and_rolled_back_effects(self):
        for mode in ['commit', 'rollback']:
            with self.subTest(mode=mode):
                result = self.validate(transcript(mode, True), mode=mode, negative=True)
                self.assertTrue(result['exact_effects'])
                self.assertFalse(result['financial_lane_wait_proven'])

    def test_nonzero_exit_cannot_be_rescued_by_pass_notices(self):
        with self.assertRaises(RuntimeError):
            self.validate(transcript(), code=1)

    def test_echoed_sql_is_not_an_observed_notice(self):
        forged = transcript().replace(
            'payer: NOTICE:  SATELLITE_FINISH_LANE_WAIT_PROVEN',
            "step wait_proven: DO $$ BEGIN RAISE NOTICE 'SATELLITE_FINISH_LANE_WAIT_PROVEN'; END $$;")
        with self.assertRaises(RuntimeError):
            self.validate(forged)

    def test_missing_or_duplicate_wait_and_completion_refuse(self):
        for marker in ['<waiting ...>', '<... completed>']:
            for replacement in ['', marker + marker]:
                with self.subTest(marker=marker, replacement=replacement), self.assertRaises(RuntimeError):
                    self.validate(transcript().replace(marker, replacement))

    def test_missing_duplicate_or_reordered_notices_refuse(self):
        lines = transcript().splitlines()
        for changed in [lines[:-1], lines + [lines[-1]],
                        [lines[0], lines[2], lines[1], *lines[3:]]]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                self.validate('\n'.join(changed))

    def test_wrong_financial_outcome_refuses(self):
        for negative in [False, True]:
            with self.subTest(negative=negative), self.assertRaises(RuntimeError):
                self.validate(transcript('rollback', negative).replace('ROLLED_BACK', 'COMMITTED'),
                              mode='rollback', negative=negative)

    def test_unexpected_backend_diagnostics_refuse_in_both_streams(self):
        for severity in ['ERROR', 'FATAL', 'PANIC', 'WARNING']:
            for negative in [False, True]:
                for stream in ['stdout', 'stderr']:
                    text = transcript(negative=negative)
                    diagnostic = f'resolver: {severity}:  unrelated failure\n'
                    with self.subTest(severity=severity, negative=negative, stream=stream), self.assertRaises(RuntimeError):
                        self.validate(text + diagnostic if stream == 'stdout' else text,
                                      negative=negative, stderr=diagnostic if stream == 'stderr' else '')

    def test_negative_missing_wrong_or_duplicate_expected_refusal_is_not_green(self):
        error = 'ERROR:  SATELLITE_FINISH_LANE_WAIT_NOT_PROVEN'
        for replacement in ['', 'ERROR:  a different failure', error + '\n' + error]:
            with self.subTest(replacement=replacement), self.assertRaises(RuntimeError):
                self.validate(transcript(negative=True).replace(error, replacement), negative=True)

    def test_negative_control_cannot_report_actual_lane_acquisition(self):
        with self.assertRaises(RuntimeError):
            self.validate(transcript(negative=True) + 'payer: NOTICE:  SATELLITE_FINISH_LANE_WAIT_PROVEN\n',
                          negative=True)

    def test_unknown_permutation_refuses(self):
        with self.assertRaises(ValueError):
            self.validate(transcript(), mode='timeout')


class SatelliteReaderEvidence(unittest.TestCase):
    def output(self, mode='commit', negative=False):
        permutation='manager_begin manager_read own_result reader_wait_proven manager_'+mode+' reader_effects'
        proof=('ERROR:  SATELLITE_READER_LANE_WAIT_NOT_PROVEN' if negative
               else 'manager: NOTICE:  SATELLITE_READER_LANE_WAIT_PROVEN')
        return '\n'.join(['Parsed test spec with 2 sessions','starting permutation: '+permutation,
          'step manager_begin: BEGIN;', 'step manager_read: DO read();',
          'manager: NOTICE:  SATELLITE_MANAGER_RECEIPT_PROVEN',
          'step own_result: DO read(); <waiting ...>', 'step reader_wait_proven: DO proof();', proof,
          'step manager_'+mode+': '+mode.upper()+';',
          'browser: NOTICE:  SATELLITE_OWN_RESULT_PROVEN', 'step own_result: <... completed>',
          'step reader_effects: DO proof();', 'browser: NOTICE:  SATELLITE_READER_EFFECTS_PROVEN'])+'\n'

    def test_exact_reader_releases_and_original_refusal(self):
        for mode in ['commit','rollback']:
            for negative in [False,True]:
                with self.subTest(mode=mode,negative=negative):
                    result=MODULE.validate_reader_result(0,self.output(mode,negative),'',mode,negative)
                    self.assertEqual(result['financial_lane_wait_proven'],not negative)

    def test_reader_requires_real_notices_and_completed_steps(self):
        source=self.output()
        for changed in [source.replace('browser: NOTICE:  SATELLITE_OWN_RESULT_PROVEN',
                                       "RAISE NOTICE 'SATELLITE_OWN_RESULT_PROVEN';"),
                        source.replace('step own_result: <... completed>',''),
                        source.replace('step reader_effects: DO proof();',''),
                        source+source,
                        source+'browser: NOTICE:  unknown notice\n',
                        source+'browser: WARNING:  unexpected warning\n']:
            with self.subTest(changed=changed),self.assertRaises(RuntimeError):
                MODULE.validate_reader_result(0,changed,'','commit',False)

    def test_reader_original_control_requires_its_exact_failed_lane_proof(self):
        source=self.output(negative=True)
        for changed in [source.replace('ERROR:  SATELLITE_READER_LANE_WAIT_NOT_PROVEN',''),
                        source.replace('SATELLITE_READER_LANE_WAIT_NOT_PROVEN','wrong failure')]:
            with self.subTest(changed=changed),self.assertRaises(RuntimeError):
                MODULE.validate_reader_result(0,changed,'','commit',True)

    def test_reader_nonzero_or_backend_error_never_passes(self):
        for code,stderr in [(1,''),(0,'browser: ERROR:  statement timeout\n')]:
            with self.subTest(code=code,stderr=stderr),self.assertRaises(RuntimeError):
                MODULE.validate_reader_result(code,self.output(),stderr,'commit',False)


if __name__ == '__main__':
    unittest.main()
