#!/usr/bin/env python3
"""Prove the elected leader or the exact legacy custody prerequisite.

This runs only inside the root-owned one-shot release transaction. It reads the
engine's fixed environment file itself, never exports or prints credentials,
and talks only to the pinned Club Arena Supabase project. HTTP health is not a
substitute for this witness: the elected leader row is the independent write
that makes a compatibility trial eligible for the durable release seal.
The separate mixed-custody mode only reads the installed catalog, once, before
the legacy checkpoint may persist its intent or open inspector access.
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
MIXED_CUSTODY_PREDECESSOR = "8825af51817f379c4261658ca29ecc9d8d81932d"
# Exact service-role READ ONLY result from stopped-bank focused-07 qualification,
# migration 20260919032212; preserves the retired-origin and original bank boundaries.
# Kept in this immutable control-generation file, never supplied by a caller.
MIXED_CUSTODY_CONTRACT = {'kind': 'f06_mixed_custody_contract_v1',
 'functions': [{'acl': '{postgres=X/postgres,service_role=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '7288e0873c01fd1e1821bd7549cd4d32',
                'signature': 'public.fn_f06_abort_retained_mtt_hands(uuid,jsonb)',
                'volatility': 'v',
                'definition_md5': 'be65ed6d185b0107737bcb124c42c41f',
                'security_definer': True},
               {'acl': '{postgres=X/postgres,service_role=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': 'aeaabb44975b8d138ed447687b0aea22',
                'signature': 'public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)',
                'volatility': 'v',
                'definition_md5': '3b047e7502c62bff570cd6253e85a741',
                'security_definer': True},
               {'acl': '{postgres=X/postgres,service_role=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '71f324a451fc0a228bf37eeabe1e0ec5',
                'signature': 'public.fn_f06_attest_retired_manager_origin(uuid,jsonb,jsonb)',
                'volatility': 'v',
                'definition_md5': 'd2bbd16fbfbe0833def3c92ef7400f7a',
                'security_definer': True},
               {'acl': '{postgres=X/postgres,service_role=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '43aa14703d4d8f37a95f7adf6c6ed5c1',
                'signature': 'public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb)',
                'volatility': 'v',
                'definition_md5': '1c45252d2701562fbd9d189927f418aa',
                'security_definer': True},
               {'acl': '{postgres=X/postgres,service_role=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': 'd140c71041b6fa7c7fe5bcec1e621fb4',
                'signature': 'public.fn_f06_find_mixed_manager_custody(uuid)',
                'volatility': 'v',
                'definition_md5': 'd9ab62fbf2dd62e234f9070582169c04',
                'security_definer': True},
               {'acl': '{postgres=X/postgres,service_role=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog'],
                'body_md5': '92dbd220f8746ba1e99ced05d7e5052e',
                'signature': 'public.fn_f06_mixed_custody_contract()',
                'volatility': 's',
                'definition_md5': '3b124d4a177fa724449c3457ab881489',
                'security_definer': True},
               {'acl': '{postgres=X/postgres,service_role=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': 'a1175d233f0cd493bf3e4775a9ecef45',
                'signature': 'public.fn_f06_mixed_custody_intent(uuid,uuid,uuid,text,jsonb)',
                'volatility': 'v',
                'definition_md5': '56095501ac846f06739c46fa0b7fbd48',
                'security_definer': True},
               {'acl': '{postgres=X/postgres,service_role=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '568665a1a07652dd2aad09dbd3a3d7f1',
                'signature': 'public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)',
                'volatility': 'v',
                'definition_md5': '53a44c9be52e0b07114917732d0cf390',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '1bc767e267e5b90534c601c39f2790a0',
                'signature': 'smarter_private.f06_assert_movement(uuid)',
                'volatility': 'v',
                'definition_md5': '7f10809c0e6ce2819c97c2ab53b95fba',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog'],
                'body_md5': '0daf117b8c81a351771c5fa802d22c62',
                'signature': 'smarter_private.f06_manager_transfer_immutable()',
                'volatility': 'v',
                'definition_md5': 'd595b68fa3464e5d56b5bc5395b5eb08',
                'security_definer': False},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '14ef74fe205a1b4164d9ba90b496f95b',
                'signature': 'smarter_private.f06_mixed_adopt_presence(uuid,jsonb)',
                'volatility': 'v',
                'definition_md5': 'f26dbbdab1bdc3cc4aecc3dcbd3ed844',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '5600dda463cd9eb331333dd16f708031',
                'signature': 'smarter_private.f06_mixed_bank_proof(uuid,jsonb)',
                'volatility': 'v',
                'definition_md5': '319879233ac2163b513107b91ce26cf1',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': 'dc612333e6fc9bb08bf70ffa8562ce1a',
                'signature': 'smarter_private.f06_mixed_current_admission(uuid,uuid,uuid)',
                'volatility': 'v',
                'definition_md5': '90ff66e263413795edcc691a879595d7',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '884dcaa75ea8fe389f4e228ab5f811d2',
                'signature': 'smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)',
                'volatility': 'v',
                'definition_md5': 'f92d6c7413496dcfa17042c03ed76cb5',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': 'f33b05adc06f9c8f31390ca5d6b7bd67',
                'signature': 'smarter_private.f06_mixed_movement_generation(uuid)',
                'volatility': 'v',
                'definition_md5': '2d096f6ee2a9eecd6895713be15cf365',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '5d061187142fe383baf6392b6306519e',
                'signature': 'smarter_private.f06_mixed_preparation_guard()',
                'volatility': 'v',
                'definition_md5': 'bcbdb70741099a7806acd90e838cc03f',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '45d5e92898dd9fb2fb72f33917cf96d8',
                'signature': 'smarter_private.f06_retained_mtt_abort_snapshot(jsonb)',
                'volatility': 'v',
                'definition_md5': '2d40c8218d043e644faa40f7b78ff772',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '26eebaeddeb611495c1c5504a794d56b',
                'signature': 'smarter_private.f06_retired_origin_begin(jsonb)',
                'volatility': 'v',
                'definition_md5': '5ea96d25a6b7262f3618dc763cd21d5b',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '5b1166bf024a6560cdbc877d405c2ad0',
                'signature': 'smarter_private.f06_retired_origin_claim_guard()',
                'volatility': 'v',
                'definition_md5': 'd3b47d8aee1b741e1f027aaa3de82ba8',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog'],
                'body_md5': '5a52aab48fb382a454b020415a798591',
                'signature': 'smarter_private.f06_retired_origin_cohort(uuid)',
                'volatility': 'i',
                'definition_md5': '501ffbb1ed7394ef077983403d115631',
                'security_definer': False},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': 'd74b4f9fe049898fcd7cc9de974ba87f',
                'signature': 'smarter_private.f06_retired_origin_disposition(jsonb)',
                'volatility': 'v',
                'definition_md5': 'af989c7c1ecd925b40057980009a7069',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog'],
                'body_md5': '0ad6579e5ec07eb8b1307f2078933c43',
                'signature': 'smarter_private.f06_retired_origin_lock(uuid)',
                'volatility': 'v',
                'definition_md5': 'cd9ee5827729c77153aa33de252d15ab',
                'security_definer': False},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': 'eef2b4beccc02dffd5efeffe57081a0e',
                'signature': 'smarter_private.f06_retired_origin_snapshot(jsonb)',
                'volatility': 'v',
                'definition_md5': 'e821cf8a38c6718237f1d45110bf7f00',
                'security_definer': True},
               {'acl': '{postgres=X/postgres}',
                'owner': 'postgres',
                'config': ['search_path=pg_catalog, public, smarter_private'],
                'body_md5': '62d8d93f836f4edb633900f7da4ddc85',
                'signature': 'smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb)',
                'volatility': 'v',
                'definition_md5': 'c59a8710299a46b798facb7b5298ce2d',
                'security_definer': True}]}


class RefuseRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


def read_mixed_custody_contract(base_url: str, service_key: str) -> object:
    # GET executes the STABLE catalog-only RPC in PostgREST's read-only
    # transaction. Never call prepare/admit/complete merely to test existence.
    request = Request(
        f"{base_url}/rest/v1/rpc/fn_f06_mixed_custody_contract",
        headers={
            "apikey": service_key,
            "authorization": f"Bearer {service_key}",
            "accept": "application/json",
            "cache-control": "no-cache, no-store",
        },
        method="GET",
    )
    opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), RefuseRedirects())
    with opener.open(request, timeout=5.0) as response:
        payload = response.read(65537)
    if len(payload) > 65536:
        raise ValueError("mixed-custody catalog response exceeds its bounded contract")
    return json.loads(payload.decode("utf-8"))


def verify_mixed_custody_contract(payload: object) -> None:
    # Exact equality includes signatures, body/definition digests, owner,
    # privileges, search path, security mode and volatility. Missing, duplicate,
    # unrecognized or malformed entries must not look like installed support.
    if not MIXED_CUSTODY_CONTRACT or json.dumps(payload, sort_keys=True) != json.dumps(
        MIXED_CUSTODY_CONTRACT, sort_keys=True
    ):
        raise ValueError("installed mixed-custody contract differs from qualification")


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
    parser.add_argument("--instance-id")
    parser.add_argument("--mixed-custody-contract", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=240)
    parser.add_argument("--poll-seconds", type=int, default=10)
    parser.add_argument("--max-heartbeat-age-seconds", type=int, default=60)
    args = parser.parse_args()

    target_sha = str(args.sha).lower()
    if not SHA_RE.fullmatch(target_sha):
        die("target SHA must be one lowercase 40-hex commit")
    instance_id = str(args.instance_id)
    if args.mixed_custody_contract:
        if target_sha != MIXED_CUSTODY_PREDECESSOR or args.instance_id is not None:
            die("mixed-custody prerequisite is limited to the qualified predecessor")
    elif not re.fullmatch(r"^[1-9][0-9]*-[0-9a-f]{8}$", instance_id):
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

    if args.mixed_custody_contract:
        try:
            verify_mixed_custody_contract(read_mixed_custody_contract(base_url, service_key))
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            # No response body, request headers, URL or environment values.
            die(f"mixed-custody prerequisite unconfirmed ({type(exc).__name__}); checkpoint not started")
        print("[engine-release-database-proof] installed mixed-custody contract matches qualification")
        return

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
