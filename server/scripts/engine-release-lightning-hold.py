#!/usr/bin/env python3
"""Hold Lightning for the engine cutover, and let it go after the thaw.

WHY THIS EXISTS (2026-10-30)
────────────────────────────
The legacy one-shot checkpoint that replaces an original engine refuses with
`retained_lightning_host_census_unproven` while a single concrete
LightningHandHost is alive in the old process. Lightning deals roughly 5,600
hands an hour across eleven Clusters, so at any instant a host is nearly
always in the air, and the 15:55 UTC attempt on 2026-10-30 was refused for
exactly that reason. The maintenance break parks classic tables at a hand
boundary; nothing parked Lightning, because its hands are formed by the
Clusters' workers, not by table engines.

Phase 13 already built the door for this: `fn_lightning_operator_control(
cluster, 'pause', reason, {request_id})`. A paused Cluster forms no new hand,
a hand already dealing plays out and settles, a formation not yet dealt is
void with no chip moved, and `resume` returns the Cluster to exactly the mode
it was paused from. This helper is the release transaction using that door,
with the release's own run key as the operator and the reason.

WHAT IT DOES
────────────
    pause   persist a v2 candidate journal, then persist each pending original
            request BEFORE sending it. Persist every bound answer separately.
            A repeated pausing invocation resolves exact original IDs, even if
            the committed pause no longer appears in the Lightning census.
    resume  durably enter cleanup, resolve pending pause outcomes WITHOUT
            creating a missing pause, and resume only positively owned holds.
            Each resume carries its original expected pause request ID, checked
            under the database Cluster lock. A later foreign hold is refused.
    status  print the selected journal without touching the database.

Request IDs remain uuid5 of (run key, action, cluster). Resolve-only answers
are bound to that exact request; absent, in-progress, malformed and transport
unknown outcomes retain the journal. Cleanup cannot restart pause work. A
missing original resume may continue with the SAME request ID and atomic pause
owner comparison; it cannot remove a foreign hold. Definite refused requests
keep their original answer rather than retrying them as a different outcome.

THREE OUTCOMES, NEVER TWO (CLAUDE.md 10.86 rule 1)
──────────────────────────────────────────────────
    0  DONE      every candidate answered (pause), or every positively owned
                 hold released with no pending unknown (resume)
    1  PARTIAL   a definite refusal is durably retained
    3  UNKNOWN   a pending or unproved outcome remains; the journal is retained
                 and is never retired as released

The v2 journal is persisted before each operator mutation and after every
answer. Unqualified v1 files remain UNKNOWN; they are never guessed into new
ownership. The resolve-only API must be installed before any new mutation.

It reads the engine's own fixed environment file, talks only to the pinned
project, follows no redirect, and never prints or exports a credential. It
never pauses a Cluster in 'must_move', 'pending_*' or 'draining': those form
no Lightning hand, and the door refuses the busy ones on its own.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import re
import stat
from pathlib import Path
import ssl
import sys
from typing import Callable
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

PROJECT_HOST = "kuklfnapbkmacvwxktbh.supabase.co"
HOLD_SCHEMA = "engine-release-lightning-hold/v2"
# Eleven Clusters today; a page that fills means the answer is incomplete.
CLUSTER_LIMIT = 200
REQUEST_NAMESPACE = uuid.UUID("5f0c8a1e-6d3b-4b0e-9d1a-2f7c4e9b8a10")

EXIT_DONE = 0
EXIT_PARTIAL = 1
EXIT_UNKNOWN = 3

LOG = "[engine-release-lightning-hold]"


class RefuseRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


class Unknown(Exception):
    """Could not tell. Distinct from both answers, and always a refusal."""


def read_fixed_env(path: Path) -> dict[str, str]:
    """Read only the two keys needed, from the engine's own environment file."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise Unknown(f"cannot read the fixed engine environment: {exc}") from None

    values: dict[str, str] = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in {"SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"}:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if "\n" in value or "\r" in value:
            raise Unknown(f"{key} contains a control character")
        values[key] = value
    return values


def database_identity(env_file: Path) -> tuple[str, str]:
    env = read_fixed_env(env_file)
    base_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not service_key:
        raise Unknown("the engine environment does not carry the database identity")
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or parsed.hostname != PROJECT_HOST:
        raise Unknown("the engine environment does not point at the pinned project")
    return base_url, service_key


Transport = Callable[[str, dict | None], object]


