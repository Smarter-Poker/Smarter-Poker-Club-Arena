"""Refuse missing, erroneous or wrong-scenario native concurrency evidence."""
from pathlib import Path
import importlib.util
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/ci'))
spec = importlib.util.spec_from_file_location('lane_results', ROOT / 'scripts/ci/test-elimination-canonical-lane.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EvidenceTests(unittest.TestCase):
    def evidence(self, baseline=False, release='commit'):
        return (ROOT / 'scripts/ci/fixtures/elimination-canonical-lane' / (('baseline' if baseline else 'candidate') + '-hand-' + release + '.stdout')).read_text()

    def test_actual_four_scenarios(self):
        for baseline in (False, True):
            for release in ('commit', 'rollback'):
                with self.subTest(baseline=baseline, release=release):
                    proof = module.validate_hand_race(0, self.evidence(baseline, release), '', baseline, release)
                    self.assertTrue(proof['exact_effects'])
                    self.assertEqual(proof['actual_advisory_wait'], not baseline)

    def test_no_missing_or_forged_success(self):
        evidence = self.evidence()
        cases = [
            (0, '', ''),
            (1, evidence, ''),
            (0, evidence, 'transport failed'),
            (0, evidence + '\nERROR: statement timeout\n', ''),
            (0, evidence.replace('observer: NOTICE:  LANE_WAIT_PROVEN\n', ''), ''),
            (0, evidence.replace('a: NOTICE:  LANE_ROW_AVAILABLE\n', ''), ''),
            (0, evidence.replace('observer: NOTICE:  LANE_EFFECTS_PROVEN\n', ''), ''),
            (0, evidence.replace('<waiting ...>', ''), ''),
            (0, evidence.replace('<... completed>', ''), ''),
            (0, evidence.replace('b: NOTICE:  LANE_DUPLICATE_PROVEN\n', ''), ''),
            (0, self.evidence(True), ''),
            (0, self.evidence(False, 'rollback'), ''),
        ]
        for case in cases:
            with self.subTest(case=case[1][-100:]):
                with self.assertRaises(RuntimeError):
                    module.validate_hand_race(*case, False, 'commit')

    def test_late_lane_baseline_is_required(self):
        evidence = self.evidence(True)
        with self.assertRaises(RuntimeError):
            module.validate_hand_race(0, evidence.replace('b: NOTICE:  LANE_BASELINE_REFUSED\n', ''), '', True, 'commit')


if __name__ == '__main__':
    unittest.main()
