"""Reject false-success transcripts for the actual admission ABI transitions."""
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/ci"))
from mtt_activation_native import TRANSITION_CASES, transition_spec, validate_transition


def transcript(case):
    import re
    spec = transition_spec(case)
    steps = dict(re.findall(r'^step "([a-z_]+)" \{ (.*) \}$', spec, re.M))
    lines = ["Parsed test spec with 3 sessions", "", "starting permutation: a_begin a_action b_begin b_action observed_wait a_finish b_finish final_state"]
    def result(name):
        lines.extend([name, "-" * len(name), " " * len(name), "(1 row)", ""])
    def completed(name, resumed=False):
        lines.append("step " + name + ": " + ("<... completed>" if resumed else steps[name]))
        if steps[name].startswith("SELECT "):
            result(steps[name].split(".")[1].split("(")[0])
    result("pristine")
    for name in ("a_begin", "a_action", "b_begin"):
        completed(name)
    lines.append("step b_action: " + steps["b_action"] + " <waiting ...>")
    completed("observed_wait")
    completed("a_finish")
    completed("b_action", True)
    completed("b_finish")
    lines.append("observer: NOTICE:  MTT ACTUAL ACTIVATION TRANSITION COMPLETE: " + case)
    completed("final_state")
    lines.extend(["a: WARNING:  there is no transaction in progress", "b: WARNING:  there is no transaction in progress", ""])
    return spec, "\n".join(lines)


class ActivationTranscriptTests(unittest.TestCase):
    def test_every_exact_case_and_notice_delivery_position(self):
        for case in TRANSITION_CASES:
            with self.subTest(case=case):
                spec, out = transcript(case)
                self.assertTrue(validate_transition(case, spec, 0, out, "")["observed_wait"])
                notice = "observer: NOTICE:  MTT ACTUAL ACTIVATION TRANSITION COMPLETE: " + case
                header = "step final_state: SELECT r46_activation.verify_final('" + case + "');"
                moved = out.replace(notice + "\n" + header, header + "\n" + notice)
                self.assertTrue(validate_transition(case, spec, 0, moved, "")["observed_wait"])

    def test_real_deferred_commit_error_cannot_be_exit_zero_success(self):
        spec, out = transcript("admission_legacy_first_commit")
        out = out.replace("step a_finish: COMMIT;", "step a_finish: COMMIT;\nERROR:  accounting_terms_not_authorised")
        with self.assertRaises(ValueError):
            validate_transition("admission_legacy_first_commit", spec, 0, out, "")

    def test_missing_wait_witness_or_result_is_refused(self):
        case = "creator_activation_first_commit"
        spec, out = transcript(case)
        faults = [out.replace(" <waiting ...>", ""),
                  out.replace("blocked\n-------\n       \n(1 row)\n", ""),
                  out.replace("step b_action: <... completed>\ncreate_event", "step b_action: <... completed>\nERROR"),
                  out.replace("verify_final\n------------\n            \n(1 row)\n", "")]
        for value in faults:
            self.assertNotEqual(value, out, "negative control must actually corrupt the result")
            with self.subTest(value=value[-60:]), self.assertRaises(ValueError):
                validate_transition(case, spec, 0, value, "")

    def test_final_marker_alone_trailing_errors_and_stderr_are_refused(self):
        case = "admission_activation_first_rollback"
        spec, out = transcript(case)
        for code, value, err in [(1,out,""), (0,out,"ERROR"), (0,out+"ERROR: late failure\n",""),
                                  (0,"MTT ACTUAL ACTIVATION TRANSITION COMPLETE: "+case+"\n","")]:
            with self.subTest(code=code,stderr=err), self.assertRaises(ValueError):
                validate_transition(case,spec,code,value,err)

    def test_spec_change_or_forced_wait_cannot_reuse_transcript(self):
        case = "creator_legacy_first_commit"
        spec, out = transcript(case)
        for changed in (spec.replace("COMMIT;", "ROLLBACK;", 1), spec.replace('"b_action" "observed_wait"','"b_action"(*) "observed_wait"')):
            with self.assertRaises(ValueError):
                validate_transition(case, changed, 0, out, "")


if __name__ == "__main__":
    unittest.main()
