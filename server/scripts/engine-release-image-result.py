#!/usr/bin/env python3
"""Pure terminal-record binding for image-request v2; no seal writer or authority.

The future existing-seal integration must create this envelope only while it
owns the same global engine/seal locks and has proved exact runtime recovery or
commit plus its audit. A v1 receipt cannot be promoted by filling in these fields.
This module deliberately has no CLI for recording a result or deleting state.
"""
import calendar
from datetime import datetime
import importlib.util
from pathlib import Path
import re

spec = importlib.util.spec_from_file_location(
    "image_request", Path(__file__).with_name("engine-release-image-request.py"))
request = importlib.util.module_from_spec(spec)
spec.loader.exec_module(request)
bundle = request.bundle
PROTOCOL = "club-arena-engine-image-result-v2"
FIELDS = {"protocol", "outcome", "run_key", "request_sha256", "intake_sha256", "source_sha",
          "control_sha", "image_authority_sha256", "attempted_image_id", "invocation_id",
          "runtime", "exit_status", "finished_at_epoch"}
RUNTIME_FIELDS = {"source_sha", "image_id", "container_id", "instance_id", "started_at"}


def require(ok, reason):
    if not ok:
        raise ValueError("ENGINE_IMAGE_RESULT_" + reason)


def validate_terminal(raw, release_raw, run_key, independent_release_digest):
    """Offline integrity/replay checks, not live proof or permission to clean up."""
    req = request.verify_bound_request(release_raw, "release", run_key, independent_release_digest)
    require(isinstance(raw, bytes) and 0 < len(raw) <= request.LIMIT, "SIZE")
    value = bundle.decode(raw)
    bundle.exact_keys(value, FIELDS, "V2_TERMINAL_SHAPE")
    require(value["protocol"] == PROTOCOL and value["outcome"] in {"published", "failed"}, "PROTOCOL")
    require(value["run_key"] == req["run_key"] and
            value["request_sha256"] == independent_release_digest and
            value["intake_sha256"] == req["intake_sha256"] and
            value["source_sha"] == req["source_sha"] and value["control_sha"] == req["control_sha"] and
            value["image_authority_sha256"] == request.digest(bundle.encode(req["image_authority"])) and
            value["attempted_image_id"] == req["image_authority"]["expected"]["identity"]["image_id"],
            "REQUEST_BINDING")
    require(bundle.hex_value(value["invocation_id"], 32) and
            type(value["finished_at_epoch"]) is int and 0 < value["finished_at_epoch"] <= 9999999999,
            "COMPLETION_IDENTITY")
    # Failure completion can occur after the mutation deadline during exact
    # desired restoration. This timestamp never creates a new mutation window.
    runtime = value["runtime"]
    bundle.exact_keys(runtime, RUNTIME_FIELDS, "TERMINAL_RUNTIME_SHAPE")
    require(bundle.hex_value(runtime["source_sha"], 40) and
            isinstance(runtime["image_id"], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", runtime["image_id"]) and
            bundle.hex_value(runtime["container_id"], 64) and
            isinstance(runtime["instance_id"], str) and re.fullmatch(r"[1-9][0-9]*-[0-9a-f]{8}", runtime["instance_id"]) and
            isinstance(runtime["started_at"], str) and
            re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z", runtime["started_at"]),
            "RUNTIME_IDENTITY")
    # Docker emits RFC3339 UTC with nanoseconds; completedAt is a whole
    # second. Compare that same precision without discarding the retained
    # original timestamp. Regex shape alone accepts impossible dates.
    try:
        started = datetime.strptime(runtime["started_at"][:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        raise ValueError("ENGINE_IMAGE_RESULT_RUNTIME_CALENDAR") from None
    started_epoch = calendar.timegm(started.timetuple())
    require(0 <= started_epoch <= value["finished_at_epoch"], "COMPLETION_ORDER")
    require(type(value["exit_status"]) is int, "EXIT_STATUS")
    if value["outcome"] == "published":
        require(value["exit_status"] == 0 and runtime["source_sha"] == req["source_sha"] and
                runtime["image_id"] == value["attempted_image_id"], "PUBLISHED_RUNTIME")
    else:
        require(1 <= value["exit_status"] <= 255 and value["exit_status"] != 75, "FAILURE_STATUS")
    require(raw == bundle.encode(value), "NONCANONICAL")
    return value


def decide_replay(raw, release_raw, run_key, independent_release_digest):
    """A terminal outcome is history, not proof the same runtime is still desired."""
    value = validate_terminal(raw, release_raw, run_key, independent_release_digest)
    return {"handoff": "completed", "outcome": value["outcome"], "request_sha256": value["request_sha256"],
            "new_transaction_authorized": False, "cleanup_authorized": False,
            "live_runtime_attested": False}
