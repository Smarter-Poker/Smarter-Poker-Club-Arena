#!/usr/bin/env python3
"""Exercise current bounty generation and real payments in retained local PG17.

This composes the eight chip-purchase helpers, exact current bounty payers and
the existing generation migration, then executes the existing exact-money probe. It never runs the broad
M6 migration, creates a cluster, or touches production. All writes roll back.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile

PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
SOCKET = "/tmp/codex-chip-drift-cutover-e2iav203/socket"
DB = "full_stage1"
SOURCES = {
    "supabase/migrations/20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql":
        "3a2af49bcaf13fdca72a4b89e2d6b38ee9c125f4d8b09aa8626c36e593aebc1f",
    "supabase/migrations/20260909182236_bounty_rebuy_settles_the_old_head_before_the_new_generation.sql":
        "4a3ade2ce44352cc6ce1dac719bb9798896cd2bb671be8dfc3e51d34f2cdec9f",
    "scripts/ci/probes/bounty-rebuy-generation-atomicity.sql":
        "ef8e7fe7c0705ad265dab8f416485302b379437ab94f055f08c98e5cff3a6a5e",
}
HELPERS = (
    ("fn_ca_lock_tournament_seat_acquisition", "uuid,uuid,uuid"),
    ("fn_ca_tournament_seat_cap", "uuid"),
    ("fn_ca_assign_tournament_player_seat_locked", "uuid,uuid,uuid,integer"),
    ("fn_ca_choose_tournament_seat_locked", "uuid,uuid,uuid,integer"),
    ("fn_ca_tournament_rebuy_window", "uuid"),
    ("fn_ca_process_tournament_chip_purchase_money_v1", "uuid,uuid,text,numeric,numeric,integer,text"),
    ("fn_ca_latest_committed_knockout_candidate", "uuid,uuid"),
    ("process_tournament_rebuy", "uuid,uuid,text,numeric,numeric,integer,text"),
)
CASE_MARKERS = ("standard_bounty_success", "pko_success", "mystery_success",
                "evidence_failure_is_closed", "late_failure_rolls_everything_back")
CURRENT_BOUNTY = (
    ("fn_collect_bounty", "uuid,uuid,uuid,jsonb", "0f331ccc9079142ea254643b112a54ca"),
    ("fn_mystery_bounty_pay", "uuid", "24dcb1cc3a72e7e9e5cdd94432a64064"),
    ("fn_mystery_bounty_settle", "uuid,uuid", "5c86ea2c44c5138577706ea30d3e1f27"),
    ("fn_finalize_bounty_pool", "uuid,uuid", "38cdf8c8d94017289b5a458270bfc921"),
    ("fn_claim_bounty_legacy_candidate_20260907",
     "uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean",
     "305c0e82124f463af61717ebdab2aa0e"),
)
M5 = "supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql"
M5_SHA256 = "59395e0e803d7c94dcbe2e35414bb6d5f97f6f674a67e9b1e30b9822a3c9c04d"
BUST_ORDER = "supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql"
MYSTERY_PHASE = "supabase/migrations/20260911094503_a_bust_belongs_to_the_phase_its_hand_was_played_in.sql"
PLAYER_ID_SHAPE = "supabase/migrations/20260910124023_a_player_id_is_a_uuid_not_a_uuid_version.sql"
PLACE_NOT_BOUNTY = "supabase/migrations/20260910145833_a_place_is_not_a_bounty.sql"
EXTRA_TABLES = (
    "public.tournament_bounty_obligations", "public.tournament_bounties",
    "public.tournament_bounty_chests", "public.tournament_bounty_awards",
    "public.tournament_bounty_award_recipients", "public.tournament_pko_settlement_watermarks",
    "public.tournament_knockout_candidates", "public.settlement_idempotency_keys",
    "public.hand_atomic_commits", "public.hand_history", "public.tournament_manager_wakes",
    "public.entry_purchase_idempotency_receipts", "public.tournament_refund_entitlements",
    "public.tournament_seat_exit_authorizations", "public.tournament_seat_move_receipts",
    "public.club_wallets", "public.union_wallets", "public.chip_ledger_idem",
    "public.rake_records", "public.rake_attributions", "public.agent_commissions",
    "public.financial_alerts", "public.ca_ledger_write_failures",
    "public.ca_drift_incidents", "public.player_stats", "public.vip_points_carry",
    "public.engine_tournament_leases",
)

def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()

def once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("expected one exact source marker: " + old[:100])
    return source.replace(old, new, 1)

def definition(source, name):
    pattern = r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\." + name + r"\s*\("
    matches = list(re.finditer(pattern, source, re.I))
    if len(matches) != 1:
        raise ValueError("expected one source definition: " + name)
    start = matches[0].start()
    tag = re.search(r"AS\s+(\$[A-Za-z_]*\$)", source[start:], re.I)
    body_start = start + tag.end()
    body_end = source.index(tag.group(1), body_start)
    return source[start:body_end + len(tag.group(1)) + 1]


LANE = "supabase/migrations/20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql"
EXTRA_SOURCES = {
    M5: M5_SHA256,
    LANE: "d07cbe35f62ef4a18e29779c812526c27420da4a82c891c0bf2f136b9e6a31fe",
    PLAYER_ID_SHAPE:
        "5bcb5cc3fd39234b329cba490b8516821296e18c1db08233399f2d450209e024",
    PLACE_NOT_BOUNTY:
        "6a52ae50c80423153705406a0bf855fd8a04baacba0ef155273455c20078c9a4",
    BUST_ORDER:
        "d2d0acba73031ed8617a243840eecea0e0e227a6dce5a78ce3ce2bfcfb79cf73",
    MYSTERY_PHASE:
        "0d620bf6061213e0ef0362126fde1e3e2feddc7b13720fa74727ad80da5fd570",
}
CURRENT_AFTER = {
    "fn_collect_bounty": "6142782f64defb871f9f7a0ef98f6793",
    "fn_mystery_bounty_pay": "335119d8c4c0b023955dbb003826e1da",
    "fn_mystery_bounty_settle": "161a9e5b46f1e35872c0c3c3f0d8b344",
    "fn_finalize_bounty_pool": "9cbe5164747835607f9f7d548d6064a3",
    "fn_claim_bounty_legacy_candidate_20260907": "d10ceaad9c867902c7407f20151f28b7",
    "fn_mystery_bounty_reserve": "cd622108895ded3658a9fd5871945789",
}
LANE_IDENTITIES = (
    ("fn_ca_lock_settlement_lane_global", "", "343015440ea5c84ee4ca7ae583c73d30"),
    ("fn_ca_lock_settlement_lane_for_tournament", "uuid,uuid", "2bc939035496d764ff9d6c14b52fa1e7"),
    ("fn_ca_share_settlement_lane_for_table", "uuid", "006d78a441e65d000d1d78929649bb44"),
)

def body_hash(text):
    tag = re.search(r"AS\s+(\$[A-Za-z_]*\$)", text, re.I)
    return hashlib.md5(text[tag.end():text.index(tag.group(1), tag.end())].encode()).hexdigest()

def source(root, relative):
    text = (root / relative).read_text()
    expected = dict(SOURCES, **EXTRA_SOURCES)[relative]
    if digest(text) != expected:
        raise ValueError("reviewed source changed: " + relative)
    return text

def lane_transform(text, lane, name):
    pattern = re.findall(r"v_excl CONSTANT text :=\s*'((?:''|[^'])*)';", lane)
    replacements = re.findall(r"'" + name + r"',\s*'([^']+)'", lane)
    if len(pattern) != 1 or len(replacements) != 1:
        raise ValueError("exact lane plan missing: " + name)
    result, count = re.subn(pattern[0].replace("''", "'"), replacements[0], text)
    if count != 1:
        raise ValueError("expected one root lock to advance: " + name)
    return result

def helper_sql(root):
    """Pure narrow current M6 helper composition, reusable by entry acceptance."""
    m6 = source(root, next(iter(SOURCES)))
    lane = source(root, LANE)
    sql = ""
    for name, signature, expected in LANE_IDENTITIES:
        text = definition(lane, name)
        if body_hash(text) != expected:
            raise ValueError("lane helper body changed: " + name)
        sql += text + "\n"
        sql += ("REVOKE ALL ON FUNCTION public." + name + "(" + signature +
                ") FROM PUBLIC,anon,authenticated,service_role;\n")
        sql += ("GRANT EXECUTE ON FUNCTION public." + name + "(" + signature +
                ") TO service_role;\n")
    for name, signature in HELPERS:
        text = definition(m6, name)
        if name in ("fn_ca_lock_tournament_seat_acquisition", "process_tournament_rebuy"):
            text = lane_transform(text, lane, name)
        sql += text + "\n"
        sql += ("REVOKE ALL ON FUNCTION public." + name + "(" + signature +
                ") FROM PUBLIC,anon,authenticated,service_role;\n")
    sql += """GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(
 uuid,uuid,text,numeric,numeric,integer,text) TO authenticated,service_role;
