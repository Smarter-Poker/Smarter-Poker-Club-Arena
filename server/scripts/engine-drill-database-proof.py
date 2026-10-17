#!/usr/bin/env python3
"""Read-only database witness for a controlled engine crash drill.

The crash drill kills the serving engine inside a certified scheduled break and
lets the production supervisor restart the same sealed image. The process that
comes back must be proved from the database, not from its own /health:

  * engine_leader names the RECOVERED instance with a fresh heartbeat;
  * engine_maintenance_break_log has this exact break, written at its end by
    the serving release, with thaw_ok = true;
  * engine_maintenance_thaws shows the freeze for this break was thawed;
  * hand_history shows hands dealt after that thaw on several tables.

Every read is a service-role GET through PostgREST to the one pinned project
host. Nothing is written. An unreadable or partial answer is a refusal, never a
pass. The verdict is one JSON object on stdout; exit 0 only when every witness
agrees.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import ssl
import sys
import time
from typing import Any, Callable, NoReturn
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
INSTANCE_RE = re.compile(r"^[1-9][0-9]*-[0-9a-f]{8}$")
PROJECT_HOST = "kuklfnapbkmacvwxktbh.supabase.co"
# A break row is written at MaintenanceBreak.end() with the break's own start
# instant; the scheduled start is breakEndsAt minus the five-minute countdown.
# Allow the observed few milliseconds of skew, never a different break.
BREAK_MATCH_TOLERANCE_SECONDS = 5
# Read at most this many post-thaw hands; the floor is far below it.
HAND_SAMPLE_LIMIT = 500


def die(message: str) -> NoReturn:
    print(f"[engine-drill-database-proof] FATAL: {message}", file=sys.stderr)
    raise SystemExit(1)


class RefuseRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


def read_fixed_env(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        die(f"cannot read the fixed engine environment: {exc}")
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
            die(f"{key} contains a control character")
        values[key] = value
    return values


def parse_time(value: object) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError("missing timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


Fetch = Callable[[str, dict[str, str]], Any]


def rest_fetcher(base_url: str, service_key: str, socket_timeout: float) -> Fetch:
    opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), RefuseRedirects())

    def fetch(table: str, query: dict[str, str]) -> Any:
        request = Request(
            f"{base_url}/rest/v1/{table}?{urlencode(query)}",
            headers={
                "apikey": service_key,
                "authorization": f"Bearer {service_key}",
                "accept": "application/json",
                "cache-control": "no-cache, no-store",
            },
            method="GET",
        )
        with opener.open(request, timeout=socket_timeout) as response:
            payload = response.read(2_000_001)
        if len(payload) > 2_000_000:
            raise ValueError(f"{table} response exceeds its bounded read")
        return json.loads(payload.decode("utf-8"))

    return fetch


def evaluate(
    fetch: Fetch,
    *,
    sha: str,
    instance_id: str,
    break_started_at: datetime,
    max_heartbeat_age_seconds: float,
    min_hands: int,
    min_tables: int,
    now: datetime,
) -> dict[str, Any]:
    """One complete read of every witness. Raises ValueError on any gap."""
    verdict: dict[str, Any] = {"sha": sha, "instanceId": instance_id}

    leader = fetch(
        "engine_leader",
        {"select": "engine_version,instance_id,heartbeat_at", "id": "eq.true", "limit": "1"},
    )
    if not isinstance(leader, list) or len(leader) != 1 or not isinstance(leader[0], dict):
        raise ValueError("engine_leader did not return exactly one row")
    row = leader[0]
    age = (now - parse_time(row.get("heartbeat_at"))).total_seconds()
    verdict["leader"] = {
        "instanceId": row.get("instance_id"),
        "engineVersion": row.get("engine_version"),
        "heartbeatAgeSeconds": round(age, 3),
    }
    if row.get("instance_id") != instance_id:
        raise ValueError("the elected leader is not the recovered instance")
    if age < -5 or age > max_heartbeat_age_seconds:
        raise ValueError("the recovered leader heartbeat is not fresh")

    low = break_started_at - timedelta(seconds=BREAK_MATCH_TOLERANCE_SECONDS)
    high = break_started_at + timedelta(seconds=BREAK_MATCH_TOLERANCE_SECONDS)
    window = [f"gte.{iso(low)}", f"lte.{iso(high)}"]

    breaks = fetch(
        "engine_maintenance_break_log",
        {
            "select": "break_started_at,break_ended_at,thaw_ok,engine_version,tables_resumed",
            "and": f"(break_started_at.{window[0]},break_started_at.{window[1]})",
            "limit": "2",
        },
    )
    if not isinstance(breaks, list) or len(breaks) != 1 or not isinstance(breaks[0], dict):
        raise ValueError("the drilled break has not recorded exactly one outcome row")
    outcome = breaks[0]
    verdict["breakOutcome"] = outcome
    if outcome.get("thaw_ok") is not True:
        raise ValueError("the drilled break did not record thaw_ok = true")
    if outcome.get("engine_version") not in {sha, sha[:8]}:
        raise ValueError("the drilled break outcome was recorded by another release")

    thaws = fetch(
        "engine_maintenance_thaws",
        {
            "select": "freeze_started_at,thawed_at,thawed_by,frozen_seconds",
            "and": f"(freeze_started_at.{window[0]},freeze_started_at.{window[1]})",
            "limit": "2",
        },
    )
    if not isinstance(thaws, list) or len(thaws) != 1 or not isinstance(thaws[0], dict):
        raise ValueError("the drilled break does not have exactly one freeze row")
    thaw = thaws[0]
    verdict["thaw"] = thaw
    thawed_at = parse_time(thaw.get("thawed_at"))

    hands = fetch(
        "hand_history",
        {
            "select": "table_id,created_at",
            "created_at": f"gt.{iso(thawed_at)}",
            "order": "created_at.asc",
            "limit": str(HAND_SAMPLE_LIMIT),
        },
    )
    if not isinstance(hands, list):
        raise ValueError("hand_history did not return a list")
    tables = {str(hand.get("table_id")) for hand in hands if isinstance(hand, dict) and hand.get("table_id")}
    verdict["handsAfterThaw"] = {"sampled": len(hands), "tables": len(tables), "limit": HAND_SAMPLE_LIMIT}
    if len(hands) < min_hands or len(tables) < min_tables:
        raise ValueError(
            f"hand progression after the thaw is {len(hands)} hands on {len(tables)} tables, "
            f"below {min_hands} hands on {min_tables} tables"
        )
    return verdict


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--break-started-at-ms", type=int, required=True)
    parser.add_argument("--min-hands", type=int, default=20)
    parser.add_argument("--min-tables", type=int, default=5)
    parser.add_argument("--max-heartbeat-age-seconds", type=int, default=15)
    parser.add_argument("--timeout-seconds", type=int, default=240)
    parser.add_argument("--poll-seconds", type=int, default=10)
    args = parser.parse_args()

    if not SHA_RE.fullmatch(args.sha):
        die("expected SHA is invalid")
    if not INSTANCE_RE.fullmatch(args.instance_id):
        die("recovered instance id is invalid")
    if not 1 <= args.min_hands <= HAND_SAMPLE_LIMIT or not 1 <= args.min_tables <= args.min_hands:
        die("hand progression floors are invalid")
    if not 1 <= args.max_heartbeat_age_seconds <= 60:
        die("heartbeat age limit is invalid")
    if not 1 <= args.timeout_seconds <= 600 or not 1 <= args.poll_seconds <= 30:
        die("timeout or poll interval is invalid")
    if not 1_700_000_000_000 < args.break_started_at_ms < 4_000_000_000_000:
        die("break start is invalid")

    env = read_fixed_env(Path(args.env_file))
    base_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or parsed.hostname != PROJECT_HOST or parsed.path not in {"", "/"}:
        die("SUPABASE_URL is not the pinned Club Arena project")
    if not service_key:
        die("SUPABASE_SERVICE_ROLE_KEY is absent")

    fetch = rest_fetcher(base_url, service_key, 10.0)
    break_started_at = datetime.fromtimestamp(args.break_started_at_ms / 1000, tz=timezone.utc)
    deadline = time.monotonic() + args.timeout_seconds
    last_error = "no read completed"
    while True:
        try:
            verdict = evaluate(
                fetch,
                sha=args.sha,
                instance_id=args.instance_id,
                break_started_at=break_started_at,
                max_heartbeat_age_seconds=args.max_heartbeat_age_seconds,
                min_hands=args.min_hands,
                min_tables=args.min_tables,
                now=datetime.now(timezone.utc),
            )
            print(json.dumps(verdict, sort_keys=True, default=str))
            return
        except Exception as exc:  # every gap is retried inside the bound, then refused
            last_error = str(exc) or type(exc).__name__
        if time.monotonic() + args.poll_seconds > deadline:
            die(f"the database did not witness a complete recovery: {last_error}")
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    main()