def https_transport(service_key: str, timeout_seconds: float) -> Transport:
    """The one real transport. Tests substitute a fake with the same shape."""

    def call(url: str, payload: dict | None) -> object:
        request = Request(
            url,
            data=None if payload is None else json.dumps(payload).encode("utf-8"),
            headers={
                "apikey": service_key,
                "authorization": f"Bearer {service_key}",
                "accept": "application/json",
                "content-type": "application/json",
                "cache-control": "no-cache, no-store",
            },
            method="GET" if payload is None else "POST",
        )
        opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), RefuseRedirects())
        try:
            with opener.open(request, timeout=timeout_seconds) as response:
                # res.ok first, every time. A non-200 body is never parsed as data.
                if response.status != 200:
                    raise Unknown(f"the database answered HTTP {response.status}")
                body = response.read(1_000_001)
        except HTTPError as exc:
            raise Unknown(f"the database answered HTTP {exc.code}") from None
        except (URLError, TimeoutError, OSError) as exc:
            raise Unknown(f"the database could not be reached: {exc}") from None
        if len(body) > 1_000_000:
            raise Unknown("the response exceeded its bounded size")
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise Unknown(f"the response was not readable JSON: {exc}") from None

    return call


def request_id(run_id: str, action: str, cluster_id: str) -> str:
    return str(uuid.uuid5(REQUEST_NAMESPACE, f"{run_id}:{action}:{cluster_id}"))


def hold_reason(run_id: str, action: str) -> str:
    if action == "pause":
        return (
            f"engine release {run_id}: Lightning held for the maintenance cutover; "
            "hands in the air settle, undealt formations are void, resumed after the thaw"
        )
    return f"engine release {run_id}: maintenance cutover finished; Lightning resumes"


def list_lightning_clusters(base_url: str, call: Transport) -> list[str]:
    query = urlencode(
        {
            "select": "id,cluster_mode",
            "cluster_mode": "eq.lightning",
            "order": "id.asc",
            "limit": str(CLUSTER_LIMIT + 1),
        }
    )
    rows = call(f"{base_url}/rest/v1/cash_games?{query}", None)
    if not isinstance(rows, list):
        raise Unknown("the Cluster read did not return a list of rows")
    if len(rows) > CLUSTER_LIMIT:
        raise Unknown(f"the Cluster read exceeded {CLUSTER_LIMIT} rows; the answer is not complete")
    ids: list[str] = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise Unknown("the Cluster read returned a malformed row")
        try:
            uuid.UUID(row["id"])
        except ValueError:
            raise Unknown("the Cluster read returned a non-uuid id") from None
        if row.get("cluster_mode") != "lightning":
            raise Unknown("the Cluster read returned a Cluster outside the asked mode")
        ids.append(row["id"])
    return ids


