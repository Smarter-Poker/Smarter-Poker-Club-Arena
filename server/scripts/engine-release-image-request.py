#!/usr/bin/env python3
"""Prepare and validate versioned image requests for the existing release controller.

No dispatch, Docker, host transfer, cleanup, or deployment is implemented here.
The production CI preparer authenticates the real bundle through the existing
verifier. Offline validation proves binding/integrity, NOT GitHub authenticity.
Only the existing trusted intake channel may install these prepared bytes as an
intent; future versioned units must establish durable ownership before doing so.
Frozen v1 units/records are never upgraded, interpreted or rewritten here.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time

spec = importlib.util.spec_from_file_location(
    "engine_image_ci_bundle", Path(__file__).with_name("engine-image-ci-bundle.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)

PROTOCOL = "club-arena-engine-image-request-v2"
LIMIT = 16384
FIELDS = {"protocol", "kind", "run_key", "run_url", "actor", "not_after_epoch",
          "source_sha", "control_sha", "image_authority", "host_import_qualified",
          "deployment_authorized"}
EXPECTED_FIELDS = {"identity", "archive_sha256", "archive_bytes", "descriptor_sha256",
                   "artifact_id", "artifact_digest"}
RECEIPT_FIELDS = {"scope", "status", "producer_job_id", "artifact_id", "identity",
                  "archive_sha256", "archive_bytes", "descriptor_sha256",
                  "host_import_qualified", "deployment_authorized"}


def require(ok, reason):
    if not ok:
        raise ValueError("ENGINE_IMAGE_REQUEST_" + reason)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def actor_ok(actor):
    return (isinstance(actor, str) and 0 < len(actor) <= 128 and
            all(ord(c) >= 32 and ord(c) != 127 for c in actor))


def generation_ok(path, control_sha):
    # The new format pins the existing deterministic generation convention.
    # This is syntax only; installed-generation inode/manifest validation stays
    # in the existing controller's versioned launcher/wrapper integration.
    return (isinstance(path, str) and path ==
            "/usr/local/lib/club-arena/engine-control-generations/" + control_sha)


def validate_expected(expected):
    bundle.exact_keys(expected, EXPECTED_FIELDS, "EXPECTED_SHAPE")
    bundle.check_identity(expected["identity"])
    require(bundle.positive(expected["artifact_id"]) and
            all(bundle.hex_value(expected[key], 64) for key in
                ("archive_sha256", "descriptor_sha256", "artifact_digest")) and
            type(expected["archive_bytes"]) is int and
            1024 <= expected["archive_bytes"] <= bundle.ARCHIVE_LIMIT, "EXPECTED_IDENTITY")


def validate_receipt(receipt, expected):
    bundle.exact_keys(receipt, RECEIPT_FIELDS, "RECEIPT_SHAPE")
    require(receipt["scope"] == "same-run-engine-image-admission" and
            receipt["status"] == "passed" and
            type(receipt["producer_job_id"]) is int and receipt["producer_job_id"] > 0 and
            receipt["host_import_qualified"] is False and
            receipt["deployment_authorized"] is False, "CUSTODY_CONTRACT")
    require(all(receipt[key] == expected[key] for key in
                ("identity", "artifact_id", "archive_sha256", "archive_bytes", "descriptor_sha256")),
            "CUSTODY_IDENTITY")


def validate_value(value, kind, run_key):
    require(kind in {"intake", "release"}, "KIND")
    require(isinstance(run_key, str) and
            re.fullmatch(r"[1-9][0-9]{0,19}-[1-9][0-9]{0,19}", run_key), "RUN_KEY")
    extra = {"generation_path", "intake_sha256"} if kind == "release" else set()
    bundle.exact_keys(value, FIELDS | extra, "REQUEST_SHAPE")
    require(value["protocol"] == PROTOCOL and value["kind"] == kind and
            value["run_key"] == run_key, "PROTOCOL_CONTEXT")
    authority = value["image_authority"]
    bundle.exact_keys(authority, ("expected", "custody_receipt", "custody_receipt_sha256"),
                      "AUTHORITY_SHAPE")
    expected, receipt = authority["expected"], authority["custody_receipt"]
    validate_expected(expected)
    validate_receipt(receipt, expected)
    require(authority["custody_receipt_sha256"] == digest(bundle.encode(receipt)), "CUSTODY_DIGEST")
    identity = expected["identity"]
    require(run_key == identity["run_id"] + "-" + identity["run_attempt"] and
            value["run_url"] == "https://github.com/" + bundle.REPOSITORY +
            "/actions/runs/" + identity["run_id"] and
            value["source_sha"] == identity["source_sha"] and
            value["control_sha"] == identity["workflow_control_sha"], "REQUEST_IDENTITY")
    require(actor_ok(value["actor"]), "ACTOR")
    require(type(value["not_after_epoch"]) is int and
            0 < value["not_after_epoch"] <= 9999999999, "DEADLINE")
    require(value["host_import_qualified"] is False and value["deployment_authorized"] is False,
            "NO_DEPLOYMENT_AUTHORITY")
    if kind == "release":
        require(generation_ok(value["generation_path"], value["control_sha"]), "GENERATION")
        parent = copy.deepcopy(value)
        parent["kind"] = "intake"
        del parent["generation_path"], parent["intake_sha256"]
        require(value["intake_sha256"] == digest(bundle.encode(parent)), "INTAKE_BINDING")
    return value


def parse(raw, kind, run_key):
    require(isinstance(raw, bytes) and 0 < len(raw) <= LIMIT, "REQUEST_SIZE")
    value = bundle.decode(raw)
    validate_value(value, kind, run_key)
    # One canonical representation makes the request itself its immutable intent.
    require(raw == bundle.encode(value), "NONCANONICAL_REQUEST")
    return value


def require_unexpired(value, now):
    require(type(now) is int and now >= 0, "CLOCK")
    require(now < value["not_after_epoch"], "EXPIRED")


def make_intake(expected, receipt, actor, deadline, now):
    """Pure binding primitive, not an authentication API; use prepare_intake in CI."""
    validate_expected(expected)
    validate_receipt(receipt, expected)
    identity = expected["identity"]
    value = {"protocol": PROTOCOL, "kind": "intake",
             "run_key": identity["run_id"] + "-" + identity["run_attempt"],
             "run_url": "https://github.com/" + bundle.REPOSITORY +
                        "/actions/runs/" + identity["run_id"],
             "actor": actor, "not_after_epoch": deadline,
             "source_sha": identity["source_sha"], "control_sha": identity["workflow_control_sha"],
             "image_authority": {"expected": copy.deepcopy(expected),
                                 "custody_receipt": copy.deepcopy(receipt),
                                 "custody_receipt_sha256": digest(bundle.encode(receipt))},
             "host_import_qualified": False, "deployment_authorized": False}
    validate_value(value, "intake", value["run_key"])
    require_unexpired(value, now)
    return bundle.encode(value)


def prepare_intake(directory, expected_path, actor, deadline):
    """The only CLI creation path: genuine same-run production API admission.

    It accepts no downloaded admission receipt and no synthetic context flags.
    A deadline is supplied once by the workflow; four bounded API reads and
    local byte checks must finish within that original deadline.
    """
    _, raw = bundle.read_regular(Path(expected_path), LIMIT, retain=True)
    expected = bundle.decode(raw)
    validate_expected(expected)
    require_unexpired({"not_after_epoch": deadline}, int(time.time()))
    receipt = bundle.admit_bundle(directory, expected)
    return make_intake(expected, receipt, actor, deadline, int(time.time()))


def verify_bound_request(raw, kind, run_key, expected_sha256):
    """Verify the independent workflow/owned-intent digest before interpreting bytes."""
    require(bundle.hex_value(expected_sha256, 64) and digest(raw) == expected_sha256,
            "BOUND_REQUEST_DIGEST")
    return parse(raw, kind, run_key)


def derive_release(intake_raw, run_key, generation_path, expected_intake_sha256):
    """Bind a verified installed generation without renewing request authority.

    An expired intake may still be derived/read for exact durable recovery. The
    existing controller must require_unexpired again before any new acquisition
    or mutation and validate the actual generation's manifest/inodes itself.
    """
    value = copy.deepcopy(verify_bound_request(intake_raw, "intake", run_key, expected_intake_sha256))
    value.update(kind="release", generation_path=generation_path,
                 intake_sha256=digest(intake_raw))
    validate_value(value, "release", run_key)
    return bundle.encode(value)


def verify_pair(intent_raw, request_raw, kind, run_key):
    """Recovery reads only: never renew, convert, dispatch or delete a record."""
    value = parse(intent_raw, kind, run_key)
    parse(request_raw, kind, run_key)
    require(intent_raw == request_raw, "INTENT_REQUEST_MISMATCH")
    return value


def write_prepared(output, raw, kind, run_key):
    """Fsync a canonical, mode-0600 prepared record; never publish a live request.

    The fixed .prepared-v2 suffix cannot trigger the current .intent/.request
    units. Existing controller installers must own future publication ordering.
    Same bytes are idempotent; any existing different/legacy bytes fail closed.
    """
    parse(raw, kind, run_key)
    output = Path(output)
    require(output.is_absolute() and output.name == run_key + "." + kind + ".prepared-v2",
            "PREPARED_PATH")
    parent = output.parent
    require(parent.resolve(strict=True) == parent, "CANONICAL_PARENT")
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = "." + output.name + "." + secrets.token_hex(12)
    created = False
    try:
        info = os.fstat(directory)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
                stat.S_IMODE(info.st_mode) == 0o700, "PRIVATE_PARENT")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        created = True
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        # link is atomic and refuses replacing any existing name, including a
        # symlink. A lost acknowledgement can only replay the exact same bytes.
        try:
            os.link(temporary, output.name, src_dir_fd=directory, dst_dir_fd=directory,
                    follow_symlinks=False)
        except FileExistsError:
            pass
        fd = os.open(output.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
                    stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= LIMIT,
                    "EXISTING_PREPARED_FILE")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                existing = stream.read(LIMIT + 1)
            require(existing == raw, "PREPARED_CONFLICT")
            after = os.fstat(fd)
            fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
            require(all(getattr(info, key) == getattr(after, key) for key in fields), "PREPARED_CHANGED")
            named = os.stat(output.name, dir_fd=directory, follow_symlinks=False)
            require((named.st_dev, named.st_ino) == (info.st_dev, info.st_ino), "PREPARED_REPLACED")
            os.fsync(fd)
        finally:
            os.close(fd)
        current = parent.stat()
        require((current.st_dev, current.st_ino) == (os.fstat(directory).st_dev, os.fstat(directory).st_ino)
                and parent.resolve(strict=True) == parent, "PARENT_REPLACED")
        os.fsync(directory)
    finally:
        try:
            if created:
                os.unlink(temporary, dir_fd=directory)
                os.fsync(directory)
        finally:
            os.close(directory)
    return {"protocol": PROTOCOL, "kind": kind, "run_key": run_key,
            "request_sha256": digest(raw), "request_bytes": len(raw),
            "host_import_qualified": False, "deployment_authorized": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--expected", required=True)
    parser.add_argument("--actor", required=True)
    parser.add_argument("--not-after-epoch", type=int, required=True)
    parser.add_argument("--output", required=True,
                        help="Private runner directory / RUN-ATTEMPT.intake.prepared-v2")
    args = parser.parse_args()
    raw = prepare_intake(args.directory, args.expected, args.actor, args.not_after_epoch)
    value = bundle.decode(raw)
    result = write_prepared(args.output, raw, "intake", value["run_key"])
    require_unexpired(value, int(time.time()))
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, bundle.subprocess.SubprocessError) as exc:
        reason = str(exc) if isinstance(exc, ValueError) and str(exc).startswith("ENGINE_") else type(exc).__name__
        raise SystemExit("engine image request refused: " + reason)
