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


def compose(root: Path, probe: Path, fixed_tail: str) -> str:
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
    scope_path = root / "scripts/deploy/phase-three-strict-tournament-cutover.sql"
    scope_defs = re.findall(r"(CREATE OR REPLACE FUNCTION public\.fn_assert_tournament_manager_write_scope\(.*?AS (\$[^$]*\$).*?\2;)", scope_path.read_text(), re.S)
    if len(scope_defs) != 1:
        raise ValueError("exact manager scope definition changed")
    scope_fixture = scope_defs[0][0] + "\nREVOKE ALL ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid) FROM PUBLIC,anon,authenticated,service_role;\n"
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
    expansion = once(expansion, "BEGIN;", "BEGIN;\n" + preflight + authority_gate + scope_fixture, "expansion begin")
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
    catalog_hashes = """
SELECT oid::regprocedure::text AS native_authority,md5(prosrc) AS native_body_md5
FROM pg_proc WHERE oid IN (
  'public.fn_settle_tournament_final_table_deal(uuid)'::regprocedure,
  'public.fn_ca_tournament_place_amounts(uuid)'::regprocedure)
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
    args = parser.parse_args()
    sys.stdout.write(compose(args.root.resolve(), (args.probe or args.root / "scripts/ci/probes/versioned-final-deal-native.sql").resolve(), args.fixed_tail))


if __name__ == "__main__":
    main()
