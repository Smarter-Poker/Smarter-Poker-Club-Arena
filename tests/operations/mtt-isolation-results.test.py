"""Offline result-consumer regressions, not execution of the SQL race cases.

Transcripts below are synthetic inputs using stock PostgreSQL REL_17_11 output
conventions, independently specified from the consumer. Native execution and
provider/fixture identity remain the invoking workflow's separate obligation.
"""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "mtt_isolation_results", ROOT / "scripts/ci/mtt_isolation_results.py")
consumer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(consumer)
CATALOG = json.loads((ROOT / "scripts/ci/probes/mtt-isolation/catalog-candidate.json").read_text())
CASES = {entry["case"]: entry for entry in CATALOG["required_cases"]}


def result_table(name):
    return name + "\n" + "-" * len(name) + "\n" + " " * len(name) + "\n(1 row)\n\n"


def synthetic_transcript(case="creation_commit", *, notice_before=True):
    """Model stock print grammar; do not call parser internals to form inputs."""
    entry = CASES[case]
    source = (ROOT / entry["path"]).read_text()
    sql = dict(re.findall(r'^step "([a-z_]+)" \{ (.*) \}$', source, re.M))
    order = re.findall(r'"([a-z_]+)"', re.search(r'^permutation (.*)$', source, re.M).group(1))
    output = "Parsed test spec with 3 sessions\n\nstarting permutation: " + " ".join(order) + "\n"
    output += result_table("pristine")
    blocker, waiter = entry["registered_blocker"], entry["registered_waiter"]

    def step(name, resumed=False):
        rendered = "step " + name + ": " + ("<... completed>" if resumed else sql[name]) + "\n"
        if sql[name].startswith("SELECT "):
            rendered += result_table(re.search(r'r46_mtt_isolation\.([a-z_]+)\(', sql[name]).group(1))
        return rendered

    for name in order:
        if name == "final_state":
            notice = "observer: NOTICE:  " + entry["final_marker"] + "\n"
            if notice_before:
                output += notice + step(name)
            else:
                output += "step final_state: " + sql[name] + "\n" + notice + result_table("verify_final")
        elif name == waiter + "_action":
            output += "step " + name + ": " + sql[name] + " <waiting ...>\n"
        else:
            output += step(name)
        if name == blocker + "_finish":
            output += step(waiter + "_action", resumed=True)
    output += "a: WARNING:  there is no transaction in progress\n"
    output += "b: WARNING:  there is no transaction in progress\n"
    return output


