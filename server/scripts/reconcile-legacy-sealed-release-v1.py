#!/usr/bin/env python3
"""One bounded, explicitly manifested retirement of a failed legacy v1 release.

This is an additive recovery entrypoint, not a replacement v1 wrapper. It cannot
stop, start, prepare, authorize, commit, or otherwise replace an engine. The old
request and generation remain immutable until their exact failed receipt exists.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

OWNER_UID = 0

class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_file(path, mode=0o600):
    value = path.lstat()
    require(stat.S_ISREG(value.st_mode) and value.st_uid == OWNER_UID
            and stat.S_IMODE(value.st_mode) == mode, "unsafe root-owned file")
    require(path.resolve() == path, "noncanonical file path")
    return path.read_bytes()


def immutable_json(path, value):
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            require(private_file(path) == data, "immutable recovery evidence mismatch")
        fsync_dir(path.parent)
    finally:
        temporary.unlink(missing_ok=True)
        fsync_dir(path.parent)


class Host:
    """Fixed native interfaces; the executable exposes no test/path override."""
    base = Path("/var/lib/club-arena")
    generations = Path("/usr/local/lib/club-arena/engine-control-generations")
    lock = Path("/var/lock/club-arena-engine-up.lock")
    wants = Path("/etc/systemd/system/multi-user.target.wants")
    env_file = Path("/opt/club-arena/server/.env")
    container = "club-arena-engine"

    def __init__(self, manifest):
        self.manifest = manifest
        # Expiry forbids creating an outcome, not bounded readback/retirement of
        # the already-committed exact terminal receipt.
        self.deadline = time.monotonic() + 300

    def call(self, arguments, seconds=20, allowed=(0,)):
        remaining = min(seconds, self.deadline - time.monotonic())
        require(remaining > 1, "recovery deadline expired; outcome unknown")
        child = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True,
                                 env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
        try:
            output, _ = child.communicate(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
            raise Refused("native command timed out; retained for exact readback")
        require(child.returncode in allowed, "native command refused; retained for exact readback")
        require(len(output) <= 1024 * 1024, "native response exceeds bound")
        return output.decode().strip()

    def unit(self, retired=False):
        raw = self.call(["systemctl", "show", self.unit_name, "--no-pager",
                         "-p", "ActiveState", "-p", "SubState", "-p", "MainPID",
                         "-p", "ControlPID", "-p", "Job", "-p", "InvocationID"])
        value = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
        require(value.get("ActiveState") in ("inactive", "failed")
                and value.get("MainPID") == "0" and value.get("ControlPID") == "0"
                and value.get("Job") in ("", "0")
                and (value.get("InvocationID") == self.manifest["invocation_id"]
                     or (retired and value.get("InvocationID") == "")),
                "original release still active, changed invocation, or queued")
        return value

    def reconciliation_invocation(self):
        invocation = os.environ.get("INVOCATION_ID", "")
        require(re.fullmatch(r"[0-9a-f]{32}", invocation), "missing native reconciliation invocation")
        name = f"club-arena-engine-legacy-reconciliation-v1@{self.manifest['run_id']}.service"
        raw = self.call(["systemctl", "show", name, "--no-pager", "-p", "InvocationID", "-p", "MainPID", "-p", "ActiveState"])
        value = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
        require(value.get("InvocationID") == invocation and value.get("MainPID") == str(os.getpid())
                and value.get("ActiveState") in ("active", "activating"), "not the independently identified native recovery invocation")
        return invocation

    @property
    def unit_name(self):
        return f"club-arena-engine-release-v1@{self.manifest['run_id']}.service"

    def seal(self, *args, allowed=(0,)):
        seconds = 45
        if args and args[0] == "record-failure":
            seconds = min(seconds, self.manifest["expires_at"] - time.time())
            require(seconds > 1, "failure creation authorization expired")
        return self.call([str(self.generations / self.manifest["control_sha"] / "engine-release-seal.py"),
                          *args], seconds=seconds, allowed=allowed)

    def state(self):
        raw = private_file(self.base / "engine-release-seal.json")
        value = json.loads(raw)
        desired = value.get("desired", {})
        require(value.get("schema") == 1 and desired.get("legacyUnlabelled", False) is self.manifest["desired_legacy_unlabelled"]
                and value.get("generation") == self.manifest["desired_generation"]
                and desired.get("sha") == self.manifest["desired_sha"]
                and desired.get("imageId") == self.manifest["desired_image_id"],
                "sealed legacy desired identity changed")
        require(self.manifest["run_id"] not in value.get("committedRuns", {}),
                "accepted release already committed; failure retirement forbidden")
        require(value.get("pending") is None and self.seal("pending-owner") == "none",
                "pending mutation requires its original recovery path")
        return {"sha256": digest(raw), "desired": desired}

    def container_identity(self):
        template = ('{"id":{{json .Id}},"image":{{json .Image}},"status":{{json .State.Status}},'
                    '"started_at":{{json .State.StartedAt}},"restart":{{json .HostConfig.RestartPolicy.Name}},'
                    '"release":{{json (index .Config.Labels "sp.release.sha")}},'
                    '"role":{{json (index .Config.Labels "sp.role")}},'
                    '"autoheal":{{json (index .Config.Labels "autoheal")}}}')
        value = json.loads(self.call(["docker", "container", "inspect", "--format", template, self.container]))
        label = value.get("release")
        exact_label = label == self.manifest["desired_sha"]
        authorized_absence = self.manifest["desired_legacy_unlabelled"] is True and label in (None, "")
        require(re.fullmatch(r"[0-9a-f]{64}", value.get("id", ""))
                and value.get("started_at") and value.get("status") == "running"
                and value.get("image") == self.manifest["desired_image_id"]
                and value.get("restart") == "always" and (exact_label or authorized_absence)
                and value.get("role") == "engine" and value.get("autoheal") == "true",
                "serving legacy container differs from sealed run specification")
        require(self.call(["docker", "container", "inspect", "--format", "{{.State.Status}}", "sp-autoheal"]) == "running",
                "existing autoheal is not running")
        return value

    def image_identity(self):
        template = '{"id":{{json .Id}},"env":{{json .Config.Env}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}'
        value = json.loads(self.call(["docker", "image", "inspect", "--format", template, self.manifest["desired_image_id"]]))
        entries = [entry.split("=", 1)[1] for entry in value.get("env", [])
                   if isinstance(entry, str) and entry.startswith("GIT_COMMIT_SHA=")]
        revision = value.get("revision")
        exact_revision = revision == self.manifest["desired_sha"]
        authorized_absence = self.manifest["desired_legacy_unlabelled"] is True and revision in (None, "")
        require(value.get("id") == self.manifest["desired_image_id"]
                and entries == [self.manifest["desired_sha"]]
                and (exact_revision or authorized_absence), "legacy immutable image source is not exact")
        return {"image_id": value["id"], "git_commit_sha": entries[0], "oci_revision": revision}

    def health(self, url):
        raw = self.call(["curl", "--silent", "--show-error", "--max-time", "10", "--max-filesize", "1048576",
                         "--proto", "=https,http", "--max-redirs", "0",
                         "-H", "Cache-Control: no-cache, no-store", "--write-out", "\n%{http_code}", url], seconds=12)
        body, code = raw.rsplit("\n", 1)
        value = json.loads(body)
        require(code in ("200", "503") and value.get("running") is True
                and value.get("liveness") == "ok"
                and value.get("version") == self.manifest["desired_sha"][:8]
                and ("releaseSha" not in value or value["releaseSha"] == self.manifest["desired_sha"])
                and re.fullmatch(r"[1-9][0-9]*-[0-9a-f]{8}", value.get("instanceId", "")),
                "legacy health identity or liveness mismatch")
        return {"instance_id": value["instanceId"], "version": value["version"], "http_status": code}

    def diagnostic(self):
        """Run only the pinned pure parser against separately fetched health.

        This is this reconciliation transaction's real failed predicate, not
        an invented historical exit code for the original wrapper's exit75.
        No original shell entrypoint or candidate code is executed.
        """
        invocation = self.reconciliation_invocation()
        path = self.generations / self.manifest["control_sha"] / "engine-release-transaction.sh"
        source = private_file(path, 0o755)
        require(digest(source) == self.manifest["transaction_sha256"], "pinned diagnostic source changed")
        text = source.decode()
        start = text.index("parse_health_instance_for_sha() {")
        end = text.index("\nhealth_instance_for_sha() {", start) + 1
        function = text[start:end]
        match = re.fullmatch(r"parse_health_instance_for_sha\(\) \{\n  local expected_sha=\"\$1\"\n  EXPECTED_SHA=\"\$expected_sha\" python3 -c '\n(.*?)\n' 2>/dev/null\n\}\n\n", function, re.S)
        require(match is not None, "pinned pure parser extraction contract changed")
        parser_source = match.group(1)
        raw = self.call(["curl", "--silent", "--show-error", "--max-time", "10", "--max-filesize", "1048576", "--max-redirs", "0",
                         "-H", "Cache-Control: no-cache, no-store", "http://127.0.0.1:8080/health"], seconds=12)
        value = json.loads(raw)
        require("releaseSha" not in value and value.get("version") == self.manifest["desired_sha"][:8]
                and value.get("running") is True and value.get("liveness") == "ok",
                "the accepted legacy missing-field defect is no longer present")
        child = subprocess.run([sys.executable, "-I", "-c", parser_source], input=raw, text=True,
                               capture_output=True, timeout=5,
                               env={"EXPECTED_SHA": self.manifest["desired_sha"], "PATH": "/usr/bin:/bin"})
        require(child.returncode == 1 and not child.stdout, "pinned legacy parser did not demonstrate the expected permanent refusal")
        return {"reconciliation_invocation_id": invocation, "original_invocation_id": self.manifest["invocation_id"],
                "transaction_sha256": digest(source), "parser_sha256": digest(parser_source.encode()),
                "status": child.returncode, "purpose": "accepted_v1_legacy_health_identity_failure",
                "health_sha256": digest(raw.encode()), "instance_id": value.get("instanceId")}

    def proof(self):
        state = self.state()
        before = self.container_identity()
        image = self.image_identity()
        local = self.health("http://127.0.0.1:8080/health")
        public = self.health(f"https://engine.smarter.poker/health?nocache={time.time_ns()}")
        require(local["instance_id"] == public["instance_id"], "local and public source processes disagree")
        self.call([str(self.generations / self.manifest["control_sha"] / "engine-release-database-proof.py"),
                   "--env-file", str(self.env_file), "--sha", self.manifest["desired_sha"],
                   "--instance-id", local["instance_id"], "--timeout-seconds", "20",
                   "--poll-seconds", "3", "--max-heartbeat-age-seconds", "15"], seconds=23)
        require(self.container_identity() == before, "container generation changed during proof")
        require(self.health("http://127.0.0.1:8080/health")["instance_id"] == local["instance_id"]
                and self.health(f"https://engine.smarter.poker/health?nocache={time.time_ns()}")["instance_id"] == local["instance_id"],
                "health generation changed during database proof")
        require(self.state() == state, "seal changed during proof")
        return {"seal": state, "container": before, "image": image, "local": local, "public": public,
                "database_leader": {"instance_id": local["instance_id"], "fresh": True}}


def validate_manifest(manifest):
    expected = {"schema", "run_id", "target_sha", "control_sha", "invocation_id", "desired_sha",
                "desired_image_id", "desired_legacy_unlabelled", "desired_generation", "initial_seal_sha256",
                "request_sha256", "intent_sha256", "pin_sha256", "seal_helper_sha256",
                "database_proof_sha256", "transaction_sha256", "entrypoint_sha256", "expires_at", "reason"}
    require(set(manifest) == expected and manifest["schema"] == 1, "invalid manifest fields")
    require(type(manifest["desired_legacy_unlabelled"]) is bool, "invalid sealed legacy marker")
    require(type(manifest["desired_generation"]) is int and manifest["desired_generation"] >= 1,
            "invalid sealed desired generation")
    for key in ("target_sha", "control_sha", "desired_sha"):
        require(re.fullmatch(r"[0-9a-f]{40}", manifest[key]), "invalid source identity")
    for key in expected:
        if key.endswith("_sha256"):
            require(re.fullmatch(r"[0-9a-f]{64}", manifest[key]), "invalid digest")
    require(re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", manifest["run_id"])
            and re.fullmatch(r"[0-9a-f]{32}", manifest["invocation_id"])
            and re.fullmatch(r"sha256:[0-9a-f]{64}", manifest["desired_image_id"]), "invalid operation identity")
    require(type(manifest["expires_at"]) is int and 0 < manifest["expires_at"]
            and manifest["expires_at"] - time.time() <= 1800,
            "manifest exceeds bounded recovery authorization")
    require(manifest["reason"] == "accepted_v1_legacy_health_identity_failure", "unexpected recovery purpose")
    require(manifest["target_sha"] != manifest["desired_sha"], "cannot fail the serving target")


def record_paths(host):
    run = host.manifest["run_id"]
    return {"pin": host.base / "engine-release-generation-pins" / f"{run}.generation",
            "lease": host.base / "engine-image-leases" / f"{run}.lease",
            "deadline": host.base / "engine-release-requests" / f"{run}.break-deadline",
            "intent": host.base / "engine-release-requests" / f"{run}.intent",
            "request": host.base / "engine-release-requests" / f"{run}.request"}


def failure_receipt(host):
    m = host.manifest
    evidence = host.base / "engine-release-legacy-reconciliations" / m["run_id"]
    diagnostic = json.loads(private_file(evidence / "diagnostic.json"))
    invocation = diagnostic["reconciliation_invocation_id"]
    require(diagnostic["original_invocation_id"] == m["invocation_id"]
            and diagnostic["status"] == 1 and diagnostic["transaction_sha256"] == m["transaction_sha256"],
            "reconciliation diagnostic linkage mismatch")
    host.seal("attest-failure", "--sha", m["target_sha"], "--run-id", m["run_id"],
              "--control-sha", m["control_sha"], "--invocation-id", invocation)
    value = json.loads(private_file(host.base / "engine-release-results" / f"{m['run_id']}.json"))
    for key, expected in {"schema": 1, "result": "failed", "runId": m["run_id"],
                          "sha": m["target_sha"], "controlSha": m["control_sha"],
                          "invocationId": invocation, "transactionExitStatus": 1,
                          "recoveredDesiredSha": m["desired_sha"],
                          "recoveredDesiredImageId": m["desired_image_id"]}.items():
        require(value.get(key) == expected, "failure receipt does not match original accepted operation")
    host.seal("attest-terminal", "--sha", m["target_sha"], "--run-id", m["run_id"], "--control-sha", m["control_sha"])
    return value


def reconcile(host, manifest_digest):
    m = host.manifest
    validate_manifest(m)
    generation = host.generations / m["control_sha"]
    require(private_file(generation / "control-sha", 0o644).decode().strip() == m["control_sha"], "pinned generation identity mismatch")
    for filename, key in (("engine-release-seal.py", "seal_helper_sha256"),
                          ("engine-release-database-proof.py", "database_proof_sha256"),
                          ("engine-release-transaction.sh", "transaction_sha256")):
        require(digest(private_file(generation / filename, 0o755)) == m[key], "pinned recovery helper bytes changed")
    evidence = host.base / "engine-release-legacy-reconciliations" / m["run_id"]
    evidence.mkdir(parents=True, mode=0o700, exist_ok=True)
    require(evidence.resolve() == evidence and evidence.stat().st_uid == OWNER_UID
            and stat.S_IMODE(evidence.stat().st_mode) == 0o700, "unsafe recovery evidence directory")
    immutable_json(evidence / "authorization.json", {"manifest": m, "manifest_sha256": manifest_digest})
    lock = os.open(host.lock, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        require(os.fstat(lock).st_uid == OWNER_UID and stat.S_ISREG(os.fstat(lock).st_mode), "unsafe native mutation lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("native mutation lock is owned; no reconciliation performed")
        paths = record_paths(host)
        complete_path = evidence / "complete.json"
        if complete_path.exists():
            complete = json.loads(private_file(complete_path))
            require(complete["manifest_sha256"] == manifest_digest
                    and complete["result"] == "failed_request_retired"
                    and complete["receipt"] == failure_receipt(host), "historical completion mismatch")
            require(all(not path.exists() and not path.is_symlink() for path in paths.values()),
                    "completed original request records reappeared")
            require(host.call(["systemctl", "is-enabled", host.unit_name], allowed=(0, 1, 3, 4)) == "disabled",
                    "completed original unit boot edge reappeared")
            return {"result": "failed_request_retired", "run_id": m["run_id"], "evidence": str(evidence),
                    "historical_readback": True}
        before_path = evidence / "before.json"
        if before_path.exists():
            before = json.loads(private_file(before_path))
        else:
            require(m["expires_at"] > time.time(), "expired authorization cannot begin reconciliation")
            require(host.state()["sha256"] == m["initial_seal_sha256"], "initial durable seal fingerprint changed")
            records = {key: private_file(path).decode() if path.exists() or path.is_symlink() else None for key, path in paths.items()}
            for key in ("request", "intent", "pin"):
                require(records[key] is not None and digest(records[key].encode()) == m[f"{key}_sha256"], "original durable record mismatch")
            lines = records["request"].splitlines()
            require(len(lines) == 6 and lines[0] == m["target_sha"] and lines[3] == str(generation)
                    and lines[4] == m["control_sha"] and records["request"] == records["intent"]
                    and records["pin"].splitlines() == [str(generation), m["control_sha"]], "original v1 request/pin binding mismatch")
            before = {"manifest_sha256": manifest_digest, "records": records, "unit": host.unit(), "proof": host.proof()}
            immutable_json(before_path, before)
        require(before["manifest_sha256"] == manifest_digest, "reconciliation belongs to another authorization")
        retired_records = all(not path.exists() and not path.is_symlink() for path in paths.values())
        if retired_records:
            failure_receipt(host)
        host.unit(retired=retired_records)
        host.proof()
        for key, path in paths.items():
            if path.exists() or path.is_symlink():
                require(private_file(path).decode() == before["records"][key], "original record changed during recovery")
            elif before["records"][key] is not None:
                failure_receipt(host)  # Only exact terminal proof permits partial-cleanup replay.
        attempt = evidence / "failure-intent.json"
        result_path = host.base / "engine-release-results" / f"{m['run_id']}.json"
        if not result_path.exists():
            require(m["expires_at"] > time.time(), "expired authorization cannot create a failure outcome")
            diagnostic_path = evidence / "diagnostic.json"
            if not diagnostic_path.exists():
                immutable_json(diagnostic_path, host.diagnostic())
            diagnostic = json.loads(private_file(diagnostic_path))
            require(diagnostic["instance_id"] == before["proof"]["local"]["instance_id"],
                    "diagnostic belongs to another serving process")
            invocation = diagnostic["reconciliation_invocation_id"]
            host.reconciliation_invocation()  # Current native owner is real even on replay.
            immutable_json(attempt, {"manifest_sha256": manifest_digest, "failure_exit_status": 1,
                                     "invocation_id": invocation})
            host.unit()
            host.state()
            require(m["expires_at"] > time.time(), "failure creation authorization expired")
            try:
                host.seal("record-failure", "--sha", m["target_sha"], "--run-id", m["run_id"],
                          "--control-sha", m["control_sha"], "--invocation-id", invocation,
                          "--exit-status", "1", "--container", host.container)
            except Refused:
                pass  # Attest first. A later attempt may repeat this exact
                # idempotent seal write only if the receipt truly is absent,
                # fresh proofs still pass, and authorization remains current.
        receipt = failure_receipt(host)
        after_proof = host.proof()
        require(after_proof["container"] == before["proof"]["container"]
                and after_proof["local"]["instance_id"] == before["proof"]["local"]["instance_id"],
                "original serving process changed; retain exact failed request")
        terminal_path = evidence / "terminal-proof.json"
        if terminal_path.exists():
            terminal = json.loads(private_file(terminal_path))
            require(terminal["receipt"] == receipt
                    and terminal["proof"]["container"] == after_proof["container"]
                    and terminal["proof"]["local"]["instance_id"] == after_proof["local"]["instance_id"],
                    "saved terminal proof belongs to another outcome or process")
        else:
            immutable_json(terminal_path, {"receipt": receipt, "proof": after_proof})
        # Same durable retirement order as v1: pin, lease, deadline, intent,
        # request last, then only the original unit's boot edge. No retention.
        for key, path in paths.items():
            failure_receipt(host)
            retired_records = all(not entry.exists() and not entry.is_symlink() for entry in paths.values())
            host.unit(retired=retired_records)
            if path.exists() or path.is_symlink():
                require(private_file(path).decode() == before["records"][key], "cleanup refuses changed original record")
                path.unlink()
                fsync_dir(path.parent)
        host.call(["systemctl", "disable", host.unit_name])
        enabled = host.call(["systemctl", "is-enabled", host.unit_name], allowed=(0, 1, 3, 4))
        require(enabled == "disabled", "original boot edge is not durably disabled")
        fsync_dir(host.wants)
        host.unit(retired=True)
        final_proof = host.proof()
        require(final_proof["container"] == before["proof"]["container"]
                and final_proof["local"]["instance_id"] == before["proof"]["local"]["instance_id"], "serving process changed after cleanup")
        immutable_json(evidence / "complete.json", {"manifest_sha256": manifest_digest, "result": "failed_request_retired",
                                                   "receipt": receipt, "container": final_proof["container"],
                                                   "instance_id": final_proof["local"]["instance_id"]})
        return {"result": "failed_request_retired", "run_id": m["run_id"], "evidence": str(evidence)}
    finally:
        os.close(lock)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "must execute under the existing root recovery owner")
    raw = private_file(args.manifest)
    require(len(raw) <= 16384 and digest(raw) == args.manifest_sha256, "manifest digest mismatch")
    manifest = json.loads(raw)
    validate_manifest(manifest)
    require(digest(private_file(Path(__file__).resolve(), 0o755)) == manifest["entrypoint_sha256"], "recovery entrypoint bytes mismatch")
    print(json.dumps(reconcile(Host(manifest), args.manifest_sha256)))


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, KeyError, TypeError) as exc:
        # Never print native stderr, environment, complete health or image data.
        print(json.dumps({"result": "UNKNOWN", "reason": str(exc) if isinstance(exc, Refused) else type(exc).__name__}), file=sys.stderr)
        raise SystemExit(75)
