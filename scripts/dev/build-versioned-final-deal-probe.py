#!/usr/bin/env python3
"""Compose a rollback-only consent probe for the explicitly owned local replay.

This prints SQL; it never opens a database connection. Use only the root-owned
current_replay database. It installs no fake terminal or money authority. The
M5-dependent activation and terminal-wrapper acceptance remain separate gates.
"""
from pathlib import Path
import argparse
import hashlib
import re
import sys


def once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise ValueError(f"{label}: expected exactly one source marker")
    return source.replace(old, new, 1)


LANE_MIGRATION = "20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql"
LANE_SOURCE_SHA256 = "d07cbe35f62ef4a18e29779c812526c27420da4a82c891c0bf2f136b9e6a31fe"
LANE_HELPERS = {
    "fn_ca_lock_settlement_lane_global": ("", "343015440ea5c84ee4ca7ae583c73d30"),
    "fn_ca_share_settlement_lane_for_table": ("uuid", "006d78a441e65d000d1d78929649bb44"),
}
STAGE_B_MIGRATION_NAME = "stage_b_current_postimage_contraction"


def exact_migration(root: Path, migration_name: str) -> Path:
    migration_directory = root / "supabase/migrations"
    matches = sorted(
        path for path in migration_directory.iterdir()
        if path.is_file() and re.fullmatch(
            rf"[0-9]{{14}}_{re.escape(migration_name)}\.sql(?:\.pending)?",
            path.name,
        )
    )
    if len(matches) != 1:
        raise ValueError(
            f"expected exactly one staged-or-promoted {migration_name} migration; "
            f"found {len(matches)}"
        )
    return matches[0]


def lane_helpers(path: Path) -> list[tuple[str, str, str, str]]:
    """Read exact committed source; never inspect or export a live definition."""
    source = path.read_bytes()
    if hashlib.sha256(source).hexdigest() != LANE_SOURCE_SHA256:
        raise ValueError("settlement lane migration is not the reviewed tracked source")
    helpers = []
    for name, (signature, digest) in LANE_HELPERS.items():
        definitions = re.findall(
            r"(CREATE OR REPLACE FUNCTION public\." + name
            + r"\(.*?AS (\$[^$]*\$)(.*?)\2;)", source.decode(), re.S)
        if len(definitions) != 1 or hashlib.md5(definitions[0][2].encode()).hexdigest() != digest:
            raise ValueError(f"{name}: exact lane helper body changed")
        helpers.append((name, signature, digest, definitions[0][0]))
    return helpers


# These are source/catalog preconditions, not definitions to install. The shared
# obligation wrapper is the only function read from its containing migration.
CASH_LEAF_SOURCES = (
    (
        "20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql",
        "fn_ca_settle_tournament_place_raw",
        "fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)",
        "329237bd65214e17d4ca3298f363f248",
        "f3a1ddf283835776198be8a470fd5611cbc496c6bea9a505b6d41c3cecae09e5",
        "search_path=public",
    ),
    (
        "20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql",
        "fn_ca_settle_final_table_deal_share_raw",
        "fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)",
        "58e2768644b692f23a9a071a8a5d1ee8",
        "a0b39fd6f04259c8c0ae40fcfa6abfe504b79196ccd7db767a4ae3cc523be223",
        "search_path=public",
    ),
    (
        "20260909165629_satellite_settlement_has_one_atomic_authority.sql",
        "fn_settle_tournament_obligation",
        "fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)",
        "915f3ebd5c4a2efb97ad3a354dfeb365",
        "c6d0fdefeec1442e9b60ca0d8926897f543d86a7fce062442e7ab7f3e3d5edd8",
        "search_path=public, pg_temp",
    ),
    (
        "20260908011408_tournament_settlement_rejects_invalid_amounts_and_places.sql",
        "fn_settle_tournament_obligation",
        "fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)",
        "68f74f87580ea2c2a1cacbe30f9b4289",
        "1cacb1c8ee4a1f807ea49e617c25f93b82c9b772013808c09e76a2fcfa7a748a",
        "search_path=public",
    ),
)


