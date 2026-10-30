#!/usr/bin/env python3
"""Unit tests for server/scripts/engine-release-lightning-hold.py.

The network layer is one function with the shape (url, payload) -> object;
these tests substitute a fake that records every call and answers from a
script, so the decision logic, the durable hold file and the three outcomes
are exercised without a database.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "server" / "scripts" / "engine-release-lightning-hold.py"

spec = importlib.util.spec_from_file_location("lightning_hold", SCRIPT)
hold = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(hold)

BASE = "https://kuklfnapbkmacvwxktbh.supabase.co"
C1 = "11111111-1111-4111-8111-111111111111"
C2 = "22222222-2222-4222-8222-222222222222"
C3 = "33333333-3333-4333-8333-333333333333"


class FakeDoor:
    """Answers the Cluster listing and the operator door from a script."""

    def __init__(self, clusters, answers=None, fail_on=None):
        self.clusters = clusters
        self.answers = answers or {}
        self.fail_on = fail_on or set()
        self.calls = []

    def __call__(self, url, payload):
        self.calls.append((url, payload))
        if payload is None:
            assert url.startswith(f"{BASE}/rest/v1/cash_games?"), url
            assert "cluster_mode=eq.lightning" in url
            return [{"id": c, "cluster_mode": "lightning"} for c in self.clusters]
        assert url == f"{BASE}/rest/v1/rpc/fn_lightning_operator_control", url
        key = (payload["p_action"], payload["p_cluster_id"])
        if key in self.fail_on:
            raise hold.Unknown("the database could not be reached: boom")
        return self.answers.get(key, {"ok": True, "idempotent": False, "action": payload["p_action"]})


class LightningHoldTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hold_file = Path(self.tmp.name) / "123-1.lightning-hold.json"

    def tearDown(self):
        self.tmp.cleanup()

    def read(self):
        return json.loads(self.hold_file.read_text())

    def test_pause_holds_every_lightning_cluster_and_records_them(self):
        door = FakeDoor([C1, C2])
        rc = hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertEqual(rc, hold.EXIT_DONE)
        record = self.read()
        self.assertEqual(record["schema"], hold.HOLD_SCHEMA)
        self.assertEqual(record["run_id"], "123-1")
        self.assertEqual(record["held"], [C1, C2])
        self.assertEqual(record["already"], [])
        self.assertEqual(record["refused"], {})
        # One listing, one pause per Cluster, each with a deterministic request id and the run key in its reason.
        pauses = [p for _, p in door.calls if p is not None]
        self.assertEqual([p["p_action"] for p in pauses], ["pause", "pause"])
        self.assertEqual(pauses[0]["p_args"]["request_id"], hold.request_id("123-1", "pause", C1))
        self.assertIn("engine release 123-1", pauses[0]["p_reason"])
        self.assertTrue(3 <= len(pauses[0]["p_reason"]) <= 2000)

    def test_request_ids_are_stable_per_run_action_and_cluster(self):
        self.assertEqual(hold.request_id("9-1", "pause", C1), hold.request_id("9-1", "pause", C1))
        self.assertNotEqual(hold.request_id("9-1", "pause", C1), hold.request_id("9-1", "resume", C1))
        self.assertNotEqual(hold.request_id("9-1", "pause", C1), hold.request_id("9-2", "pause", C1))

    def test_a_cluster_another_operator_paused_is_never_claimed(self):
        door = FakeDoor([C1, C2], answers={("pause", C2): {"ok": True, "idempotent": True, "already": True, "code": "ALREADY"}})
        rc = hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertEqual(rc, hold.EXIT_DONE)
        record = self.read()
        self.assertEqual(record["held"], [C1])
        self.assertEqual(record["already"], [C2])
        # Resume touches only the Cluster this run paused.
        door2 = FakeDoor([C1, C2])
        rc = hold.resume(BASE, door2, "123-1", self.hold_file)
        self.assertEqual(rc, hold.EXIT_DONE)
        resumes = [p for _, p in door2.calls if p is not None]
        self.assertEqual([(p["p_action"], p["p_cluster_id"]) for p in resumes], [("resume", C1)])

    def test_a_busy_cluster_is_partial_with_its_code_named(self):
        door = FakeDoor([C1, C2], answers={("pause", C1): {"ok": False, "code": "CLUSTER_BUSY", "reason": "CLUSTER_BUSY"}})
        rc = hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertEqual(rc, hold.EXIT_PARTIAL)
        record = self.read()
        self.assertEqual(record["held"], [C2])
        self.assertEqual(record["refused"], {C1: "CLUSTER_BUSY"})
        # A second pause inside the same break re-sends nothing.
        door2 = FakeDoor([C1, C2])
        self.assertEqual(hold.pause(BASE, door2, "123-1", self.hold_file), hold.EXIT_PARTIAL)
        self.assertEqual([p for _, p in door2.calls if p is not None], [])

    def test_an_unknown_answer_keeps_what_was_paused_and_a_retry_continues(self):
        door = FakeDoor([C1, C2, C3], fail_on={("pause", C2)})
        with self.assertRaises(hold.Unknown):
            hold.pause(BASE, door, "123-1", self.hold_file)
        record = self.read()
        self.assertEqual(record["held"], [C1])
        self.assertEqual(record["unknown"], [C2])
        # The retry asks only the unanswered Clusters, with the same request ids.
        door2 = FakeDoor([C1, C2, C3])
        self.assertEqual(hold.pause(BASE, door2, "123-1", self.hold_file), hold.EXIT_DONE)
        pauses = [p for _, p in door2.calls if p is not None]
        self.assertEqual([p["p_cluster_id"] for p in pauses], [C2, C3])
        self.assertEqual(pauses[0]["p_args"]["request_id"], hold.request_id("123-1", "pause", C2))
        self.assertEqual(self.read()["held"], [C1, C2, C3])
        self.assertEqual(self.read()["unknown"], [])

    def test_main_maps_unknown_to_exit_three(self):
        # No env file at all: UNKNOWN, never DONE and never PARTIAL.
        rc = hold.main(["pause", "--env-file", str(Path(self.tmp.name) / "absent.env"), "--run-id", "1-1", "--hold-file", str(self.hold_file)])
        self.assertEqual(rc, hold.EXIT_UNKNOWN)
        self.assertFalse(self.hold_file.exists())

    def test_env_file_must_point_at_the_pinned_project(self):
        env = Path(self.tmp.name) / "engine.env"
        env.write_text('SUPABASE_URL="https://evil.example.com"\nSUPABASE_SERVICE_ROLE_KEY=k\n')
        with self.assertRaises(hold.Unknown):
            hold.database_identity(env)
        env.write_text(f"export SUPABASE_URL={BASE}\nSUPABASE_SERVICE_ROLE_KEY='k'\nOTHER=x\n")
        self.assertEqual(hold.database_identity(env), (BASE, "k"))

    def test_no_lightning_cluster_means_nothing_to_hold_and_nothing_to_resume(self):
        door = FakeDoor([])
        self.assertEqual(hold.pause(BASE, door, "123-1", self.hold_file), hold.EXIT_DONE)
        self.assertFalse(self.hold_file.exists())
        self.assertEqual(hold.resume(BASE, door, "123-1", self.hold_file), hold.EXIT_DONE)
        self.assertEqual(len(door.calls), 1)

    def test_resume_releases_exactly_the_held_clusters_and_retires_the_hold(self):
        hold.pause(BASE, FakeDoor([C1, C2]), "123-1", self.hold_file)
        door = FakeDoor([C1, C2], answers={("resume", C2): {"ok": True, "already": True, "code": "ALREADY"}})
        rc = hold.resume(BASE, door, "123-1", self.hold_file)
        self.assertEqual(rc, hold.EXIT_DONE)
        self.assertFalse(self.hold_file.exists())
        released = json.loads(self.hold_file.with_name(self.hold_file.name + ".released").read_text())
        self.assertEqual(released["released"], [C1, C2])
        resumes = [p for _, p in door.calls if p is not None]
        self.assertEqual([p["p_cluster_id"] for p in resumes], [C1, C2])
        self.assertEqual(resumes[1]["p_args"]["request_id"], hold.request_id("123-1", "resume", C2))

    def test_a_refused_resume_keeps_the_hold_for_the_next_reader(self):
        hold.pause(BASE, FakeDoor([C1, C2]), "123-1", self.hold_file)
        door = FakeDoor([C1, C2], answers={("resume", C1): {"ok": False, "code": "CLUSTER_FROZEN", "reason": "CLUSTER_FROZEN"}})
        self.assertEqual(hold.resume(BASE, door, "123-1", self.hold_file), hold.EXIT_PARTIAL)
        self.assertTrue(self.hold_file.exists())
        record = self.read()
        self.assertEqual(record["resume_refused"], {C1: "CLUSTER_FROZEN"})
        self.assertEqual(record["released"], [C2])
        # The next reader re-asks only the still-held list (idempotent for C2).
        door2 = FakeDoor([C1, C2])
        self.assertEqual(hold.resume(BASE, door2, "123-1", self.hold_file), hold.EXIT_DONE)
        self.assertFalse(self.hold_file.exists())

    def test_a_hold_file_from_another_run_is_never_resumed(self):
        hold.pause(BASE, FakeDoor([C1]), "123-1", self.hold_file)
        with self.assertRaises(hold.Unknown):
            hold.resume(BASE, FakeDoor([C1]), "999-1", self.hold_file)
        self.assertTrue(self.hold_file.exists())

    def test_a_full_cluster_page_is_unknown_not_a_census(self):
        door = FakeDoor([f"{i:08d}-0000-4000-8000-000000000000" for i in range(hold.CLUSTER_LIMIT + 1)])
        with self.assertRaises(hold.Unknown):
            hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertFalse(self.hold_file.exists())

    def test_the_helper_never_reads_a_horse_flag(self):
        source = SCRIPT.read_text()
        self.assertNotIn("is_horse", source)
        self.assertNotIn("horse_id", source)


if __name__ == "__main__":
    unittest.main()
