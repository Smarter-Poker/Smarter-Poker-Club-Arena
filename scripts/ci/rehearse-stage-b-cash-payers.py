#!/usr/bin/env python3
"""Run a rollback-only Stage-B cash payer composition in owned current_replay.

Only the strict public payer and exact three-leaf contraction block are extracted
from Stage B. This is not a whole Stage-B deployment or terminal closure proof.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import importlib.util
import json
import re
import subprocess
import tempfile

PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
SOCKET = "/tmp/codex-chip-drift-cutover-e2iav203/socket"
IDENTITIES = (
    "public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)",
    "public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)",
    "public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)",
)
GUARDS = (
    "aa_guard_tournament_completing_claim",
    "aaa_guard_atomic_satellite_completion",
    "zzzz_freeze_finalized_tournament_prize_pool",
    "zzzz_tournament_pool_finalization_window_guard",
    "zzzz_tournaments_atomic_place_completion_guard",
    "zzzzz_tournaments_atomic_final_table_deal_completion_guard",
    "zzzzzz_tournaments_financial_certificate",
)
TABLES = (
    "auth.users", "public.users", "public.profiles", "public.clubs",
    "public.club_members", "public.tournaments", "public.tournament_players",
    "public.tournament_escrow", "public.tournament_payouts",
    "public.tournament_obligations", "public.wallet_credit_idempotency",
    "public.wallet_transactions", "public.wallets", "public.chip_ledger",
    "public.ca_settle_sources", "public.tables", "public.table_seats",
    "public.hands", "public.hand_players", "public.tournament_tables",
    "public.tournament_place_settlement_batches",
    "public.tournament_finish_receipts",
    "public.tournament_deal_proposals",
    "public.tournament_deal_reviews",
    "public.tournament_deal_proposal_consents",
    "public.tournament_deal_proposal_executions",
    "public.tournament_deal_review_policy",
    "public.tournament_final_table_deal_batches",
    "public.tournament_final_table_deal_receipts",
)

def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError("expected exactly one marker: " + before[:100])
    return text.replace(before, after, 1)

def q(text):
    return "'" + text.replace("'", "''") + "'"

def sql(command):
    return subprocess.check_output(
        [PSQL, "-X", "-h", SOCKET, "-p", "55473", "-U", "postgres",
         "-d", "current_replay", "-At", "-v", "ON_ERROR_STOP=1", "-c", command],
        text=True).strip()

def snapshot():
    result = {}
    for catalog in ("pg_proc", "pg_trigger", "pg_class", "pg_attribute",
                    "pg_attrdef", "pg_constraint", "pg_index", "pg_policy"):
        result[catalog] = sql(
            "SELECT md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n'"
            " ORDER BY row_to_json(t)::text),'')) FROM pg_catalog."
            + catalog + " t")
    for table in TABLES:
        if sql("SELECT to_regclass(" + q(table) + ") IS NOT NULL") == "t":
            result[table] = sql(
                "SELECT json_build_object('count',count(*),'md5',md5(COALESCE("
                "string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')))"
                " FROM " + table + " t")
        else:
            result[table] = None
    return result

def compose(root, fixed_tail, lane_path):
    builder_path = root / "scripts/dev/build-versioned-final-deal-probe.py"
    spec = importlib.util.spec_from_file_location("cash_base", builder_path)
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    stage_b = (root / "scripts/deploy/phase-three-strict-tournament-cutover.sql").read_text()
    blocks = re.findall(r"DO \$contract_cash_batch_payers\$.*?\$contract_cash_batch_payers\$;", stage_b, re.S)
    wrappers = re.findall(
        r"(CREATE OR REPLACE FUNCTION public\.fn_settle_tournament_obligation\(.*?"
        r"AS (\$[^$]*\$).*?\2;)", stage_b, re.S)
    if len(blocks) != 1 or len(wrappers) != 1:
        raise ValueError("exact Stage-B payer definitions are missing")
    block = blocks[0]
    probe = (root / "scripts/ci/probes/stage-b-cash-payers-native.sql").read_text()
    normalise_acl = "\n".join(
        "REVOKE ALL ON FUNCTION " + identity + " FROM PUBLIC,anon,authenticated,service_role;"
        for identity in IDENTITIES)
    strict = wrappers[0][0] + """
REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid) TO service_role;
"""
    negatives = []
    # Exercise a late leaf failure so an earlier rewritten leaf also rolls back.
    for role in ("PUBLIC", "anon", "authenticated", "service_role"):
        negatives.append("""
