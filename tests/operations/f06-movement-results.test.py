"""The native owning caller must not accept missing effects or swallowed SQL errors."""
from pathlib import Path
import importlib.util
import sys
import unittest

sys.dont_write_bytecode=True
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'scripts/ci'))
spec=importlib.util.spec_from_file_location('movement_owner',root/'scripts/ci/test-f06-movement-admission.py')
owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)

def transcript(mode):
    return f'''Parsed test spec with 3 sessions
starting permutation: a_begin a_claim b_claim_{mode} observed_wait a_{mode} final_state
step a_begin: BEGIN;
a: NOTICE:  MOVEMENT_RACE_CLAIM_PROVEN
step a_claim: SELECT pg_temp.claim(false);
claim
-----

(1 row)
step b_claim_{mode}: SELECT pg_temp.claim(true); <waiting ...>
observer: NOTICE:  MOVEMENT_RACE_WAIT_PROVEN
step observed_wait: SELECT observed_lock();
step a_{mode}: END;
b: NOTICE:  MOVEMENT_RACE_CLAIM_PROVEN
step b_claim_{mode}: <... completed>
claim
-----

(1 row)
observer: NOTICE:  MOVEMENT_RACE_EFFECTS_PROVEN
step final_state: SELECT verify_actual_rows();
'''

class Results(unittest.TestCase):
    def test_both_release_modes(self):
        for mode in ('commit','rollback'):
            self.assertTrue(owner.validate_race(0,transcript(mode),'',mode)['actual_wait'])
    def test_observed_lock_is_mandatory(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit').replace('observer: NOTICE:  MOVEMENT_RACE_WAIT_PROVEN\n',''),'','commit')
    def test_exact_effects_are_mandatory(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit').replace('observer: NOTICE:  MOVEMENT_RACE_EFFECTS_PROVEN\n',''),'','commit')
    def test_error_on_stdout_is_failure_even_exit_zero(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit')+'b: ERROR: claim failed\n','','commit')
    def test_stderr_is_not_suppressed(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit'),'WARNING: unexpected transaction\n','commit')
    def test_nonzero_exit(self):
        with self.assertRaises(RuntimeError):owner.validate_race(1,transcript('commit'),'','commit')
    def test_missing_completed_caller_result(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit').replace('step b_claim_commit: <... completed>\nclaim\n-----\n\n(1 row)','step b_claim_commit: <... completed>'),'','commit')
    def test_duplicate_claim_notice(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('commit')+'b: NOTICE: MOVEMENT_RACE_CLAIM_PROVEN\n','','commit')
    def test_wrong_permutation(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,transcript('rollback'),'','commit')
    def test_waiting_step_label_alone_is_not_proof(self):
        with self.assertRaises(RuntimeError):owner.validate_race(0,'step b_claim_commit: <waiting ...>\n','','commit')

class ProbeResults(unittest.TestCase):
    def test_complete_probe(self):
        owner.validate_probe(0,'F06_MOVEMENT_ADMISSION_PASS\n','MOVEMENT PASS: case\n'*139)
    def test_missing_or_extra_assertion(self):
        for n in (0,73,138,140):
            with self.assertRaises(RuntimeError): owner.validate_probe(0,'F06_MOVEMENT_ADMISSION_PASS\n','MOVEMENT PASS: case\n'*n)
    def test_sql_error_or_missing_terminal(self):
        for code,out,err in [(1,'F06_MOVEMENT_ADMISSION_PASS\n','MOVEMENT PASS: case\n'*139), (0,'','MOVEMENT PASS: case\n'*139), (0,'F06_MOVEMENT_ADMISSION_PASS\n','MOVEMENT PASS: case\n'*139+'ERROR: failed')]:
            with self.assertRaises(RuntimeError): owner.validate_probe(code,out,err)

if __name__=='__main__':unittest.main()
