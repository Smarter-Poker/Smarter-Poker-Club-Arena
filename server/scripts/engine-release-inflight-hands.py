#!/usr/bin/env python3
"""Ask the DATABASE whether any hand is actually in the air.

WHY THIS EXISTS (2026-09-21)
────────────────────────────
The release gate used to ask process memory one question - "did every engine
object report itself parked" - and treat any other answer as "a hand may be in
flight". Those are not the same question, and on 2026-09-18 the difference
froze the platform: engine 8825af51 held a tournament hand permit that could
never resolve inside that process, so `readyForRestart` stayed shut for 70 of
the 71 breaks it lived through, and the build that fixes the permit could not
be deployed, because deploying requires the restart the permit was blocking.

A permit that can never resolve is not a hand in the air. The database can say
which of the two it is, independently of any bug in the engine holding it, so
that is who the gate asks when process memory refuses for that reason.

WHAT COUNTS AS A HAND IN THE AIR
────────────────────────────────
An incomplete `hand_state_snapshots` row that has been WRITTEN TO RECENTLY.

Both halves are load-bearing, and the second one is the whole design. Measured
on production 2026-09-21: 2,553 incomplete snapshot rows exist, the oldest
last touched on 2026-08-22. Gating on "an incomplete snapshot exists" would
therefore refuse every cutover for ever - the same forever-block this file was
written to end, one level up (CLAUDE.md 10.86 rule 4). A hand is in flight
when its row is still MOVING.

THE THRESHOLD, DERIVED AND NOT GUESSED (CLAUDE.md 10.84)
─────────────────────────────────────────────────────────
Age of every incomplete snapshot on a non-closed table, production,
2026-09-21 07:3x UTC, against /health reporting handsInFlightTotal = 40:

    <= 30s    28          <= 300s   36
    <= 60s    36          <= 600s   36
    <= 120s   36           > 600s  539

The band between 60s and 600s is EMPTY: live hands cluster under a minute,
corpses are hours to weeks old, and nothing lives in between. Any threshold in
that gap classifies identically, so the choice is insensitive by construction.
120s is used - twice the observed live ceiling, a fifth of the corpse floor.
Deliberately NOT set to the 60s ceiling that was just measured: a budget equal
to the number you read has no headroom (CLAUDE.md 10.86 rule 4).

WHY A SNAPSHOT IS SUFFICIENT EVIDENCE HERE
──────────────────────────────────────────
Only inside a certified countdown. From :53 every table is told to finish its
hand and no new hand may be dealt, and the caller has already proved
phase == counting_down and durableConfirmed before this runs. So the case a
snapshot read could otherwise miss - a hand dealt just now whose first write
has not landed - cannot arise: nothing is being dealt. The caller additionally
requires the engine's own handsInFlightTotal to be 0, so this is the second of
two independent witnesses, not the only one.

THREE OUTCOMES, NEVER TWO (CLAUDE.md 10.86 rule 1)
──────────────────────────────────────────────────
    0  QUIET    - no hand in the air. The caller may proceed.
    1  IN AIR   - at least one. The caller must refuse.
    3  UNKNOWN  - could not tell. The caller must refuse.

UNKNOWN is never folded into QUIET. An unreadable database, an HTTP error, a
malformed body, a truncated page: each is a refusal, not an empty list
(CLAUDE.md 10.86 rule 2). There is no flag, environment variable or argument
that turns a refusal into permission - that is the point of the file.

It reads the engine's own fixed environment file, talks only to the pinned
project, follows no redirect, and never prints or exports a credential.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import ssl
import sys
from typing import NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

PROJECT_HOST = "kuklfnapbkmacvwxktbh.supabase.co"

# See "THE THRESHOLD" above. Measured, with the measurement kept beside it.
DEFAULT_MAX_AGE_SECONDS = 120

# A bound on the page this gate will consider. Exceeding it means the answer
# did not fit in one read, which is UNKNOWN, not "these are all of them".
ROW_LIMIT = 500

EXIT_QUIET = 0
EXIT_HAND_IN_AIR = 1
EXIT_UNKNOWN = 3


class RefuseRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


def unknown(message: str) -> NoReturn:
    """Could not tell. Distinct from both answers, and always a refusal."""
    print(f"[engine-release-inflight-hands] UNKNOWN: {message}", file=sys.stderr)
    raise SystemExit(EXIT_UNKNOWN)


def read_fixed_env(path: Path) -> dict[str, str]:
    """Read only the two keys needed, from the engine's own environment file."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        unknown(f"cannot read the fixed engine environment: {exc}")

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
            unknown(f"{key} contains a control character")
        values[key] = value
    return values


