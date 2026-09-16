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
    sys.argv = [str(driver_path), "--output", str(output)]
    driver.main()


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
        self.catalog = {
            "migration": asset(self.driver.MIGRATION),
            "fixture": asset(self.driver.ASSETS + "/fixture.sql"),
            "readme": asset(self.driver.ASSETS + "/README.md"),
            "native_probes": [asset("scripts/ci/probes/" + filename)
                              for filename, _ in self.driver.PROBES],
            "included_probes": [asset(INCLUDE)],
            "required_cases": [],
        }
        for case in ("creation_commit", "creation_rollback", "edit_after_creation",
                     "edit_before_creation", "restart_commit", "restart_rollback"):
            self.catalog["required_cases"].append({
                **asset(self.driver.ASSETS + "/" + case + ".spec"), "case": case,
            })
        for relative in ("scripts/ci/test-mtt-unlimited.py", "scripts/ci/mtt_isolation_results.py",
                         "scripts/ci/mtt_unlimited_fixture.py"):
            asset(relative)
        self.execution = types.SimpleNamespace(root=self.root, report={"source_sha256": {}})

    def invoke(self):
        path = self.root / self.driver.ASSETS / "catalog-candidate.json"
        path.write_text(json.dumps(self.catalog))
        return self.driver.run_cases(self.execution)

    def rejects_before_composition(self, exception, message=None):
        with mock.patch.object(self.driver, "compose") as compose:
            if message is None:
                with self.assertRaises(exception):
                    self.invoke()
            else:
                with self.assertRaisesRegex(exception, message):
                    self.invoke()
            compose.assert_not_called()

    def test_bound_inputs_reach_composition_with_executable_identities(self):
        with mock.patch.object(self.driver, "compose", side_effect=CompositionBoundaryReached):
            with self.assertRaises(CompositionBoundaryReached):
                self.invoke()
        for relative in (self.driver.MIGRATION, INCLUDE, "scripts/ci/test-mtt-unlimited.py",
                         "scripts/ci/mtt_isolation_results.py", "scripts/ci/mtt_unlimited_fixture.py",
                         self.driver.ASSETS + "/catalog-candidate.json"):
            self.assertEqual(self.execution.report["source_sha256"][relative],
                             hashlib.sha256((self.root / relative).read_bytes()).hexdigest())

    def test_missing_actual_migration_is_refused(self):
        del self.catalog["migration"]
        self.rejects_before_composition((KeyError, ValueError))

    def test_other_migration_cannot_supply_the_executed_migration_identity(self):
        self.catalog["migration"] = self.asset("supabase/migrations/unrelated.sql")
        self.rejects_before_composition(ValueError, "actual migration")

    def test_changed_actual_migration_bytes_are_refused(self):
        (self.root / self.driver.MIGRATION).write_text("changed migration")
        self.rejects_before_composition(ValueError, "source binding changed")

    def test_missing_included_probe_is_refused(self):
        self.catalog["included_probes"] = []
        self.rejects_before_composition(ValueError, "exact ticket include")

    def test_other_include_cannot_supply_the_actual_include_identity(self):
        self.catalog["included_probes"] = [self.asset("scripts/ci/probes/unrelated.sql")]
        self.rejects_before_composition(ValueError, "exact ticket include")

    def test_changed_included_probe_bytes_are_refused(self):
        (self.root / INCLUDE).write_text("changed included SQL")
        self.rejects_before_composition(ValueError, "source binding changed")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--signal-child":
        signal_child(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
    else:
        unittest.main()