def cash_leaf_gates(root: Path) -> str:
    """Reject unreviewed source or existing cash leaves before fixture writes."""
    gates = []
    for filename, source_name, identity, digest, source_sha, config in CASH_LEAF_SOURCES:
        path = root / "supabase/migrations" / filename
        definitions = re.findall(
            r"(CREATE OR REPLACE FUNCTION public\." + source_name
            + r"\(.*?AS (\$[^$]*\$)(.*?)\2;)", path.read_text(), re.S)
        if len(definitions) != 1:
            raise ValueError(f"{identity}: expected one tracked cash leaf definition")
        definition, _, body = definitions[0]
        if (hashlib.sha256(definition.encode()).hexdigest() != source_sha
                or hashlib.md5(body.encode()).hexdigest() != digest):
            raise ValueError(f"{identity}: tracked cash leaf source changed")
        gates.append(
            f"-- CASH_LEAF_SOURCE_SHA256 {source_sha} {path.relative_to(root)}::{source_name}\n"
            + "DO $cash_leaf_gate$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_proc p "
            + "JOIN pg_language l ON l.oid=p.prolang "
            + f"WHERE p.oid=to_regprocedure('public.{identity}') "
            + f"AND md5(p.prosrc)='{digest}' AND p.prosecdef "
            + "AND pg_get_userbyid(p.proowner)='postgres' AND l.lanname='plpgsql' "
            + f"AND p.proconfig=ARRAY['{config}']::text[]) "
            + f"THEN RAISE EXCEPTION 'native cash leaf differs: {identity}'; "
            + "END IF; END; $cash_leaf_gate$;\n"
        )
    return "".join(gates)