def get_json(url: str, service_key: str, timeout_seconds: float) -> object:
    request = Request(
        url,
        headers={
            "apikey": service_key,
            "authorization": f"Bearer {service_key}",
            "accept": "application/json",
            "cache-control": "no-cache, no-store",
        },
    )
    opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), RefuseRedirects())
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            # res.ok first, every time. A non-200 body is never parsed as data.
            if response.status != 200:
                unknown(f"the database answered HTTP {response.status}")
            payload = response.read(4_000_001)
    except HTTPError as exc:
        unknown(f"the database answered HTTP {exc.code}")
    except (URLError, TimeoutError, OSError) as exc:
        unknown(f"the database could not be reached: {exc}")
    if len(payload) > 4_000_000:
        unknown("the response exceeded its bounded size")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        unknown(f"the response was not readable JSON: {exc}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--max-age-seconds", type=int, default=DEFAULT_MAX_AGE_SECONDS)
    parser.add_argument("--timeout-seconds", type=float, default=8.0)
    args = parser.parse_args()

    if not 30 <= args.max_age_seconds <= 600:
        unknown("the freshness window must stay inside its measured band")

    env = read_fixed_env(Path(args.env_file))
    base_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not service_key:
        unknown("the engine environment does not carry the database identity")
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or parsed.hostname != PROJECT_HOST:
        unknown("the engine environment does not point at the pinned project")

    since = datetime.now(timezone.utc) - timedelta(seconds=args.max_age_seconds)
    query = urlencode(
        {
            "select": "table_id,hand_number,stage,updated_at",
            "is_complete": "eq.false",
            "updated_at": f"gte.{since.isoformat()}",
            "order": "updated_at.desc",
            "limit": str(ROW_LIMIT),
        }
    )
    rows = get_json(f"{base_url}/rest/v1/hand_state_snapshots?{query}", service_key, args.timeout_seconds)

    if not isinstance(rows, list):
        unknown("the in-flight read did not return a list of rows")
    if len(rows) >= ROW_LIMIT:
        unknown(f"the in-flight read filled its {ROW_LIMIT}-row page; the answer is not complete")

    # Deliberately NOT filtered by table status. Counting a snapshot the gate
    # could have excluded can only make it refuse, which is the safe direction;
    # excluding one wrongly would let a live hand through. Freshness alone is
    # the discriminator, and a closed table stops updating within the window.
    if rows:
        print(
            f"[engine-release-inflight-hands] {len(rows)} hand(s) in the air within "
            f"{args.max_age_seconds}s - refusing the cutover:",
            file=sys.stderr,
        )
        for row in rows[:20]:
            if not isinstance(row, dict):
                unknown("the in-flight read returned a malformed row")
            print(
                f"  table={row.get('table_id')} hand={row.get('hand_number')} "
                f"stage={row.get('stage')} updated_at={row.get('updated_at')}",
                file=sys.stderr,
            )
        raise SystemExit(EXIT_HAND_IN_AIR)

    # QUIET still writes to stderr, like every other outcome in this file.
    # The caller invokes this script directly inside a command substitution
    # that captures its OWN stdout as a numeric return value
    # (engine-release-transaction.sh's `maintenance_certificate`); a stdout
    # line here has nothing to do with that value and would concatenate into
    # it, which is exactly what happened before this fix (see the paired
    # bash correction in engine-release-transaction.sh's inflight_rc==0
    # branch).
    print(
        f"[engine-release-inflight-hands] no hand in the air: zero incomplete hand "
        f"snapshots written in the last {args.max_age_seconds}s",
        file=sys.stderr,
    )
    raise SystemExit(EXIT_QUIET)


if __name__ == "__main__":
    main()