"""
    return sql

def current_bounty_sql(root):
    m5 = source(root, M5)
    lane = source(root, LANE)
    sql = ""
    functions = list(CURRENT_BOUNTY) + [
        ("fn_mystery_bounty_reserve", "uuid,uuid,jsonb,uuid,text,uuid,integer",
         "789f33328d2641870eeaf23bba2f582a")]
    for name, signature, before_md5 in functions:
        text = definition(m5, name)
        if body_hash(text) != before_md5:
            raise ValueError("original bounty source differs: " + name)
        if name != "fn_claim_bounty_legacy_candidate_20260907":
            text = lane_transform(text, lane, name)
            if body_hash(text) != CURRENT_AFTER[name]:
                raise ValueError("current production lane body differs: " + name)
        sql += text + "\n"
        sql += ("REVOKE ALL ON FUNCTION public." + name + "(" + signature +
                ") FROM PUBLIC,anon,authenticated,service_role;\n")
        if name != "fn_claim_bounty_legacy_candidate_20260907":
            sql += ("GRANT EXECUTE ON FUNCTION public." + name + "(" + signature +
                    ") TO service_role;\n")
    # These two exact migrations update the older claim/resolver bodies. Apply
    # them before installing the later byte-exact claim source so their
    # resolver changes remain represented without trying to replay them over a
    # body that already includes their postimages.
    for relative in (PLAYER_ID_SHAPE, PLACE_NOT_BOUNTY):
        patch = source(root, relative)
        sql += once(once(patch, "BEGIN;", ""), "COMMIT;", "") + "\n"
    bust_order = source(root, BUST_ORDER)
    current_claim = definition(bust_order, "fn_claim_bounty_legacy_candidate_20260907")
    if body_hash(current_claim) != "ea7b6236b7c5c844dbc16ce2e78d2764":
        raise ValueError("reviewed live bust-order claimant source changed")
    sql += current_claim + "\n"
    sql += ("REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907("
            + next(item[1] for item in CURRENT_BOUNTY
                   if item[0] == "fn_claim_bounty_legacy_candidate_20260907")
            + ") FROM PUBLIC,anon,authenticated,service_role;\n")
    # Replay the whole later migration, not just its claimant substitution: its
    # collect and mystery-seed changes are part of the same live money state.
    mystery_phase = source(root, MYSTERY_PHASE)
    sql += once(once(mystery_phase, "BEGIN;", ""), "COMMIT;", "") + "\n"
    sql += """DO $current_claim$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
  'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure)
  IS DISTINCT FROM 'd10ceaad9c867902c7407f20151f28b7'
 THEN RAISE EXCEPTION 'current production claimant body differs'; END IF;