def compose(
    root: Path,
    probe: Path,
    fixed_tail: str,
    lane_path: Path,
    stage_b_path: Path | None = None,
) -> str:
    expansion_path = root / "scripts/deploy/phase-three-versioned-final-deal.sql"
    activation_path = root / "scripts/deploy/phase-three-activate-versioned-final-deal.sql"
    fixture_path = root / "scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql"
    deal_path = root / "scripts/ci/probes/atomic-terminal-final-deal-replay.sql"
    authority_path = root / "supabase/migrations/20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql"
    source_seed_path = root / "supabase/migrations/20260905203123_phase_6_1_a_settlement_outside_the_platform_needs_an_approve.sql"
    source_rows = re.findall(r"^  (\('final_table_deal', 'fn_final_table_deal'\)),?$", source_seed_path.read_text(), re.M)
    if len(source_rows) != 1:
        raise ValueError("canonical final deal source seed changed")
    source_seed = "INSERT INTO public.ca_settle_sources(source,note) VALUES " + source_rows[0] + " ON CONFLICT(source) DO NOTHING;\n"
    authority_source = authority_path.read_text()
    fingerprints = []
    for name in ("fn_ca_tournament_place_amounts", "fn_settle_tournament_final_table_deal"):
        definitions = re.findall(r"CREATE OR REPLACE FUNCTION public\." + name + r"\(.*?AS (\$[^$]*\$)(.*?)\1;", authority_source, re.S)
        if len(definitions) != 1:
            raise ValueError(f"{name}: exact native authority source changed")
        fingerprints.append((name, hashlib.md5(definitions[0][1].encode()).hexdigest()))
    authority_gate = "DO $native_gate$ BEGIN\n" + "\n".join(
        f"IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.{name}(uuid)'::regprocedure) IS DISTINCT FROM '{digest}' THEN RAISE EXCEPTION 'native authority source differs: {name}'; END IF;"
        for name, digest in fingerprints) + "\nEND; $native_gate$;\n"
    scope_path = stage_b_path or exact_migration(root, STAGE_B_MIGRATION_NAME)
    scope_defs = re.findall(r"(CREATE OR REPLACE FUNCTION public\.fn_assert_tournament_manager_write_scope\(.*?AS (\$[^$]*\$).*?\2;)", scope_path.read_text(), re.S)
    if len(scope_defs) != 1:
        raise ValueError("exact manager scope definition changed")
    scope_fixture = scope_defs[0][0] + "\nREVOKE ALL ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid) FROM PUBLIC,anon,authenticated,service_role;\n"
    lane_fixture = ""
    for name, signature, digest, definition in lane_helpers(lane_path):
        identity = f"public.{name}({signature})"
        lane_fixture += (
            f"DO $lane_before$ BEGIN IF to_regprocedure('{identity}') IS NOT NULL "
            f"AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('{identity}')) "
            f"IS DISTINCT FROM '{digest}' THEN RAISE EXCEPTION 'existing lane helper differs: {name}'; "
            "END IF; END; $lane_before$;\n"
            + definition + "\n"
            + f"REVOKE ALL ON FUNCTION {identity} FROM PUBLIC,anon,authenticated,service_role;\n"
            + f"GRANT EXECUTE ON FUNCTION {identity} TO service_role;\n"
            + f"DO $lane_after$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='{identity}'::regprocedure "
            f"AND md5(prosrc)='{digest}' AND NOT prosecdef "
            "AND proconfig=ARRAY['search_path=public, pg_temp']::text[]) "
            f"THEN RAISE EXCEPTION 'installed lane helper differs: {name}'; END IF; END; $lane_after$;\n"
        )
    # Only the reviewed final-deal cash body is advanced inside this rollback.
    # The fixture preflight above still authenticates its exact local baseline.
    cash_name = "fn_settle_tournament_final_table_deal"
    cash_definitions = re.findall(
        r"(CREATE OR REPLACE FUNCTION public\." + cash_name
        + r"\(.*?AS (\$[^$]*\$)(.*?)\2;)", authority_source, re.S)
    lane_source = lane_path.read_text()
    lane_patterns = re.findall(r"v_excl CONSTANT text :=\s*'((?:''|[^'])*)';", lane_source)
    lane_replacements = re.findall(r"'" + cash_name + r"',\s*'([^']+)'", lane_source)
    if len(cash_definitions) != 1 or len(lane_patterns) != 1 or len(lane_replacements) != 1:
        raise ValueError("exact cash lane transformation changed")
    pattern = lane_patterns[0].replace("''", "'")
    current_cash, hits = re.subn(pattern, lane_replacements[0], cash_definitions[0][0])
    current_body, body_hits = re.subn(pattern, lane_replacements[0], cash_definitions[0][2])
    current_digest = "141c723b5225bcec588b8957cf039184"
    if hits != 1 or body_hits != 1 or hashlib.md5(current_body.encode()).hexdigest() != current_digest:
        raise ValueError("current cash lane postimage does not match verified live hash")
    cash_identity = "public.fn_settle_tournament_final_table_deal(uuid)"
    cash_fixture = (
        current_cash + "\n"
        + f"REVOKE ALL ON FUNCTION {cash_identity} FROM PUBLIC,anon,authenticated,service_role;\n"
        + f"GRANT EXECUTE ON FUNCTION {cash_identity} TO service_role;\n"
        + f"DO $cash_current$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='{cash_identity}'::regprocedure "
        + f"AND md5(prosrc)='{current_digest}' AND prosecdef "
        + "AND proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[]) "
        + "THEN RAISE EXCEPTION 'installed current cash authority differs'; END IF; END; $cash_current$;\n"
    )
    expansion = expansion_path.read_text()
    expansion = once(expansion, "COMMIT;", "", "expansion transaction")
    preflight = """
DO $disposable_only$
BEGIN
  IF current_database()<>'current_replay' OR current_user<>'postgres'
     OR inet_server_addr() IS NOT NULL OR EXISTS(SELECT 1 FROM auth.users)
     OR to_regprocedure('public.fn_settle_tournament_final_table_deal(uuid)') IS NULL THEN
    RAISE EXCEPTION 'requires the empty root-owned local current_replay database with native cash authority';
  END IF;
END;
$disposable_only$;
"""
    expansion = once(expansion, "BEGIN;", "BEGIN;\n" + preflight + authority_gate + cash_leaf_gates(root) + lane_fixture + cash_fixture + scope_fixture, "expansion begin")
    fixture = fixture_path.read_text()
    fixture = once(fixture, "BEGIN;", "", "fixture begin")
    fixture = once(fixture, "COMMIT;", "", "fixture commit")
    deal = deal_path.read_text()
    start_marker = "SET LOCAL session_replication_role=replica;"
    end_marker = "CREATE FUNCTION pg_temp.atomic_deal_state()"
    if deal.count(start_marker) != 1 or deal.count(end_marker) != 1:
        raise ValueError("existing final-deal fixture source markers changed")
    deal = deal[deal.index(start_marker):deal.index(end_marker)]
    deal = once(deal, "'prize_pool_finalized',false", "'prize_pool_finalized',true", "funded preview fixture")
    prior = {"paid":5,"unpaid":0,"partial":2}[fixed_tail]
    deal = once(deal, "'chip_balance',0,'updated_at',now()", f"'chip_balance',CASE WHEN g.i=6 THEN {prior} ELSE 0 END,'updated_at',now()", "prior wallet fixture")
    deal = once(deal, "'prize_out',5", f"'prize_out',{prior}", "prior escrow out")
    deal = once(deal, "'prize_balance',95", f"'prize_balance',{100-prior}", "prior escrow balance")
    if prior == 0:
        receipt_start = deal.index("INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)")
        receipt_end = deal.index("SET LOCAL session_replication_role=origin;", receipt_start)
        deal = deal[:receipt_start] + deal[receipt_end:]
    elif prior == 2:
        deal = once(deal, "md5('atomic-deal-user:6')::uuid,5);", "md5('atomic-deal-user:6')::uuid,2);", "partial credit key")
        deal = once(deal, "md5('atomic-deal-user:6')::uuid,6,5,'structure'", "md5('atomic-deal-user:6')::uuid,6,2,'structure'", "partial payout")
        deal = once(deal, "::uuid,5,5,'engine.fixed_probe',now()", "::uuid,5,2,'engine.fixed_probe',NULL", "partial obligation")
        deal = once(deal, "::uuid,'PLAYER',5,'credit'", "::uuid,'PLAYER',2,'credit'", "partial journal")
        deal = once(deal, "000000000001',5);", "000000000001',2);", "partial journal balance")
    deal = once(deal, "SET status='eliminated',position=6,prize=5", f"SET status='eliminated',position=6,prize={prior}", "prior prize cache")
    activation = activation_path.read_text()
    guard_pattern = r"CREATE TRIGGER require_exact_final_deal_proposal\n.*?EXECUTE FUNCTION public\.fn_require_exact_final_deal_proposal\(\);"
    guards = re.findall(guard_pattern, activation, re.S)
    if len(guards) != 1:
        raise ValueError("activation must define one exact proposal obligation guard")
    provenance = "\n".join(
        f"-- SOURCE_SHA256 {hashlib.sha256(path.read_bytes()).hexdigest()} {path.relative_to(root)}"
        for path in (expansion_path, activation_path, fixture_path, deal_path, authority_path, source_seed_path, scope_path)
    )
    provenance += f"\n-- SOURCE_SHA256 {LANE_SOURCE_SHA256} {lane_path.name}"
    catalog_hashes = """
SELECT oid::regprocedure::text AS native_authority,md5(prosrc) AS native_body_md5
FROM pg_proc WHERE oid IN (
  'public.fn_settle_tournament_final_table_deal(uuid)'::regprocedure,
  'public.fn_ca_tournament_place_amounts(uuid)'::regprocedure,
  'public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)'::regprocedure,
  'public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)'::regprocedure,
  'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure,
  'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure)
ORDER BY oid::regprocedure::text;
"""
    return (
        "\\set ON_ERROR_STOP on\n" + provenance + "\n" + expansion + fixture + deal
        + "\n-- Isolated native guard acceptance only; not the M5 activation gate.\n"
        + guards[0] + "\n" + source_seed + catalog_hashes + probe.read_text()
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="owned repository worktree")
    parser.add_argument("--probe", type=Path, default=None)
    parser.add_argument("--fixed-tail",choices=["paid","unpaid","partial"],default="paid")
    parser.add_argument("--lane-migration", type=Path, help="exact tracked lane migration, possibly in its owning checkout")
    args = parser.parse_args()
    lane_path = args.lane_migration or args.root / "supabase/migrations" / LANE_MIGRATION
    sys.stdout.write(compose(args.root.resolve(), (args.probe or args.root / "scripts/ci/probes/versioned-final-deal-native.sql").resolve(), args.fixed_tail, lane_path.resolve()))


if __name__ == "__main__":
    main()
