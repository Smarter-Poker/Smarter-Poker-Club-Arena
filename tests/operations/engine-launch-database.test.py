"""Actual child-process transport tests; no PostgreSQL/native API claim."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "server/scripts/engine_launch_database.py"
spec = importlib.util.spec_from_file_location("engine_launch_database", SOURCE)
db = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = db
spec.loader.exec_module(db)
ID = "00000000-0000-4000-8000-000000000001"
ID2 = "00000000-0000-4000-8000-000000000002"
IDENTITY = {
    "kernel_boot_id": ID, "pid": 42, "process_start_ticks": "4808",
    "uid": 0, "gid": 0, "cgroup_inode": 99, "cgroup_path": "/docker/example",
    "pid_namespace_inode": 100, "executable_inode": 101, "executable_device": 1,
    "container_id": "a" * 64, "image_id": "sha256:" + "b" * 64, "release_sha": "c" * 40,
}
REGISTRATION = {
    "version": 1, "kind": "original_launch_registration", "registration_ref": ID2,
    "pending_ref": ID, "identity_hash": "d" * 64, **db._FALSE,
}
ORIGINAL = {**{k: ID for k in (
    "admission_id", "tournament_id", "table_id", "lease_generation", "custody_id", "permit_id"
)}, "lifecycle": "1", "admission_revision": "2", "hand_number": "3"}
ATTEMPT = {"version": 1, "attempt_id": ID2, "original": ORIGINAL,
           "registration_ref": ID, "game_format_id": "nlhe-cash"}
ACK = {**ATTEMPT, "kind": "original_attempt_ack", "marker_id": ID,
       "marker_hash": "e" * 64, "producer_receipt_ref": ID2}
TERMINATION = {"identity": IDENTITY, "mechanism": "pidfd-exit-and-cgroup-empty",
               "remaining_descendants": 0, "observed_at": "2026-09-14T10:00:00Z"}
TERMINATED = {"version": 1, "kind": "local_termination_record",
              "registration_ref": ID, "termination_receipt_ref": ID2, **db._FALSE}


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ca-broker-database-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.program = self.root / "psql"
        self.log = self.root / "input.sql"
        self.processes = []
        real_popen = subprocess.Popen

        def launch(*args, **kwargs):
            self.assertNotIn("PGPASSWORD", kwargs["env"])
            self.assertNotIn("PGSERVICE", kwargs["env"])
            self.assertNotIn(ID, " ".join(args[0]))
            self.assertIn("--set=ON_ERROR_STOP=1", args[0])
            self.assertIn("-X", args[0])
            p = real_popen(*args, **kwargs)
            self.processes.append(p)
            return p

        @contextlib.contextmanager
        def environment():
            yield {"PATH": "/usr/bin:/bin", "TEST_LOG": str(self.log)}, ()

        self.enterContext(patch.object(db, "_PSQL", str(self.program)))
        self.enterContext(patch.object(db, "_environment", environment))
        self.enterContext(patch.object(db.subprocess, "Popen", launch))
        self.adapter = db.BrokerDatabase()

    def client(self, value=REGISTRATION, mode="ok"):
        raw = value if isinstance(value, str) else json.dumps(value)
        source = """import os,re,sys,time
from pathlib import Path
sql=sys.stdin.read()
Path(os.environ['TEST_LOG']).write_text(sql)
marker=re.search(r'\\\\echo (F06_COMMIT_[0-9a-f]+)',sql).group(1)
raw=RAW
mode=MODE
if mode=='flood':
 sys.stdout.write('x'*100000);sys.stdout.flush();time.sleep(4)
if mode=='stderr_flood':
 sys.stderr.write('s'*100000);sys.stderr.flush();time.sleep(4)
