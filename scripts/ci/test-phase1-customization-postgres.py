#!/usr/bin/env python3
"""Native PostgreSQL 17 qualification for the two Phase 1 customization migrations.

The runner starts one disposable socket-only cluster on the external SSD,
loads the smallest production-shaped predecessor schema, installs the latest
committed fn_purchase_feature_v2 definition verbatim, applies the two exact
candidate migration files, and exercises only their user-visible authority
contracts.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "scripts/ci/fixtures/phase1-customization"
MIGRATION_CUSTOMIZATION = ROOT / (
    "supabase/migrations/"
    "20261005111453_phase_one_customization_ownership_face_decks_and_avatar_styl.sql"
)
MIGRATION_FINAL_TABLE = ROOT / (
    "supabase/migrations/20261005111523_short_formats_never_reach_final_table.sql"
)
MIGRATION_BATCH = ROOT / "supabase/migrations/20261005230204_the_final_table_cleanup_advances_in_bounded_transactions.sql"
MIGRATION_FINALIZER = ROOT / "supabase/migrations/20261005230230_the_final_table_cleanup_seals_its_completed_transition.sql"
PURCHASE_SOURCE = ROOT / "supabase/migrations/20260930235000_a_retry_gets_its_first_receipt.sql"
OWNED_RUNTIME_ROOT = Path(
    os.environ.get("PHASE1_PG_WORK_ROOT")
    or os.environ.get("RUNNER_TEMP")
    or "/Volumes/SmarterWork/agent-work/codex-club-arena-phase1-20261005"
)
PG = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
PORT = "55731"
OWNER = "00000000-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"
EXPIRED = "00000000-0000-4000-8000-000000000003"
LIFETIME = "00000000-0000-4000-8000-000000000004"
CLIENT_SHA = "1" * 40
SECOND_CLIENT_SHA = "2" * 40
ENGINE_SHA = "abcdef01" * 5
FOREIGN_ENGINE_SHA = "deadbeef" * 5
ENGINE_VERSION = ENGINE_SHA[:8]
FOREIGN_ENGINE_VERSION = FOREIGN_ENGINE_SHA[:8]

ENV = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
ENV["LC_ALL"] = "C"
RESULTS: dict[str, object] = {
    "scope": "Phase 1 customization authority and Final Table format guard",
    "postgres": None,
    "migrationSha256": {},
    "postImageMd5": {},
    "cases": [],
    "passed": False,
}


def command(argv: list[object], *, stdin: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(item) for item in argv],
        input=stdin,
        text=True,
        capture_output=True,
        env=ENV,
        timeout=timeout,
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def record(name: str, passed: bool, detail: object | None = None) -> None:
    entry: dict[str, object] = {"name": name, "passed": bool(passed)}
    if detail is not None:
        entry["detail"] = detail
    cast_cases = RESULTS["cases"]
    assert isinstance(cast_cases, list)
    cast_cases.append(entry)
    require(passed, f"{name}: {detail!r}")


def extract_latest_purchase_v2() -> str:
    source = PURCHASE_SOURCE.read_text()
    marker = "CREATE OR REPLACE FUNCTION public.fn_purchase_feature_v2(p_user_id uuid, p_feature text, p_request_id uuid)"
    start = source.find(marker)
    require(start >= 0, "latest fn_purchase_feature_v2 definition was not found")
    end_marker = "$function$;"
    end = source.find(end_marker, start)
    require(end >= 0, "latest fn_purchase_feature_v2 terminator was not found")
    definition = source[start : end + len(end_marker)]
    require(definition.count("RETURN v_cached_result;") == 1, "latest purchase-v2 lost first-receipt retry semantics")
    require(
        definition.count("'theme_id', 'table_id', 'button_id', 'background_id'") == 1,
        "purchase-v2 customization allow-list is not an exact single patch target",
    )
    return definition


def as_user(user_id: str, statement: str) -> str:
    return (
        "SET ROLE authenticated; "
        f"SET request.jwt.claim.sub = '{user_id}'; "
        + statement
    )


def as_service(statement: str) -> str:
    return (
        "SET ROLE service_role; "
        "SET request.jwt.claim.role = 'service_role'; "
        + statement
    )


def output_tail(result: subprocess.CompletedProcess[str]) -> str:
    return (result.stdout + result.stderr)[-3000:]


OWNED_RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
run_dir = Path(tempfile.mkdtemp(prefix=".p1pg-", dir=OWNED_RUNTIME_ROOT))
data = run_dir / "data"
socket = run_dir / "s"
socket.mkdir(mode=0o700)
started = False

PSQL = [
    PG / "psql",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    "VERBOSITY=verbose",
    "-h",
    socket,
    "-p",
    PORT,
    "-U",
    "postgres",
    "-d",
    "postgres",
]


def psql(statement: str, *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return command(PSQL, stdin=statement, timeout=timeout)


def psql_file(path: Path, *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return command(PSQL + ["-f", path], timeout=timeout)


def expect_value(name: str, statement: str, expected: str = "t") -> str:
    result = psql(statement)
    actual = result.stdout.rstrip("\n")
    record(
        name,
        result.returncode == 0 and actual == expected,
        {"expected": expected, "actual": actual, "diagnostic": result.stderr[-800:]},
    )
    return actual


def expect_error(name: str, statement: str, sqlstate: str) -> None:
    result = psql(statement)
    record(
        name,
        result.returncode != 0 and sqlstate in result.stderr,
        {"expectedSqlstate": sqlstate, "returnCode": result.returncode, "diagnostic": result.stderr[-1000:]},
    )


def expect_file_error(name: str, path: Path, sqlstate: str) -> None:
    result = psql_file(path, timeout=240)
    record(
        name,
        result.returncode != 0 and sqlstate in result.stderr,
        {"expectedSqlstate": sqlstate, "returnCode": result.returncode, "diagnostic": result.stderr[-1000:]},
    )


try:
    for binary in ("postgres", "initdb", "pg_ctl", "psql"):
        require((PG / binary).is_file(), f"PostgreSQL 17 binary missing: {PG / binary}")
    version = command([PG / "postgres", "--version"])
    require(version.returncode == 0, version.stderr)
    require(re.search(r"PostgreSQL\) 17\.", version.stdout) is not None, "PostgreSQL 17 is required")
    RESULTS["postgres"] = version.stdout.strip()

    for migration in (MIGRATION_CUSTOMIZATION, MIGRATION_FINAL_TABLE, MIGRATION_BATCH, MIGRATION_FINALIZER):
        require(migration.is_file(), f"candidate migration is missing: {migration}")
        sha_map = RESULTS["migrationSha256"]
        assert isinstance(sha_map, dict)
        sha_map[migration.name] = hashlib.sha256(migration.read_bytes()).hexdigest()

    init = command(
        [
            PG / "initdb",
            "-D",
            data,
            "-U",
            "postgres",
            "--auth-local=trust",
            "--auth-host=reject",
            "--no-locale",
            "--encoding=UTF8",
        ]
    )
    require(init.returncode == 0, output_tail(init))
    with (data / "postgresql.conf").open("a") as config:
        config.write(
            "\nlisten_addresses=''\n"
            f"unix_socket_directories='{socket}'\n"
            "unix_socket_permissions=0700\n"
            f"port={PORT}\n"
            "shared_buffers='32MB'\nmax_connections=20\nfsync=off\nwal_level=logical\n"
        )
    start = command([PG / "pg_ctl", "-D", data, "-l", run_dir / "postgres.log", "-w", "start"])
    require(start.returncode == 0, output_tail(start))
    started = True

    bootstrap = psql_file(FIXTURES / "bootstrap.sql")
    require(bootstrap.returncode == 0, "bootstrap failed:\n" + output_tail(bootstrap))

    purchase_definition = extract_latest_purchase_v2()
    install_purchase = psql(
        purchase_definition
        + "\nREVOKE ALL ON FUNCTION public.fn_purchase_feature_v2(uuid,text,uuid) FROM PUBLIC, anon;"
        + "\nGRANT EXECUTE ON FUNCTION public.fn_purchase_feature_v2(uuid,text,uuid) TO authenticated, service_role;"
    )
    require(install_purchase.returncode == 0, "purchase-v2 install failed:\n" + output_tail(install_purchase))

    first_migration = psql_file(MIGRATION_CUSTOMIZATION, timeout=240)
    require(first_migration.returncode == 0, "customization migration failed:\n" + output_tail(first_migration))
    record(
        "backward-compatible-prerequisite-applies-on-postgresql-17",
        True,
        {MIGRATION_CUSTOMIZATION.name: RESULTS["migrationSha256"][MIGRATION_CUSTOMIZATION.name]},
    )

    # The prerequisite lands the owner-bound replacements without breaking the
    # client that is still serving during the release overlap.
    expect_value(
        "prerequisite-preserves-legacy-interface-theme-rpc",
        as_user(OWNER, "SELECT public.fn_set_interface_theme('dark') = 'dark';"),
    )
    expect_value(
        "prerequisite-preserves-legacy-table-touch-rpc",
        as_user(
            OWNER,
            "DO $$ BEGIN PERFORM public.fn_mark_table_setting_touched("
            "ARRAY['card_back']); END $$; "
            "SELECT settings_touched @> ARRAY['card_back'] "
            f"FROM public.user_table_settings WHERE user_id = '{OWNER}';",
        ),
    )
    expect_value(
        "prerequisite-preserves-legacy-collection-rpcs",
        as_user(
            OWNER,
            "SELECT count(*) = 1 FROM public.fn_seed_table_studio_preferences("
            "ARRAY[]::text[], '[null,null,null]'::jsonb); "
            "SELECT count(*) = 1 AND bool_and(favorites @> ARRAY['themes:default-dark']) "
            "AND bool_and(revision = 1) "
            "FROM public.fn_mutate_table_studio_preferences("
            "'themes:default-dark', true, NULL, NULL);",
        ),
        "t\nt",
    )
    expect_value(
        "prerequisite-preserves-owner-scoped-direct-appearance-write",
        as_user(
            OWNER,
            "UPDATE public.user_theme_settings SET cards_id = 'classic_blue' "
            f"WHERE user_id = '{OWNER}' AND game_type = 'ALL'; "
            "SELECT cards_id = 'classic_blue' FROM public.user_theme_settings "
            f"WHERE user_id = '{OWNER}' AND game_type = 'ALL'; "
            "UPDATE public.user_theme_settings SET cards_id = 'classic_red' "
            f"WHERE user_id = '{OWNER}' AND game_type = 'ALL';",
        ),
    )

    # Owner-bound account settings and stable mutation receipts.
    expect_error(
        "interface-theme-refuses-stale-owner",
        as_user(
            OWNER,
            "SELECT public.fn_set_interface_theme("
            f"'{OTHER}', '20000000-0000-4000-8000-000000000001', 'dark');",
        ),
        "42501",
    )
    expect_value(
        "interface-theme-accepts-current-owner",
        as_user(
            OWNER,
            "WITH saved AS (SELECT public.fn_set_interface_theme("
            f"'{OWNER}', '20000000-0000-4000-8000-000000000002', 'dark') value) "
            "SELECT value = 'dark' AND (SELECT settings->>'theme' = 'dark' FROM public.profiles "
            f"WHERE id = '{OWNER}') FROM saved;",
        ),
    )
    expect_value(
        "account-auto-preference-is-preserved",
        as_user(
            OWNER,
            "DO $$ BEGIN PERFORM public.fn_patch_account_settings("
            f"'{OWNER}', '20000000-0000-4000-8000-000000000003', "
            "'{\"theme\":\"auto\",\"soundEnabled\":true}'::jsonb, 'dark'); END $$; "
            "WITH saved AS (SELECT public.fn_patch_account_settings("
            f"'{OWNER}', '20000000-0000-4000-8000-000000000003', "
            "'{\"theme\":\"auto\",\"soundEnabled\":true}'::jsonb, 'dark') value) "
            "SELECT value->>'theme' = 'auto' AND (SELECT settings->>'theme' = 'auto' "
            f"FROM public.profiles WHERE id = '{OWNER}') FROM saved;",
        ),
    )
    expect_error(
        "account-patch-refuses-stale-owner",
        as_user(
            OWNER,
            "SELECT public.fn_patch_account_settings("
            f"'{OTHER}', '20000000-0000-4000-8000-000000000004', "
            "'{\"theme\":\"dark\"}'::jsonb, 'dark');",
        ),
        "42501",
    )
    expect_value(
        "account-mutation-retry-returns-first-result-without-reverting-newer-data",
        as_user(
            OWNER,
            "DO $$ BEGIN PERFORM public.fn_patch_account_settings("
            f"'{OWNER}', '20000000-0000-4000-8000-000000000005', "
            "'{\"soundEnabled\":false}'::jsonb, 'dark'); END $$; "
            "WITH replay AS (SELECT public.fn_patch_account_settings("
            f"'{OWNER}', '20000000-0000-4000-8000-000000000003', "
            "'{\"theme\":\"auto\",\"soundEnabled\":true}'::jsonb, 'dark') value) "
            "SELECT (replay.value->>'soundEnabled')::boolean "
            "AND (SELECT NOT (settings->>'soundEnabled')::boolean AND settings->>'theme' = 'auto' "
            f"FROM public.profiles WHERE id = '{OWNER}') FROM replay;",
        ),
    )

    expect_error(
        "table-touch-refuses-stale-owner",
        as_user(OWNER, f"SELECT public.fn_mark_table_setting_touched('{OTHER}', ARRAY['table_color']);"),
        "42501",
    )
    expect_value(
        "table-touch-accepts-current-owner",
        as_user(
            OWNER,
            "DO $$ BEGIN PERFORM public.fn_mark_table_setting_touched("
            f"'{OWNER}', ARRAY['table_color']); END $$; "
            "SELECT settings_touched @> ARRAY['table_color'] FROM public.user_table_settings "
            f"WHERE user_id = '{OWNER}';",
        ),
    )
    expect_error(
        "collection-mutation-refuses-stale-owner",
        as_user(
            OWNER,
            "SELECT * FROM public.fn_mutate_table_studio_preferences("
            f"'{OTHER}', 'decks:house-classic', true, NULL, NULL);",
        ),
        "42501",
    )
    expect_value(
        "collection-mutation-accepts-current-owner",
        as_user(
            OWNER,
            "WITH changed AS (SELECT * FROM public.fn_mutate_table_studio_preferences("
            f"'{OWNER}', 'decks:house-classic', true, NULL, NULL)) "
            "SELECT favorites @> ARRAY['decks:house-classic'] AND revision = 2 FROM changed;",
        ),
    )

    # Browser writes cannot forge any entitlement or receipt ledger.
    expect_error(
        "purchase-receipt-direct-write-is-refused",
        as_user(
            OWNER,
            "INSERT INTO public.feature_purchases(user_id,feature,cost,usage_type) "
            f"VALUES ('{OWNER}','studio:face_deck_id:neon-circuit',0,'permanent');",
        ),
        "42501",
    )
    expect_error(
        "table-entitlement-direct-write-is-refused",
        as_user(
            OWNER,
            "INSERT INTO public.theme_asset_unlocks(user_id,category,asset_id,unlock_method) "
            f"VALUES ('{OWNER}','face_deck_id','neon-circuit','forged');",
        ),
        "42501",
    )
    expect_error(
        "avatar-entitlement-direct-write-is-refused",
        as_user(
            EXPIRED,
            f"INSERT INTO public.avatar_unlocks(user_id,avatar_id) VALUES ('{EXPIRED}','frame_obsidian');",
        ),
        "42501",
    )

    # Purchase-v2 must charge once, return the first receipt, deliver, equip,
    # and enter a full six-field cloud loadout immediately.
    purchase_sql = as_user(
        OWNER,
        "SELECT public.fn_purchase_feature_v2("
        f"'{OWNER}','studio:face_deck_id:neon-circuit',"
        "'30000000-0000-4000-8000-000000000001');",
    )
    first_purchase = psql(purchase_sql)
    require(first_purchase.returncode == 0, output_tail(first_purchase))
    retry_purchase = psql(purchase_sql)
    require(retry_purchase.returncode == 0, output_tail(retry_purchase))
    first_receipt = json.loads(first_purchase.stdout.strip())
    retry_receipt = json.loads(retry_purchase.stdout.strip())
    record(
        "face-deck-purchase-returns-identical-first-receipt-on-retry",
        first_receipt == retry_receipt
        and first_receipt.get("success") is True
        and first_receipt.get("cost") == 200
        and first_receipt.get("diamonds_remaining") == 800,
        {"first": first_receipt, "retry": retry_receipt},
    )
    expect_value(
        "face-deck-purchase-charges-and-delivers-once",
        as_user(
            OWNER,
            "SELECT (SELECT diamonds = 800 FROM public.profiles "
            f"WHERE id = '{OWNER}') "
            "AND (SELECT count(*) = 1 FROM public.feature_purchases "
            f"WHERE user_id = '{OWNER}' AND feature = 'studio:face_deck_id:neon-circuit') "
            "AND (SELECT count(*) = 1 FROM public.theme_asset_unlocks "
            f"WHERE user_id = '{OWNER}' AND category = 'face_deck_id' "
            "AND asset_id = 'neon-circuit');",
        ),
    )
    expect_value(
        "pre-existing-purchase-trigger-remains-attached",
        "SELECT count(*) = 1 FROM public.phase1_trigger_audit "
        "WHERE source_table = 'feature_purchases' "
        "AND row_key = 'studio:face_deck_id:neon-circuit';",
    )
    expect_value(
        "purchase-refuses-another-account",
        as_user(
            OWNER,
            "SELECT public.fn_purchase_feature_v2("
            f"'{OTHER}','studio:face_deck_id:royal-purple',"
            "'30000000-0000-4000-8000-000000000002')->>'error' "
            "= 'Purchases Are Limited To Your Own Account';",
        ),
    )
    expect_error(
        "appearance-rpc-refuses-stale-owner",
        as_user(
            OWNER,
            "SELECT public.fn_patch_table_appearance("
            f"'{OTHER}','40000000-0000-4000-8000-000000000001','ALL',"
            "'{\"cards_id\":\"classic_blue\"}'::jsonb);",
        ),
        "42501",
    )
    expect_error(
        "unowned-face-deck-cannot-be-equipped",
        as_user(
            OWNER,
            "SELECT public.fn_patch_table_appearance("
            f"'{OWNER}','40000000-0000-4000-8000-000000000002','ALL',"
            "'{\"face_deck_id\":\"royal-purple\"}'::jsonb);",
        ),
        "42501",
    )
    expect_value(
        "owner-bound-appearance-rpc-equips-purchased-face-deck-immediately",
        as_user(
            OWNER,
            "DO $$ BEGIN PERFORM public.fn_patch_table_appearance("
            f"'{OWNER}','40000000-0000-4000-8000-000000000003','ALL',"
            "'{\"face_deck_id\":\"neon-circuit\"}'::jsonb); END $$; "
            "WITH saved AS (SELECT public.fn_patch_table_appearance("
            f"'{OWNER}','40000000-0000-4000-8000-000000000003','ALL',"
            "'{\"face_deck_id\":\"neon-circuit\"}'::jsonb) value) "
            "SELECT value->>'face_deck_id' = 'neon-circuit' "
            "AND (SELECT face_deck_id = 'neon-circuit' FROM public.user_theme_settings "
            f"WHERE user_id = '{OWNER}' AND game_type = 'ALL') FROM saved;",
        ),
    )
    expect_value(
        "appearance-retry-returns-first-result-without-reverting-newer-choice",
        as_user(
            OWNER,
            "DO $$ BEGIN PERFORM public.fn_patch_table_appearance("
            f"'{OWNER}','40000000-0000-4000-8000-000000000004','ALL',"
            "'{\"cards_id\":\"classic_blue\"}'::jsonb); END $$; "
            "WITH replay AS (SELECT public.fn_patch_table_appearance("
            f"'{OWNER}','40000000-0000-4000-8000-000000000003','ALL',"
            "'{\"face_deck_id\":\"neon-circuit\"}'::jsonb) value) "
            "SELECT replay.value->>'cards_id' = 'classic_red' "
            "AND (SELECT cards_id = 'classic_blue' AND face_deck_id = 'neon-circuit' "
            "FROM public.user_theme_settings "
            f"WHERE user_id = '{OWNER}' AND game_type = 'ALL') FROM replay;",
        ),
    )
    loadout = (
        '{"theme_id":"default-dark","table_id":"classic_green",'
        '"button_id":"classic-white","background_id":"midnight",'
        '"cards_id":"classic_red","face_deck_id":"neon-circuit",'
        '"name":"Live","saved_at":"2026-10-05T12:00:00Z"}'
    )
    expect_value(
        "face-deck-persists-in-six-field-cloud-loadout",
        as_user(
            OWNER,
            "WITH changed AS (SELECT * FROM public.fn_mutate_table_studio_preferences("
            f"'{OWNER}', NULL, NULL, 1, '{loadout}'::jsonb)) "
            "SELECT loadouts->1->>'face_deck_id' = 'neon-circuit' AND revision = 3 FROM changed;",
        ),
    )
    expect_value(
        "legacy-loadout-is-backfilled-with-house-classic",
        as_user(
            OWNER,
            "SELECT loadouts->0->>'face_deck_id' = 'house-classic' "
            "FROM public.user_table_studio_preferences "
            f"WHERE user_id = '{OWNER}';",
        ),
    )

    # Ten frames and ten auras: 3 free + 7 catalogued premium in each kind.
    expect_value(
        "avatar-catalog-exposes-ten-frames-and-ten-auras",
        "SELECT (3 + count(*) FILTER (WHERE unlock_token LIKE 'frame\\_%') = 10) "
        "AND (3 + count(*) FILTER (WHERE unlock_token LIKE 'aura\\_%') = 10) "
        "FROM public.avatar_style_catalog;",
    )
    expect_value(
        "expired-vip-does-not-own-premium-avatar-style",
        f"SELECT NOT public.sp_cosmetic_is_owned('{EXPIRED}','frame_obsidian','frame');",
    )
    expect_value(
        "lifetime-vip-remains-active-despite-historical-expiry",
        f"SELECT public.sp_cosmetic_is_owned('{LIFETIME}','aura_aurora','aura');",
    )
    server_unlock = psql(
        "INSERT INTO public.avatar_unlocks(user_id,avatar_id) "
        f"VALUES ('{EXPIRED}','frame_obsidian');"
    )
    require(server_unlock.returncode == 0, output_tail(server_unlock))
    expect_value(
        "durable-avatar-unlock-survives-expired-vip",
        as_user(
            EXPIRED,
            "UPDATE public.profiles SET equipped_frame = 'frame_obsidian' "
            f"WHERE id = '{EXPIRED}'; "
            "SELECT equipped_frame = 'frame_obsidian' "
            f"FROM public.profiles WHERE id = '{EXPIRED}';",
        ),
    )
    expect_value(
        "durable-avatar-unlock-is-the-authoritative-expired-vip-entitlement",
        f"SELECT public.sp_cosmetic_is_owned('{EXPIRED}','frame_obsidian','frame');",
    )
    expect_value(
        "avatar-ownership-trigger-still-allows-active-lifetime-vip",
        as_user(
            LIFETIME,
            "UPDATE public.profiles SET equipped_aura = 'aura_aurora' "
            f"WHERE id = '{LIFETIME}'; SELECT equipped_aura = 'aura_aurora' "
            f"FROM public.profiles WHERE id = '{LIFETIME}';",
        ),
    )

    # Before the compatible-engine cutover, the prerequisite is deliberately
    # backward compatible: old false-positive flags and NULLs remain tolerated,
    # while only the new MTT-only RPC can create a receipt/event transition.
    expect_value(
        "prerequisite-leaves-legacy-short-and-null-flags-for-post-engine-cleanup",
        "SELECT count(*) FILTER (WHERE final_table_triggered IS TRUE) = 5 "
        "AND count(*) FILTER (WHERE final_table_triggered IS NULL) = 1 "
        "AND EXISTS (SELECT 1 FROM public.tournaments "
        "WHERE final_table_triggered IS TRUE "
        "AND (format_contract IN ('mtt-v1','mtt-v2')) IS NOT TRUE) "
        "FROM public.tournaments;",
    )
    expect_value(
        "prerequisite-does-not-arm-the-post-engine-constraint",
        "SELECT c.is_nullable = 'YES' "
        "AND NOT EXISTS (SELECT 1 FROM pg_constraint k "
        "WHERE k.conrelid = 'public.tournaments'::regclass "
        "AND k.conname = 'tournaments_final_table_requires_mtt_check') "
        "FROM information_schema.columns c "
        "WHERE c.table_schema = 'public' AND c.table_name = 'tournaments' "
        "AND c.column_name = 'final_table_triggered';",
    )
    expect_value(
        "public-final-table-event-has-no-private-owner-token",
        "SELECT count(*) = 2 "
        "AND bool_and(column_name IN ('tournament_id','reached_at')) "
        "AND NOT bool_or(column_name = 'ownership_token') "
        "FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'tournament_final_table_events';",
    )
    expect_value(
        "final-table-ledgers-add-no-foreign-key-to-the-hot-tournaments-table",
        "SELECT count(*) = 0 FROM pg_constraint "
        "WHERE contype = 'f' AND conrelid IN ("
        "'public.tournament_final_table_transition_receipts'::regclass,"
        "'public.tournament_final_table_events'::regclass);",
    )
    expect_value(
        "public-final-table-event-is-in-supabase-realtime",
        "SELECT count(*) = 1 FROM pg_publication_tables "
        "WHERE pubname = 'supabase_realtime' AND schemaname = 'public' "
        "AND tablename = 'tournament_final_table_events';",
    )
    expect_value(
        "anon-can-read-the-payload-minimal-final-table-event",
        "SET ROLE anon; SELECT count(*) = 1 FROM public.tournament_final_table_events;",
    )
    expect_value(
        "authenticated-can-read-the-payload-minimal-final-table-event",
        as_user(
            OWNER,
            "SELECT count(*) = 1 FROM public.tournament_final_table_events;",
        ),
    )
    expect_value(
        "public-event-roles-have-select-only-table-privileges",
        "SELECT bool_and(has_table_privilege(role_name, "
        "'public.tournament_final_table_events','SELECT')) "
        "AND bool_and(NOT has_table_privilege(role_name, "
        "'public.tournament_final_table_events','INSERT')) "
        "AND bool_and(NOT has_table_privilege(role_name, "
        "'public.tournament_final_table_events','UPDATE')) "
        "AND bool_and(NOT has_table_privilege(role_name, "
        "'public.tournament_final_table_events','DELETE')) "
        "FROM unnest(ARRAY['anon','authenticated','service_role']) role_name;",
    )
    expect_error(
        "service-role-cannot-write-public-transition-event-directly",
        "SET ROLE service_role; INSERT INTO public.tournament_final_table_events(tournament_id) "
        "VALUES ('10000000-0000-4000-8000-000000000006');",
        "42501",
    )
    expect_error(
        "browser-cannot-call-final-table-transition-rpc",
        as_user(
            OWNER,
            "SELECT * FROM public.fn_claim_final_table_transition("
            "'10000000-0000-4000-8000-000000000006',"
            "'50000000-0000-4000-8000-000000000001');",
        ),
        "42501",
    )
    expect_error(
        "service-role-cannot-read-transition-ledger-directly",
        "SET ROLE service_role; SELECT * "
        "FROM public.tournament_final_table_transition_receipts;",
        "42501",
    )
    expect_error(
        "short-format-transition-claim-is-refused",
        "SET ROLE service_role; SELECT * FROM public.fn_claim_final_table_transition("
        "'10000000-0000-4000-8000-000000000001',"
        "'50000000-0000-4000-8000-000000000002');",
        "23514",
    )
    expect_error(
        "unresolved-format-transition-claim-fails-closed",
        "SET ROLE service_role; SELECT * FROM public.fn_claim_final_table_transition("
        "'10000000-0000-4000-8000-000000000004',"
        "'50000000-0000-4000-8000-000000000006');",
        "23514",
    )
    expect_value(
        "legacy-triggered-mtt-hydrates-without-replaying-announcement",
        "SET ROLE service_role; WITH claimed AS ("
        "SELECT * FROM public.fn_claim_final_table_transition("
        "'10000000-0000-4000-8000-000000000005',"
        "'50000000-0000-4000-8000-000000000003')) "
        "SELECT state = 'already_persisted' "
        "AND ownership_token <> '50000000-0000-4000-8000-000000000003'::uuid "
        "FROM claimed;",
    )
    expect_value(
        "new-mtt-transition-has-one-stable-announcement-owner",
        "SET ROLE service_role; WITH claimed AS ("
        "SELECT * FROM public.fn_claim_final_table_transition("
        "'10000000-0000-4000-8000-000000000006',"
        "'50000000-0000-4000-8000-000000000004')) "
        "SELECT state = 'announcement_owned' "
        "AND ownership_token = '50000000-0000-4000-8000-000000000004'::uuid "
        "AND announced_at IS NULL FROM claimed;",
    )
    expect_value(
        "same-transition-token-recovers-a-lost-claim-response",
        "SET ROLE service_role; WITH claimed AS ("
        "SELECT * FROM public.fn_claim_final_table_transition("
        "'10000000-0000-4000-8000-000000000006',"
        "'50000000-0000-4000-8000-000000000004')) "
        "SELECT state = 'announcement_owned' "
        "AND ownership_token = '50000000-0000-4000-8000-000000000004'::uuid "
        "FROM claimed;",
    )
    expect_value(
        "different-manager-cannot-replay-an-owned-announcement",
        "SET ROLE service_role; WITH claimed AS ("
        "SELECT * FROM public.fn_claim_final_table_transition("
        "'10000000-0000-4000-8000-000000000006',"
        "'50000000-0000-4000-8000-000000000005')) "
        "SELECT state = 'already_persisted' "
        "AND ownership_token = '50000000-0000-4000-8000-000000000004'::uuid "
        "FROM claimed;",
    )
    expect_value(
        "only-owner-can-ack-and-ack-is-idempotent",
        "SET ROLE service_role; "
        "SELECT NOT public.fn_ack_final_table_announcement("
        "'10000000-0000-4000-8000-000000000006',"
        "'50000000-0000-4000-8000-000000000005') "
        "AND public.fn_ack_final_table_announcement("
        "'10000000-0000-4000-8000-000000000006',"
        "'50000000-0000-4000-8000-000000000004') "
        "AND public.fn_ack_final_table_announcement("
        "'10000000-0000-4000-8000-000000000006',"
        "'50000000-0000-4000-8000-000000000004');",
    )
    expect_value(
        "transition-readback-is-durable-and-announced",
        "SET ROLE service_role; WITH current_state AS ("
        "SELECT * FROM public.fn_read_final_table_transition("
        "'10000000-0000-4000-8000-000000000006')) "
        "SELECT triggered "
        "AND ownership_token = '50000000-0000-4000-8000-000000000004'::uuid "
        "AND announced_at IS NOT NULL FROM current_state;",
    )
    expect_value(
        "transition-ledger-contains-one-receipt-per-triggered-mtt",
        "SELECT count(*) = 2 AND count(DISTINCT tournament_id) = 2 "
        "FROM public.tournament_final_table_transition_receipts;",
    )
    expect_value(
        "claim-reclaim-and-refused-formats-produce-exactly-one-event-per-mtt",
        "SELECT count(*) = 2 AND count(DISTINCT tournament_id) = 2 "
        "AND count(*) FILTER (WHERE tournament_id = "
        "'10000000-0000-4000-8000-000000000006') = 1 "
        "AND count(*) FILTER (WHERE tournament_id IN ("
        "'10000000-0000-4000-8000-000000000001',"
        "'10000000-0000-4000-8000-000000000004')) = 0 "
        "FROM public.tournament_final_table_events;",
    )

    # Model the deployment overlap: the old engine wins one valid MTT flag
    # after prerequisite installation but before the compatible-engine cutover.
    expect_value(
        "rollout-era-old-engine-can-still-set-a-valid-mtt-flag",
        "UPDATE public.tournaments SET final_table_triggered = true "
        "WHERE id = '10000000-0000-4000-8000-000000000008'; "
        "SELECT final_table_triggered "
        "AND NOT EXISTS (SELECT 1 FROM public.tournament_final_table_transition_receipts "
        "WHERE tournament_id = '10000000-0000-4000-8000-000000000008') "
        "AND NOT EXISTS (SELECT 1 FROM public.tournament_final_table_events "
        "WHERE tournament_id = '10000000-0000-4000-8000-000000000008') "
        "FROM public.tournaments "
        "WHERE id = '10000000-0000-4000-8000-000000000008';",
    )

    # The destructive half of the rollout is sealed by protected, durable
    # deployment truth. It must fail closed and roll back until the exact
    # client/engine pair is attested by a freshly heartbeating shipped engine.
    expect_value(
        "cutover-sealer-is-owner-bound-security-definer-with-fixed-search-path",
        "SELECT pg_get_userbyid(p.proowner) = 'postgres' "
        "AND p.prosecdef "
        "AND p.proconfig @> ARRAY['search_path=pg_catalog, public'] "
        "AND has_function_privilege('service_role', p.oid, 'EXECUTE') "
        "AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') "
        "AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') "
        "FROM pg_proc p "
        "WHERE p.oid = 'public.fn_seal_phase_one_customization_cutover(text,text)'::regprocedure;",
    )
    expect_value(
        "cutover-ledgers-have-no-browser-or-service-direct-privileges",
        "SELECT bool_and(NOT has_table_privilege(role_name, "
        "'public.phase_one_customization_prerequisite','SELECT')) "
        "AND bool_and(NOT has_table_privilege(role_name, "
        "'public.phase_one_customization_cutover_seals','SELECT')) "
        "AND bool_and(NOT has_table_privilege(role_name, "
        "'public.phase_one_customization_cutover_seals','INSERT')) "
        "AND bool_and(NOT has_table_privilege(role_name, "
        "'public.phase_one_customization_cutover_seals','UPDATE')) "
        "AND bool_and(NOT has_table_privilege(role_name, "
        "'public.phase_one_customization_cutover_seals','DELETE')) "
        "FROM unnest(ARRAY['anon','authenticated','service_role']) role_name;",
    )
    expect_file_error(
        "post-cutover-migration-refuses-an-absent-cutover-seal",
        MIGRATION_FINAL_TABLE,
        "55000",
    )
    expect_value(
        "absent-seal-refusal-rolls-back-the-entire-post-cutover-migration",
        "SELECT has_function_privilege('authenticated',"
        "'public.fn_set_interface_theme(text)','EXECUTE') "
        "AND has_table_privilege('authenticated',"
        "'public.user_theme_settings','UPDATE') "
        "AND NOT EXISTS (SELECT 1 FROM pg_constraint "
        "WHERE conrelid = 'public.tournaments'::regclass "
        "AND conname = 'tournaments_final_table_requires_mtt_check') "
        "AND (SELECT final_table_triggered IS TRUE FROM public.tournaments "
        "WHERE id = '10000000-0000-4000-8000-000000000001') "
        "AND (SELECT final_table_triggered IS NULL FROM public.tournaments "
        "WHERE id = '10000000-0000-4000-8000-000000000007');",
    )
    expect_error(
        "authenticated-user-cannot-seal-the-cutover",
        as_user(
            OWNER,
            "SELECT public.fn_seal_phase_one_customization_cutover("
            f"'{CLIENT_SHA}','{ENGINE_SHA}');",
        ),
        "42501",
    )
    expect_error(
        "cutover-sealer-refuses-malformed-identities",
        as_service("SELECT public.fn_seal_phase_one_customization_cutover('bad','also-bad');"),
        "22023",
    )
    expect_value(
        "cutover-fixture-records-an-unshipped-exact-target",
        "INSERT INTO public.ca_engine_deploy_attempts "
        "(run_id,target_sha,shipped,reason,actor) VALUES "
        f"('phase1-unshipped','{ENGINE_SHA}',false,'fixture refusal','phase1-pg17'); "
        "SELECT count(*) = 1 FROM public.ca_engine_deploy_attempts "
        f"WHERE target_sha = '{ENGINE_SHA}' AND shipped IS FALSE;",
    )
    expect_error(
        "cutover-sealer-refuses-an-unshipped-target",
        as_service(
            "SELECT public.fn_seal_phase_one_customization_cutover("
            f"'{CLIENT_SHA}','{ENGINE_SHA}');"
        ),
        "55000",
    )
    expect_value(
        "cutover-fixture-records-a-shipped-target-with-only-a-stale-heartbeat",
        "INSERT INTO public.ca_engine_deploy_attempts "
        "(run_id,target_sha,shipped,reason,actor) VALUES "
        f"('phase1-shipped','{ENGINE_SHA}',true,'fixture ship','phase1-pg17'); "
        "INSERT INTO public.engine_leader "
        "(id,instance_id,engine_version,acquired_at,heartbeat_at) VALUES "
        f"(true,'stale-leader','{ENGINE_VERSION}',clock_timestamp() - interval '10 minutes',"
        "clock_timestamp() - interval '10 minutes'); "
        "SELECT EXISTS (SELECT 1 FROM public.ca_engine_deploy_attempts "
        f"WHERE target_sha = '{ENGINE_SHA}' AND shipped) "
        "AND EXISTS (SELECT 1 FROM public.engine_leader "
        "WHERE heartbeat_at < clock_timestamp() - interval '180 seconds');",
    )
    expect_error(
        "cutover-sealer-refuses-a-stale-exact-engine-heartbeat",
        as_service(
            "SELECT public.fn_seal_phase_one_customization_cutover("
            f"'{CLIENT_SHA}','{ENGINE_SHA}');"
        ),
        "55000",
    )
    expect_value(
        "cutover-fixture-switches-to-a-fresh-null-engine-version",
        "UPDATE public.engine_leader SET instance_id = 'null-version-leader', "
        "engine_version = NULL, heartbeat_at = clock_timestamp(); "
        "SELECT engine_version IS NULL "
        "AND heartbeat_at > clock_timestamp() - interval '180 seconds' "
        "FROM public.engine_leader WHERE id;",
    )
    expect_error(
        "cutover-sealer-fails-closed-on-a-fresh-null-engine-version",
        as_service(
            "SELECT public.fn_seal_phase_one_customization_cutover("
            f"'{CLIENT_SHA}','{ENGINE_SHA}');"
        ),
        "55000",
    )
    expect_value(
        "cutover-fixture-switches-to-a-fresh-foreign-engine",
        "UPDATE public.engine_leader SET instance_id = 'foreign-leader', "
        f"engine_version = '{FOREIGN_ENGINE_VERSION}', heartbeat_at = clock_timestamp(); "
        "SELECT engine_version = "
        f"'{FOREIGN_ENGINE_VERSION}' AND heartbeat_at > clock_timestamp() - interval '180 seconds' "
        "FROM public.engine_leader WHERE id;",
    )
    expect_error(
        "cutover-sealer-refuses-a-fresh-foreign-engine-heartbeat",
        as_service(
            "SELECT public.fn_seal_phase_one_customization_cutover("
            f"'{CLIENT_SHA}','{ENGINE_SHA}');"
        ),
        "55000",
    )
    expect_value(
        "cutover-fixture-switches-to-one-fresh-exact-engine-version",
        "UPDATE public.engine_leader SET instance_id = 'exact-leader', "
        f"engine_version = '{ENGINE_VERSION}', "
        "heartbeat_at = GREATEST(clock_timestamp(), "
        "(SELECT max(at) + interval '1 millisecond' "
        "FROM public.ca_engine_deploy_attempts WHERE shipped)); "
        "INSERT INTO public.engine_table_leases "
        "(table_id,instance_id,engine_version,acquired_at,heartbeat_at) VALUES "
        f"('60000000-0000-4000-8000-000000000001','exact-worker','{ENGINE_VERSION}',"
        "clock_timestamp(),clock_timestamp()); "
        "SELECT count(DISTINCT engine_version) = 1 "
        f"AND bool_and(engine_version = '{ENGINE_VERSION}') "
        "FROM (SELECT engine_version FROM public.engine_leader "
        "UNION ALL SELECT engine_version FROM public.engine_table_leases) live;",
    )
    expect_value(
        "service-role-seals-the-exact-shipped-live-client-engine-pair",
        as_service(
            "WITH sealed AS (SELECT public.fn_seal_phase_one_customization_cutover("
            f"'{CLIENT_SHA}','{ENGINE_SHA}') value) "
            "SELECT (value->>'sealed')::boolean "
            "AND value->>'contract' = 'phase1-customization-v1' "
            f"AND value->>'client_sha' = '{CLIENT_SHA}' "
            f"AND value->>'engine_sha' = '{ENGINE_SHA}' FROM sealed;"
        ),
    )
    first_seal = psql(
        "SELECT engine_heartbeat_at::text || '|' || sealed_at::text "
        "FROM public.phase_one_customization_cutover_seals "
        f"WHERE client_sha = '{CLIENT_SHA}' AND engine_sha = '{ENGINE_SHA}';"
    )
    require(first_seal.returncode == 0 and first_seal.stdout.strip(), output_tail(first_seal))
    seal_retry = psql(
        as_service(
            "SELECT public.fn_seal_phase_one_customization_cutover("
            f"'{CLIENT_SHA}','{ENGINE_SHA}');"
        )
    )
    require(seal_retry.returncode == 0, output_tail(seal_retry))
    retried_seal = psql(
        "SELECT engine_heartbeat_at::text || '|' || sealed_at::text "
        "FROM public.phase_one_customization_cutover_seals "
        f"WHERE client_sha = '{CLIENT_SHA}' AND engine_sha = '{ENGINE_SHA}';"
    )
    require(retried_seal.returncode == 0, output_tail(retried_seal))
    seal_count = psql(
        "SELECT count(*) FROM public.phase_one_customization_cutover_seals "
        f"WHERE client_sha = '{CLIENT_SHA}' AND engine_sha = '{ENGINE_SHA}';"
    )
    require(seal_count.returncode == 0, output_tail(seal_count))
    record(
        "same-client-engine-seal-is-idempotent-and-does-not-rewrite-its-receipt",
        first_seal.stdout.strip() == retried_seal.stdout.strip()
        and seal_count.stdout.strip() == "1",
        {
            "storedReceiptBefore": first_seal.stdout.strip(),
            "storedReceiptAfter": retried_seal.stdout.strip(),
            "rowCount": seal_count.stdout.strip(),
        },
    )
    append_seal = psql(
        as_service(
            "SELECT public.fn_seal_phase_one_customization_cutover("
            f"'{SECOND_CLIENT_SHA}','{ENGINE_SHA}');"
        )
    )
    require(append_seal.returncode == 0, output_tail(append_seal))
    expect_value(
        "a-new-client-descendant-appends-a-second-cutover-seal",
        "SELECT count(*) = 2 "
        f"AND count(*) FILTER (WHERE client_sha = '{CLIENT_SHA}') = 1 "
        f"AND count(*) FILTER (WHERE client_sha = '{SECOND_CLIENT_SHA}') = 1 "
        "FROM public.phase_one_customization_cutover_seals;",
    )
    expect_error(
        "service-role-cannot-update-an-append-only-cutover-seal-directly",
        "SET ROLE service_role; UPDATE public.phase_one_customization_cutover_seals "
        "SET sealed_at = clock_timestamp();",
        "42501",
    )
    expect_error(
        "service-role-cannot-delete-an-append-only-cutover-seal-directly",
        "SET ROLE service_role; DELETE FROM public.phase_one_customization_cutover_seals;",
        "42501",
    )

    expect_value(
        "post-cutover-guard-fixture-ages-the-sealed-engine-out",
        "UPDATE public.engine_leader SET heartbeat_at = clock_timestamp() - interval '10 minutes'; "
        "UPDATE public.engine_table_leases SET heartbeat_at = clock_timestamp() - interval '10 minutes'; "
        "SELECT bool_and(heartbeat_at < clock_timestamp() - interval '180 seconds') "
        "FROM (SELECT heartbeat_at FROM public.engine_leader "
        "UNION ALL SELECT heartbeat_at FROM public.engine_table_leases) live;",
    )
    expect_file_error(
        "post-cutover-migration-refuses-a-stale-sealed-engine",
        MIGRATION_FINAL_TABLE,
        "55000",
    )
    expect_value(
        "stale-engine-refusal-rolls-back-legacy-path-retirement",
        "SELECT has_function_privilege('authenticated',"
        "'public.fn_set_interface_theme(text)','EXECUTE') "
        "AND has_table_privilege('authenticated',"
        "'public.user_theme_settings','UPDATE') "
        "AND NOT EXISTS (SELECT 1 FROM pg_constraint "
        "WHERE conrelid = 'public.tournaments'::regclass "
        "AND conname = 'tournaments_final_table_requires_mtt_check');",
    )
    expect_value(
        "post-cutover-guard-fixture-presents-only-fresh-null-engine-versions",
        "UPDATE public.engine_leader SET "
        "engine_version = NULL, heartbeat_at = clock_timestamp(); "
        "UPDATE public.engine_table_leases SET "
        "engine_version = NULL, heartbeat_at = clock_timestamp(); "
        "SELECT bool_and(engine_version IS NULL) "
        "AND bool_and(heartbeat_at > clock_timestamp() - interval '180 seconds') "
        "FROM (SELECT engine_version, heartbeat_at FROM public.engine_leader "
        "UNION ALL SELECT engine_version, heartbeat_at FROM public.engine_table_leases) live;",
    )
    expect_file_error(
        "post-cutover-migration-fails-closed-on-fresh-null-engine-versions",
        MIGRATION_FINAL_TABLE,
        "55000",
    )
    expect_value(
        "null-engine-refusal-rolls-back-legacy-path-retirement",
        "SELECT has_function_privilege('authenticated',"
        "'public.fn_set_interface_theme(text)','EXECUTE') "
        "AND has_table_privilege('authenticated',"
        "'public.user_theme_settings','UPDATE') "
        "AND NOT EXISTS (SELECT 1 FROM pg_constraint "
        "WHERE conrelid = 'public.tournaments'::regclass "
        "AND conname = 'tournaments_final_table_requires_mtt_check');",
    )
    expect_value(
        "post-cutover-guard-fixture-presents-only-a-fresh-foreign-engine",
        "UPDATE public.engine_leader SET "
        f"engine_version = '{FOREIGN_ENGINE_VERSION}', heartbeat_at = clock_timestamp(); "
        "UPDATE public.engine_table_leases SET "
        f"engine_version = '{FOREIGN_ENGINE_VERSION}', heartbeat_at = clock_timestamp(); "
        "SELECT count(DISTINCT engine_version) = 1 "
        f"AND bool_and(engine_version = '{FOREIGN_ENGINE_VERSION}') "
        "FROM (SELECT engine_version FROM public.engine_leader "
        "UNION ALL SELECT engine_version FROM public.engine_table_leases) live;",
    )
    expect_file_error(
        "post-cutover-migration-refuses-a-fresh-foreign-engine",
        MIGRATION_FINAL_TABLE,
        "55000",
    )
    expect_value(
        "foreign-engine-refusal-rolls-back-legacy-path-retirement",
        "SELECT has_function_privilege('authenticated',"
        "'public.fn_set_interface_theme(text)','EXECUTE') "
        "AND has_table_privilege('authenticated',"
        "'public.user_theme_settings','UPDATE') "
        "AND NOT EXISTS (SELECT 1 FROM pg_constraint "
        "WHERE conrelid = 'public.tournaments'::regclass "
        "AND conname = 'tournaments_final_table_requires_mtt_check');",
    )
    expect_value(
        "post-cutover-guard-fixture-restores-the-fresh-sealed-engine",
        "UPDATE public.engine_leader SET "
        f"engine_version = '{ENGINE_VERSION}', heartbeat_at = clock_timestamp(); "
        "UPDATE public.engine_table_leases SET "
        f"engine_version = '{ENGINE_VERSION}', heartbeat_at = clock_timestamp(); "
        "SELECT count(DISTINCT engine_version) = 1 "
        f"AND bool_and(engine_version = '{ENGINE_VERSION}') "
        "AND bool_and(heartbeat_at > clock_timestamp() - interval '180 seconds') "
        "FROM (SELECT engine_version, heartbeat_at FROM public.engine_leader "
        "UNION ALL SELECT engine_version, heartbeat_at FROM public.engine_table_leases) live;",
    )

    second_migration = psql_file(MIGRATION_FINAL_TABLE, timeout=240)
    require(second_migration.returncode == 0, "Final Table migration failed:\n" + output_tail(second_migration))
    second_replay = psql_file(MIGRATION_FINAL_TABLE, timeout=240)
    require(second_replay.returncode == 0, "Final Table migration replay failed:\n" + output_tail(second_replay))
    invariants = psql_file(FIXTURES / "post-apply-invariants.sql")
    require(invariants.returncode == 0, "post-apply invariants failed:\n" + output_tail(invariants))
    record("both-exact-migrations-apply-in-release-order-on-postgresql-17", True, RESULTS["migrationSha256"])
    record("post-cutover-migration-replay-is-idempotent", True, MIGRATION_FINAL_TABLE.name)

    expect_value(
        "post-cutover-retires-all-four-unbound-customization-rpcs",
        "SELECT NOT has_function_privilege('authenticated',"
        "'public.fn_set_interface_theme(text)','EXECUTE') "
        "AND NOT has_function_privilege('authenticated',"
        "'public.fn_mark_table_setting_touched(text[])','EXECUTE') "
        "AND NOT has_function_privilege('authenticated',"
        "'public.fn_seed_table_studio_preferences(text[],jsonb)','EXECUTE') "
        "AND NOT has_function_privilege('authenticated',"
        "'public.fn_mutate_table_studio_preferences(text,boolean,integer,jsonb)','EXECUTE');",
    )
    expect_error(
        "post-cutover-legacy-rpc-call-is-refused",
        as_user(OWNER, "SELECT public.fn_set_interface_theme('light');"),
        "42501",
    )
    expect_error(
        "post-cutover-legacy-table-touch-rpc-call-is-refused",
        as_user(OWNER, "SELECT public.fn_mark_table_setting_touched(ARRAY['card_back']);"),
        "42501",
    )
    expect_error(
        "post-cutover-legacy-collection-seed-rpc-call-is-refused",
        as_user(
            OWNER,
            "SELECT * FROM public.fn_seed_table_studio_preferences("
            "ARRAY[]::text[], '[null,null,null]'::jsonb);",
        ),
        "42501",
    )
    expect_error(
        "post-cutover-legacy-collection-mutate-rpc-call-is-refused",
        as_user(
            OWNER,
            "SELECT * FROM public.fn_mutate_table_studio_preferences("
            "'themes:default-dark', true, NULL, NULL);",
        ),
        "42501",
    )
    expect_error(
        "post-cutover-direct-appearance-write-is-refused",
        as_user(
            OWNER,
            "UPDATE public.user_theme_settings SET cards_id = 'classic_red' "
            f"WHERE user_id = '{OWNER}' AND game_type = 'ALL';",
        ),
        "42501",
    )
    expect_error(
        "post-cutover-direct-appearance-insert-is-refused",
        as_user(
            OWNER,
            "INSERT INTO public.user_theme_settings(user_id,game_type) "
            f"VALUES ('{OWNER}','NLH');",
        ),
        "42501",
    )
    expect_value(
        "post-cutover-owner-bound-appearance-rpc-remains-live",
        as_user(
            OWNER,
            "WITH saved AS (SELECT public.fn_patch_table_appearance("
            f"'{OWNER}','40000000-0000-4000-8000-000000000006','ALL',"
            "'{\"button_id\":\"classic-white\"}'::jsonb) value) "
            "SELECT value->>'button_id' = 'classic-white' FROM saved;",
        ),
    )

    expect_value(
        "post-engine-cleanup-clears-short-and-null-flags",
        "SELECT bool_and(final_table_triggered IS NOT NULL) "
        "AND count(*) FILTER (WHERE final_table_triggered IS TRUE) = 3 "
        "AND count(*) FILTER (WHERE final_table_triggered IS TRUE "
        "AND (format_contract IN ('mtt-v1','mtt-v2')) IS NOT TRUE) = 0 "
        "FROM public.tournaments;",
    )
    expect_value(
        "post-engine-cleanup-reconciles-rollout-era-valid-mtt-transition",
        "SELECT (SELECT count(*) = 3 "
        "FROM public.tournament_final_table_transition_receipts) "
        "AND (SELECT count(*) = 3 FROM public.tournament_final_table_events) "
        "AND EXISTS (SELECT 1 FROM public.tournament_final_table_transition_receipts "
        "WHERE tournament_id = '10000000-0000-4000-8000-000000000008') "
        "AND EXISTS (SELECT 1 FROM public.tournament_final_table_events "
        "WHERE tournament_id = '10000000-0000-4000-8000-000000000008');",
    )
    expect_error(
        "short-format-final-table-flag-is-refused",
        "UPDATE public.tournaments SET final_table_triggered = true "
        "WHERE id = '10000000-0000-4000-8000-000000000001';",
        "23514",
    )
    expect_value(
        "mtt-v1-and-v2-final-table-flags-are-allowed",
        "UPDATE public.tournaments SET final_table_triggered = true "
        "WHERE format_contract IN ('mtt-v1','mtt-v2'); "
        "SELECT count(*) = 3 FROM public.tournaments "
        "WHERE final_table_triggered AND format_contract IN ('mtt-v1','mtt-v2');",
    )
    expect_value(
        "final-table-column-is-defaulted-not-null-and-constraint-is-validated",
        "SELECT c.is_nullable = 'NO' AND c.column_default = 'false' "
        "AND EXISTS (SELECT 1 FROM pg_constraint k "
        "WHERE k.conrelid = 'public.tournaments'::regclass "
        "AND k.conname = 'tournaments_final_table_requires_mtt_check' AND k.convalidated) "
        "FROM information_schema.columns c "
        "WHERE c.table_schema = 'public' AND c.table_name = 'tournaments' "
        "AND c.column_name = 'final_table_triggered';",
    )

    expect_value(
        "cutover-seal-readback-retains-exact-durable-release-evidence",
        "WITH latest AS (SELECT * "
        "FROM public.phase_one_customization_cutover_seals "
        "WHERE contract = 'phase1-customization-v1' "
        "ORDER BY sealed_at DESC LIMIT 1), live AS ("
        "SELECT engine_version, heartbeat_at FROM public.engine_leader "
        "UNION ALL SELECT engine_version, heartbeat_at FROM public.engine_table_leases) "
        "SELECT (SELECT count(*) = 2 FROM public.phase_one_customization_cutover_seals) "
        "AND latest.client_sha ~ '^[0-9a-f]{40}$' "
        f"AND latest.engine_sha = '{ENGINE_SHA}' "
        "AND latest.engine_heartbeat_at IS NOT NULL "
        "AND latest.sealed_at IS NOT NULL "
        "AND EXISTS (SELECT 1 FROM public.ca_engine_deploy_attempts d "
        "JOIN public.phase_one_customization_prerequisite p ON p.singleton "
        "WHERE d.shipped AND d.target_sha = latest.engine_sha "
        "AND d.at >= p.installed_at) "
        "AND (SELECT count(DISTINCT engine_version) = 1 "
        "AND bool_and(engine_version = left(latest.engine_sha,8)) "
        "AND bool_and(heartbeat_at > clock_timestamp() - interval '180 seconds') "
        "FROM live) FROM latest;",
    )

    post_images = psql(
        "SELECT p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = 'public' AND p.oid IN ("
        "'public.fn_seal_phase_one_customization_cutover(text,text)'::regprocedure,"
        "'public.fn_patch_table_appearance(uuid,uuid,text,jsonb)'::regprocedure,"
        "'public.fn_claim_final_table_transition(uuid,uuid)'::regprocedure,"
        "'public.fn_read_final_table_transition(uuid)'::regprocedure,"
        "'public.fn_ack_final_table_announcement(uuid,uuid)'::regprocedure,"
        "'public.fn_purchase_feature_v2(uuid,text,uuid)'::regprocedure) "
        "ORDER BY p.oid::regprocedure::text;"
    )
    require(post_images.returncode == 0, output_tail(post_images))
    post_image_map = RESULTS["postImageMd5"]
    assert isinstance(post_image_map, dict)
    for line in post_images.stdout.strip().splitlines():
        signature, digest = line.rsplit("|", 1)
        post_image_map[signature] = digest
    require(len(post_image_map) == 6, f"expected six post-image hashes, got {post_image_map!r}")

    # Reproduce the production interrupted cleanup independently of its ledger:
    # old constraint absent, legacy privileges present, 450 incorrect historical flags.
    fixture = psql("""
      ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_final_table_requires_mtt_check;
      GRANT UPDATE ON public.user_theme_settings TO authenticated;
      GRANT EXECUTE ON FUNCTION public.fn_set_interface_theme(text) TO authenticated;
      CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS
        $$ SELECT coalesce(current_setting('fixture.frozen',true),'false')::boolean $$;
      CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz)
        RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
      INSERT INTO public.tournaments(id,format_contract,final_table_triggered)
        SELECT ('e0000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,NULL,true
        FROM generate_series(1,450) n;
      CREATE TABLE public.fixture_updates(id uuid);
      CREATE FUNCTION public.fixture_collateral_update() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN IF current_setting('fixture.collateral',true)='true' THEN NEW.format_contract:='sng-v1'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_collateral BEFORE UPDATE ON public.tournaments
        FOR EACH ROW EXECUTE FUNCTION public.fixture_collateral_update();
      CREATE FUNCTION public.fixture_count_update() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN IF current_setting('fixture.slow',true)='true' THEN PERFORM pg_sleep(1); END IF; INSERT INTO public.fixture_updates VALUES(NEW.id); RETURN NEW; END $$;
      CREATE TRIGGER fixture_update AFTER UPDATE ON public.tournaments
        FOR EACH ROW EXECUTE FUNCTION public.fixture_count_update();
    """)
    require(fixture.returncode == 0, output_tail(fixture))
    batch_install = psql_file(MIGRATION_BATCH)
    require(batch_install.returncode == 0, output_tail(batch_install))
    expect_file_error("forward-finalizer-refuses-incomplete-pages", MIGRATION_FINALIZER, "55000")
    expect_value("refusal-preserves-legacy-access-and-no-constraint",
      "SELECT has_table_privilege('authenticated','public.user_theme_settings','UPDATE') "
      "AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tournaments_final_table_requires_mtt_check');")
    call = "SELECT public.fn_advance_final_table_cleanup('90000000-0000-4000-8000-000000000001');"
    expect_error("batch-requires-top-level-timeout",call,"55000")
    expect_error("batch-refuses-authenticated",as_user(OWNER,"SET statement_timeout='5s';"+call),"42501")
    expect_error("batch-refuses-service-role",as_service("SET statement_timeout='5s';"+call),"42501")
    expect_error("batch-refuses-platform-freeze","SET statement_timeout='5s'; SET fixture.frozen='true';"+call,"55000")
    expect_value("refused-batches-have-no-receipt","SELECT count(*)=0 FROM public.final_table_cleanup_receipts;")
    expect_error("statement-deadline-rolls-back-entire-page",
      "SET statement_timeout='100ms'; SET fixture.slow='true';"+call,"57014")
    expect_value("deadline-preserves-cursor-receipts-and-triggers",
      "SELECT (SELECT last_id IS NULL FROM public.final_table_cleanup_progress) "
      "AND NOT EXISTS (SELECT 1 FROM public.final_table_cleanup_receipts) "
      "AND NOT EXISTS (SELECT 1 FROM public.fixture_updates);")
    expect_error("collateral-trigger-change-rolls-back-entire-page",
      "SET statement_timeout='5s'; SET fixture.collateral='true';"+call,"55000")
    expect_value("collateral-refusal-preserves-all-state",
      "SELECT (SELECT last_id IS NULL FROM public.final_table_cleanup_progress) "
      "AND NOT EXISTS (SELECT 1 FROM public.final_table_cleanup_receipts) "
      "AND NOT EXISTS (SELECT 1 FROM public.fixture_updates) "
      "AND (SELECT count(*)=450 FROM public.tournaments WHERE format_contract IS NULL AND final_table_triggered);")
    # A locked row refuses the whole page. A cursor must never skip it.
    locker = subprocess.Popen([str(x) for x in PSQL], stdin=subprocess.PIPE,
      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV)
    assert locker.stdin is not None and locker.stdout is not None
    locker.stdin.write("BEGIN; SELECT id FROM public.tournaments ORDER BY id LIMIT 1 FOR UPDATE;\n")
    locker.stdin.flush()
    require(bool(locker.stdout.readline().strip()), "row lock fixture did not acquire")
    try:
      expect_error("locked-row-refuses-without-skipping","SET statement_timeout='5s';"+call,"55P03")
    finally:
      locker.stdin.write("ROLLBACK;\n"); locker.stdin.close(); locker.wait(timeout=10)
    expect_value("locked-page-cursor-unchanged","SELECT last_id IS NULL FROM public.final_table_cleanup_progress;")
    first = psql("SET statement_timeout='5s';"+call)
    require(first.returncode == 0,output_tail(first))
    first_result = json.loads(first.stdout)
    record("first-page-boundary",first_result["visited"] == 200 and first_result["updated"] == 192 and not first_result["complete"],first_result)
    duplicate = psql("SET statement_timeout='5s';"+call)
    record("same-request-returns-first-receipt",duplicate.returncode == 0 and json.loads(duplicate.stdout)==first_result)
    expect_value("duplicate-does-not-fire-triggers-again","SELECT count(*)=192 FROM public.fixture_updates;")
    second = psql("SET statement_timeout='5s'; SELECT public.fn_advance_final_table_cleanup('90000000-0000-4000-8000-000000000002');")
    require(second.returncode == 0,output_tail(second))
    record("second-page-boundary",json.loads(second.stdout)["updated"]==200 and not json.loads(second.stdout)["complete"])
    third = psql("SET statement_timeout='5s'; SELECT public.fn_advance_final_table_cleanup('90000000-0000-4000-8000-000000000003');")
    require(third.returncode == 0,output_tail(third))
    record("last-page-boundary",json.loads(third.stdout)["updated"]==58 and json.loads(third.stdout)["complete"])
    expect_value("all-and-only-invalid-rows-updated-with-triggers","SELECT count(*)=450 AND count(DISTINCT id)=450 FROM public.fixture_updates;")
    # A late invalid insert behind the cursor must still make finalization refuse.
    expect_value("late-invalid-row-fixture","INSERT INTO public.tournaments VALUES ('01000000-0000-4000-8000-000000000001',NULL,true); SELECT true;")
    expect_file_error("finalizer-does-not-trust-cursor-over-rows",MIGRATION_FINALIZER,"55000")
    expect_value("remove-isolated-late-row","DELETE FROM public.tournaments WHERE id='01000000-0000-4000-8000-000000000001'; SELECT true;")
    expect_value("forward-sealed-engine-mismatch-fixture",
      "UPDATE public.engine_leader SET engine_version='deadbeef'; SELECT true;")
    expect_file_error("forward-finalizer-refuses-current-engine-mismatch",MIGRATION_FINALIZER,"55000")
    expect_value("forward-restore-sealed-engine-fixture",
      f"UPDATE public.engine_leader SET engine_version='{ENGINE_VERSION}',heartbeat_at=clock_timestamp(); SELECT true;")
    finish = psql_file(MIGRATION_FINALIZER)
    require(finish.returncode == 0,output_tail(finish))
    invariants = psql_file(FIXTURES / "post-apply-invariants.sql")
    require(invariants.returncode == 0,output_tail(invariants))
    record("forward-finalizer-restores-all-original-invariants",True)

    sha_map = RESULTS["migrationSha256"]
    assert isinstance(sha_map, dict)
    unchanged = all(
        hashlib.sha256(migration.read_bytes()).hexdigest() == sha_map[migration.name]
        for migration in (MIGRATION_CUSTOMIZATION, MIGRATION_FINAL_TABLE, MIGRATION_BATCH, MIGRATION_FINALIZER)
    )
    record(
        "qualified-migration-bytes-remained-unchanged-through-the-native-proof",
        unchanged,
        sha_map,
    )

    RESULTS["passed"] = all(case["passed"] for case in RESULTS["cases"] if isinstance(case, dict))
finally:
    if started and (data / "postmaster.pid").exists():
        command([PG / "pg_ctl", "-D", data, "-m", "immediate", "-w", "stop"], timeout=30)
    shutil.rmtree(run_dir, ignore_errors=True)

print(json.dumps(RESULTS, indent=2, sort_keys=True))
raise SystemExit(0 if RESULTS["passed"] else 1)
