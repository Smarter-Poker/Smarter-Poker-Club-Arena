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
import subprocess
import tempfile
import unittest
from unittest.mock import patch

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


def missing(payload):
    return {"ok": False, "resolved": False, "code": "REQUEST_OUTCOME_UNKNOWN",
            "action": payload["p_args"]["expected_action"],
            "cluster_id": payload["p_cluster_id"], "request_id": payload["p_args"]["request_id"]}


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
        identity = {"action": payload["p_action"], "cluster_id": payload["p_cluster_id"],
                    "request_id": payload["p_args"]["request_id"]}
        if payload["p_action"] == "resolve_release_hold":
            return missing(payload)
        if payload["p_action"] == "resume":
            assert payload["p_args"]["expected_pause_request_id"] == hold.request_id(
                "123-1", "pause", payload["p_cluster_id"])
        return {**identity, **self.answers.get(key, {"ok": True, "idempotent": False})}



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
        pauses = [p for _, p in door.calls if p is not None and p["p_action"] != "resolve_release_hold"]
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
        resumes = [p for _, p in door2.calls if p is not None and p["p_action"] != "resolve_release_hold"]
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
        self.assertEqual([p for _, p in door2.calls if p is not None and p["p_action"] != "resolve_release_hold"], [])

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
        pauses = [p for _, p in door2.calls if p is not None and p["p_action"] != "resolve_release_hold"]
        self.assertEqual([p["p_cluster_id"] for p in pauses], [C2, C3])
        self.assertEqual(pauses[0]["p_args"]["request_id"], hold.request_id("123-1", "pause", C2))
        self.assertEqual(self.read()["held"], [C1, C2, C3])
        self.assertEqual(self.read()["unknown"], [])

    def test_committed_pause_lost_response_cannot_disappear_from_next_census(self):
        requests = {}
        active = [C1]
        def door(url, payload):
            if payload is None:
                return [{"id": c, "cluster_mode": "lightning"} for c in active]
            key = payload["p_args"]["request_id"]
            if payload["p_action"] == "resolve_release_hold":
                if key not in requests:
                    return missing(payload)
                answer = requests[key]
                return {"ok": True, "resolved": True, "action": answer["action"],
                        "cluster_id": C1, "request_id": key, "answer": answer}
            if key in requests:
                return {**requests[key], "replayed": True}
            answer = {"ok": True, "action": "pause", "cluster_id": C1, "request_id": key}
            requests[key] = answer
            active.remove(C1)
            raise hold.Unknown("response lost after commit")
        with self.assertRaises(hold.Unknown):
            hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertEqual(hold.pause(BASE, door, "123-1", self.hold_file), hold.EXIT_DONE)
        self.assertEqual(self.read()["held"], [C1])

    def test_unknown_pause_is_never_retired_by_cleanup(self):
        with self.assertRaises(hold.Unknown):
            hold.pause(BASE, FakeDoor([C1], fail_on={("pause", C1)}), "123-1", self.hold_file)
        door = FakeDoor([])
        with self.assertRaises(hold.Unknown):
            hold.resume(BASE, door, "123-1", self.hold_file)
        self.assertTrue(self.hold_file.exists())
        self.assertFalse(self.hold_file.with_name(self.hold_file.name + ".released").exists())
        self.assertEqual([p["p_action"] for _, p in door.calls], ["resolve_release_hold"])

    def test_each_request_is_durable_before_send_and_each_answer_before_next(self):
        def door(url, payload):
            if payload is None:
                return [{"id": c, "cluster_mode": "lightning"} for c in [C1, C2]]
            if payload["p_action"] == "resolve_release_hold":
                return missing(payload)
            record = self.read()
            cluster = payload["p_cluster_id"]
            self.assertIn(cluster, record["unknown"])
            self.assertEqual(record["candidates"], [C1, C2])
            if cluster == C2:
                self.assertEqual(record["held"], [C1])
            return {"ok": True, "action": "pause", "cluster_id": cluster,
                    "request_id": payload["p_args"]["request_id"]}
        self.assertEqual(hold.pause(BASE, door, "123-1", self.hold_file), hold.EXIT_DONE)

    def test_cleanup_resolves_committed_pause_without_creating_a_new_pause(self):
        answer = None
        def door(url, payload):
            nonlocal answer
            if payload is None:
                return [{"id": C1, "cluster_mode": "lightning"}]
            action = payload["p_action"]
            if action == "pause":
                self.assertIsNone(answer)
                answer = {"ok": True, "action": "pause", "cluster_id": C1,
                          "request_id": payload["p_args"]["request_id"]}
                raise hold.Unknown("committed response lost")
            if action == "resolve_release_hold":
                if answer is None or payload["p_args"]["expected_action"] == "resume":
                    return missing(payload)
                return {"ok": True, "resolved": True, **{k: answer[k] for k in
                        ("action", "cluster_id", "request_id")}, "answer": answer}
            self.assertEqual(action, "resume")
            self.assertEqual(payload["p_args"]["expected_pause_request_id"], answer["request_id"])
            record = self.read()
            self.assertEqual(record["held"], [C1])
            self.assertEqual(record["resume_pending"], [C1])
            return {"ok": True, "action": "resume", "cluster_id": C1,
                    "request_id": payload["p_args"]["request_id"]}
        with self.assertRaises(hold.Unknown):
            hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertEqual(hold.resume(BASE, door, "123-1", self.hold_file), hold.EXIT_DONE)
        self.assertFalse(self.hold_file.exists())

    def test_lost_resume_answer_is_resolved_by_exact_original_id(self):
        hold.pause(BASE, FakeDoor([C1, C2]), "123-1", self.hold_file)
        saved = {}
        def door(url, payload):
            action, cluster = payload["p_action"], payload["p_cluster_id"]
            if action == "resolve_release_hold":
                if cluster not in saved:
                    return missing(payload)
                answer = saved[cluster]
                self.assertEqual(payload["p_args"]["request_id"], answer["request_id"])
                return {"ok": True, "resolved": True, "action": "resume", "cluster_id": cluster,
                        "request_id": answer["request_id"], "answer": answer}
            self.assertEqual(action, "resume")
            self.assertNotIn(cluster, saved)
            saved[cluster] = {"ok": True, "action": "resume", "cluster_id": cluster,
                              "request_id": payload["p_args"]["request_id"]}
            if cluster == C1:
                raise hold.Unknown("resume response lost")
            self.assertEqual(self.read()["resume_pending"], [C1, C2])
            return saved[cluster]
        with self.assertRaises(hold.Unknown):
            hold.resume(BASE, door, "123-1", self.hold_file)
        self.assertEqual(self.read()["released"], [C2])
        self.assertEqual(hold.resume(BASE, door, "123-1", self.hold_file), hold.EXIT_DONE)

    def test_crash_after_pause_commit_retains_pending_before_any_answer_write(self):
        class Crash(BaseException):
            pass
        def door(url, payload):
            if payload is None:
                return [{"id": C1, "cluster_mode": "lightning"}]
            if payload["p_action"] == "resolve_release_hold":
                return missing(payload)
            self.assertEqual(self.read()["unknown"], [C1])
            raise Crash()
        with self.assertRaises(Crash):
            hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertEqual(self.read()["unknown"], [C1])
        self.assertEqual(self.read()["held"], [])

    def test_cleanup_phase_refuses_pause_continuation(self):
        with self.assertRaises(hold.Unknown):
            hold.pause(BASE, FakeDoor([C1], fail_on={("pause", C1)}), "123-1", self.hold_file)
        with self.assertRaises(hold.Unknown):
            hold.resume(BASE, FakeDoor([]), "123-1", self.hold_file)
        door = FakeDoor([C1])
        with self.assertRaises(hold.Unknown):
            hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertEqual(door.calls, [])

    def test_journal_write_failure_prevents_the_operator_call(self):
        door = FakeDoor([C1])
        with patch.object(hold, "write_durable", side_effect=hold.Unknown("fsync failed")):
            with self.assertRaises(hold.Unknown):
                hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertTrue(all(p is None for _, p in door.calls))

    def test_journal_rejects_malformed_foreign_and_unsafe_files(self):
        hold.pause(BASE, FakeDoor([C1]), "123-1", self.hold_file)
        original = self.read()
        for key, value in [("candidates", [C1, C1]), ("held", [C2]),
                           ("unknown", [C1]), ("resume_pending", "bad"),
                           ("schema", "engine-release-lightning-hold/v1"),
                           ("phase", "released"), ("refused", {C2: "BAD"})]:
            with self.subTest(key=key):
                record = {**original, key: value}
                self.hold_file.write_text(json.dumps(record))
                door = FakeDoor([])
                with self.assertRaises(hold.Unknown):
                    hold.resume(BASE, door, "123-1", self.hold_file)
                self.assertEqual(door.calls, [])
        self.hold_file.unlink()
        target = Path(self.tmp.name) / "target"
        target.write_text(json.dumps(original))
        self.hold_file.symlink_to(target)
        with self.assertRaises(hold.Unknown):
            hold.resume(BASE, FakeDoor([]), "123-1", self.hold_file)

    def test_mismatched_or_unbound_rpc_answers_keep_request_unknown(self):
        for answer in [{"ok": True}, {"ok": True, "action": "resume"},
                       {"ok": True, "request_id": C3}, {"ok": True, "already": "yes"},
                       {"ok": False, "code": "raw private exception"}]:
            with self.subTest(answer=answer):
                if self.hold_file.exists():
                    self.hold_file.unlink()
                door = FakeDoor([C1], answers={("pause", C1): answer})
                if answer == {"ok": True}:
                    def malformed(url, payload):
                        return ([{"id": C1, "cluster_mode": "lightning"}] if payload is None else
                                missing(payload) if payload["p_action"] == "resolve_release_hold" else answer)
                    door = malformed
                with self.assertRaises(hold.Unknown):
                    hold.pause(BASE, door, "123-1", self.hold_file)
                self.assertEqual(self.read()["unknown"], [C1])

    def test_old_api_refuses_before_any_pause_or_resume_mutation(self):
        door = FakeDoor([C1])
        def old(url, payload):
            if payload is None:
                return door(url, payload)
            self.assertEqual(payload["p_action"], "resolve_release_hold")
            return {"ok": False, "code": "INVALID_ACTION"}
        with self.assertRaises(hold.Unknown):
            hold.pause(BASE, old, "123-1", self.hold_file)
        self.assertEqual(self.read()["unknown"], [C1])

    def test_resume_cas_refusal_does_not_release_a_foreign_replacement_hold(self):
        hold.pause(BASE, FakeDoor([C1]), "123-1", self.hold_file)
        door = FakeDoor([], answers={("resume", C1): {"ok": False, "code": "HOLD_OWNERSHIP_CHANGED"}})
        self.assertEqual(hold.resume(BASE, door, "123-1", self.hold_file), hold.EXIT_PARTIAL)
        self.assertEqual(self.read()["resume_refused"], {C1: "HOLD_OWNERSHIP_CHANGED"})
        self.assertFalse(self.hold_file.with_name(self.hold_file.name + ".released").exists())

    def test_real_child_exit_after_commit_keeps_durable_original_identity(self):
        effect = Path(self.tmp.name) / "committed.json"
        source = r'''
import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('hold',sys.argv[1]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
cluster=sys.argv[4]
def door(url,p):
 if p is None:return [{'id':cluster,'cluster_mode':'lightning'}]
 if p['p_action']=='resolve_release_hold':return {'ok':False,'resolved':False,'code':'REQUEST_OUTCOME_UNKNOWN','action':'pause','cluster_id':cluster,'request_id':p['p_args']['request_id']}
 Path(sys.argv[3]).write_text(json.dumps(p))
 os._exit(91)
h.pause('https://kuklfnapbkmacvwxktbh.supabase.co',door,'123-1',Path(sys.argv[2]))
'''
        result = subprocess.run([sys.executable, "-B", "-c", source, str(SCRIPT),
                                 str(self.hold_file), str(effect), C1], timeout=5)
        self.assertEqual(result.returncode, 91)
        self.assertEqual(self.read()["unknown"], [C1])
        request = json.loads(effect.read_text())
        self.assertEqual(request["p_args"]["request_id"], hold.request_id("123-1", "pause", C1))

    def test_in_progress_pause_stays_pending_until_original_commit_resolves(self):
        answer = None
        def door(url, payload):
            nonlocal answer
            if payload is None:
                return [{"id": C1, "cluster_mode": "lightning"}]
            action = payload["p_action"]
            expected = payload["p_args"].get("expected_action")
            if action == "resolve_release_hold":
                if answer is None or expected == "resume":
                    return missing(payload)
                return {"ok": True, "resolved": True, "action": "pause", "cluster_id": C1,
                        "request_id": answer["request_id"], "answer": answer}
            if action == "pause":
                answer = {"ok": True, "action": "pause", "cluster_id": C1,
                          "request_id": payload["p_args"]["request_id"]}
                return {**answer, "ok": False, "code": "REQUEST_IN_PROGRESS"}
            return {"ok": True, "action": "resume", "cluster_id": C1,
                    "request_id": payload["p_args"]["request_id"]}
        with self.assertRaises(hold.Unknown):
            hold.pause(BASE, door, "123-1", self.hold_file)
        self.assertEqual(self.read()["unknown"], [C1])
        self.assertEqual(self.read()["refused"], {})
        self.assertEqual(hold.resume(BASE, door, "123-1", self.hold_file), hold.EXIT_DONE)

    def test_missing_resume_continues_only_same_original_id_with_pause_cas(self):
        hold.pause(BASE, FakeDoor([C1]), "123-1", self.hold_file)
        record = self.read()
        record["phase"] = "resuming"
        record["resume_pending"] = [C1]
        hold.write_durable(self.hold_file, record)
        door = FakeDoor([])
        self.assertEqual(hold.resume(BASE, door, "123-1", self.hold_file), hold.EXIT_DONE)
        actions = [p for _, p in door.calls]
        self.assertEqual([p["p_action"] for p in actions], ["resolve_release_hold", "resume"])
        self.assertEqual(actions[0]["p_args"]["request_id"], actions[1]["p_args"]["request_id"])
        self.assertEqual(actions[0]["p_args"]["expected_pause_request_id"],
                         actions[1]["p_args"]["expected_pause_request_id"])

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
        resumes = [p for _, p in door.calls if p is not None and p["p_action"] != "resolve_release_hold"]
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
        # The same original request replays its refusal; a fresh fake success
        # must not overwrite the already-recorded durable negative outcome.
        door2 = FakeDoor([C1, C2])
        self.assertEqual(hold.resume(BASE, door2, "123-1", self.hold_file), hold.EXIT_PARTIAL)
        self.assertTrue(self.hold_file.exists())
        self.assertEqual(door2.calls, [])

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