print('1' if mode!='wrong_principal' else '0',flush=True)
print(raw,flush=True)
if mode=='delay':time.sleep(4)
if mode!='missing_marker':print(marker,flush=True)
if mode=='bad_exit':sys.exit(3)
"""
        self.program.write_text("#!" + sys.executable + "\n" +
                                source.replace("RAW", repr(raw)).replace("MODE", repr(mode)))
        self.program.chmod(0o700)

    def call(self, operation="register", *args):
        result = self.adapter.observe(operation, *(args or (ID, IDENTITY)))
        self.assertIs(result.startAuthority, False)
        self.assertIs(result.noStartAuthority, False)
        self.assertIs(result.financialMutationAuthority, False)
        return result

    def assert_reaped(self):
        self.assertTrue(self.processes)
        self.assertTrue(all(p.returncode is not None for p in self.processes))
        self.assertIsNone(self.adapter._retained)

    def test_commit_requires_complete_protocol_and_process_success(self):
        self.client()
        observed = self.call()
        self.assertEqual(observed.state, "commit_ack")
        self.assertEqual(json.loads(observed.evidence_json), REGISTRATION)
        sql = self.log.read_text()
        self.assertLess(sql.index("COMMIT;"), sql.index("\\echo "))
        self.assertIn("session_user='f06_original_launch_broker'", sql)
        self.assertIn("current_user='f06_original_launch_broker'", sql)
        self.assertIn("READ COMMITTED", sql)
        self.assertIn("statement_timeout='1500ms'", sql)
        self.assertIn("lock_timeout='250ms'", sql)
        self.assert_reaped()

    def test_returned_row_without_commit_confirmation_stays_unknown(self):
        self.client(mode="missing_marker")
        self.assertEqual(self.call().state, "unknown")
        self.assertEqual(len(self.processes), 1)  # No retry or automatic second transaction.
        self.assert_reaped()

    def test_lost_connection_after_printed_confirmation_stays_unknown(self):
        self.client(mode="bad_exit")
        self.assertEqual(self.call().state, "unknown")
        self.assert_reaped()

    def test_actual_deadline_kills_and_reaps_only_owned_client(self):
        self.client(mode="delay")
        start = time.monotonic()
        self.assertEqual(self.call().state, "unknown")
        self.assertLess(time.monotonic() - start, 3.8)
        self.assert_reaped()

    def test_output_and_error_streams_have_real_byte_caps(self):
        for mode in ("flood", "stderr_flood"):
            with self.subTest(mode=mode):
                self.client(mode=mode)
                self.assertEqual(self.call().state, "unknown")
                self.assert_reaped()

    def test_wrong_principal_marker_cannot_qualify_result(self):
        self.client(mode="wrong_principal")
        self.assertEqual(self.call().state, "unknown")

    def test_explicit_registration_readback_is_a_readonly_transaction(self):
        self.client()
        result = self.call("read_registration", ID, IDENTITY)
        self.assertEqual(result.state, "immutable_readback")
        self.assertTrue(result.historical)
        self.assertIn("READ ONLY;", self.log.read_text())
        self.assertIn("f06_read_original_launch(", self.log.read_text())
        self.assertNotIn("f06_register_original_launch(", self.log.read_text())

    def test_absence_while_original_commit_is_pending_remains_unknown(self):
        self.client({"kind": "unknown", "reason": "registration_commit_unresolved_or_missing",
                     **db._FALSE})
        self.assertEqual(self.call("read_registration", ID, IDENTITY).state, "unknown")

    def test_binding_and_both_termination_signatures(self):
        self.client({"kind": "original_launch_binding", "admission_id": ID,
                     "registration_ref": ID2, **db._FALSE})
        self.assertEqual(self.call("bind", ID, ID2, "nlhe-cash").state, "commit_ack")
        for operation in ("terminate", "read_termination"):
            self.client(TERMINATED)
            result = self.call(operation, ID, ID2, "immutable-observation-1", TERMINATION)
            self.assertNotEqual(result.state, "unknown")

    def test_first_marker_commit_and_historical_replay_remain_distinct(self):
        self.client(ACK)
        fresh = self.call("append", ATTEMPT)
        self.assertEqual(fresh.state, "commit_ack")
        self.assertFalse(fresh.historical)
        self.client({**ACK, "startAuthority": False})
        historical = self.call("append", ATTEMPT)
        self.assertTrue(historical.historical)
        self.assertEqual(self.call("read_attempt", ATTEMPT).state, "immutable_readback")
        self.client(ACK)
        self.assertEqual(self.call("read_attempt", ATTEMPT).state, "unknown")

    def test_wrong_identity_extra_authority_and_duplicate_fields_refuse(self):
        for value in (
            {**REGISTRATION, "pending_ref": ID2},
            {**REGISTRATION, "startAuthority": True},
            {**REGISTRATION, "unreviewed": True},
            json.dumps(REGISTRATION)[:-1] + ',"pending_ref":"' + ID + '"}',
        ):
            with self.subTest(value=type(value).__name__):
                self.client(value)
                self.assertEqual(self.call().state, "unknown")

    def test_request_validation_precedes_process_creation(self):
        self.client()
        for identity in ({**IDENTITY, "uid": True}, {**IDENTITY, "pid": -1},
                         {**IDENTITY, "caller_trusted": True}, {**IDENTITY, "cgroup_path": "/../x"}):
            self.assertEqual(self.call("register", ID, identity).state, "unknown")
        self.assertEqual(self.call("run_arbitrary_sql", ID, IDENTITY).state, "unknown")
        self.assertEqual(self.processes, [])

    def test_echoed_attempt_preserves_json_types_and_exact_original(self):
        for value in (
            {**ACK, "version": True},
            {**ACK, "original": {**ORIGINAL, "hand_number": "4"}},
            {**ACK, "registration_ref": ID2},
            {**ACK, "marker_hash": None},
        ):
            self.client(value)
            self.assertEqual(self.call("append", ATTEMPT).state, "unknown")

    def test_text_cannot_inject_sql_or_psql_commands(self):
        self.client()
        identity = {**IDENTITY, "cgroup_path": "/group/'quoted;--"}
        self.assertEqual(self.call("register", ID, identity).state, "commit_ack")
        self.assertNotIn(identity["cgroup_path"], self.log.read_text())
        self.assertEqual(self.log.read_text().count("SELECT smarter_private."), 1)

    def test_occupied_transport_cannot_start_another_client(self):
        self.client()
        self.adapter._lock.acquire()
        try:
            self.assertEqual(self.call().state, "unknown")
            self.assertEqual(self.processes, [])
        finally:
            self.adapter._lock.release()

    def test_unreaped_client_is_retained_and_blocks_overlap(self):
        self.client()
        class Pending:
            def poll(self):
                return None
        pending = Pending()
        self.adapter._retained = pending
        self.assertEqual(self.call().state, "unknown")
        self.assertIs(self.adapter._retained, pending)
        self.assertEqual(self.processes, [])


class CredentialBoundaryTests(unittest.TestCase):
    def test_nonroot_host_cannot_load_credentials(self):
        with patch.object(db.sys, "platform", "linux"), patch.object(db.os, "geteuid", return_value=1):
            with self.assertRaises(db.Refusal):
                with db._environment():
                    self.fail("credentials must remain unavailable")

    def test_nonlinux_host_cannot_load_credentials(self):
        with patch.object(db.sys, "platform", "darwin"), patch.object(db.os, "geteuid", return_value=0):
            with self.assertRaises(db.Refusal):
                with db._environment():
                    self.fail("credentials must remain unavailable")

    def test_symlink_credential_is_never_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / "secret").write_text("fixture only")
            (p / "link").symlink_to(p / "secret")
            with self.assertRaises(OSError):
                db._open_private(p / "link", 100)

    def test_invalid_credential_size_and_mode_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "credential"
            for content, mode in (("", 0o600), ("x" * 101, 0o600), ("x", 0o644)):
                p.write_text(content)
                p.chmod(mode)
                with self.assertRaises(db.Refusal):
                    db._open_private(p, 100)


if __name__ == "__main__":
    unittest.main()
