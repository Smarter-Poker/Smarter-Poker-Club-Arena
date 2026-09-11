#!/usr/bin/env python3
"""Durable, fail-closed release authority for the Club Arena engine.

The Docker tags and the repository checkout on the engine host are mutable
caches.  This file keeps the one authoritative release decision in a
root-owned state file outside that checkout.  A normal deploy may only move the
high-water mark forward along ``origin/main``.  A rollback needs its own
explicit, audited mode and never lowers that high-water mark.

Every command which mutates the seal is serialized and atomically replaces the
state file.  ``engine-up.sh`` consumes the one-use token created by ``prepare``
before it stops the serving container; the host supervisor may start only the
sealed desired image without a token.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
from typing import Any, NoReturn


SCHEMA = 1
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
RUN_ID_RE = re.compile(r"^[1-9][0-9]*(?:-[1-9][0-9]*)?$")
RUN_URL_RE = re.compile(r"^https://github\.com/[^/]+/[^/]+/actions/runs/[1-9][0-9]*$")
INSTANCE_ID_RE = re.compile(r"^[1-9][0-9]*-[0-9a-f]{8}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
INVOCATION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
PENDING_TTL_SECONDS = int(os.environ.get("ENGINE_RELEASE_PENDING_TTL_SECONDS", "1800"))
STATE_DIR = Path(os.environ.get("ENGINE_RELEASE_STATE_DIR", "/var/lib/club-arena"))
STATE_FILE = Path(os.environ.get("ENGINE_RELEASE_STATE_FILE", str(STATE_DIR / "engine-release-seal.json")))
AUDIT_FILE = Path(os.environ.get("ENGINE_RELEASE_AUDIT_FILE", str(STATE_DIR / "engine-release-audit.jsonl")))
RESULT_DIR = Path(
    os.environ.get("ENGINE_RELEASE_RESULT_DIR", str(STATE_DIR / "engine-release-results"))
)
LOCK_FILE = Path(os.environ.get("ENGINE_RELEASE_LOCK_FILE", "/var/lock/club-arena-engine-release.lock"))


def die(message: str) -> NoReturn:
    print(f"[engine-release-seal] FATAL: {message}", file=sys.stderr)
    raise SystemExit(1)


def valid_sha(value: str, label: str = "sha") -> str:
    value = value.lower()
    if not SHA_RE.fullmatch(value):
        die(f"{label} must be one lowercase 40-hex commit")
    return value


def valid_image_id(value: str, label: str = "image id") -> str:
    value = value.lower()
    if not IMAGE_ID_RE.fullmatch(value):
        die(f"{label} must be one full sha256 image id")
    return value


def run(command: list[str]) -> str:
    try:
        result = subprocess.run(
            command,
            check=True,
            text=True,
            capture_output=True,
            env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"},
            timeout=30,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        stderr = getattr(exc, "stderr", "") or ""
        die(f"command failed: {' '.join(command)}: {stderr.strip() or exc}")
    return result.stdout.strip()


def docker_json(kind: str, reference: str) -> dict[str, Any]:
    raw = run(["docker", kind, "inspect", "--format", "{{json .}}", reference])
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        die(f"docker returned malformed {kind} identity for {reference}")
    if not isinstance(value, dict):
        die(f"docker returned non-object {kind} identity for {reference}")
    return value


def image_identity(reference: str, *, require_label: bool) -> tuple[str, str, bool]:
    value = docker_json("image", reference)
    image_id = valid_image_id(str(value.get("Id", "")))
    config = value.get("Config") if isinstance(value.get("Config"), dict) else {}
    labels = config.get("Labels") if isinstance(config.get("Labels"), dict) else {}
    revision = labels.get("org.opencontainers.image.revision")
    if isinstance(revision, str) and SHA_RE.fullmatch(revision.lower()):
        return image_id, revision.lower(), True
    if require_label:
        die(f"image {reference} has no valid org.opencontainers.image.revision label")

    # Legacy bootstrap only: images built before the seal carried the full SHA
    # in image config ENV.  New candidates must carry the immutable OCI label.
    env = config.get("Env") if isinstance(config.get("Env"), list) else []
    matches = [entry.split("=", 1)[1] for entry in env if isinstance(entry, str) and entry.startswith("GIT_COMMIT_SHA=")]
    if len(matches) != 1 or not SHA_RE.fullmatch(matches[0].lower()):
        die(f"legacy image {reference} has no unique full GIT_COMMIT_SHA identity")
    return image_id, matches[0].lower(), False


def container_identity(name: str) -> tuple[str, str]:
    value = docker_json("container", name)
    state = value.get("State") if isinstance(value.get("State"), dict) else {}
    return str(state.get("Status", "")), valid_image_id(str(value.get("Image", "")), "container image id")


def ensure_dirs() -> None:
    state_created = not STATE_DIR.exists()
    result_created = not RESULT_DIR.exists()
    lock_parent_created = not LOCK_FILE.parent.exists()
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    RESULT_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        STATE_DIR.chmod(0o700)
        RESULT_DIR.chmod(0o700)
    except PermissionError:
        pass
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    # An atomic file replacement is not durable if the directory containing
    # that file disappears after power loss. Persist every newly-created queue
    # root in its parent before any command can acknowledge a seal/result.
    for directory, created in (
        (RESULT_DIR, result_created),
        (STATE_DIR, state_created or result_created),
        (STATE_DIR.parent, state_created),
        (LOCK_FILE.parent, lock_parent_created),
        (LOCK_FILE.parent.parent, lock_parent_created),
    ):
        if not created:
            continue
        descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


class SealLock:
    def __enter__(self) -> "SealLock":
        ensure_dirs()
        self.handle = LOCK_FILE.open("a+")
        fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *_: object) -> None:
        fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        self.handle.close()


def validate_release(value: Any, label: str) -> dict[str, str]:
    if not isinstance(value, dict):
        die(f"seal {label} is missing")
    return {
        "sha": valid_sha(str(value.get("sha", "")), f"{label}.sha"),
        "imageId": valid_image_id(str(value.get("imageId", "")), f"{label}.imageId"),
    }


def load_state() -> dict[str, Any]:
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"release seal is missing: {STATE_FILE}")
    except (OSError, json.JSONDecodeError) as exc:
        die(f"release seal is unreadable: {exc}")
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        die("release seal schema is invalid")
    raw_desired = value.get("desired")
    value["desired"] = validate_release(raw_desired, "desired")
    legacy_unlabelled = (
        raw_desired.get("legacyUnlabelled", False) if isinstance(raw_desired, dict) else False
    )
    if not isinstance(legacy_unlabelled, bool):
        die("release seal desired legacy marker is invalid")
    value["desired"]["legacyUnlabelled"] = legacy_unlabelled
    value["highWaterSha"] = valid_sha(str(value.get("highWaterSha", "")), "highWaterSha")
    generation = value.get("generation")
    if not isinstance(generation, int) or generation < 1:
        die("release seal generation is invalid")
    committed_runs = value.get("committedRuns", {})
    if not isinstance(committed_runs, dict):
        die("release seal committed-run history is invalid")
    for run_id, receipt in committed_runs.items():
        if not RUN_ID_RE.fullmatch(str(run_id)) or not isinstance(receipt, dict):
            die("release seal contains an invalid committed-run receipt")
        receipt.update(validate_release(receipt, f"committedRuns.{run_id}"))
    value["committedRuns"] = committed_runs
    finalization = value.get("finalization")
    if finalization is not None:
        if not isinstance(finalization, dict):
            die("release seal finalization owner is invalid")
        finalization.update(validate_release(finalization, "finalization"))
        if not RUN_ID_RE.fullmatch(str(finalization.get("runId", ""))):
            die("release seal finalization run id is invalid")
        committed_owner = committed_runs.get(str(finalization["runId"]))
        if (
            not isinstance(committed_owner, dict)
            or committed_owner.get("sha") != finalization["sha"]
            or committed_owner.get("imageId") != finalization["imageId"]
            or value["desired"]["sha"] != finalization["sha"]
            or value["desired"]["imageId"] != finalization["imageId"]
        ):
            die("release seal finalization owner is not the exact desired commit")
    value["finalization"] = finalization
    pending = value.get("pending")
    if pending is not None:
        if not isinstance(pending, dict):
            die("release seal pending entry is invalid")
        pending.update(validate_release(pending, "pending"))
        if pending.get("mode") not in {"deploy", "rollback"}:
            die("release seal pending mode is invalid")
        if not isinstance(pending.get("expiresAt"), int) or not isinstance(pending.get("used"), bool):
            die("release seal pending lifecycle is invalid")
        if not re.fullmatch(r"^[0-9a-f]{64}$", str(pending.get("tokenHash", ""))):
            die("release seal pending token hash is invalid")
        if not RUN_ID_RE.fullmatch(str(pending.get("runId", ""))):
            die("release seal pending run id is invalid")
    return value


def write_state(value: dict[str, Any]) -> None:
    ensure_dirs()
    write_json_atomic(STATE_FILE, value)


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        try:
            os.fchmod(fd, 0o600)
            payload = (
                json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n"
            ).encode()
            write_all(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary_path, path)
        directory_fd = os.open(
            path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        )
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        # An exception before replace must never leave a root-owned partial
        # state/result candidate that can accumulate or be mistaken for work.
        temporary_path.unlink(missing_ok=True)


def write_all(fd: int, payload: bytes) -> None:
    """Write every byte or fail; os.write is allowed to complete partially."""
    remaining = memoryview(payload)
    while remaining:
        written = os.write(fd, remaining)
        if written <= 0:
            raise OSError("write returned no progress")
        remaining = remaining[written:]


def audit(event: str, state: dict[str, Any], **details: Any) -> None:
    record = {
        "at": int(time.time()),
        "event": event,
        "generation": state.get("generation"),
        **details,
    }
    fd = os.open(AUDIT_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        write_all(
            fd,
            (json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n").encode(),
        )
        os.fsync(fd)
    finally:
        os.close(fd)
    # The file fsync above persists appended bytes, but the first O_CREAT also
    # adds a directory entry. Persist the parent on every append so a power
    # loss cannot retain a seal/result while losing its corresponding audit
    # stream's first entry.
    directory_fd = os.open(AUDIT_FILE.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def audit_once(
    event: str,
    state: dict[str, Any],
    event_key: str,
    **details: Any,
) -> None:
    """Append one receipt audit exactly once, repairing a lost first append."""
    digest = hashlib.sha256(
        json.dumps(details, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    try:
        records = AUDIT_FILE.read_bytes().splitlines(keepends=True)
    except FileNotFoundError:
        records = []
    except OSError as exc:
        die(f"release audit is unreadable: {exc}")
    for raw in records:
        if not raw.endswith(b"\n"):
            die("release audit ends with a partial record")
        try:
            existing = json.loads(raw)
        except json.JSONDecodeError as exc:
            die(f"release audit contains malformed JSON: {exc}")
        if not isinstance(existing, dict) or existing.get("eventKey") != event_key:
            continue
        if existing.get("event") != event or existing.get("eventDigest") != digest:
            die("release audit event key is bound to different receipt bytes")
        return
    audit(event, state, eventKey=event_key, eventDigest=digest, **details)


def metadata(args: argparse.Namespace) -> dict[str, str]:
    run_id = str(args.run_id)
    github_run_id = run_id.split("-", 1)[0]
    run_url = str(args.run_url)
    actor = str(args.actor).strip()
    reason = str(args.reason).strip()
    if not RUN_ID_RE.fullmatch(run_id):
        die("an audited numeric GitHub run id is required")
    if not RUN_URL_RE.fullmatch(run_url) or not run_url.endswith(f"/{github_run_id}"):
        die("run URL must identify the same audited GitHub Actions run")
    if not actor or len(actor) > 128 or any(ord(char) < 32 for char in actor):
        die("an audited actor is required")
    if not reason or len(reason) > 1000 or any(ord(char) < 32 for char in reason):
        die("an audited reason is required")
    return {"runId": run_id, "runUrl": run_url, "actor": actor, "reason": reason}


def pending_is_active(pending: Any) -> bool:
    # expiresAt is the first unauthorized second, not the last authorized one.
    # This also makes a deliberately zero-second test token deterministically
    # unusable without sleeping on the wall clock.
    return isinstance(pending, dict) and int(pending.get("expiresAt", 0)) > int(time.time())


def git_has_commit(repo: str, sha: str) -> None:
    run(["git", "-C", repo, "cat-file", "-e", f"{sha}^{{commit}}"])


def git_is_ancestor(repo: str, older: str, newer: str, explanation: str) -> None:
    try:
        subprocess.run(
            ["git", "-C", repo, "merge-base", "--is-ancestor", older, newer],
            check=True,
            text=True,
            capture_output=True,
            env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"},
            timeout=30,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        die(explanation)


def cmd_bootstrap_running(args: argparse.Namespace) -> None:
    with SealLock():
        if STATE_FILE.exists():
            state = load_state()
            print(state["desired"]["sha"])
            return
        meta = metadata(args)
        status, image_id = container_identity(args.container)
        if status != "running":
            die(f"cannot bootstrap from {args.container}: state is {status or 'unknown'}")
        inspected_id, sha, has_revision_label = image_identity(image_id, require_label=False)
        if inspected_id != image_id:
            die("running container and inspected image identities disagree")
        git_has_commit(args.repo, sha)
        git_is_ancestor(
            args.repo,
            sha,
            "origin/main",
            "running bootstrap image is not contained in fetched protected main",
        )
        state: dict[str, Any] = {
            "schema": SCHEMA,
            "generation": 1,
            "desired": {
                "sha": sha,
                "imageId": image_id,
                # The first rollout has to seal the already-running b4 image,
                # which predates both the OCI revision label and the container
                # sp.release.sha label.  This explicit, one-generation marker
                # lets the supervisor accept only that exact sealed image
                # without restarting it before a maintenance cutover.
                "legacyUnlabelled": not has_revision_label,
            },
            "highWaterSha": sha,
            "committedRuns": {},
            "finalization": None,
            "pending": None,
            "updatedAt": int(time.time()),
            "updatedBy": meta,
        }
        write_state(state)
        audit("bootstrap", state, desired=state["desired"], **meta)
        print(sha)


def cmd_prepare(args: argparse.Namespace) -> None:
    meta = metadata(args)
    target_sha = valid_sha(args.sha)
    image_id, image_sha, _ = image_identity(args.image, require_label=True)
    if image_sha != target_sha:
        die(f"image revision {image_sha} does not equal requested commit {target_sha}")

    with SealLock():
        state = load_state()
        if result_path(meta["runId"]).exists():
            die("this audited run already has an immutable terminal result")
        finalization = state.get("finalization")
        if isinstance(finalization, dict):
            die(
                "committed run "
                f"{finalization['runId']} owns durable result finalization"
            )
        git_has_commit(args.repo, target_sha)
        git_has_commit(args.repo, state["highWaterSha"])
        git_is_ancestor(
            args.repo,
            target_sha,
            "origin/main",
            "requested commit is not contained in fetched origin/main",
        )
        if args.mode == "deploy":
            git_is_ancestor(
                args.repo,
                state["highWaterSha"],
                target_sha,
                "normal deploy would move behind or diverge from the sealed high-water commit",
            )
        else:
            git_is_ancestor(
                args.repo,
                target_sha,
                state["highWaterSha"],
                "rollback target is not an ancestor of the sealed high-water commit",
            )
            if target_sha == state["desired"]["sha"]:
                die("rollback target already is the desired release")
            if len(meta["reason"]) < 12:
                die("rollback reason must describe the emergency in at least 12 characters")

        existing = state.get("pending")
        if pending_is_active(existing) and str(existing.get("runId")) != meta["runId"]:
            die(f"another audited cutover is still active (run {existing.get('runId')})")

        token = secrets.token_hex(32)
        state["pending"] = {
            "sha": target_sha,
            "imageId": image_id,
            "mode": args.mode,
            "tokenHash": hashlib.sha256(token.encode()).hexdigest(),
            "expiresAt": int(time.time()) + PENDING_TTL_SECONDS,
            "used": False,
            **meta,
        }
        state["updatedAt"] = int(time.time())
        state["updatedBy"] = meta
        write_state(state)
        audit("prepare", state, target={"sha": target_sha, "imageId": image_id}, mode=args.mode, **meta)
        print(token)


def cmd_authorize(args: argparse.Namespace) -> None:
    image_id, image_sha, _ = image_identity(args.image, require_label=False)
    supplied_token = ""
    if args.token_stdin:
        supplied_token = sys.stdin.read(129).strip()
        if len(supplied_token) > 128:
            die("cutover authorization token input is too long")
    with SealLock():
        state = load_state()
        desired = state["desired"]
        if image_id == desired["imageId"] and image_sha == desired["sha"]:
            audit("desired_start_authorized", state, target=desired)
            # Return the immutable pair. The caller must docker-run imageId,
            # never the mutable tag/reference it asked us to authorize.
            print(f'desired {desired["sha"]} {desired["imageId"]}')
            return

        pending = state.get("pending")
        if not pending_is_active(pending):
            die("requested image is not the sealed desired release and no live cutover authorization exists")
        if pending.get("used") is True:
            die("the prepared cutover authorization was already consumed")
        if image_id != pending.get("imageId") or image_sha != pending.get("sha"):
            die("requested image does not match the prepared immutable SHA/image-id pair")
        supplied_hash = hashlib.sha256(supplied_token.encode()).hexdigest()
        if not secrets.compare_digest(supplied_hash, str(pending.get("tokenHash"))):
            die("cutover authorization token is missing or invalid")
        pending["used"] = True
        state["updatedAt"] = int(time.time())
        write_state(state)
        audit(
            "candidate_start_authorized",
            state,
            target={"sha": pending["sha"], "imageId": pending["imageId"]},
            mode=pending["mode"],
            runId=pending["runId"],
            runUrl=pending["runUrl"],
            actor=pending["actor"],
        )
        print(f'pending {pending["sha"]} {pending["imageId"]}')


def cmd_classify(args: argparse.Namespace) -> None:
    try:
        status, image_id = container_identity(args.container)
    except SystemExit:
        print("absent")
        return
    with SealLock():
        state = load_state()
        if image_id == state["desired"]["imageId"]:
            suffix = f' {state["desired"]["sha"]}' if args.with_sha else ""
            print(f"desired{suffix}")
            return
        pending = state.get("pending")
        if (
            status == "running"
            and pending_is_active(pending)
            and pending.get("used") is True
            and image_id == pending.get("imageId")
        ):
            suffix = f' {pending["sha"]}' if args.with_sha else ""
            print(f"pending{suffix}")
            return
        print("drift")


def cmd_get(args: argparse.Namespace) -> None:
    with SealLock():
        state = load_state()
        fields = {
            "desired-sha": state["desired"]["sha"],
            "desired-image-id": state["desired"]["imageId"],
            "high-water-sha": state["highWaterSha"],
            "desired-legacy-unlabelled": (
                "true" if state["desired"]["legacyUnlabelled"] else "false"
            ),
        }
        print(fields[args.field])


def cmd_pending_owner(_args: argparse.Namespace) -> None:
    """Describe only pending ownership/lifecycle, never its authorization hash."""
    with SealLock():
        state = load_state()
        pending = state.get("pending")
        if not isinstance(pending, dict):
            print("none")
            return
        lifecycle = "active" if pending_is_active(pending) else "expired"
        used = "true" if pending.get("used") is True else "false"
        print(f'{lifecycle} {pending["runId"]} {used} {pending["expiresAt"]}')


def result_path(run_id: str) -> Path:
    if not RUN_ID_RE.fullmatch(run_id):
        die("result run id is invalid")
    return RESULT_DIR / f"{run_id}.json"


def load_result(run_id: str) -> dict[str, Any]:
    path = result_path(run_id)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"durable release result is missing for run {run_id}")
    except (OSError, json.JSONDecodeError) as exc:
        die(f"durable release result is unreadable: {exc}")
    if not isinstance(value, dict) or value.get("schema") != 1:
        die("durable release result schema is invalid")
    value["runId"] = str(value.get("runId", ""))
    if value["runId"] != run_id:
        die("durable release result belongs to another run")
    if value.get("result") not in {"sealed", "already-released"}:
        die("durable release result outcome is invalid")
    value["sha"] = valid_sha(str(value.get("sha", "")), "result.sha")
    value["imageId"] = valid_image_id(str(value.get("imageId", "")), "result.imageId")
    if not INSTANCE_ID_RE.fullmatch(str(value.get("instanceId", ""))):
        die("durable release result instance id is invalid")
    if not CONTAINER_ID_RE.fullmatch(str(value.get("containerId", ""))):
        die("durable release result container id is invalid")
    started_at = str(value.get("startedAt", ""))
    if not started_at or len(started_at) > 80 or any(ord(char) < 32 for char in started_at):
        die("durable release result start generation is invalid")
    value["controlSha"] = valid_sha(str(value.get("controlSha", "")), "result.controlSha")
    invocation_ids = value.get("invocationIds")
    if (
        not isinstance(invocation_ids, list)
        or not invocation_ids
        or any(not INVOCATION_ID_RE.fullmatch(str(item)) for item in invocation_ids)
        or len(set(invocation_ids)) != len(invocation_ids)
    ):
        die("durable release result invocation history is invalid")
    if not isinstance(value.get("completedAt"), int) or int(value["completedAt"]) < 1:
        die("durable release result completion time is invalid")
    completion = value.get("completionRuntime")
    if not isinstance(completion, dict):
        die("durable release result completion generation is missing")
    if not INSTANCE_ID_RE.fullmatch(str(completion.get("instanceId", ""))):
        die("durable release result original instance id is invalid")
    if not CONTAINER_ID_RE.fullmatch(str(completion.get("containerId", ""))):
        die("durable release result original container id is invalid")
    if not INVOCATION_ID_RE.fullmatch(str(completion.get("invocationId", ""))):
        die("durable release result original invocation id is invalid")
    original_started = str(completion.get("startedAt", ""))
    if not original_started or len(original_started) > 80 or any(
        ord(char) < 32 for char in original_started
    ):
        die("durable release result original start generation is invalid")
    return value


def load_failure(run_id: str) -> dict[str, Any]:
    path = result_path(run_id)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"durable release failure is missing for run {run_id}")
    except (OSError, json.JSONDecodeError) as exc:
        die(f"durable release failure is unreadable: {exc}")
    if not isinstance(value, dict) or value.get("schema") != 1:
        die("durable release failure schema is invalid")
    if str(value.get("runId", "")) != run_id:
        die("durable release failure belongs to another run")
    value["runId"] = run_id
    value["sha"] = valid_sha(str(value.get("sha", "")), "failure.sha")
    value["controlSha"] = valid_sha(
        str(value.get("controlSha", "")), "failure.controlSha"
    )
    if value.get("result") != "failed":
        die("durable release failure outcome is invalid")
    if not INVOCATION_ID_RE.fullmatch(str(value.get("invocationId", ""))):
        die("durable release failure invocation id is invalid")
    exit_status = value.get("transactionExitStatus")
    if (
        not isinstance(exit_status, int)
        or isinstance(exit_status, bool)
        or exit_status < 1
        or exit_status > 255
        or exit_status == 75
    ):
        die("durable release failure exit status is invalid")
    value["recoveredDesiredSha"] = valid_sha(
        str(value.get("recoveredDesiredSha", "")), "failure.recoveredDesiredSha"
    )
    value["recoveredDesiredImageId"] = valid_image_id(
        str(value.get("recoveredDesiredImageId", "")),
        "failure.recoveredDesiredImageId",
    )
    if not isinstance(value.get("completedAt"), int) or int(value["completedAt"]) < 1:
        die("durable release failure completion time is invalid")
    return value


def cmd_record_failure(args: argparse.Namespace) -> None:
    run_id = str(args.run_id)
    if not RUN_ID_RE.fullmatch(run_id):
        die("failure run id is invalid")
    target_sha = valid_sha(args.sha, "failure.sha")
    control_sha = valid_sha(args.control_sha, "failure.controlSha")
    invocation_id = str(args.invocation_id)
    if not INVOCATION_ID_RE.fullmatch(invocation_id):
        die("failure systemd invocation id is invalid")
    try:
        exit_status = int(str(args.exit_status), 10)
    except ValueError:
        die("failure transaction exit status is invalid")
    if exit_status < 1 or exit_status > 255 or exit_status == 75:
        die("failure transaction exit status is not permanent")

    with SealLock():
        state = load_state()
        committed = state.get("committedRuns", {}).get(run_id)
        if isinstance(committed, dict):
            die("a committed release attempt cannot be recorded as failed")

        # The wrapper invokes this only after recovery returns successfully.
        # Re-prove the strongest identity available at this boundary so the
        # tombstone cannot be written while an unsealed candidate is serving.
        desired = state["desired"]
        status, running_image_id = container_identity(args.container)
        if status != "running" or running_image_id != desired["imageId"]:
            die("failure recovery does not run the sealed desired image")
        inspected_image_id, recovered_sha, _ = image_identity(
            running_image_id, require_label=False
        )
        if inspected_image_id != running_image_id or recovered_sha != desired["sha"]:
            die("failure recovery image identity disagrees with the seal")

        path = result_path(run_id)
        expected = {
            "sha": target_sha,
            "controlSha": control_sha,
            "invocationId": invocation_id,
            "transactionExitStatus": exit_status,
            "recoveredDesiredSha": desired["sha"],
            "recoveredDesiredImageId": desired["imageId"],
        }
        if path.exists():
            value = load_failure(run_id)
            if any(value[key] != expected[key] for key in expected):
                die("an existing failure binds this run to different attempt bytes")
            audit_once(
                "failure_recorded",
                state,
                f"failure_recorded:{run_id}",
                failure=value,
            )
            print("failed")
            return

        value = {
            "schema": 1,
            "runId": run_id,
            "result": "failed",
            **expected,
            "completedAt": int(time.time()),
        }
        write_json_atomic(path, value)
        audit_once(
            "failure_recorded",
            state,
            f"failure_recorded:{run_id}",
            failure=value,
        )
        print("failed")


def cmd_attest_failure(args: argparse.Namespace) -> None:
    run_id = str(args.run_id)
    target_sha = valid_sha(args.sha, "failure.sha")
    control_sha = str(args.control_sha or "")
    invocation_id = str(args.invocation_id or "")
    if control_sha:
        control_sha = valid_sha(control_sha, "failure.controlSha")
    if invocation_id and not INVOCATION_ID_RE.fullmatch(invocation_id):
        die("failure systemd invocation id is invalid")
    with SealLock():
        state = load_state()
        value = load_failure(run_id)
        if value["sha"] != target_sha:
            die("durable failure does not attest this exact SHA")
        if control_sha and value["controlSha"] != control_sha:
            die("durable failure does not attest this exact control generation")
        if invocation_id and value["invocationId"] != invocation_id:
            die("durable failure does not attest this exact invocation")
        # Attestation is also the reboot/uncertain-response convergence edge.
        # A crash can occur after the immutable failure file is fsynced but
        # before its audit append. Repair that exact event idempotently before
        # allowing a wrapper or observer to treat the tombstone as terminal.
        audit_once(
            "failure_recorded",
            state,
            f"failure_recorded:{run_id}",
            failure=value,
        )
        print(
            " ".join(
                str(value[key])
                for key in (
                    "result",
                    "sha",
                    "controlSha",
                    "invocationId",
                    "transactionExitStatus",
                    "recoveredDesiredSha",
                    "recoveredDesiredImageId",
                )
            )
        )


def cmd_attest_terminal(args: argparse.Namespace) -> None:
    """Attest immutable terminal bytes without requiring they remain desired."""
    run_id = str(args.run_id)
    target_sha = valid_sha(args.sha, "terminal.sha")
    control_sha = valid_sha(args.control_sha, "terminal.controlSha")
    with SealLock():
        path = result_path(run_id)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            die(f"durable terminal result is missing for run {run_id}")
        except (OSError, json.JSONDecodeError) as exc:
            die(f"durable terminal result is unreadable: {exc}")
        outcome = raw.get("result") if isinstance(raw, dict) else None
        if outcome == "failed":
            value = load_failure(run_id)
        elif outcome in {"sealed", "already-released"}:
            value = load_result(run_id)
        else:
            die("durable terminal result outcome is invalid")
        if value["sha"] != target_sha or value["controlSha"] != control_sha:
            die("durable terminal result does not match the exact release request")
        if outcome == "failed":
            # Terminal cleanup is the last authority that can delete the
            # durable request. It must repair a failure audit lost in the
            # result-fsync/audit-append crash window before permitting that
            # deletion, even when no separate attest-failure call ran first.
            state = load_state()
            audit_once(
                "failure_recorded",
                state,
                f"failure_recorded:{run_id}",
                failure=value,
            )
        print(str(value["result"]))


def cmd_record_result(args: argparse.Namespace) -> None:
    run_id = str(args.run_id)
    if not RUN_ID_RE.fullmatch(run_id):
        die("result run id is invalid")
    target_sha = valid_sha(args.sha, "result.sha")
    image_id = valid_image_id(args.image_id, "result.imageId")
    control_sha = valid_sha(args.control_sha, "result.controlSha")
    instance_id = str(args.instance_id)
    container_id = str(args.container_id)
    started_at = str(args.started_at)
    invocation_id = str(args.invocation_id)
    if not INSTANCE_ID_RE.fullmatch(instance_id):
        die("result instance id is invalid")
    if not CONTAINER_ID_RE.fullmatch(container_id):
        die("result container id is invalid")
    if not started_at or len(started_at) > 80 or any(ord(char) < 32 for char in started_at):
        die("result start generation is invalid")
    if not INVOCATION_ID_RE.fullmatch(invocation_id):
        die("result systemd invocation id is invalid")

    with SealLock():
        state = load_state()
        desired = state["desired"]
        if desired["sha"] != target_sha or desired["imageId"] != image_id:
            die("durable seal does not identify the result release")
        committed = state.get("committedRuns", {}).get(run_id)
        this_run_sealed = (
            isinstance(committed, dict)
            and committed.get("sha") == target_sha
            and committed.get("imageId") == image_id
        )
        if args.result == "sealed" and not this_run_sealed:
            die("this run did not seal the claimed result")
        # A power loss after the atomic seal commit but before the separate
        # result file cannot erase authorship. The seal's audited run id is the
        # authority on whether this run performed the cutover.
        effective_result = "sealed" if this_run_sealed else "already-released"

        path = result_path(run_id)
        finalization = state.get("finalization")
        exact_finalization = (
            isinstance(finalization, dict)
            and finalization.get("runId") == run_id
            and finalization.get("sha") == target_sha
            and finalization.get("imageId") == image_id
        )
        if isinstance(finalization, dict) and not exact_finalization:
            die("another committed run owns durable result finalization")
        if args.result == "sealed" and not path.exists() and not exact_finalization:
            die("sealed result has no exclusive durable finalization owner")
        if path.exists():
            value = load_result(run_id)
            expected = {
                "sha": target_sha,
                "imageId": image_id,
                "controlSha": control_sha,
            }
            if any(value[key] != expected[key] for key in expected):
                die("an existing result binds this run to different release bytes")
            # A boot replay after an already-fsynced success can restart or
            # recreate the same sealed image, changing the process/container
            # generation. Preserve the original completion below and append a
            # fresh, independently proved observation for this invocation.
            if invocation_id not in value["invocationIds"]:
                value["invocationIds"].append(invocation_id)
            value["instanceId"] = instance_id
            value["containerId"] = container_id
            value["startedAt"] = started_at
            write_json_atomic(path, value)
        else:
            value = {
                "schema": 1,
                "runId": run_id,
                "sha": target_sha,
                "imageId": image_id,
                "result": effective_result,
                "instanceId": instance_id,
                "containerId": container_id,
                "startedAt": started_at,
                "controlSha": control_sha,
                "invocationIds": [invocation_id],
                "completedAt": int(time.time()),
                "completionRuntime": {
                    "instanceId": instance_id,
                    "containerId": container_id,
                    "startedAt": started_at,
                    "invocationId": invocation_id,
                },
            }
            write_json_atomic(path, value)
        audit_once(
            "result_recorded",
            state,
            f"result_recorded:{run_id}:{invocation_id}",
            result={
                "runId": run_id,
                "result": value["result"],
                "sha": target_sha,
                "imageId": image_id,
                "controlSha": control_sha,
                "invocationId": invocation_id,
                "instanceId": instance_id,
                "containerId": container_id,
                "startedAt": started_at,
            },
        )
        if exact_finalization:
            state["finalization"] = None
            state["updatedAt"] = int(time.time())
            write_state(state)
        print(value["result"])


def cmd_attest_result(args: argparse.Namespace) -> None:
    run_id = str(args.run_id)
    target_sha = valid_sha(args.sha, "result.sha")
    invocation_id = str(args.invocation_id or "")
    if invocation_id and not INVOCATION_ID_RE.fullmatch(invocation_id):
        die("result systemd invocation id is invalid")
    with SealLock():
        state = load_state()
        value = load_result(run_id)
        if value["sha"] != target_sha:
            die("durable result does not attest this exact SHA")
        if invocation_id and invocation_id not in value["invocationIds"]:
            die("durable result does not attest this exact invocation")
        desired = state["desired"]
        if desired["sha"] != value["sha"] or desired["imageId"] != value["imageId"]:
            die("durable result no longer matches the sealed desired release")
        print(
            " ".join(
                str(value[key])
                for key in (
                    "result",
                    "sha",
                    "imageId",
                    "containerId",
                    "startedAt",
                    "instanceId",
                    "controlSha",
                )
            )
        )


def cmd_commit(args: argparse.Namespace) -> None:
    meta = metadata(args)
    target_sha = valid_sha(args.sha)
    image_id, image_sha, _ = image_identity(args.image, require_label=True)
    if image_sha != target_sha:
        die("commit image revision does not match target")
    status, running_image_id = container_identity(args.container)
    if status != "running" or running_image_id != image_id:
        die("compatibility proof cannot seal an image that is not the running container")

    with SealLock():
        state = load_state()
        pending = state.get("pending")
        # A lost SSH response or an audit-append failure can make the caller
        # uncertain after the fsynced state replacement succeeded. The same
        # audited run may safely retry/attest that exact durable receipt; it may
        # not move or rewrite any other release.
        committed = state.get("committedRuns", {}).get(meta["runId"])
        if (
            pending is None
            and state["desired"]["sha"] == target_sha
            and state["desired"]["imageId"] == image_id
            and isinstance(committed, dict)
            and committed.get("sha") == target_sha
            and committed.get("imageId") == image_id
        ):
            finalization = state.get("finalization")
            expected_finalization = {
                "runId": meta["runId"],
                "sha": target_sha,
                "imageId": image_id,
            }
            if isinstance(finalization, dict) and any(
                finalization.get(key) != value for key, value in expected_finalization.items()
            ):
                die("another committed run owns durable result finalization")
            if finalization is None and not result_path(meta["runId"]).exists():
                state["finalization"] = expected_finalization
                state["updatedAt"] = int(time.time())
                write_state(state)
            audit("commit_attested", state, desired=state["desired"], **meta)
            print(target_sha)
            return
        if not pending_is_active(pending) or pending.get("used") is not True:
            die("no consumed live cutover authorization exists for commit")
        if pending.get("sha") != target_sha or pending.get("imageId") != image_id:
            die("running release does not match the prepared cutover")
        if str(pending.get("runId")) != meta["runId"]:
            die("only the run which prepared the cutover may commit it")

        old_desired = state["desired"]
        state["desired"] = {
            "sha": target_sha,
            "imageId": image_id,
            "legacyUnlabelled": False,
        }
        if pending["mode"] == "deploy":
            state["highWaterSha"] = target_sha
        # An intentional rollback changes what recovery should run, but never
        # turns an older commit into the normal deploy high-water authority.
        state["generation"] += 1
        mode = pending["mode"]
        state["committedRuns"][meta["runId"]] = {
            "sha": target_sha,
            "imageId": image_id,
        }
        state["finalization"] = {
            "runId": meta["runId"],
            "sha": target_sha,
            "imageId": image_id,
        }
        state["pending"] = None
        state["updatedAt"] = int(time.time())
        state["updatedBy"] = meta
        write_state(state)
        audit(
            "commit",
            state,
            previous=old_desired,
            desired=state["desired"],
            highWaterSha=state["highWaterSha"],
            mode=mode,
            **meta,
        )
        print(target_sha)


def cmd_attest_commit(args: argparse.Namespace) -> None:
    target_sha = valid_sha(args.sha)
    image_id = str(args.image_id)
    if not IMAGE_ID_RE.fullmatch(image_id):
        die("commit attestation image ID is invalid")
    run_id = str(args.run_id)
    if not RUN_ID_RE.fullmatch(run_id):
        die("commit attestation run id is invalid")
    with SealLock():
        state = load_state()
        desired = state["desired"]
        committed = state.get("committedRuns", {}).get(run_id)
        if (
            desired["sha"] != target_sha
            or desired["imageId"] != image_id
            or not isinstance(committed, dict)
            or committed.get("sha") != target_sha
            or committed.get("imageId") != image_id
        ):
            die("durable release state does not attest this run's exact commit")
        print(f'{state["generation"]} {target_sha} {image_id} {run_id}')


def cmd_abort(args: argparse.Namespace) -> None:
    with SealLock():
        state = load_state()
        pending = state.get("pending")
        if not isinstance(pending, dict) or str(pending.get("runId")) != str(args.run_id):
            return
        target = {"sha": pending["sha"], "imageId": pending["imageId"]}
        state["pending"] = None
        state["updatedAt"] = int(time.time())
        write_state(state)
        audit("abort", state, target=target, runId=str(args.run_id))


def add_audit_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-url", required=True)
    parser.add_argument("--actor", required=True)
    parser.add_argument("--reason", required=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)

    bootstrap = commands.add_parser("bootstrap-running")
    bootstrap.add_argument("--container", default="club-arena-engine")
    bootstrap.add_argument("--repo", default="/opt/club-arena")
    add_audit_arguments(bootstrap)
    bootstrap.set_defaults(handler=cmd_bootstrap_running)

    prepare = commands.add_parser("prepare")
    prepare.add_argument("--sha", required=True)
    prepare.add_argument("--image", required=True)
    prepare.add_argument("--mode", choices=("deploy", "rollback"), required=True)
    prepare.add_argument("--repo", default="/opt/club-arena")
    add_audit_arguments(prepare)
    prepare.set_defaults(handler=cmd_prepare)

    authorize = commands.add_parser("authorize")
    authorize.add_argument("--image", required=True)
    authorize.add_argument("--token-stdin", action="store_true")
    authorize.set_defaults(handler=cmd_authorize)

    classify = commands.add_parser("classify-running")
    classify.add_argument("--container", default="club-arena-engine")
    classify.add_argument("--with-sha", action="store_true")
    classify.set_defaults(handler=cmd_classify)

    get = commands.add_parser("get")
    get.add_argument(
        "field",
        choices=(
            "desired-sha",
            "desired-image-id",
            "desired-legacy-unlabelled",
            "high-water-sha",
        ),
    )
    get.set_defaults(handler=cmd_get)

    pending_owner = commands.add_parser("pending-owner")
    pending_owner.set_defaults(handler=cmd_pending_owner)

    record_result = commands.add_parser("record-result")
    record_result.add_argument("--sha", required=True)
    record_result.add_argument("--image-id", required=True)
    record_result.add_argument("--result", choices=("sealed", "already-released"), required=True)
    record_result.add_argument("--instance-id", required=True)
    record_result.add_argument("--container-id", required=True)
    record_result.add_argument("--started-at", required=True)
    record_result.add_argument("--run-id", required=True)
    record_result.add_argument("--control-sha", required=True)
    record_result.add_argument("--invocation-id", required=True)
    record_result.set_defaults(handler=cmd_record_result)

    attest_result = commands.add_parser("attest-result")
    attest_result.add_argument("--sha", required=True)
    attest_result.add_argument("--run-id", required=True)
    attest_result.add_argument("--invocation-id")
    attest_result.set_defaults(handler=cmd_attest_result)

    record_failure = commands.add_parser("record-failure")
    record_failure.add_argument("--sha", required=True)
    record_failure.add_argument("--run-id", required=True)
    record_failure.add_argument("--control-sha", required=True)
    record_failure.add_argument("--invocation-id", required=True)
    record_failure.add_argument("--exit-status", required=True)
    record_failure.add_argument("--container", default="club-arena-engine")
    record_failure.set_defaults(handler=cmd_record_failure)

    attest_failure = commands.add_parser("attest-failure")
    attest_failure.add_argument("--sha", required=True)
    attest_failure.add_argument("--run-id", required=True)
    attest_failure.add_argument("--control-sha")
    attest_failure.add_argument("--invocation-id")
    attest_failure.set_defaults(handler=cmd_attest_failure)

    attest_terminal = commands.add_parser("attest-terminal")
    attest_terminal.add_argument("--sha", required=True)
    attest_terminal.add_argument("--run-id", required=True)
    attest_terminal.add_argument("--control-sha", required=True)
    attest_terminal.set_defaults(handler=cmd_attest_terminal)

    commit = commands.add_parser("commit")
    commit.add_argument("--sha", required=True)
    commit.add_argument("--image", required=True)
    commit.add_argument("--container", default="club-arena-engine")
    add_audit_arguments(commit)
    commit.set_defaults(handler=cmd_commit)

    attest = commands.add_parser("attest-commit")
    attest.add_argument("--sha", required=True)
    attest.add_argument("--image-id", required=True)
    attest.add_argument("--run-id", required=True)
    attest.set_defaults(handler=cmd_attest_commit)

    abort = commands.add_parser("abort")
    abort.add_argument("--run-id", required=True)
    abort.set_defaults(handler=cmd_abort)
    return result


def main() -> None:
    args = parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
