#!/usr/bin/env python3
"""Focused unit checks for the Stage-B cash-payer runner's target guard."""
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


RUNNER_PATH = Path(__file__).with_name("rehearse-stage-b-cash-payers.py")
SPEC = importlib.util.spec_from_file_location("stage_b_cash_payer_runner", RUNNER_PATH)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class StageBCashPayerTargetSafetyTest(unittest.TestCase):
    def setUp(self):
        self.socket_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.socket_directory.cleanup)
        self.arguments = [
            "--root", str(RUNNER_PATH.parents[2]),
            "--evidence", str(Path(self.socket_directory.name) / "evidence.json"),
            "--socket", self.socket_directory.name,
            "--port", "55473",
            "--database", "stage_b_cash_payer_disposable",
            "--psql", sys.executable,
            "--acknowledge", RUNNER.DISPOSABLE_ACKNOWLEDGEMENT,
        ]

    def parse(self, arguments=None):
        with mock.patch.dict(os.environ, {"DATABASE_URL": ""}):
            return RUNNER.parse_args(arguments or self.arguments)

    def test_target_and_acknowledgement_are_mandatory(self):
        without_acknowledgement = self.arguments[:-2]
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.parse(without_acknowledgement)

        bad_acknowledgement = self.arguments[:-1] + ["NOT_DISPOSABLE"]
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.parse(bad_acknowledgement)

    def test_only_an_existing_absolute_socket_directory_is_accepted(self):
        unsafe_arguments = self.arguments.copy()
        unsafe_arguments[unsafe_arguments.index("--socket") + 1] = "localhost"
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.parse(unsafe_arguments)

    def test_explicit_target_drives_every_psql_command(self):
        _, target = self.parse()
        command = target.command("-At", "-c", "SELECT 1")
        self.assertIn("--host", command)
        self.assertIn(self.socket_directory.name, command)
        self.assertIn("--port", command)
        self.assertIn("55473", command)
        self.assertIn("--dbname", command)
        self.assertIn("stage_b_cash_payer_disposable", command)
        self.assertNotIn("current_replay", command)
        self.assertNotIn("/tmp/codex-chip-drift-cutover-e2iav203/socket", command)

    def test_preflight_fails_closed_on_any_target_mismatch(self):
        _, target = self.parse()
        safe = target.database + "|postgres|17|true|0|0"
        with mock.patch.object(RUNNER, "sql", return_value=safe):
            connection = RUNNER.assert_safe_target(target)
        self.assertEqual(connection["database"], target.database)
        for index in range(6):
            unsafe = safe.split("|")
            unsafe[index] = "unsafe"
            with self.subTest(field=index), mock.patch.object(
                RUNNER, "sql", return_value="|".join(unsafe)
            ), self.assertRaises(RuntimeError):
                RUNNER.assert_safe_target(target)

    def test_zero_data_proof_tolerates_missing_tournament_tables_relation(self):
        expression = RUNNER.zero_data_expression()
        self.assertIn("('public','tournament_tables')", expression)
        self.assertNotIn("FROM public.tournament_tables", expression)
        self.assertIn("JOIN pg_catalog.pg_class relation", expression)
        self.assertIn("pg_catalog.query_to_xml", expression)

    def test_composed_sql_rechecks_the_named_target(self):
        target = RUNNER.DatabaseTarget(
            sys.executable, self.socket_directory.name, 55473, "cash'payer_clone"
        )
        gate = RUNNER.disposable_sql_gate(target)
        self.assertIn("current_database()<>'cash''payer_clone'", gate)
        self.assertIn("server_version_num", gate)
        self.assertIn("inet_server_addr() IS NOT NULL", gate)
        self.assertIn("pid<>pg_backend_pid()", gate)
        self.assertIn(RUNNER.zero_data_expression(), gate)

        original = """BEGIN;
DO $disposable_only$
BEGIN
  IF current_database()<>'current_replay' THEN RAISE EXCEPTION 'unsafe'; END IF;
END;
$disposable_only$;
SELECT 1;
"""
        retargeted = RUNNER.retarget_disposable_sql_gate(original, target)
        self.assertNotIn("current_replay", retargeted)
        self.assertEqual(retargeted.count("$disposable_only$"), 2)
        self.assertIn("current_database()<>'cash''payer_clone'", retargeted)

    def test_current_canonical_sources_compose_without_a_database(self):
        root = RUNNER_PATH.parents[2]
        stage_b_path = RUNNER.exact_migration(root, RUNNER.STAGE_B_MIGRATION_NAME)
        stage_b = stage_b_path.read_text()
        wrapper, block, contraction_path = RUNNER.canonical_cash_sources(root, stage_b)
        self.assertEqual(
            hashlib.sha256(wrapper.encode()).hexdigest(),
            RUNNER.STRICT_PAYER_DEFINITION_SHA256,
        )
        self.assertEqual(
            hashlib.sha256(block.encode()).hexdigest(),
            RUNNER.CASH_CONTRACTION_BLOCK_SHA256,
        )
        self.assertIn("20260911050554_", contraction_path.name)

        leaf_hash = RUNNER.CASH_LEAF_POSTIMAGES[0][1]
        with self.assertRaises(ValueError):
            RUNNER.canonical_cash_sources(
                root, stage_b.replace(leaf_hash, "0" * 32, 1)
            )

        target = RUNNER.DatabaseTarget(
            sys.executable, self.socket_directory.name, 55473,
            "stage_b_cash_payer_disposable",
        )
        lane = RUNNER.exact_migration(root, RUNNER.LANE_MIGRATION_NAME)
        composed = RUNNER.compose(root, "paid", lane, target)
        self.assertEqual(composed.count(block), 1)
        self.assertIn(wrapper, composed)
        self.assertNotIn("68f74f87580ea2c2a1cacbe30f9b4289", composed)
        self.assertIn(RUNNER.PRIVATE_CORE_SOURCE_MD5, composed)
        self.assertIn(RUNNER.PRIVATE_CORE_DEFINITION_MD5, composed)
        self.assertIn(RUNNER.FINAL_DEAL_SOURCE_MD5, composed)
        self.assertIn(RUNNER.FINAL_DEAL_DEFINITION_MD5, composed)
        self.assertNotIn("d26fa5a8d5b09bbf8ad2fd28c2e5b1f1", composed)
        self.assertEqual(composed.count("-- M5_CURRENT_CASH_LEAF"), 2)
        self.assertNotIn(RUNNER.COMPOSER_FINAL_DEAL_SOURCE_MD5, composed)
        self.assertNotIn(
            "CREATE OR REPLACE FUNCTION public.fn_settle_tournament_final_table_deal(",
            composed,
        )
        self.assertIn("current final-deal authority was not preserved", composed)
        self.assertNotIn("synthetic-stage-b-cash-payer-fixture", composed)
        self.assertIn(RUNNER.NORMAL_CASH_SOURCE_MD5, composed)
        self.assertIn(RUNNER.NORMAL_CASH_DEFINITION_MD5, composed)
        self.assertNotIn("CREATE TABLE public.tournament_deal_proposals (", composed)
        self.assertIn("Exact-tail donor already contains", composed)
        self.assertIn("seat_game_scope,seat_admission_key", composed)
        self.assertIn("active_game_scope,active_parent_key", composed)
        self.assertIn(
            "'club_id','20000000-0000-0000-0000-000000000001'", composed
        )
        self.assertNotIn("unchanged raw payer unexpectedly succeeded", composed)
        self.assertIn("strict public payer refusals preserve exact money state", composed)
        self.assertIn("exact-tail auto-revoke prevents the unsafe", composed)
        self.assertIn("current_database()<>'stage_b_cash_payer_disposable'", composed)

    def test_ambient_connection_target_is_removed(self):
        ambient = {
            "PGHOST": "remote.example",
            "PGHOSTADDR": "203.0.113.2",
            "PGPORT": "5432",
            "PGDATABASE": "production",
            "PGUSER": "danger",
            "PGSERVICE": "production",
            "PGSERVICEFILE": "/tmp/production.conf",
            "PGPASSWORD": "kept-for-explicit-target",
        }
        with mock.patch.dict(os.environ, ambient, clear=True):
            sanitized = RUNNER.psql_environment()
        for name in ambient:
            if name != "PGPASSWORD":
                self.assertNotIn(name, sanitized)
        self.assertEqual(sanitized["PGPASSWORD"], "kept-for-explicit-target")


if __name__ == "__main__":
    unittest.main()
