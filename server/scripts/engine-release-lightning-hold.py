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
    pause   list every Cluster in cluster_mode 'lightning', pause each one
            through the operator door, and record WHICH ONES THIS RUN PAUSED
            in a durable hold file beside the release request. A Cluster
            that was already paused belongs to whoever paused it: it is
            recorded as `already` and is never resumed by this run.
    resume  resume exactly the Clusters the hold file says this run paused,
            then retire the hold file to `<run>.lightning-hold.released`.
            A Cluster that is no longer paused answers `already` and counts
            as released.
    status  print the hold file, if any, without touching the database.

Request ids are uuid5 of (run key, action, cluster), so a repeated call after
an unknown HTTP outcome replays the first answer instead of acting twice.

THREE OUTCOMES, NEVER TWO (CLAUDE.md 10.86 rule 1)
──────────────────────────────────────────────────
    0  DONE      every live Lightning Cluster is held (pause) / every held
                 Cluster is released (resume)
    1  PARTIAL   the door refused some Cluster with a named code (for example
                 CLUSTER_BUSY while a drain is in flight); the rest are held
                 or released, and the hold file says which
    3  UNKNOWN   could not tell: the database was unreachable, answered a
                 non-200, or returned a malformed body. On pause the hold
                 file still records every Cluster that WAS paused before the
                 failure, so a later resume releases them.

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
from pathlib import Path
import ssl
import sys
from typing import Callable, NoReturn
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

PROJECT_HOST = "kuklfnapbkmacvwxktbh.supabase.co"
HOLD_SCHEMA = "engine-release-lightning-hold/v1"
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


def request_id(run_id: str, action: str, cluster_id: str, generation: int = 1) -> str:
    """Stable per (run, hold generation, action, cluster). A release that waits
    through more than one qualifying break holds Lightning once per break;
    each hold is a new generation, because the door replays a repeated request
    id instead of acting on it."""
    suffix = "" if generation == 1 else f":{generation}"
    return str(uuid.uuid5(REQUEST_NAMESPACE, f"{run_id}:{action}:{cluster_id}{suffix}"))


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


def operator_control(base_url: str, call: Transport, run_id: str, action: str, cluster_id: str, generation: int = 1) -> dict:
    answer = call(
        f"{base_url}/rest/v1/rpc/fn_lightning_operator_control",
        {
            "p_cluster_id": cluster_id,
            "p_action": action,
            "p_reason": hold_reason(run_id, action),
            "p_args": {"request_id": request_id(run_id, action, cluster_id, generation)},
        },
    )
    if not isinstance(answer, dict) or not isinstance(answer.get("ok"), bool):
        raise Unknown(f"the operator door gave an unreadable answer for {action} {cluster_id}")
    return answer


def classify(answer: dict) -> str:
    """held / already / refused:<code> - one word per answer, never a guess."""
    if answer["ok"] is True:
        return "already" if answer.get("already") is True else "acted"
    code = answer.get("code")
    return f"refused:{code if isinstance(code, str) and code else 'UNNAMED'}"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_durable(path: Path, payload: dict) -> None:
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    data = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_hold(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Unknown(f"the hold file is unreadable: {exc}") from None
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != HOLD_SCHEMA
        or not isinstance(payload.get("held"), list)
        or not all(isinstance(item, str) for item in payload["held"])
    ):
        raise Unknown("the hold file does not carry the maintained contract")
    return payload


def pause(base_url: str, call: Transport, run_id: str, hold_file: Path) -> int:
    existing = read_hold(hold_file)
    if existing is not None and existing.get("run_id") != run_id:
        raise Unknown("the hold file belongs to a different run key")
    if existing is not None and not existing.get("unknown"):
        # Every Cluster was answered once already. A refused Cluster was busy
        # with its own drain; asking again inside the same break changes nothing.
        print(f"{LOG} this run already holds {len(existing['held'])} Lightning Cluster(s); nothing re-paused")
        return EXIT_PARTIAL if existing.get("refused") else EXIT_DONE

    clusters = list_lightning_clusters(base_url, call)
    generation = 1
    if existing is None:
        previous = read_hold(hold_file.with_name(hold_file.name + ".released"))
        if previous is not None and previous.get("run_id") == run_id:
            generation = int(previous.get("generation", 1)) + 1
    record: dict = existing or {
        "schema": HOLD_SCHEMA,
        "run_id": run_id,
        "generation": generation,
        "paused_at": now_iso(),
        "held": [],
        "already": [],
        "refused": {},
        "unknown": [],
    }
    generation = int(record.get("generation", 1))
    # A retry after an UNKNOWN answer picks up where the first call stopped.
    answered = set(record["held"]) | set(record.get("already", [])) | set(record.get("refused", {}))
    record["unknown"] = []
    try:
        for cluster in clusters:
            if cluster in answered:
                continue
            try:
                outcome = classify(operator_control(base_url, call, run_id, "pause", cluster, generation))
            except Unknown:
                # Everything paused so far is recorded before the refusal
                # propagates, so resume can still release it.
                record["unknown"].append(cluster)
                raise
            if outcome == "acted":
                record["held"].append(cluster)
            elif outcome == "already":
                record["already"].append(cluster)
            else:
                record["refused"][cluster] = outcome.split(":", 1)[1]
    finally:
        if clusters:
            write_durable(hold_file, record)

    print(
        f"{LOG} Lightning held for release {run_id}: {len(record['held'])} paused, "
        f"{len(record['already'])} already paused by another operator, "
        f"{len(record['refused'])} refused, of {len(clusters)} live Cluster(s)"
    )
    for cluster, code in record["refused"].items():
        print(f"{LOG}   refused {cluster}: {code}", file=sys.stderr)
    if not clusters:
        print(f"{LOG} no Cluster is in Lightning mode; nothing to hold")
    return EXIT_PARTIAL if record["refused"] else EXIT_DONE


def resume(base_url: str, call: Transport, run_id: str, hold_file: Path) -> int:
    record = read_hold(hold_file)
    if record is None:
        print(f"{LOG} no Lightning hold is recorded for release {run_id}; nothing to resume")
        return EXIT_DONE
    if record.get("run_id") != run_id:
        raise Unknown("the hold file belongs to a different run key")

    released: list[str] = []
    refused: dict[str, str] = {}
    generation = int(record.get("generation", 1))
    for cluster in record["held"]:
        outcome = classify(operator_control(base_url, call, run_id, "resume", cluster, generation))
        if outcome in ("acted", "already"):
            released.append(cluster)
        else:
            refused[cluster] = outcome.split(":", 1)[1]
    record["resumed_at"] = now_iso()
    record["released"] = released
    record["resume_refused"] = refused
    if refused:
        # Keep the hold on disk so the next reader tries again.
        write_durable(hold_file, record)
        for cluster, code in refused.items():
            print(f"{LOG}   resume refused {cluster}: {code}", file=sys.stderr)
        print(f"{LOG} Lightning partly released for release {run_id}: {len(released)} resumed, {len(refused)} refused")
        return EXIT_PARTIAL
    released_file = hold_file.with_name(hold_file.name + ".released")
    write_durable(released_file, record)
    hold_file.unlink()
    fd = os.open(hold_file.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    print(f"{LOG} Lightning released for release {run_id}: {len(released)} Cluster(s) resumed")
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
