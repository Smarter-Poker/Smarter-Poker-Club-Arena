"""Unit regressions for runner cancellation and executable source binding.

Real child processes receive real signals, but Execution is explicitly fake.
The fixture module is an import-only stub that refuses composition. No database,
PostgreSQL binary, native fixture, or production service is executed here.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import signal
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts/ci/test-mtt-unlimited.py"
INCLUDE = "scripts/ci/probes/existing-ticket-current-redemption-native.sql"


def load_runner(path=RUNNER):
    fixture_stub = types.ModuleType("mtt_unlimited_fixture")

    def refuse_native_composition(_root):
        raise AssertionError("unit import-only fixture stub cannot compose a database")

    fixture_stub.compose = refuse_native_composition
    fixture_stub.preparation_supplement_sql = refuse_native_composition
    spec = importlib.util.spec_from_file_location("r46_runner_under_test", path)
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, {"mtt_unlimited_fixture": fixture_stub}):
        with mock.patch.object(sys, "path", [str(ROOT / "scripts/ci"), *sys.path]):
            spec.loader.exec_module(module)
    return module


def signal_child(driver_path, output, pg):
    """Exercise the real main(), replacing only its database execution seam."""
    driver = load_runner(driver_path)

    class FakeExecution:
        def __init__(self, _root, result_dir, _pg, _work_parent, _deadline):
            self.output = result_dir
            self.report = {
                "native": [], "races": [], "close_calls": 0,
                "cleanup": {"stopped": False, "removed": False},
            }

        def close(self):
            self.report["close_calls"] += 1
            print("CLOSING", flush=True)
            # The parent sends repeat signals only after this handshake, then
            # permits cleanup to finish. No timing-based sleep is required.
            if sys.stdin.readline() != "finish\n":
                raise AssertionError("cleanup completion handshake was missing")
            self.report["cleanup"] = {"stopped": True, "removed": True}

    def fake_run_cases(_execution):
        print("READY", flush=True)
        sys.stdin.readline()
        raise AssertionError("expected a signal to interrupt active execution")

    driver.Execution = FakeExecution
    driver.run_cases = fake_run_cases
    os.environ["PG_BIN"] = str(pg)
    sys.argv = [str(driver_path), "--mode", "preparation", "--output", str(output)]
    driver.main()


class QualificationInputTest(unittest.TestCase):
    def test_only_finite_unique_uuid_inputs_are_accepted(self):
        render = load_runner().qualification_sql
        for values in ([], ["not-a-uuid"], ["'; COMMIT; --"],
                       ["46463000-0000-4000-8000-000000000010"] * 2,
                       ["46463000-0000-4000-8000-000000000010"] * 129):
            with self.subTest(values=values[:2]):
                with self.assertRaises(ValueError):
                    render(values)
        sql = render(["46463000-0000-4000-8000-000000000010"])
        self.assertIn("'46463000-0000-4000-8000-000000000010'::uuid", sql)
        self.assertNotIn("CREATE ", sql)
        self.assertNotIn("ALTER ", sql)


class RunnerCancellationTest(unittest.TestCase):
    def event(self, child, expected):
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(5), f"child did not emit {expected}")
        self.assertEqual(child.stdout.readline().strip(), expected)

    def cancel(self, first_signal, repeat):
        with tempfile.TemporaryDirectory(prefix="r46-runner-unit-") as directory:
            work = Path(directory)
            pg = work / "fake-pg"
            pg.mkdir()
            for name in ("postgres", "pg_ctl", "initdb", "psql"):
                executable = pg / name
                executable.write_text("#!/bin/sh\nexit 97\n")
                executable.chmod(0o700)
            output = work / "result"
            child = subprocess.Popen(
                [sys.executable, "-B", str(Path(__file__).resolve()), "--signal-child",
                 str(RUNNER), str(output), str(pg)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, start_new_session=True,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            try:
                self.event(child, "READY")
                child.send_signal(first_signal)
                self.event(child, "CLOSING")
                if repeat:
                    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                        child.send_signal(signum)
                stdout, stderr = child.communicate("finish\n", timeout=5)
                self.assertEqual(child.returncode, 1, (stdout, stderr))
                self.assertEqual(stderr, "")
                receipt = json.loads((output / "result.json").read_text())
                self.assertEqual(receipt["status"], "failed")
                self.assertEqual(receipt["failure"],
                                 f"InterruptedError: R46 execution cancelled by signal {first_signal}")
                self.assertEqual(receipt["close_calls"], 1)
                self.assertEqual(receipt["cleanup"], {"stopped": True, "removed": True})
                self.assertEqual(receipt["native"], [])
                self.assertEqual(receipt["races"], [])
                summary = json.loads(stdout)
                self.assertEqual(summary["status"], "failed")
                self.assertEqual(summary["failure"], receipt["failure"])
                self.assertEqual(summary["cleanup"], receipt["cleanup"])
            finally:
                if child.poll() is None:
                    child.kill()
                    child.communicate(timeout=5)
                for stream in (child.stdin, child.stdout, child.stderr):
                    stream.close()

    def test_sigterm_records_failure_and_closes_exactly_once(self):
        self.cancel(signal.SIGTERM, repeat=False)

    def test_repeated_termination_cannot_interrupt_cleanup_or_receipt(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(first_signal=signum):
                self.cancel(signum, repeat=True)


class CompositionBoundaryReached(Exception):
    """The unit-only preflight passed; native execution is deliberately refused."""


class RunnerSourceBindingTest(unittest.TestCase):
    def setUp(self):
        self.driver = load_runner()
        self.temporary = tempfile.TemporaryDirectory(prefix="r46-binding-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

        def asset(relative, content=None):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            data = (content or "unit-only input: " + relative).encode()
            path.write_bytes(data)
            return {"path": relative, "sha256": hashlib.sha256(data).hexdigest()}

        self.asset = asset
        self.catalog = {"version": 1, "mode": "preparation", "stages": [],
                        "locks": [], "fixtures": [],
                        "pending_activation_cases": list(self.driver.PENDING_ACTIVATION_CASES)}
        for name, migration, probe, marker, prefix, count in self.driver.PREPARATION_STAGES:
            migration_asset = asset("supabase/migrations/" + migration)
            probe_text = ("\\ir ../../../" + migration_asset["path"] + "\n") if name == "foundation" else "-- unit-only probe"
            self.catalog["stages"].append({"id": name, "migration": migration_asset,
                "probe": asset("scripts/ci/probes/" + probe, probe_text), "marker": marker,
                "notice_prefix": prefix, "assertions": count or 1})
        self.catalog["locks"] = [{**asset(path), "case": case, "permutations": 2}
                                 for case, path in self.driver.LOCK_SPECS.items()]
        self.catalog["fixtures"] = [
            {**asset(self.driver.SUCCESSOR_CAPTURE), "kind": "function-successor", "presence": "exact-predecessor"},
            {**asset("scripts/ci/fixtures/mtt-format-preparation/unit-capture.json"),
             "kind": "functions", "presence": "absent"}]
        self.catalog["preparation_races"] = [
            {"mode": mode, "fixture": asset("scripts/ci/fixtures/mtt-format-preparation/" + filename),
             "cases": [{**asset("scripts/ci/probes/mtt-isolation/" + case.replace("_", "-") + ".spec"),
                        "case": case, "permutations": 1} for case in cases]}
            for mode, (filename, cases) in self.driver.PREPARATION_RACES.items()]
        for relative in ("scripts/ci/test-mtt-unlimited.py", "scripts/ci/mtt_isolation_results.py",
                         "scripts/ci/mtt_unlimited_fixture.py", "scripts/ci/mtt_format_qualification.py"):
            asset(relative)
        # The L03 inputs are genuine source assets, not fabricated SQL authorities.
        # These unit tests only validate bytes and orchestration; no SQL executes.
        authoring = ROOT / "scripts/ci/fixtures/mtt-break-authoring/source-binding.json"
        manifest = json.loads(authoring.read_text())
        for relative in [*manifest["files"], str(authoring.relative_to(ROOT)),
                         "scripts/ci/mtt_break_authoring_native.py"]:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, path)
        self.execution = types.SimpleNamespace(root=self.root, report={"source_sha256": {}})

    def invoke(self):
        path = self.root / self.driver.PREPARATION_CATALOG
        path.write_text(json.dumps(self.catalog))
        return self.driver.run_cases(self.execution)

    def rejects_before_composition(self, exception=ValueError, message=None):
        with mock.patch.object(self.driver, "compose") as compose:
            with self.assertRaisesRegex(exception, message or ".*"):
                self.invoke()
            compose.assert_not_called()

    def test_bound_inputs_reach_composition_with_executable_identities(self):
        with mock.patch.object(self.driver, "compose", side_effect=CompositionBoundaryReached):
            with self.assertRaises(CompositionBoundaryReached):
                self.invoke()
        for relative in (self.catalog["stages"][0]["migration"]["path"],
                         "scripts/ci/test-mtt-unlimited.py", "scripts/ci/mtt_isolation_results.py",
                         "scripts/ci/mtt_unlimited_fixture.py", "scripts/ci/mtt_format_qualification.py", self.driver.PREPARATION_CATALOG):
            self.assertEqual(self.execution.report["source_sha256"][relative],
                             hashlib.sha256((self.root / relative).read_bytes()).hexdigest())

    def test_authoring_probe_drift_refuses_before_composition(self):
        (self.root / "scripts/dev/fixtures/mtt-blind-contract/authoring-native.sql").write_text("changed assertion")
        self.rejects_before_composition(message="L03 authoring source binding changed")

    def test_authoring_partial_assertion_contract_refuses_before_composition(self):
        path = self.root / "scripts/ci/fixtures/mtt-break-authoring/source-binding.json"
        document = json.loads(path.read_text())
        document["native_assertions"] -= 1
        path.write_text(json.dumps(document))
        self.rejects_before_composition(message="L03 authoring source binding shape changed")

    def authoring_wiring(self, fail):
        # Exercise the maintained caller with explicit fake execution. This checks
        # call order, template identity and failure propagation, not native SQL.
        foundation = self.catalog["stages"][0]
        foundation["probe"] = self.asset(foundation["probe"]["path"],
            "\\ir ../../../" + foundation["migration"]["path"] +
            "\n-- QUALIFY_FIRST_FORMAT\n-- REPLAY_FIRST_FORMAT\n-- QUALIFY_REMAINING_FORMATS\n")
        execution = self.execution
        execution.output = self.root / "unit-evidence"
        execution.output.mkdir()
        execution.pg = self.root
        execution.start = mock.Mock()
        execution.discard = mock.Mock()
        execution.database = mock.Mock(side_effect=["unit-template"] + ["unit-case-" + str(i) for i in range(9)])
        execution.snapshot = mock.Mock(return_value="unit-data")
        execution.catalog_snapshot = mock.Mock(return_value="unit-catalog")
        execution.report.update(native=[], races=[], migration_refusals=[])
        applied = []

        def sql(_database, _query=None, **kwargs):
            label = kwargs["label"]
            if label.startswith("prepare-"):
                applied.append(label.removeprefix("prepare-"))
            if label == "original-seats-red":
                return 3, "", "ERROR: SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: unit fixture\n"
            return 0, "", ""

        execution.sql = mock.Mock(side_effect=sql)
        tool = self.root / "unit-isolation-tool"
        tool.write_text("not executable: native unit seam")
        composition = {"sql": "unit-only SQL never executed", "source_sha256": {}, "limits": []}

        def authoring(actual_execution, root, actual_composition, *, prepared_template, preparation_sources):
            self.assertIs(actual_execution, execution)
            self.assertEqual(root, self.root)
            self.assertIs(actual_composition, composition)
            self.assertEqual(prepared_template, "unit-template")
            self.assertEqual(applied, [stage[0] for stage in self.driver.PREPARATION_STAGES])
            self.assertNotIn(mock.call("unit-template"), execution.discard.call_args_list)
            for path in ("scripts/ci/mtt_break_authoring_native.py",
                         "scripts/dev/fixtures/mtt-blind-contract/authoring-native.sql"):
                self.assertEqual(preparation_sources[path], hashlib.sha256((self.root / path).read_bytes()).hexdigest())
            if fail:
                raise RuntimeError("unit authoring refusal")
            return {"status": "passed"}

        with mock.patch.object(self.driver, "compose", return_value=composition), \
             mock.patch.object(self.driver, "preparation_supplement_sql", return_value="unit-only"), \
             mock.patch.object(self.driver, "stock_isolationtester", return_value=tool), \
             mock.patch.object(self.driver, "qualify_historical_freebuy"), \
             mock.patch.object(self.driver, "run_drift_cases"), \
             mock.patch.object(self.driver, "run_lock_cases"), \
             mock.patch.object(self.driver, "run_preparation_races"), \
             mock.patch.object(self.driver, "assert_probe_result"), \
             mock.patch.object(self.driver, "run_authoring_native", side_effect=authoring) as call:
            if fail:
                with self.assertRaisesRegex(RuntimeError, "unit authoring refusal"):
                    self.invoke()
                self.assertNotIn("source_binding_verified_at_completion", execution.report)
            else:
                self.invoke()
                self.assertIs(execution.report["source_binding_verified_at_completion"], True)
                execution.discard.assert_called_with("unit-template")
            call.assert_called_once()

    def test_authoring_receives_template_only_after_all_eight_preparations(self):
        self.authoring_wiring(fail=False)

    def test_authoring_failure_cannot_be_a_complete_preparation_pass(self):
        self.authoring_wiring(fail=True)

    def test_missing_preparation_stage_is_not_a_partial_pass(self):
        self.catalog["stages"].pop()
        self.rejects_before_composition(message="all eight")

    def test_reordered_preparation_is_refused(self):
        self.catalog["stages"][0], self.catalog["stages"][1] = self.catalog["stages"][1], self.catalog["stages"][0]
        self.rejects_before_composition(message="all eight")

    def test_unsafe_old_migration_cannot_supply_preparation_identity(self):
        self.catalog["stages"][0]["migration"] = self.asset("supabase/migrations/20260915150000_mtts_have_no_entry_cap.sql")
        self.rejects_before_composition(message="actual preparation asset")

    def test_changed_actual_migration_bytes_are_refused(self):
        (self.root / self.catalog["stages"][0]["migration"]["path"]).write_text("changed migration")
        self.rejects_before_composition(message="source binding changed")

    def test_missing_capture_is_refused(self):
        self.catalog["fixtures"] = []
        self.rejects_before_composition(message="captured preparation supplements")

    def test_successor_cannot_be_omitted_reordered_or_made_permissive(self):
        first = self.catalog["fixtures"].pop(0)
        self.rejects_before_composition(message="current satellite successor")
        self.catalog["fixtures"].append(first)
        self.rejects_before_composition(message="current satellite successor")
        self.catalog["fixtures"].reverse()
        first["presence"] = "exact-or-absent"
        self.rejects_before_composition(message="current satellite successor")

    def test_alternate_probe_include_is_refused_even_when_rehashed(self):
        entry = self.catalog["stages"][0]
        entry["probe"] = self.asset(entry["probe"]["path"], "\\ir ../../../supabase/migrations/unrelated.sql\n")
        self.rejects_before_composition(message="actual bound migration")

    def test_unbound_extra_probe_include_is_refused(self):
        entry = self.catalog["stages"][1]
        entry["probe"] = self.asset(entry["probe"]["path"], "\\ir unbound.sql\n")
        self.rejects_before_composition(message="unbound native include")

    def test_capture_symlink_outside_root_is_refused(self):
        with tempfile.TemporaryDirectory(prefix="r46-outside-unit-") as other:
            outside = Path(other) / "source.json"
            outside.write_text("outside")
            entry = self.catalog["fixtures"][0]
            path = self.root / entry["path"]
            path.unlink()
            path.symlink_to(outside)
            entry["sha256"] = hashlib.sha256(outside.read_bytes()).hexdigest()
            self.rejects_before_composition(message="source binding changed")

    def test_captured_table_schema_must_bind_the_actual_companion_bytes(self):
        schema_path = "scripts/ci/fixtures/mtt-format-preparation/projection-tables-20260917.sql"
        fixture = {**self.asset("scripts/ci/fixtures/mtt-format-preparation/projection-tables-20260917.json"),
                   "kind": "tables", "presence": "absent", "schema": self.asset(schema_path)}
        self.catalog["fixtures"].append(fixture)
        with mock.patch.object(self.driver, "compose", side_effect=CompositionBoundaryReached):
            with self.assertRaises(CompositionBoundaryReached):
                self.invoke()
        (self.root / schema_path).write_text("unbound replacement schema")
        self.rejects_before_composition(message="source binding changed")
        fixture["schema"] = self.asset("scripts/ci/fixtures/mtt-format-preparation/unrelated.sql")
        self.rejects_before_composition(message="actual preparation asset path")

    def test_both_lock_contracts_and_pending_activation_are_mandatory(self):
        original = list(self.catalog["locks"])
        self.catalog["locks"].pop()
        self.rejects_before_composition(message="all preparation")
        self.catalog["locks"] = original
        self.catalog["pending_activation_cases"].pop()
        self.rejects_before_composition(message="six pending")

    def test_missing_race_group_or_case_cannot_claim_complete_preparation(self):
        groups = self.catalog["preparation_races"]
        self.catalog["preparation_races"] = groups[:1]
        self.rejects_before_composition(message="race groups required")
        self.catalog["preparation_races"] = groups
        groups[1]["cases"].pop()
        self.rejects_before_composition(message="all eight ordered")

    def test_changed_race_fixture_and_spec_bytes_are_refused(self):
        group = self.catalog["preparation_races"][0]
        path = self.root / group["fixture"]["path"]
        before = path.read_bytes()
        path.write_text("changed economic oracle")
        self.rejects_before_composition(message="source binding changed")
        path.write_bytes(before)
        (self.root / group["cases"][0]["path"]).write_text("changed permutation")
        self.rejects_before_composition(message="source binding changed")

    def test_race_fixture_cannot_hide_unbound_includes(self):
        group = self.catalog["preparation_races"][0]
        group["fixture"] = self.asset(group["fixture"]["path"], "\\ir unbound.sql\n")
        self.rejects_before_composition(message="unbound preparation race fixture")

    def test_legacy_fixture_cannot_be_swapped_for_synthetic_future(self):
        groups = self.catalog["preparation_races"]
        groups[1]["fixture"] = groups[0]["fixture"]
        self.rejects_before_composition(message="actual preparation asset path")

    def test_native_marker_alone_cannot_hide_missing_assertions_or_errors(self):
        stage = self.catalog["stages"][0]
        out = stage["marker"] + "\n"
        notices = ("NOTICE: " + stage["notice_prefix"] + " accepted\n") * stage["assertions"]
        notices += "WARNING: " + self.driver.FOUNDATION_REFUSAL_WARNING + "\n"
        self.driver.assert_probe_result(stage, out, notices)
        for stdout, stderr in [(out, ""), (out + out, notices), (out, notices + "WARNING: refused\n"),
                               (out + "ERROR: incomplete\n", notices)]:
            with self.subTest(stdout=stdout, stderr=stderr):
                with self.assertRaises(ValueError):
                    self.driver.assert_probe_result(stage, stdout, stderr)

    def test_foundation_requires_exactly_its_one_deliberate_refusal_warning(self):
        stage = self.catalog["stages"][0]
        out = stage["marker"] + "\n"
        notices = ("NOTICE: " + stage["notice_prefix"] + " accepted\n") * stage["assertions"]
        warning = "WARNING: " + self.driver.FOUNDATION_REFUSAL_WARNING + "\n"
        self.driver.assert_probe_result(stage, out, notices + warning)
        for diagnostic in ("", warning * 2, warning.replace("000000000024", "000000000025"),
                           warning + "WARNING: unexpected native failure\n"):
            with self.subTest(diagnostic=diagnostic):
                with self.assertRaisesRegex(ValueError, "warning evidence differs"):
                    self.driver.assert_probe_result(stage, out, notices + diagnostic)
        other = self.catalog["stages"][1]
        with self.assertRaisesRegex(ValueError, "warning evidence differs"):
            self.driver.assert_probe_result(other, other["marker"] + "\n", warning)


class RunnerRefusalEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.driver = load_runner()
        self.stage = {"id": "projections", "migration": {"path": "unit-only.sql"}}
        self.cases = [("unit-only", "UNIT-ONLY MUTATION", "EXPECTED_REFUSAL")]

    def execution(self, code=3, stderr="ERROR: EXPECTED_REFUSAL\n", row_drift=False, catalog_drift=False):
        fixture = mock.Mock()
        fixture.root = ROOT
        fixture.report = {"migration_refusals": []}
        fixture.database.return_value = "unit-only"
        fixture.sql.side_effect = [(0, "", ""), (code, "", stderr)]
        fixture.snapshot.side_effect = ["rows-before", "rows-changed" if row_drift else "rows-before"]
        fixture.catalog_snapshot.side_effect = ["catalog-before", "catalog-changed" if catalog_drift else "catalog-before"]
        return fixture

    def test_exact_refusal_requires_matching_data_and_catalog(self):
        execution = self.execution()
        self.driver.run_drift_cases(execution, "unit-only-template", self.stage, self.cases)
        self.assertEqual(execution.report["migration_refusals"], [{
            "stage": "projections", "kind": "unit-only", "error": "EXPECTED_REFUSAL",
            "exact_rollback": True, "database_removed": True}])
        execution.discard.assert_called_once_with("unit-only")

    def test_wrong_exit_or_error_never_counts_as_guard_refusal(self):
        for code, stderr in [(0, "ERROR: EXPECTED_REFUSAL\n"), (1, "ERROR: EXPECTED_REFUSAL\n"),
                             (3, "ERROR: UNEXPECTED_REFUSAL\n"),
                             (3, "ERROR: EXPECTED_REFUSAL\nERROR: EXTRA\n")]:
            with self.subTest(code=code, stderr=stderr):
                execution = self.execution(code=code, stderr=stderr)
                with self.assertRaisesRegex(ValueError, "did not refuse exact"):
                    self.driver.run_drift_cases(execution, "unit-only-template", self.stage, self.cases)
                self.assertEqual(execution.report["migration_refusals"], [])


    def test_refusal_cannot_hide_partial_catalog_or_data_changes(self):
        for row_drift, catalog_drift in [(True, False), (False, True), (True, True)]:
            with self.subTest(rows=row_drift, catalog=catalog_drift):
                execution = self.execution(row_drift=row_drift, catalog_drift=catalog_drift)
                with self.assertRaisesRegex(ValueError, "did not preserve full"):
                    self.driver.run_drift_cases(execution, "unit-only-template", self.stage, self.cases)
                self.assertEqual(execution.snapshot.call_count, 2)
                self.assertEqual(execution.catalog_snapshot.call_count, 2)
                self.assertEqual(execution.report["migration_refusals"], [])


class RunnerIsolationToolTest(unittest.TestCase):
    def test_existing_accounting_tool_path_is_used_and_invalid_explicit_path_refused(self):
        driver = load_runner()
        with tempfile.TemporaryDirectory(prefix="r46-tool-unit-") as directory:
            root = Path(directory)
            tool = root / "isolationtester"
            tool.write_text("unit-only executable, never invoked")
            tool.chmod(0o700)
            with mock.patch.dict(os.environ, {"PG_ISOLATION_TESTER": str(tool)}):
                self.assertEqual(driver.stock_isolationtester(root / "bin"), tool.resolve())
                tool.unlink()
                with self.assertRaisesRegex(RuntimeError, "configured PostgreSQL isolationtester"):
                    driver.stock_isolationtester(root / "bin")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--signal-child":
        signal_child(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
    else:
        unittest.main()