DO $bad_acl$
BEGIN
  BEGIN
    GRANT EXECUTE ON FUNCTION public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric) TO """ + role + """;
    EXECUTE """ + q(block) + """;
    RAISE EXCEPTION 'unexpectedly accepted a non-owner raw payer';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Stage-B cash payer is not owner-only:%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(
    (SELECT md5(prosrc) FROM pg_proc WHERE oid=
      'public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)'::regprocedure)
      ='329237bd65214e17d4ca3298f363f248',
    'unexpected """ + role + """ ACL refuses contraction and rolls back earlier leaf');
END;
$bad_acl$;
""")
    for alteration in (
        "ALTER FUNCTION public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric) SET search_path=public,pg_temp",
        "DO $alter_body$ DECLARE d text; BEGIN SELECT pg_get_functiondef('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)'::regprocedure) INTO d; EXECUTE replace(d,'DECLARE',E'DECLARE\\n-- changed source'); END; $alter_body$",
    ):
        negatives.append("""
DO $bad_source$
BEGIN
  BEGIN
    EXECUTE """ + q(alteration) + """;
    EXECUTE """ + q(block) + """;
    RAISE EXCEPTION 'unexpectedly accepted changed raw payer source';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Stage-B cash payer source differs:%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(
    (SELECT md5(prosrc) FROM pg_proc WHERE oid=
      'public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)'::regprocedure)
      ='329237bd65214e17d4ca3298f363f248',
    'changed raw payer body or search_path refuses and restores earlier leaf');
END;
$bad_source$;
""")
    probe = once(probe, "-- @CONTRACTION_NEGATIVES@", "\n".join(negatives))
    probe = once(probe, "-- @CONTRACTION_BLOCK@", block)
    guard_sql = "\n".join(
        "ALTER TABLE public.tournaments ENABLE TRIGGER " + name + ";" for name in GUARDS)
    composed = base.compose(
        root, root / "scripts/ci/probes/versioned-final-deal-native.sql", fixed_tail,
        lane_path)
    # Seed an actual cash winner plus stone bubble during the original synthetic
    # opening fixture, before session_replication_role is restored to origin.
    composed = once(composed, "current_players,payout_structure,prize_pool_finalized,\n",
                    "current_players,payout_structure,prize_pool_finalized,bubble_protection,\n")
    composed = once(composed, "10,0,now(),9,'RUNNING',10,0,0,0,0,1,",
                    "1,0,now(),9,'RUNNING',10,0,0,0,0,2,")
    composed = once(composed, "'[{\"place\":1,\"percentage\":100}]'::jsonb,false,",
                    "'[{\"place\":1,\"percentage\":100}]'::jsonb,false,true,")
    bubble = """
INSERT INTO public.profiles
SELECT (jsonb_populate_record(NULL::public.profiles,
  to_jsonb(p)||jsonb_build_object('id','10000000-0000-0000-0000-000000000002',
    'username','atomic_cash_bubble'))).*
FROM public.profiles p WHERE p.id='10000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,prize,current_bounty,
  bounty_winnings,mystery_bounty_value,position,elimination_sequence,eliminated_at)
VALUES('31000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002','Probe User Two',0,'eliminated',
  0,0,0,0,2,1,now());
