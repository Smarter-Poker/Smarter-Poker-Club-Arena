#!/usr/bin/env python3
"""Prove that the elected engine leader wrote the requested release.

This runs only inside the root-owned one-shot release transaction. It reads the
engine's fixed environment file itself, never exports or prints credentials,
and talks only to the pinned Club Arena Supabase project. HTTP health is not a
substitute for this witness: the elected leader row is the independent write
that makes a compatibility trial eligible for the durable release seal.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import ssl
import sys
import time
from typing import NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener


SHA_RE = re.compile(r"^[0-9a-f]{40}$")
PROJECT_HOST = "kuklfnapbkmacvwxktbh.supabase.co"


def die(message: str) -> NoReturn:
    print(f"[engine-release-database-proof] FATAL: {message}", file=sys.stderr)
    raise SystemExit(1)


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


def heartbeat_age_seconds(value: object) -> float:
    if not isinstance(value, str) or not value:
        raise ValueError("missing heartbeat_at")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds()


def read_leader(
    base_url: str, service_key: str, socket_timeout_seconds: float
) -> tuple[str, str, float]:
    query = urlencode(
        {
            "select": "engine_version,instance_id,heartbeat_at",
            "id": "eq.true",
            "limit": "1",
        }
    )
    request = Request(
        f"{base_url}/rest/v1/engine_leader?{query}",
        headers={
            "apikey": service_key,
            "authorization": f"Bearer {service_key}",
            "accept": "application/json",
            "cache-control": "no-cache, no-store",
        },
    )
    class RefuseRedirects(HTTPRedirectHandler):
        def redirect_request(self, *_args: object, **_kwargs: object) -> None:
            return None

    # Authorization must never follow a redirect to a different origin. The
    # sole allowed endpoint is already pinned above, so every redirect is an
    # invalid configuration rather than a navigation aid.
    opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), RefuseRedirects())
    with opener.open(request, timeout=socket_timeout_seconds) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise ValueError("engine_leader did not return exactly one row")
    row = payload[0]
    return (
        str(row.get("engine_version") or ""),
        str(row.get("instance_id") or ""),
        heartbeat_age_seconds(row.get("heartbeat_at")),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=240)
    parser.add_argument("--poll-seconds", type=int, default=10)
    parser.add_argument("--max-heartbeat-age-seconds", type=int, default=60)
    args = parser.parse_args()

    target_sha = str(args.sha).lower()
    if not SHA_RE.fullmatch(target_sha):
        die("target SHA must be one lowercase 40-hex commit")
    instance_id = str(args.instance_id)
    if not re.fullmatch(r"^[1-9][0-9]*-[0-9a-f]{8}$", instance_id):
        die("instance id is invalid")
    if (
        not 1 <= args.timeout_seconds <= 600
        or not 1 <= args.poll_seconds <= 60
        or not 1 <= args.max_heartbeat_age_seconds <= 60
    ):
        die("proof timing is outside the bounded contract")

    values = read_fixed_env(Path(args.env_file))
    base_url = values.get("SUPABASE_URL", "").rstrip("/")
    service_key = values.get("SUPABASE_SERVICE_ROLE_KEY", "")
    parsed_url = urlparse(base_url)
    if base_url != f"https://{PROJECT_HOST}" or parsed_url.netloc != PROJECT_HOST:
        die("SUPABASE_URL is not the pinned Club Arena project origin")
    if not service_key:
        die("SUPABASE_SERVICE_ROLE_KEY is absent from the fixed engine environment")

    expected = target_sha[:8]
    deadline = time.monotonic() + args.timeout_seconds
    attempt = 0
    last_version = "unreadable"
    last_instance = "unreadable"
    last_age: float | None = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            age_text = "unknown" if last_age is None else f"{last_age:.0f}s"
            die(
                f"elected leader never proved {expected}; "
                f"last_version={last_version} instance_match={last_instance == instance_id} "
                f"heartbeat_age={age_text}"
            )
        attempt += 1
        try:
            version, leader_instance, age = read_leader(
                base_url, service_key, min(15.0, remaining)
            )
            last_version, last_instance, last_age = version, leader_instance, age
            print(
                f"[engine-release-database-proof] attempt {attempt}: "
                f"leader={version or 'missing'} instance_match={leader_instance == instance_id} "
                f"heartbeat_age={age:.0f}s"
            )
            if (
                version == expected
                and leader_instance == instance_id
                and -30 <= age <= args.max_heartbeat_age_seconds
            ):
                print(
                    f"[engine-release-database-proof] proved elected leader {expected} "
                    f"with a fresh heartbeat"
                )
                return
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            # Never include request headers, the URL query, or environment
            # values. The exception class is sufficient operational evidence.
            print(
                f"[engine-release-database-proof] attempt {attempt}: "
                f"witness unreadable ({type(exc).__name__})"
            )

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            age_text = "unknown" if last_age is None else f"{last_age:.0f}s"
            die(
                f"elected leader never proved {expected}; "
                f"last_version={last_version} instance_match={last_instance == instance_id} "
                f"heartbeat_age={age_text}"
            )
        time.sleep(min(float(args.poll_seconds), remaining))


if __name__ == "__main__":
    main()