def operator_control(base_url: str, call: Transport, run_id: str, action: str, cluster_id: str) -> dict:
    payload = {
        "p_cluster_id": cluster_id,
        "p_action": action,
        "p_reason": hold_reason(run_id, action),
        "p_args": {"request_id": request_id(run_id, action, cluster_id)},
    }
    if action == "resume":
        payload["p_args"]["expected_pause_request_id"] = request_id(run_id, "pause", cluster_id)
    answer = call(f"{base_url}/rest/v1/rpc/fn_lightning_operator_control", payload)
    if not isinstance(answer, dict) or not isinstance(answer.get("ok"), bool):
        raise Unknown(f"the operator door gave an unreadable answer for {action} {cluster_id}")
    return answer


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_durable(path: Path, payload: dict) -> None:
    temporary = path.with_name(path.name + f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as handle:
                handle.write(data)
                handle.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        raise Unknown("the hold journal could not be made durable") from None
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def cluster_ids(value: object) -> bool:
    return (isinstance(value, list) and len(value) <= CLUSTER_LIMIT
            and all(isinstance(v, str) and re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", v) for v in value)
            and len(set(value)) == len(value))


def read_hold(path: Path) -> dict | None:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise Unknown("the hold journal is unsafe or unreadable") from None
    try:
        metadata = os.fstat(fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > 262144):
            raise Unknown("the hold journal identity or size is unproved")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            raw = handle.read(262145)
        if len(raw) > 262144:
            raise Unknown("the hold journal exceeded its bound")
        payload = json.loads(raw)
    except (OSError, ValueError, UnicodeError):
        raise Unknown("the hold journal is unreadable") from None
    finally:
        os.close(fd)
    lists = ("candidates", "held", "already", "unknown", "resume_pending", "released")
    if (not isinstance(payload, dict) or payload.get("schema") != HOLD_SCHEMA
            or not re.fullmatch(r"[1-9][0-9]*(?:-[1-9][0-9]*)?", str(payload.get("run_id", "")))
            or payload.get("phase") not in {"pausing", "resuming", "released"}
            or not all(cluster_ids(payload.get(k)) for k in lists)
            or not all(isinstance(payload.get(k), dict) and len(payload[k]) <= CLUSTER_LIMIT
                       and all(isinstance(v, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", v)
                               for v in payload[k].values()) for k in ("refused", "resume_refused"))):
        raise Unknown("the hold file does not carry the maintained contract")
    candidates, held = set(payload["candidates"]), set(payload["held"])
    pause_sets = [set(payload[k]) for k in ("held", "already", "unknown", "refused")]
    resume_sets = [set(payload[k]) for k in ("resume_pending", "released", "resume_refused")]
    if (any(not values <= candidates for values in pause_sets)
            or sum(map(len, pause_sets)) != len(set().union(*pause_sets))
            or any(not values <= held for values in resume_sets)
            or sum(map(len, resume_sets)) != len(set().union(*resume_sets))
            or (payload["phase"] == "pausing" and any(resume_sets))
            or (payload["phase"] == "released" and (payload["unknown"]
                or held != set(payload["released"]) or payload["resume_refused"]))):
        raise Unknown("the hold journal outcomes are inconsistent")
    return payload


def own_record(hold_file: Path, run_id: str) -> dict | None:
    if not re.fullmatch(r"[1-9][0-9]*(?:-[1-9][0-9]*)?", run_id):
        raise Unknown("invalid release run key")
    record = read_hold(hold_file)
    if record is not None and record["run_id"] != run_id:
        raise Unknown("the hold file belongs to a different run key")
    return record


def retained_answer(answer: object, run_id: str, action: str, cluster: str) -> str:
    if (not isinstance(answer, dict) or type(answer.get("ok")) is not bool
            or answer.get("request_id") != request_id(run_id, action, cluster)
            or answer.get("action") != action or answer.get("cluster_id") != cluster):
        raise Unknown("the operator answer is not bound to this original request")
    if answer["ok"] is True:
        if "already" in answer and type(answer["already"]) is not bool:
            raise Unknown("the operator answer has an invalid ownership predicate")
        return "already" if answer.get("already") is True else "acted"
    code = answer.get("code")
    if code == "REQUEST_IN_PROGRESS":
        raise Unknown("the original operator request is still in progress")
    if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", code):
        raise Unknown("the operator refusal is not a bounded code")
    return "refused:" + code


def resolve_outcome(base_url: str, call: Transport, run_id: str, action: str, cluster: str) -> str | None:
    # An exact missing answer proves API support, never absence of a pause's
    # historical effects. Only phase=pausing may execute that original pause.
    args = {"request_id": request_id(run_id, action, cluster), "expected_action": action}
    if action == "resume":
        args["expected_pause_request_id"] = request_id(run_id, "pause", cluster)
    response = call(f"{base_url}/rest/v1/rpc/fn_lightning_operator_control", {
        "p_cluster_id": cluster, "p_action": "resolve_release_hold",
        "p_reason": hold_reason(run_id, "resume"), "p_args": args,
    })
    if (not isinstance(response, dict)
            or response.get("request_id") != request_id(run_id, action, cluster)
            or response.get("action") != action or response.get("cluster_id") != cluster):
        raise Unknown("the original operator outcome remains unknown")
    if (response.get("ok") is False and response.get("resolved") is False
            and response.get("code") == "REQUEST_OUTCOME_UNKNOWN" and "answer" not in response):
        return None
    if response.get("ok") is not True or response.get("resolved") is not True:
        raise Unknown("the original operator outcome remains unknown")
    return retained_answer(response.get("answer"), run_id, action, cluster)


def save_pause_answer(record: dict, cluster: str, outcome: str, hold_file: Path) -> None:
    record["unknown"].remove(cluster)
    if outcome == "acted":
        record["held"].append(cluster)
    elif outcome == "already":
        record["already"].append(cluster)
    else:
        record["refused"][cluster] = outcome.split(":", 1)[1]
    write_durable(hold_file, record)


def pause(base_url: str, call: Transport, run_id: str, hold_file: Path) -> int:
    record = own_record(hold_file, run_id)
    if record is None:
        if read_hold(hold_file.with_name(hold_file.name + ".released")) is not None:
            raise Unknown("this release already finished its Lightning hold")
        clusters = list_lightning_clusters(base_url, call)
        if not clusters:
            return EXIT_DONE
        if not cluster_ids(clusters):
            raise Unknown("the Cluster census has duplicate or invalid identities")
        record = {"schema": HOLD_SCHEMA, "run_id": run_id, "phase": "pausing",
                  "paused_at": now_iso(), "candidates": clusters, "held": [], "already": [],
                  "refused": {}, "unknown": [], "resume_pending": [], "released": [],
                  "resume_refused": {}}
        write_durable(hold_file, record)
    if record["phase"] != "pausing":
        raise Unknown("release cleanup has begun; no new pause may be sent")
    # Resume exact pending requests even if their committed mode no longer
    # appears in a fresh Lightning census. Never add another candidate here.
    answered = set(record["held"]) | set(record["already"]) | set(record["refused"])
    for cluster in record["candidates"]:
        if cluster in answered:
            continue
        if cluster not in record["unknown"]:
            record["unknown"].append(cluster)
            write_durable(hold_file, record)
        # The resolve-only contract also refuses an old uninstalled API before
        # any state change. A pending commit is read even if its mode changed.
        outcome = resolve_outcome(base_url, call, run_id, "pause", cluster)
        if outcome is None:
            outcome = retained_answer(operator_control(base_url, call, run_id, "pause", cluster),
                                      run_id, "pause", cluster)
        save_pause_answer(record, cluster, outcome, hold_file)
    print(f"{LOG} Lightning hold recorded: {len(record['held'])} owned, "
          f"{len(record['already'])} foreign, {len(record['refused'])} refused")
    return EXIT_PARTIAL if record["refused"] else EXIT_DONE


def resume(base_url: str, call: Transport, run_id: str, hold_file: Path) -> int:
    record = own_record(hold_file, run_id)
    if record is None:
        return EXIT_DONE
    if record["phase"] != "resuming":
        record["phase"] = "resuming"
        write_durable(hold_file, record)
    unresolved = False
    for cluster in list(record["unknown"]):
        try:
            outcome = resolve_outcome(base_url, call, run_id, "pause", cluster)
            if outcome is None:
                raise Unknown("the original pause outcome remains unknown")
        except Unknown:
            unresolved = True
            continue
        save_pause_answer(record, cluster, outcome, hold_file)
    for cluster in record["held"]:
        if cluster in record["released"] or cluster in record["resume_refused"]:
            continue
        try:
            outcome = resolve_outcome(base_url, call, run_id, "resume", cluster)
            if outcome is None:
                if cluster not in record["resume_pending"]:
                    record["resume_pending"].append(cluster)
                    write_durable(hold_file, record)
                # Reissue only this exact original resume, guarded atomically
                # by its expected pause owner; never recreate a missing pause.
                outcome = retained_answer(operator_control(base_url, call, run_id, "resume", cluster),
                                          run_id, "resume", cluster)
            elif cluster not in record["resume_pending"]:
                # A response exists but this journal never recorded the send.
                raise Unknown("an unjournaled resume outcome cannot be adopted")
        except Unknown:
            unresolved = True
            continue
        record["resume_pending"].remove(cluster)
        if outcome in ("acted", "already"):
            record["released"].append(cluster)
        else:
            record["resume_refused"][cluster] = outcome.split(":", 1)[1]
        write_durable(hold_file, record)
    if unresolved or record["unknown"] or record["resume_pending"]:
        raise Unknown("the hold has unresolved original requests; journal retained")
    if record["resume_refused"]:
        return EXIT_PARTIAL
    record["resumed_at"] = now_iso()
    record["phase"] = "released"
    released_file = hold_file.with_name(hold_file.name + ".released")
    write_durable(released_file, record)
    hold_file.unlink()
    fd = os.open(hold_file.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    print(f"{LOG} Lightning hold released: {len(record['released'])} owned Cluster(s)")
    return EXIT_DONE


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["pause", "resume", "status"])
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--hold-file", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=8.0)
    args = parser.parse_args(argv)

    hold_file = Path(args.hold_file)
    if args.action == "status":
        try:
            record = read_hold(hold_file)
        except Unknown as exc:
            print(f"{LOG} UNKNOWN: {exc}", file=sys.stderr)
            return EXIT_UNKNOWN
        print(json.dumps(record, indent=2, sort_keys=True))
        return EXIT_DONE

    try:
        base_url, service_key = database_identity(Path(args.env_file))
        call = https_transport(service_key, args.timeout_seconds)
        if args.action == "pause":
            return pause(base_url, call, args.run_id, hold_file)
        return resume(base_url, call, args.run_id, hold_file)
    except Unknown as exc:
        print(f"{LOG} UNKNOWN: {exc}", file=sys.stderr)
        return EXIT_UNKNOWN


if __name__ == "__main__":
    raise SystemExit(main())
