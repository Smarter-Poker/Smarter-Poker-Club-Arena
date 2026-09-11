#!/usr/bin/env python3
"""Native filesystem/flock/seal/parser regressions; all external services are fixtures."""
import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


recovery = load("recovery", ROOT / "server/scripts/reconcile-legacy-sealed-release-v1.py")
installer = load("installer", ROOT / "server/scripts/install-legacy-sealed-reconciliation-v1.py")
recovery.OWNER_UID = os.getuid()  # No executable/runtime switch exposes this fixture seam.
SHA = "14794f7dc20daf06529f517cd6d4e3c4cf33ebdd"
CONTROL = "bc525463996c65be3a89a7fe0cb35cd601a0d5e3"
IMAGE = "sha256:" + "b" * 64


class FixtureHost(recovery.Host):
    def __init__(self, root):
        self.base = root / "state"
        self.generations = root / "generations"
        self.lock = root / "mutation.lock"
        self.wants = root / "wants"
        self.wants.mkdir()
        self.base.mkdir(mode=0o700)
        self.enabled = True
        self.calls = []
        self.fail_before_record = False
        self.lose_record_response = False
        self.fail_database = False
        self.active = False
        self.unload_on_disable = False
        self.unit_invocation = "3a902ad6ad6743f98bad98ff90f55b20"
        self.http = "200"
        self.wrong_image = False
        self.oci_revision = SHA
        self.image_env = [f"GIT_COMMIT_SHA={SHA}"]
        self.health_value = {"running": True, "version": SHA[:8], "liveness": "ok", "instanceId": "1-3fc6cd2e"}
        self.runtime = {"id": "c" * 64, "image": IMAGE, "status": "running", "started_at": "2026-09-11T13:56:17Z",
                        "restart": "always", "release": SHA, "role": "engine", "autoheal": "true"}
        self.manifest = {"schema": 1, "run_id": "34623692969-1", "target_sha": CONTROL, "control_sha": CONTROL,
                         "invocation_id": "3a902ad6ad6743f98bad98ff90f55b20", "desired_sha": SHA, "desired_image_id": IMAGE,
                         "desired_legacy_unlabelled": False,
                         "desired_generation": 1,
                         "expires_at": int(time.time()) + 600, "reason": "accepted_v1_legacy_health_identity_failure"}
        generation = self.generations / CONTROL
        generation.mkdir(parents=True)
        self.write(generation / "control-sha", CONTROL + "\n", 0o644)
        for filename, key in (("engine-release-seal.py", "seal_helper_sha256"),
                              ("engine-release-database-proof.py", "database_proof_sha256"),
                              ("engine-release-transaction.sh", "transaction_sha256")):
            data = (ROOT / "server/scripts" / filename).read_bytes()
            if filename == "engine-release-transaction.sh":
                # The accepted generation remains frozen when current-main
                # source receives its separate ordinary compatibility fix.
                fixture = json.loads((ROOT / "tests/fixtures/legacy-sealed-source/bc525-health-parser.json").read_text())
                assert fixture["source_commit"] == CONTROL
                assert recovery.digest(fixture["function"].encode()) == fixture["function_sha256"]
                data = (fixture["function"] + "health_instance_for_sha() { :; }\n").encode()
            self.write(generation / filename, data, 0o755)
            self.manifest[key] = recovery.digest(data)
        self.manifest["entrypoint_sha256"] = recovery.digest((ROOT / "server/scripts/reconcile-legacy-sealed-release-v1.py").read_bytes())
        request = f"{CONTROL}\nhttps://github.com/smarter-poker/club-arena/actions/runs/34623692969\ngithub-actions[bot]\n{generation}\n{CONTROL}\n1789157257\n"
        values = {"request": request, "intent": request, "pin": f"{generation}\n{CONTROL}\n", "lease": CONTROL + "\n", "deadline": "1789157000\n"}
        for key, path in recovery.record_paths(self).items():
            self.write(path, values[key])
            if key in ("request", "intent", "pin"):
                self.manifest[f"{key}_sha256"] = recovery.digest(values[key].encode())
        self.state_value = {"schema": 1, "generation": 1, "highWaterSha": SHA,
                            "desired": {"sha": SHA, "imageId": IMAGE, "legacyUnlabelled": False},
                            "pending": None, "committedRuns": {}, "finalization": None}
        self.save_state()
        self.manifest["initial_seal_sha256"] = recovery.digest((self.base / "engine-release-seal.json").read_bytes())
        self.native_seal = load("fixture_seal", ROOT / "server/scripts/engine-release-seal.py")
        for name, path in {"STATE_DIR": self.base, "STATE_FILE": self.base / "engine-release-seal.json",
                           "AUDIT_FILE": self.base / "engine-release-audit.jsonl",
                           "RESULT_DIR": self.base / "engine-release-results", "LOCK_FILE": root / "seal.lock"}.items():
            setattr(self.native_seal, name, path)
        self.native_seal.run = lambda arguments: self.call(arguments)

    @staticmethod
    def write(path, data, mode=0o600):
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        path.write_bytes(data.encode() if isinstance(data, str) else data)
        path.chmod(mode)

    def save_state(self):
        self.write(self.base / "engine-release-seal.json", json.dumps(self.state_value))

    def reconciliation_invocation(self):
        return "d" * 32

    def call(self, args, seconds=20, allowed=(0,)):
        self.calls.append(args)
        if args[0] == "systemctl":
            if args[1] == "disable":
                self.enabled = False
                if self.unload_on_disable:
                    self.unit_invocation = ""
                return ""
            if args[1] == "is-enabled":
                return "enabled" if self.enabled else "disabled"
            return f"ActiveState={'active' if self.active else 'inactive'}\nSubState=dead\nMainPID=0\nControlPID=0\nJob=\nInvocationID={self.unit_invocation}"
        if args[0] == "curl":
            raw = json.dumps(self.health_value)
            return raw + "\n" + self.http if "--write-out" in args else raw
        if args[0] == "docker":
            if args[-1] == "sp-autoheal":
                return "running"
            if args[1] == "image":
                value = {"Id": IMAGE, "Config": {"Env": self.image_env, "Labels": {"org.opencontainers.image.revision": self.oci_revision}}}
                return json.dumps(value if args[-2] == "{{json .}}" else {"id": IMAGE, "env": value["Config"]["Env"], "revision": self.oci_revision})
            runtime = {**self.runtime, "image": "sha256:" + "e" * 64} if self.wrong_image else self.runtime
            if args[-2] == "{{json .}}":
                return json.dumps({"Image": runtime["image"], "State": {"Status": runtime["status"]}})
            return json.dumps(runtime)
        if args[0].endswith("engine-release-database-proof.py"):
            if self.fail_database:
                raise recovery.Refused("fixture leader stale")
            assert args[args.index("--sha") + 1] == SHA
            assert args[args.index("--max-heartbeat-age-seconds") + 1] == "15"
            return "fresh fixture leader"
        raise AssertionError(args)

    def seal(self, *args, allowed=(0,)):
        self.calls.append(["seal", *args])
        if args[0] == "record-failure" and self.fail_before_record:
            raise recovery.Refused("fixture failure before commit")
        parsed = self.native_seal.parser().parse_args(args)
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                parsed.handler(parsed)
        except SystemExit:
            raise recovery.Refused("fixture seal refusal")
        if args[0] == "record-failure" and self.lose_record_response:
            raise recovery.Refused("fixture lost response after fsync")
        return output.getvalue().strip()


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="legacy-reconciliation-")
        self.host = FixtureHost(Path(self.temporary.name).resolve())
        self.manifest_digest = recovery.digest(json.dumps(self.host.manifest).encode())

    def tearDown(self):
        self.temporary.cleanup()

    def run_recovery(self):
        return recovery.reconcile(self.host, self.manifest_digest)

    def records_exist(self):
        return all(path.exists() for path in recovery.record_paths(self.host).values())

    def test_real_parser_and_seal_retire_exact_failed_request_without_engine_mutation(self):
        self.assertEqual(self.run_recovery()["result"], "failed_request_retired")
        self.assertFalse(any(path.exists() for path in recovery.record_paths(self.host).values()))
        receipt = json.loads((self.host.base / "engine-release-results/34623692969-1.json").read_text())
        self.assertEqual(receipt["invocationId"], "d" * 32)
        self.assertEqual(receipt["transactionExitStatus"], 1)
        self.assertNotEqual(receipt["invocationId"], self.host.manifest["invocation_id"])
        for call in self.host.calls:
            if call[0] == "docker":
                self.assertEqual(call[2], "inspect")
            if call[0] == "seal":
                self.assertIn(call[1], ("pending-owner", "record-failure", "attest-failure", "attest-terminal"))

    def test_lost_seal_response_attests_durable_receipt(self):
        self.host.lose_record_response = True
        self.assertEqual(self.run_recovery()["result"], "failed_request_retired")

    def test_before_seal_commit_failure_retries_same_idempotent_write(self):
        self.host.fail_before_record = True
        with self.assertRaises(recovery.Refused):
            self.run_recovery()
        self.assertTrue(self.records_exist())
        self.host.fail_before_record = False
        self.assertEqual(self.run_recovery()["result"], "failed_request_retired")

    def interrupt_cleanup(self):
        native = recovery.fsync_dir
        def fail_after_pin(path):
            native(path)
            if path == self.host.base / "engine-release-generation-pins":
                raise OSError("fixture crash after pin unlink")
        with patch.object(recovery, "fsync_dir", fail_after_pin):
            with self.assertRaises(OSError):
                self.run_recovery()

    def test_partial_cleanup_replays_receipt_after_authorization_expiry(self):
        self.interrupt_cleanup()
        with patch.object(recovery.time, "time", return_value=self.host.manifest["expires_at"] + 60):
            self.assertEqual(self.run_recovery()["result"], "failed_request_retired")

    def test_partial_cleanup_accepts_health_503_without_rewriting_first_proof(self):
        self.interrupt_cleanup()
        self.host.http = "503"
        self.assertEqual(self.run_recovery()["result"], "failed_request_retired")

    def test_expired_authorization_cannot_create_absent_failure(self):
        self.host.fail_before_record = True
        with self.assertRaises(recovery.Refused):
            self.run_recovery()
        self.host.fail_before_record = False
        with patch.object(recovery.time, "time", return_value=self.host.manifest["expires_at"] + 60):
            with self.assertRaisesRegex(recovery.Refused, "expired authorization"):
                self.run_recovery()
        self.assertTrue(self.records_exist())

    def test_historical_complete_readback_does_not_require_old_engine_still_serving(self):
        self.run_recovery()
        self.host.wrong_image = True
        self.host.state_value["desired"]["sha"] = "a" * 40
        self.host.save_state()
        with patch.object(recovery.time, "time", return_value=self.host.manifest["expires_at"] + 60):
            self.assertTrue(self.run_recovery()["historical_readback"])

    def test_committed_run_cannot_be_failed(self):
        self.host.state_value["committedRuns"][self.host.manifest["run_id"]] = {"sha": CONTROL, "imageId": IMAGE}
        self.host.save_state()
        with self.assertRaisesRegex(recovery.Refused, "already committed"):
            self.run_recovery()
        self.assertTrue(self.records_exist())

    def test_any_pending_mutation_refuses_reconciliation(self):
        self.host.state_value["pending"] = {"runId": "99-1"}
        self.host.save_state()
        with self.assertRaisesRegex(recovery.Refused, "pending mutation"):
            self.run_recovery()
        self.assertTrue(self.records_exist())

    def test_native_lock_owner_excludes_reconciliation(self):
        with self.host.lock.open("w") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(recovery.Refused, "lock is owned"):
                self.run_recovery()
        self.assertTrue(self.records_exist())

    def test_active_original_unit_refuses_reconciliation(self):
        self.host.active = True
        with self.assertRaisesRegex(recovery.Refused, "still active"):
            self.run_recovery()

    def test_changed_request_refuses_before_failure_write(self):
        recovery.record_paths(self.host)["request"].write_text("another request\n")
        with self.assertRaisesRegex(recovery.Refused, "record mismatch"):
            self.run_recovery()

    def test_stale_database_leader_refuses_before_failure_write(self):
        self.host.fail_database = True
        with self.assertRaisesRegex(recovery.Refused, "leader stale"):
            self.run_recovery()
        self.assertTrue(self.records_exist())

    def test_wrong_image_refuses_before_failure_write(self):
        self.host.wrong_image = True
        with self.assertRaisesRegex(recovery.Refused, "run specification"):
            self.run_recovery()
        self.assertTrue(self.records_exist())

    def test_null_full_sha_cannot_use_absent_field_compatibility(self):
        self.host.health_value["releaseSha"] = None
        with self.assertRaisesRegex(recovery.Refused, "health identity"):
            self.run_recovery()

    def test_missing_legacy_defect_cannot_invent_permanent_failure(self):
        self.host.health_value["releaseSha"] = SHA
        with self.assertRaisesRegex(recovery.Refused, "defect is no longer present"):
            self.run_recovery()
        self.assertTrue(self.records_exist())

    def test_recovery_invocation_requires_actual_native_pid_and_identity(self):
        invocation = "e" * 32
        with patch.dict(os.environ, {"INVOCATION_ID": invocation}):
            with patch.object(self.host, "call", return_value=f"InvocationID={invocation}\nMainPID=0\nActiveState=activating"):
                with self.assertRaisesRegex(recovery.Refused, "native recovery invocation"):
                    recovery.Host.reconciliation_invocation(self.host)
            with patch.object(self.host, "call", return_value=f"InvocationID={invocation}\nMainPID={os.getpid()}\nActiveState=activating"):
                self.assertEqual(recovery.Host.reconciliation_invocation(self.host), invocation)

    def test_cleanup_refuses_replaced_optional_record_symlink(self):
        self.interrupt_cleanup()
        lease = recovery.record_paths(self.host)["lease"]
        lease.unlink()
        lease.symlink_to(lease.parent / "absent-other-file")
        with self.assertRaises(recovery.Refused):
            self.run_recovery()
        self.assertTrue(recovery.record_paths(self.host)["request"].exists())

    def test_absent_label_requires_explicit_matching_sealed_legacy_authorization(self):
        self.host.oci_revision = None
        self.host.runtime["release"] = None
        with self.assertRaisesRegex(recovery.Refused, "run specification"):
            self.run_recovery()

    def test_separately_authorized_sealed_unlabelled_image_requires_full_unique_env(self):
        self.host.manifest["desired_legacy_unlabelled"] = True
        self.host.state_value["desired"]["legacyUnlabelled"] = True
        self.host.save_state()
        self.host.oci_revision = None
        self.host.runtime["release"] = None
        self.host.manifest["initial_seal_sha256"] = recovery.digest((self.host.base / "engine-release-seal.json").read_bytes())
        self.manifest_digest = recovery.digest(json.dumps(self.host.manifest).encode())
        self.assertEqual(self.run_recovery()["result"], "failed_request_retired")

    def test_duplicate_image_source_env_refuses_even_with_exact_oci_label(self):
        self.host.image_env.append(f"GIT_COMMIT_SHA={SHA}")
        with self.assertRaisesRegex(recovery.Refused, "image source"):
            self.run_recovery()

    def test_conflicting_oci_label_cannot_use_legacy_env_fallback(self):
        self.host.oci_revision = "e" * 40
        with self.assertRaisesRegex(recovery.Refused, "image source"):
            self.run_recovery()

    def test_initial_durable_seal_fingerprint_must_match_under_native_lock(self):
        self.host.manifest["initial_seal_sha256"] = "0" * 64
        self.manifest_digest = recovery.digest(json.dumps(self.host.manifest).encode())
        with self.assertRaisesRegex(recovery.Refused, "initial durable seal fingerprint"):
            self.run_recovery()
        self.assertTrue(self.records_exist())

    def test_sealed_generation_change_refuses_even_with_same_image(self):
        self.host.state_value["generation"] = 2
        self.host.save_state()
        with self.assertRaisesRegex(recovery.Refused, "desired identity changed"):
            self.run_recovery()
        self.assertTrue(self.records_exist())

    def test_unit_unloaded_by_disable_can_finish_exact_retirement(self):
        self.host.unload_on_disable = True
        self.assertEqual(self.run_recovery()["result"], "failed_request_retired")

    def test_crash_after_final_request_deletion_survives_unit_collection(self):
        native = recovery.fsync_dir
        def fail_after_request(path):
            native(path)
            if path == self.host.base / "engine-release-requests" and not any(p.exists() for p in recovery.record_paths(self.host).values()):
                raise OSError("fixture crash after final request deletion")
        with patch.object(recovery, "fsync_dir", fail_after_request):
            with self.assertRaises(OSError):
                self.run_recovery()
        self.host.unit_invocation = ""
        self.assertEqual(self.run_recovery()["result"], "failed_request_retired")

    def install_fixture(self, *, bad_loaded=False, fail_reload=False):
        root = Path(self.temporary.name).resolve() / "installation"
        root.mkdir(exist_ok=True)
        layout = installer.Layout()
        layout.artifacts, layout.authorizations = root / "artifacts", root / "authorizations"
        layout.evidence, layout.units, layout.lock = root / "evidence", root / "units", self.host.lock
        source = root / "staged/reconcile-legacy-sealed-release-v1.py"
        self.host.write(source, (ROOT / "server/scripts/reconcile-legacy-sealed-release-v1.py").read_bytes(), 0o755)
        self.host.manifest["entrypoint_sha256"] = recovery.digest(source.read_bytes())
        raw = (json.dumps(self.host.manifest) + "\n").encode()
        manifest = root / "manifest.json"
        self.host.write(manifest, raw)
        manifest_digest = recovery.digest(raw)
        name = f"club-arena-engine-legacy-reconciliation-v1@{self.host.manifest['run_id']}.service"
        entrypoint = layout.artifacts / self.host.manifest["entrypoint_sha256"] / source.name
        authorization = layout.authorizations / f"{manifest_digest}.json"
        calls = []
        def command(args):
            calls.append(args)
            if args[:2] == ["systemd-analyze", "verify"]:
                unit = Path(args[2]).read_text()
                self.assertIn("Type=oneshot\n", unit)
                self.assertIn("Restart=no\n", unit)
                self.assertIn("TimeoutStartSec=300\n", unit)
                self.assertNotIn("ExecStopPost", unit)
                self.assertNotIn("[Install]", unit)
                return ""
            if args[:2] == ["systemctl", "daemon-reload"]:
                if fail_reload:
                    raise RuntimeError("fixture lost reload response")
                return ""
            self.assertEqual(args[:2], ["systemctl", "show"])
            return (f"FragmentPath={layout.units/name}\nDropInPaths={'/unreviewed/dropin' if bad_loaded else ''}\n"
                    "Type=oneshot\nRestart=no\nTimeoutStartUSec=5min\nTimeoutStopUSec=10s\nKillMode=control-group\n"
                    "ActiveState=inactive\nMainPID=0\nControlPID=0\nJob=\n"
                    f"ExecStart={{ path={entrypoint} ; argv[]={entrypoint} --manifest {authorization} --manifest-sha256 {manifest_digest} ; ignore_errors=no ; }}")
        return source, manifest, manifest_digest, layout, command, calls

    def test_installer_verifies_immutable_native_unit_without_start_or_enable(self):
        source, manifest, digest, layout, command, calls = self.install_fixture()
        receipt = installer.install(recovery, source, manifest, digest, layout, command)
        self.assertEqual(receipt["result"], "installed_inactive")
        self.assertEqual(installer.install(recovery, source, manifest, digest, layout, command), receipt)
        self.assertTrue(all(call[:2] in (["systemd-analyze", "verify"], ["systemctl", "daemon-reload"], ["systemctl", "show"]) for call in calls))

    def test_installer_rejects_loaded_dropins(self):
        source, manifest, digest, layout, command, _ = self.install_fixture(bad_loaded=True)
        with self.assertRaisesRegex(recovery.Refused, "loaded recovery unit contract"):
            installer.install(recovery, source, manifest, digest, layout, command)
        self.assertFalse((layout.evidence / digest / "installed.json").exists())

    def test_installer_reconciles_lost_reload_response_without_replacing_immutable_files(self):
        source, manifest, digest, layout, command, _ = self.install_fixture(fail_reload=True)
        with self.assertRaises(RuntimeError):
            installer.install(recovery, source, manifest, digest, layout, command)
        source, manifest, digest, layout, command, _ = self.install_fixture()
        self.assertEqual(installer.install(recovery, source, manifest, digest, layout, command)["result"], "installed_inactive")

    def test_installer_rejects_conflicting_native_unit_and_preserves_it(self):
        source, manifest, digest, layout, command, _ = self.install_fixture()
        unit = layout.units / f"club-arena-engine-legacy-reconciliation-v1@{self.host.manifest['run_id']}.service"
        self.host.write(unit, "different existing unit\n", 0o644)
        with self.assertRaisesRegex(recovery.Refused, "immutable installed bytes conflict"):
            installer.install(recovery, source, manifest, digest, layout, command)
        self.assertEqual(unit.read_text(), "different existing unit\n")

    def test_installer_refuses_held_existing_native_lock(self):
        source, manifest, digest, layout, command, calls = self.install_fixture()
        with layout.lock.open("w") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(recovery.Refused, "mutation owner is active"):
                installer.install(recovery, source, manifest, digest, layout, command)
        self.assertEqual(calls, [])

    def test_installer_refuses_expired_manifest(self):
        source, manifest, digest, layout, command, calls = self.install_fixture()
        with patch.object(recovery.time, "time", return_value=self.host.manifest["expires_at"] + 1):
            with self.assertRaisesRegex(recovery.Refused, "expired authorization"):
                installer.install(recovery, source, manifest, digest, layout, command)
        self.assertEqual(calls, [])

    def test_installer_refuses_conflicting_digest_addressed_entrypoint(self):
        source, manifest, digest, layout, command, calls = self.install_fixture()
        artifact = layout.artifacts / self.host.manifest["entrypoint_sha256"] / source.name
        self.host.write(artifact, "different bytes\n", 0o755)
        with self.assertRaisesRegex(recovery.Refused, "immutable installed bytes conflict"):
            installer.install(recovery, source, manifest, digest, layout, command)
        self.assertEqual(artifact.read_text(), "different bytes\n")
        self.assertEqual(calls, [])

    def test_installer_requires_native_systemd_verification_before_unit_install(self):
        source, manifest, digest, layout, _, _ = self.install_fixture()
        def refused(args):
            self.assertEqual(args[:2], ["systemd-analyze", "verify"])
            raise RuntimeError("fixture systemd rejects unit")
        with self.assertRaises(RuntimeError):
            installer.install(recovery, source, manifest, digest, layout, refused)
        self.assertEqual(list(layout.units.iterdir()), [])

    def test_installer_rejects_loaded_command_with_different_manifest(self):
        source, manifest, digest, layout, command, _ = self.install_fixture()
        def altered(args):
            text = command(args)
            return text.replace(f"--manifest-sha256 {digest}", "--manifest-sha256 " + "0" * 64)
        with self.assertRaisesRegex(recovery.Refused, "loaded native command differs"):
            installer.install(recovery, source, manifest, digest, layout, altered)

    def test_installer_replay_after_native_run_ignores_volatile_execution_metadata(self):
        source, manifest, digest, layout, command, _ = self.install_fixture()
        before = installer.install(recovery, source, manifest, digest, layout, command)
        def observed_after_run(args):
            return command(args).replace("ignore_errors=no ;", "ignore_errors=no ; start_time=Fri 2026-09-11 ; pid=123 ;")
        self.assertEqual(installer.install(recovery, source, manifest, digest, layout, observed_after_run), before)

    def test_installer_refuses_root_owned_input_beneath_writable_ancestor(self):
        source, manifest, digest, layout, command, calls = self.install_fixture()
        parent = manifest.parent
        parent.chmod(0o777)
        try:
            with self.assertRaisesRegex(RuntimeError, "untrusted ancestor"):
                installer.install(recovery, source, manifest, digest, layout, command)
        finally:
            parent.chmod(0o700)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