END; $current_claim$;
"""
    return sql

def compose(root):
    texts = {}
    for relative, expected in SOURCES.items():
        text = (root / relative).read_text()
        if digest(text) != expected:
            raise ValueError("reviewed source changed: " + relative)
        texts[relative] = text
    m6, generation, probe = (texts[path] for path in SOURCES)
    sql = "BEGIN;\nSET LOCAL statement_timeout='45s';\nSET LOCAL lock_timeout='5s';\n"
    sql += """DO $owned_baseline$ BEGIN
 IF current_database()<>'full_stage1' OR current_user<>'postgres'
    OR inet_server_addr() IS NOT NULL
    OR (SELECT count(*) FROM auth.users)<>15
    OR (SELECT count(*) FROM public.tournaments)<>12
    OR EXISTS(SELECT 1 FROM public.tournaments WHERE id::text LIKE 'b7200000-%')
 THEN RAISE EXCEPTION 'requires the retained exclusively owned full_stage1 baseline'; END IF;
END; $owned_baseline$;
"""
    sql += helper_sql(root)
    sql += current_bounty_sql(root)
    # Preserve the current per-tournament mystery lane and the newer refusal
    # that prevents a rejected second finishing place from creating a debt.
    catalog_path = root / "docs/audits/2026-09-10-native-current-money-authorities.json"
    catalog = json.loads(catalog_path.read_text())
    expected = {
        "fn_mystery_bounty_pay(uuid)": "8f16f673aeaafac711da36b0df9466a2",
        "fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)": "ebabbaf0456d80335aaa2e04471d0ab6",
    }
    assert {item["signature"] for item in catalog["money_functions"]} == set(expected)
    for item in catalog["money_functions"]:
        assert body_hash(item["definition"]) == expected[item["signature"]]
        sql += item["definition"] + ";\n"
        sql += "REVOKE ALL ON FUNCTION public."+item["signature"]+" FROM PUBLIC,anon,authenticated,service_role;\n"
        if "service_role" in item["acl"]:
            sql += "GRANT EXECUTE ON FUNCTION public."+item["signature"]+" TO service_role;\n"
    # These exact rows are present in production and in the tracked Phase 6.1
    # seed. Restore fixture data only; the settlement admission guard is intact.
    seed = (root / "supabase/migrations/20260905203123_phase_6_1_a_settlement_outside_the_platform_needs_an_approve.sql").read_text()
    for name in ("fn_collect_bounty", "fn_mystery_bounty_pay", "fn_mystery_bounty_settle", "fn_finalize_bounty_pool"):
        row = "('"+name+"', 'DB caller')"
        assert row in seed and name in catalog["sources"]
        sql += "INSERT INTO public.ca_settle_sources(source,note) VALUES "+row+" ON CONFLICT(source) DO NOTHING;\n"
    # The existing generation file is bounded: a platform source row, two
    # functions, and an asserted patch of the just-authenticated rebuy body.
    generation = once(once(generation, "BEGIN;", ""), "COMMIT;", "")
    sql += generation + "\n"
    probe = once(probe, "BEGIN;", "")
    final_marker = "DO $pass$"
    if probe.count(final_marker) != 1:
        raise ValueError("existing probe final rollback marker differs")
    probe = probe[:probe.index(final_marker)]
    for name in CASE_MARKERS:
        ending = "$" + name + "$;"
        probe = once(probe, ending, ending +
                     "\nDO $notice$ BEGIN RAISE NOTICE 'PASS " + name + "'; END; $notice$;")
    sql += probe + """