class IsolationResultsTest(unittest.TestCase):
    def setUp(self):
        self.entry = copy.deepcopy(CASES["creation_commit"])
        self.source = (ROOT / self.entry["path"]).read_text()
        self.output = synthetic_transcript()

    def validate(self, output=None, **overrides):
        args = dict(stdout=self.output if output is None else output, stderr="", returncode=0)
        args.update(overrides)
        return consumer.validate_case_result(self.entry, self.source, **args)

    def reject(self, output, **overrides):
        with self.assertRaises(ValueError):
            self.validate(output, **overrides)

    def test_all_six_catalog_cases_and_both_libpq_notice_positions(self):
        self.assertEqual(len(CASES), 6)
        for case, entry in CASES.items():
            for before in (True, False):
                with self.subTest(case=case, notice_before=before):
                    output = synthetic_transcript(case, notice_before=before)
                    receipt = consumer.validate_case_result(
                        entry, (ROOT / entry["path"]).read_text(), stdout=output, stderr="", returncode=0)
                    self.assertEqual(receipt["case"], case)
                    self.assertEqual(receipt["status"], "transcript_accepted")
                    self.assertEqual(receipt["spec_sha256"], entry["sha256"])
                    self.assertEqual(receipt["stdout_sha256"], hashlib.sha256(output.encode()).hexdigest())
                    self.assertIs(receipt["observed_wait_assertion"], True)
                    self.assertEqual(len(receipt["completed_steps"]), 8)
                    self.assertEqual(set(receipt["completed_steps"]), set(receipt["permutation"]))
                    self.assertEqual(receipt["completed_steps"][-1], "final_state")
                    self.assertEqual(receipt["final_marker"], entry["final_marker"])
                    self.assertEqual(len(receipt["accepted_teardown_warnings"]), 2)

    def test_successfully_stripped_trailing_void_padding_is_supported(self):
        output = "\n".join(line.rstrip(" ") for line in self.output.split("\n"))
        self.assertEqual(self.validate(output)["status"], "transcript_accepted")

    def test_missing_final_marker_rejects_despite_exit_zero_and_step_label(self):
        line = "observer: NOTICE:  " + self.entry["final_marker"] + "\n"
        self.assertIn("step final_state:", self.output)
        self.reject(self.output.replace(line, ""))

    def test_error_while_exit_zero_rejects_before_during_and_after_results(self):
        error = "ERROR:  R46 ASSERTION FAILED: fixture assertion\n"
        for position in [0, self.output.index("step observed_wait:"),
                         self.output.index("step final_state:"), len(self.output)]:
            with self.subTest(position=position):
                self.reject(self.output[:position] + error + self.output[position:])
        self.reject(self.output.replace(result_table("blocked"), error))
        self.reject(self.output.replace(result_table("verify_final"), error))

    def test_step_labels_and_final_marker_without_sql_results_cannot_pass(self):
        for result in ("pristine", "ensure", "blocked", "verify_final"):
            with self.subTest(result=result):
                self.reject(self.output.replace(result_table(result), "", 1))
        self.reject("\n".join(line for line in self.output.splitlines()
                              if line.startswith(("Parsed", "starting", "step", "observer:", "a:", "b:"))) + "\n")

    def test_void_result_requires_actual_single_empty_row(self):
        valid = result_table("blocked")
        for invalid in (valid.replace("(1 row)", "(0 rows)"),
                        valid.replace("(1 row)", "(2 rows)"),
                        valid.replace("       \n", "t\n"),
                        valid.replace("       \n", ""),
                        valid.replace("-------", "------")):
            with self.subTest(invalid=repr(invalid)):
                self.reject(self.output.replace(valid, invalid))

    def test_only_one_exact_permutation_is_accepted(self):
        line = next(line for line in self.output.splitlines() if line.startswith("starting permutation:")) + "\n"
        for output in (self.output.replace(line, ""), self.output.replace(line, line + line),
                       self.output.replace(line, line.replace("a_begin a_action", "a_action a_begin")),
                       self.output + self.output):
            with self.subTest(output_length=len(output)):
                self.reject(output)

    def test_each_step_must_finish_once_with_exact_sql_and_in_order(self):
        step_lines = [line + "\n" for line in self.output.splitlines() if line.startswith("step ")]
        for line in step_lines:
            with self.subTest(line=line):
                self.reject(self.output.replace(line, ""))
                self.reject(self.output.replace(line, line + line))
        self.reject(self.output.replace("SELECT r46_mtt_isolation.blocked('a','b');", "SELECT true;"))
        self.reject(self.output.replace("step b_action: <... completed>\n", "step b_action: pending\n"))
        self.reject(self.output.replace("step a_finish: COMMIT;", "step a_finish: ROLLBACK;"))

    def test_wait_must_be_real_and_observed_before_owner_release(self):
        self.reject(self.output.replace(" <waiting ...>", ""))
        self.reject(self.output.replace(" <waiting ...>", " <waiting ...> (*)"))
        wait = "step observed_wait: SELECT r46_mtt_isolation.blocked('a','b');\n" + result_table("blocked")
        release = "step a_finish: COMMIT;\n"
        self.reject(self.output.replace(wait + release, release + wait))
        completed = "step b_action: <... completed>\n" + result_table("ensure")
        self.reject(self.output.replace(release + completed, completed + release))

    def test_final_notice_identity_count_and_phase_are_exact(self):
        notice = "observer: NOTICE:  " + self.entry["final_marker"] + "\n"
        for replacement in (notice + notice, notice.replace("observer:", "a:"),
                            notice.replace("creation_commit", "creation_rollback"),
                            notice.replace("NOTICE:", "WARNING:")):
            with self.subTest(replacement=replacement):
                self.reject(self.output.replace(notice, replacement))
        without = self.output.replace(notice, "")
        self.reject(notice + without)
        self.reject(without + notice)
        self.reject(without.replace("step observed_wait:", notice + "step observed_wait:"))

    def test_only_exact_actor_teardown_warnings_at_the_end_are_accepted(self):
        a = "a: WARNING:  there is no transaction in progress\n"
        b = "b: WARNING:  there is no transaction in progress\n"
        for replacement in ("", a, b, b + a, a + a + b, a + b + b,
                            a.replace("a:", "observer:") + b,
                            a.replace("in progress", "in progress!") + b):
            with self.subTest(replacement=replacement):
                self.reject(self.output.replace(a + b, replacement))
        self.reject(a + self.output.replace(a, ""))
        self.reject(self.output.replace(a, "").replace("step a_finish:", a + "step a_finish:"))

    def test_unknown_diagnostics_never_get_filtered_even_if_marker_exists(self):
        for diagnostic in (
            "WARNING:  there is no transaction in progress",
            "b: WARNING:  unrelated warning", "observer: NOTICE:  unrelated notice",
            "isolationtester: canceling step b_action after 15 seconds",
            "step b_action timed out after 30 seconds", "FATAL:  connection lost",
            "ERROR:  deadlock detected", "unexpected result status: PGRES_BAD_RESPONSE",
            "failed to send query for step b_action: connection lost",
            'a: NOTIFY "unexpected" with payload "" from b', "arbitrary unknown output",
        ):
            with self.subTest(diagnostic=diagnostic):
                self.reject(self.output + diagnostic + "\n")

    def test_stderr_never_treated_as_a_benign_notice_stream(self):
        for stderr in ("teardown of session a failed: ERROR: failure\n", " ", "\n",
                       "a: WARNING:  there is no transaction in progress\n"):
            with self.subTest(stderr=stderr):
                self.reject(self.output, stderr=stderr)

    def test_nonzero_or_untyped_process_status_cannot_pass(self):
        for status in (1, 2, 124, -9, None, True, False, "0", 0.0):
            with self.subTest(status=status):
                self.reject(self.output, returncode=status)

    def test_missing_truncated_or_control_character_output_is_rejected(self):
        for output in ("", self.output[:-1], self.output[:self.output.index("step final_state:")],
                       self.output + "\x00\n", self.output.replace("NOTICE", "\x1b[32mNOTICE"),
                       self.output.replace("\n", "\r\n"), self.output + "x" * 1048576 + "\n"):
            with self.subTest(length=len(output)):
                self.reject(output)

    def test_spec_sha256_is_bound_before_log_acceptance(self):
        self.source += "\n# changed source\n"
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.validate()
        self.source = (ROOT / self.entry["path"]).read_text()
        self.entry["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.validate()

    def test_catalog_cannot_reroute_case_actors_marker_or_permutation_count(self):
        for key, value in (("case", "unknown"), ("case", "creation_rollback"),
                           ("registered_blocker", "b"), ("registered_waiter", "a"),
                           ("final_marker", "PASS"), ("permutations", 2),
                           ("permutations", True)):
            entry = self.entry.copy()
            entry[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                consumer.validate_case_result(entry, self.source, stdout=self.output, stderr="", returncode=0)

    def test_changed_spec_contract_is_rejected_even_with_updated_hash(self):
        for source in (self.source.replace('"b_action" "observed_wait"', '"b_action"(*) "observed_wait"'),
                       self.source.replace("blocked('a','b')", "blocked('b','a')"),
                       self.source.replace("teardown { ROLLBACK; }", "teardown { COMMIT; }", 1),
                       self.source.replace('session "observer"', 'session "other"'),
                       self.source + '\nstep "extra" { SELECT 1; }\n',
                       self.source + '\npermutation "a_begin"\n'):
            entry = self.entry.copy()
            entry["sha256"] = hashlib.sha256(source.encode()).hexdigest()
            with self.subTest(source_length=len(source)), self.assertRaises(ValueError):
                consumer.validate_case_result(entry, source, stdout=self.output, stderr="", returncode=0)


class PreparationLockResultsTest(unittest.TestCase):
    def setUp(self):
        self.folder = ROOT / "tests/operations/fixtures/mtt-preparation-lock"

    def inputs(self, case="format_admission", negative=False):
        filename = {"format_admission": "mtt-format-admission-lock.spec",
                    "registration_admission": "mtt-registration-admission-lock.spec",
                    "seat_capacity_admission": "mtt-seat-capacity-admission-lock.spec"}[case]
        source = (ROOT / "scripts/ci/probes" / filename).read_text()
        entry = {"case": case, "sha256": hashlib.sha256(source.encode()).hexdigest(), "permutations": 2}
        output = (self.folder / (case + ("-negative" if negative else "-actual") + ".stdout")).read_text()
        return entry, source, output

    def test_both_real_lock_paths_and_both_missing_lock_controls(self):
        for case in ("format_admission", "registration_admission", "seat_capacity_admission"):
            for negative in (False, True):
                entry, source, output = self.inputs(case, negative)
                result = consumer.validate_format_lock_result(entry, source, stdout=output, stderr="", returncode=0, negative=negative)
                self.assertEqual(result["permutations"], 2)
                self.assertEqual(result["observed_wait_assertions"], 0 if negative else 2)
                self.assertEqual(result["exact_missing_lock_refusals"], 2 if negative else 0)

    def test_truncation_errors_wait_and_result_loss_cannot_pass_exit_zero(self):
        for case in ("format_admission", "registration_admission", "seat_capacity_admission"):
            entry, source, output = self.inputs(case)
            mutations = [output[:-1], output.replace(" <waiting ...>", ""),
                         output.replace("step writer_update: <... completed>\n", ""),
                         output.replace("(1 row)", "(0 rows)", 1),
                         output + "ERROR: hidden\n", output.replace("legacy-capacity-v1", "unlimited-mtt-v2"),
                         output[:output.rindex("starting permutation:")],
                         output.replace("reader_commit writer_rollback", "writer_rollback reader_commit")]
            for mutant in mutations:
                with self.subTest(case=case, size=len(mutant)):
                    with self.assertRaises(ValueError):
                        consumer.validate_format_lock_result(entry, source, stdout=mutant, stderr="", returncode=0)

    def test_negative_control_is_not_positive_success_and_requires_exact_both_refusals(self):
        for case in ("format_admission", "registration_admission", "seat_capacity_admission"):
            entry, source, output = self.inputs(case, True)
            for mutant, negative in [(output, False), (output.replace("ERROR:  ", "NOTICE:  ", 1), True),
                                     (output + "ERROR:  unrelated\n", True)]:
                with self.assertRaises(ValueError):
                    consumer.validate_format_lock_result(entry, source, stdout=mutant, stderr="", returncode=0, negative=negative)

    def test_process_status_stderr_and_changed_spec_fail_closed(self):
        entry, source, output = self.inputs()
        for kwargs in ({"returncode": 1}, {"stderr": "WARNING: issue\n"}, {"returncode": False}):
            args = {"stdout": output, "stderr": "", "returncode": 0, **kwargs}
            with self.assertRaises(ValueError):
                consumer.validate_format_lock_result(entry, source, **args)
        with self.assertRaises(ValueError):
            consumer.validate_format_lock_result(entry, source + "\n", stdout=output, stderr="", returncode=0)


if __name__ == "__main__":
    unittest.main()