"""
    composed = once(composed, "SET LOCAL session_replication_role=origin;",
                    bubble + "\nSET LOCAL session_replication_role=origin;")
    cash_source = (root / "supabase/migrations/20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql").read_text()
    definitions = re.findall(r"(CREATE OR REPLACE FUNCTION public\.fn_settle_tournament_places\(.*?AS (\$[^$]*\$)(.*?)\2;)", cash_source, re.S)
    lane_source = lane_path.read_text()
    patterns = re.findall(r"v_excl CONSTANT text :=\s*'((?:''|[^'])*)';", lane_source)
    replacements = re.findall(r"'fn_settle_tournament_places',\s*'([^']+)'", lane_source)
    if len(definitions)!=1 or len(patterns)!=1 or len(replacements)!=1:
        raise ValueError("exact current normal cash lane composition changed")
    definition, _, old_body = definitions[0]
    current_definition, hits = re.subn(patterns[0].replace("''", "'"),replacements[0],definition)
    current_body, body_hits = re.subn(patterns[0].replace("''", "'"),replacements[0],old_body)
    if hits!=1 or body_hits!=1 or hashlib.md5(current_body.encode()).hexdigest()!='d0262f4928b12eea1cc5e9175cbf2737':
        raise ValueError("current normal cash body does not match verified authority")
    normal_cash = "DO $normal_cash_gate$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_settle_tournament_places(uuid,uuid)'::regprocedure) IS DISTINCT FROM " + q(hashlib.md5(old_body.encode()).hexdigest()) + " THEN RAISE EXCEPTION 'native normal cash baseline differs'; END IF; END; $normal_cash_gate$;\n" + current_definition + "\nREVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO service_role;\n"
    marker = "-- This refusal trigger observes an actual earlier credit, then forces the\n"
    composed = once(composed, marker,
                    normal_cash + strict + normalise_acl + "\n" + guard_sql + "\n" + probe + "\n" + marker)
    return composed

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if sql("SELECT current_database()||'|'||current_user||'|'||"
           "(inet_server_addr() IS NULL)::text||'|'||"
           "(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()"
           " AND pid<>pg_backend_pid())||'|'||(SELECT count(*) FROM auth.users)"
           "||'|'||(SELECT count(*) FROM public.tournaments)") != "current_replay|postgres|true|0|0|0":
        raise RuntimeError("requires the pristine exclusively owned local current_replay database")
    before = snapshot()
    evidence = {
        "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "production_ddl_applied": False, "whole_stage_b_executed": False,
        "scope": "Strict public payer plus exact owner-only cash leaf contraction; existing native money functions.",
        "synthetic_opening_fixture_only": True,
        "runtime_session_replication_role": "origin",
        "deferred_guards_enabled_during_acceptance": list(GUARDS),
        "variants": [], "before": before,
    }
    output = Path(tempfile.mkdtemp(prefix="codex-stage-b-cash-payers-"))
    lane_name = "20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql"
    lane_path = output / lane_name
    lane_source = root / "supabase/migrations/20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql"
    lane_bytes = lane_source.read_bytes()
    if hashlib.sha256(lane_bytes).hexdigest() != "d07cbe35f62ef4a18e29779c812526c27420da4a82c891c0bf2f136b9e6a31fe":
        raise RuntimeError("tracked settlement lane source differs")
    # Preserve the original provenance filename so composed rehearsal SQL is unchanged.
    lane_path.write_bytes(lane_bytes)
    for variant in ("paid", "unpaid", "partial"):
        text = compose(root, variant, lane_path)
        path = output / (variant + ".sql")
        path.write_text(text)
        result = subprocess.run(
            [PSQL, "-X", "-h", SOCKET, "-p", "55473", "-U", "postgres",
             "-d", "current_replay", "-v", "ON_ERROR_STOP=1", "-f", str(path)],
            text=True, capture_output=True)
        log = result.stdout + result.stderr
        (output / (variant + ".log")).write_text(log)
        after = snapshot()
        item = {"variant": variant, "exit_code": result.returncode,
                "assertions": len(re.findall(r"NOTICE:\s+PASS ", log)),
                "sql_sha256": hashlib.sha256(text.encode()).hexdigest(),
                "exact_rollback": after == before}
        evidence["variants"].append(item)
        evidence["after"] = after
        print(json.dumps(item), flush=True)
        if result.returncode or after != before:
            item["failure_tail"] = re.sub(r"psql:[^:\n]+:\d+:", "psql:", log).splitlines()[-18:]
            print("\n".join(item["failure_tail"]), flush=True)
        if after != before:
            evidence["status"] = "blocked_rollback_mismatch"
            args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
            raise SystemExit(1)
    evidence["status"] = ("blocked_final_deal_claim" if any(
        item["exit_code"] for item in evidence["variants"]) else "passed")
    evidence["count_note"] = "The same assertions run against three fixed-tail states; totals are not distinct tests."
    evidence["remaining_gate"] = (
        "Current final-deal cash authority changes RUNNING to COMPLETING without the immutable finish claim required by the genuine enabled guard. This proof cannot certify terminal completion."
        if evidence["status"] != "passed" else None)
    evidence["source_sha256"] = {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (
            Path(__file__), root / "scripts/ci/probes/stage-b-cash-payers-native.sql",
            root / "scripts/dev/build-versioned-final-deal-probe.py",
            root / "scripts/deploy/phase-three-strict-tournament-cutover.sql")}
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    print("Completed all variants; original catalog/data state restored. Status: " + evidence["status"], flush=True)
    if evidence["status"] != "passed":
        raise SystemExit(1)

if __name__ == "__main__":
    main()