SELECT 'BOUNTY_LIFECYCLE_EVIDENCE=' || jsonb_build_object(
 'cases',jsonb_build_array('standard_bounty_success','pko_success','mystery_success',
                          'evidence_failure_is_closed','late_failure_rolls_everything_back'),
 'events',(SELECT jsonb_agg(jsonb_build_object(
   'id',t.id,'bounty_pool',t.bounty_pool,'bounty_pool_paid',t.bounty_pool_paid,
   'escrow',to_jsonb(e),'wallet_bounty_credits',
   (SELECT sum(w.amount) FROM public.wallet_transactions w
     WHERE w.related_entity_id=t.id AND w.category='bounty'))
   ORDER BY t.id)
   FROM public.tournaments t JOIN public.tournament_escrow e ON e.tournament_id=t.id
   WHERE t.id::text LIKE 'b7200000-%'),
 'runtime_replication_role',current_setting('session_replication_role'),
 'terminal_completed',false)::text;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
"""
    return sql

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--compose-only", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    sql = compose(root)
    if args.compose_only:
        print(sql)
        return
    if args.evidence is None:
        parser.error("--evidence is required for execution")
    native = module(root / "scripts/ci/rehearse-final-deal-current-terminal.py", "native_snapshot")
    cash = module(root / "scripts/ci/rehearse-stage-b-cash-payers.py", "cash_tables")
    baseline = native.read_sql(
        "SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text"
        "||'|'||(SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)"
        "||'|'||(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()"
        " AND pid<>pg_backend_pid())")
    if baseline != "full_stage1|postgres|true|15|12|0":
        raise RuntimeError("retained database baseline differs: " + baseline)
    tables = list(cash.TABLES) + list(EXTRA_TABLES)
    before = native.snapshot(tables)
    output = Path(tempfile.mkdtemp(prefix="codex-current-bounty-lifecycle-"))
    sql_path = output / "generation.sql"
    sql_path.write_text(sql)
    run = subprocess.run([PSQL, "-X", "-h", SOCKET, "-p", "55473", "-U", "postgres",
        "-d", DB, "-At", "-v", "ON_ERROR_STOP=1", "-f", str(sql_path)],
        text=True, capture_output=True)
    log = run.stdout + run.stderr
    (output / "generation.log").write_text(log)
    after = native.snapshot(tables)
    rows = [line.removeprefix("BOUNTY_LIFECYCLE_EVIDENCE=")
            for line in run.stdout.splitlines() if line.startswith("BOUNTY_LIFECYCLE_EVIDENCE=")]
    passed_cases = re.findall(r"NOTICE:\s+PASS ([a-z_]+)", log)
    passed = (run.returncode == 0 and before == after and len(rows) == 1
              and passed_cases == list(CASE_MARKERS))
    evidence = {"recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "status": "passed" if passed else "failed", "baseline": baseline,
        "production_mutations": False, "broad_m6_migration_executed": False,
        "terminal_completed": False, "exit_code": run.returncode,
        "passed_cases": passed_cases, "exact_rollback": before == after,
        "sql_sha256": digest(sql), "source_sha256": dict(SOURCES, **EXTRA_SOURCES),
        "current_money_snapshot_sha256": digest((root / "docs/audits/2026-09-10-native-current-money-authorities.json").read_text()),
        "output_directory": str(output), "before": before, "after": after,
        "native_evidence": json.loads(rows[0]) if len(rows) == 1 else None}
    if not passed:
        evidence["failure_tail"] = re.sub(r"psql:[^:\n]+:\d+:", "psql:", log).splitlines()[-30:]
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({key: evidence[key] for key in
        ("status", "exit_code", "passed_cases", "exact_rollback", "output_directory")}), flush=True)
    if not passed:
        print("\n".join(evidence["failure_tail"]), flush=True)
        raise SystemExit(1)

if __name__ == "__main__":
    main()
