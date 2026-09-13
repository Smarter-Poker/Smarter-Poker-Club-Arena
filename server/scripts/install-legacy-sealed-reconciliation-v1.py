#!/usr/bin/env python3
"""Install and verify one immutable recovery-only native unit; never start it."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time


class Layout:
    artifacts = Path("/usr/local/lib/club-arena/engine-legacy-reconciliation-v1")
    authorizations = Path("/var/lib/club-arena/engine-release-legacy-authorizations")
    evidence = Path("/var/lib/club-arena/engine-release-legacy-installations")
    units = Path("/etc/systemd/system")
    lock = Path("/var/lock/club-arena-engine-up.lock")


def unit_bytes(entrypoint, manifest, manifest_digest):
    return f"""[Unit]
Description=Bounded Club Arena accepted legacy release reconciliation
After=docker.service network-online.target

[Service]
Type=oneshot
User=root
Group=root
ExecStart={entrypoint} --manifest {manifest} --manifest-sha256 {manifest_digest}
Restart=no
TimeoutStartSec=300
TimeoutStopSec=10
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/club-arena /var/lock /etc/systemd/system/multi-user.target.wants
""".encode()


class Native:
    def __init__(self):
        self.deadline = time.monotonic() + 90

    def __call__(self, command):
        remaining = min(30, self.deadline - time.monotonic())
        if remaining <= 1:
            raise RuntimeError("installation deadline expired")
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
        try:
            output, _ = child.communicate(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
            raise RuntimeError("installation command timed out; read back before retry")
        if child.returncode or len(output) > 262144:
            raise RuntimeError("native installation verification refused")
        return output.decode().strip()


def trusted_parents(path, owner=0, *, boundary=Path("/")):
    # The executable always checks through /. Native tests inject only their
    # disposable filesystem boundary; no CLI or environment override exists.
    if path != boundary and boundary not in path.parents:
        raise RuntimeError("installation path escaped trusted boundary")
    for parent in (path, *path.parents):
        value = parent.lstat()
        if (not stat.S_ISDIR(value.st_mode) or value.st_uid not in (0, owner)
                or stat.S_IMODE(value.st_mode) & 0o022 or parent.resolve() != parent):
            raise RuntimeError("installation input or target has an untrusted ancestor")
        if parent == boundary:
            return


def directory(core, path):
    missing = []
    cursor = path
    while not cursor.exists():
        missing.append(cursor)
        cursor = cursor.parent
    trusted_parents(cursor, core.OWNER_UID)
    for created in reversed(missing):
        created.mkdir(mode=0o700)
        core.fsync_dir(created)
        core.fsync_dir(created.parent)
    value = path.lstat()
    core.require(stat.S_ISDIR(value.st_mode) and value.st_uid == core.OWNER_UID
                 and not stat.S_IMODE(value.st_mode) & 0o022 and path.resolve() == path,
                 "unsafe installation directory")


def install_bytes(core, path, data, mode):
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            core.require(core.private_file(path, mode) == data, "immutable installed bytes conflict")
        core.fsync_dir(path.parent)
    finally:
        temporary.unlink(missing_ok=True)
        core.fsync_dir(path.parent)


def install(core, source, manifest_path, manifest_digest, layout=None, command=None):
    layout = layout or Layout()
    command = command or Native()
    trusted_parents(source.parent, core.OWNER_UID)
    trusted_parents(manifest_path.parent, core.OWNER_UID)
    raw = core.private_file(manifest_path)
    core.require(len(raw) <= 16384 and core.digest(raw) == manifest_digest, "manifest digest mismatch")
    manifest = json.loads(raw)
    core.validate_manifest(manifest)
    core.require(manifest["expires_at"] > time.time(), "expired authorization cannot install a new native invocation")
    code = core.private_file(source, 0o755)
    core.require(core.digest(code) == manifest["entrypoint_sha256"], "recovery entrypoint digest mismatch")
    name = f"club-arena-engine-legacy-reconciliation-v1@{manifest['run_id']}.service"
    artifact_root = layout.artifacts / manifest["entrypoint_sha256"]
    entrypoint = artifact_root / "reconcile-legacy-sealed-release-v1.py"
    authorization = layout.authorizations / f"{manifest_digest}.json"
    evidence = layout.evidence / manifest_digest
    unit = layout.units / name
    data = unit_bytes(entrypoint, authorization, manifest_digest)
    # Every interpolated value is either a fixed native path or validated hex /
    # run-attempt identity. No shell, unit escaping or caller command is used.
    for path in (artifact_root, layout.authorizations, evidence, layout.units):
        directory(core, path)
    intent = {"manifest_sha256": manifest_digest, "entrypoint_sha256": core.digest(code),
              "entrypoint": str(entrypoint), "authorization": str(authorization),
              "unit": name, "unit_sha256": core.digest(data), "purpose": "recovery_only_no_start"}
    core.immutable_json(evidence / "intent.json", intent)
    fd = os.open(layout.lock, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        core.require(os.fstat(fd).st_uid == core.OWNER_UID and stat.S_ISREG(os.fstat(fd).st_mode), "unsafe existing engine lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise core.Refused("engine mutation owner is active; install retained for retry")
        install_bytes(core, entrypoint, code, 0o755)
        install_bytes(core, authorization, raw, 0o600)
        staged = evidence / name
        install_bytes(core, staged, data, 0o644)
        command(["systemd-analyze", "verify", str(staged)])
        install_bytes(core, unit, data, 0o644)
        command(["systemctl", "daemon-reload"])
        raw_loaded = command(["systemctl", "show", name, "--no-pager", "-p", "FragmentPath", "-p", "DropInPaths",
                              "-p", "Type", "-p", "Restart", "-p", "TimeoutStartUSec", "-p", "TimeoutStopUSec",
                              "-p", "KillMode", "-p", "ExecStart", "-p", "ActiveState", "-p", "MainPID", "-p", "ControlPID", "-p", "Job"])
        loaded = dict(line.split("=", 1) for line in raw_loaded.splitlines() if "=" in line)
        expected = {"FragmentPath": str(unit), "DropInPaths": "", "Type": "oneshot", "Restart": "no",
                    "TimeoutStartUSec": "5min", "TimeoutStopUSec": "10s", "KillMode": "control-group",
                    "ActiveState": "inactive", "MainPID": "0", "ControlPID": "0", "Job": ""}
        core.require(all(loaded.get(key) == value for key, value in expected.items()), "loaded recovery unit contract differs")
        invocation = f"{entrypoint} --manifest {authorization} --manifest-sha256 {manifest_digest}"
        core.require(f"path={entrypoint} ;" in loaded.get("ExecStart", "")
                     and f"argv[]={invocation} ;" in loaded.get("ExecStart", ""), "loaded native command differs")
        core.require(core.private_file(unit, 0o644) == data and core.private_file(entrypoint, 0o755) == code
                     and core.private_file(authorization) == raw, "installed readback bytes differ")
        # ExecStart also contains volatile PID/start/stop timestamps. Verify
        # that native response, but retain only its immutable command contract
        # so reinstall readback after the one-shot ran remains idempotent.
        receipt = {**intent, "result": "installed_inactive", "systemd_verified": True,
                   "loaded": {**expected, "ExecStart": invocation}}
        core.immutable_json(evidence / "installed.json", receipt)
        return receipt
    finally:
        os.close(fd)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("root recovery owner required")
    # Verify exact root-owned bytes before importing any staged entrypoint.
    for path, mode in ((args.source, 0o755), (args.manifest, 0o600)):
        trusted_parents(path.parent)
        value = path.lstat()
        if not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or stat.S_IMODE(value.st_mode) != mode or path.resolve() != path:
            raise RuntimeError("unsafe staged recovery input")
    raw = args.manifest.read_bytes()
    if len(raw) > 16384 or hashlib.sha256(raw).hexdigest() != args.manifest_sha256:
        raise RuntimeError("manifest digest mismatch")
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != json.loads(raw).get("entrypoint_sha256"):
        raise RuntimeError("entrypoint digest mismatch")
    spec = importlib.util.spec_from_file_location("verified_recovery", args.source)
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)
    print(json.dumps(install(core, args.source, args.manifest, args.manifest_sha256)))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"result": "INSTALL_NOT_VERIFIED", "reason": type(exc).__name__}), file=sys.stderr)
        raise SystemExit(75)
