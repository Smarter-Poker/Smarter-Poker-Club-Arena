"""The native owning caller must not accept missing effects or swallowed SQL errors."""
from pathlib import Path
import importlib.util
import sys
import unittest

sys.dont_write_bytecode=True
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'scripts/ci'))
spec=importlib.util.spec_from_file_location('elimination_owner',root/'scripts/ci/test-f06-accepted-elimination.py')
owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)

def transcript(mode):
    return f'''Parsed test spec with 3 sessions
starting permutation: a_begin a_claim b_claim_{mode} observed_wait a_{mode} final_state
step a_begin: BEGIN;
a: NOTICE:  ELIMINATION_RACE_CLAIM_PROVEN
step a_claim: SELECT f06_elimination_native.claim(false);
claim
-----
     
(1 row)
step b_claim_{mode}: SELECT f06_elimination_native.claim(true); <waiting ...>
observer: NOTICE:  ELIMINATION_RACE_WAIT_PROVEN
step observed_wait: SELECT observed_lock();
step a_{mode}: END;
b: NOTICE:  ELIMINATION_RACE_CLAIM_PROVEN
step b_claim_{mode}: <... completed>
claim
-----
     
(1 row)
observer: NOTICE:  ELIMINATION_RACE_EFFECTS_PROVEN
step final_state: SELECT verify_actual_rows();
'''

class Results(unittest.TestCase):
    def test_both_release_modes(self):
        for mode in ('commit','rollback'):
            self.assertTrue(owner.validate_race(0,transcript(mode),'',mode)['actual_wait'])
    def test_observed_lock_is_mandatory(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit').replace('observer: NOTICE:  ELIMINATION_RACE_WAIT_PROVEN\n',''),'','commit')
    def test_exact_effects_are_mandatory(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit').replace('observer: NOTICE:  ELIMINATION_RACE_EFFECTS_PROVEN\n',''),'','commit')
    def test_error_on_stdout_is_failure_even_exit_zero(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit')+'b: ERROR: claim failed\n','','commit')
    def test_stderr_is_not_suppressed(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit'),'WARNING: unexpected transaction\n','commit')
    def test_nonzero_exit(self):
        with self.assertRaises(RuntimeError):owner.validate_race(1,transcript('commit'),'','commit')
    def test_missing_completed_caller_result(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit').replace('step b_claim_commit: <... completed>\nclaim\n-----\n     \n(1 row)','step b_claim_commit: <... completed>'),'','commit')
    def test_duplicate_claim_notice(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit')+'b: NOTICE: ELIMINATION_RACE_CLAIM_PROVEN\n','','commit')
    def test_wrong_permutation(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('rollback'),'','commit')
    def test_waiting_step_label_alone_is_not_proof(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,'step b_claim_commit: <waiting ...>\n','','commit')

if __name__=='__main__':unittest.main()
