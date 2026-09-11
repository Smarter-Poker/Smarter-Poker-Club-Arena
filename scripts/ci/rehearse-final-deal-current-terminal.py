#!/usr/bin/env python3
"""Verify the approved final-deal v2 using real terminal authority, then roll back."""
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
TID = "87000000-0000-0000-0000-000000000001"
STAGE_B_RESOLVER = "scripts/ci/stage_b_migration_source.py"
GUARDS = ("aa_guard_tournament_completing_claim",
 "zzzz_freeze_finalized_tournament_prize_pool",
 "zzzz_tournament_pool_finalization_window_guard",
 "zzzz_tournaments_atomic_place_completion_guard",
 "zzzzz_tournaments_atomic_final_table_deal_completion_guard",
 "zzzzzz_tournaments_financial_certificate",
 "aaa_guard_atomic_satellite_completion")

def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()

def once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("source marker is not unique: " + old[:100])
    return text.replace(old, new, 1)

def read_sql(query):
    return subprocess.check_output(
        [PSQL, "-X", "-h", SOCKET, "-p", "55473", "-U", "postgres",
         "-d", DB, "-At", "-v", "ON_ERROR_STOP=1", "-c", query], text=True).strip()

def quote(text):
    return "'" + text.replace("'", "''") + "'"

def snapshot(tables):
    result = {}
    for catalog in ("pg_proc", "pg_trigger", "pg_class", "pg_attribute",
                    "pg_attrdef", "pg_constraint", "pg_index", "pg_policy"):
        result[catalog] = read_sql(
            "SELECT md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' "
            "ORDER BY row_to_json(t)::text),'')) FROM pg_catalog." + catalog + " t")
    for table in sorted(set(tables)):
        if read_sql("SELECT to_regclass(" + quote(table) + ") IS NOT NULL") == "t":
            result[table] = read_sql(
                "SELECT json_build_object('count',count(*),'md5',md5(COALESCE("
                "string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')))"
                " FROM " + table + " t")
        else:
            result[table] = None
    return result

def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj

def definition(path, name, expected, lane_after=None):
    text = path.read_text()
    matches = list(re.finditer(r"CREATE OR REPLACE FUNCTION public\." + name + r"\(", text))
    if len(matches) != 1:
        raise ValueError("function definition not unique: " + name)
    start = matches[0].start()
    tag = re.search(r"AS\s+(\$[A-Za-z_]*\$)", text[start:], re.I)
    a = start + tag.end()
    b = text.index(tag.group(1), a)
    body = text[a:b]
    if hashlib.md5(body.encode()).hexdigest() != expected:
        raise ValueError("source body changed: " + name)
    result = text[start:b + len(tag.group(1)) + 1]
    if lane_after:
        pattern = r"PERFORM\s+pg_advisory_xact_lock\(\s*hashtextextended\(\s*'ca:tournament-terminal-settlement:v1'\s*,\s*0\s*\)\s*\)\s*;"
        result, count = re.subn(pattern, "PERFORM public.fn_ca_lock_settlement_lane_global();", result)
        body, body_count = re.subn(pattern, "PERFORM public.fn_ca_lock_settlement_lane_global();", body)
        if count != 1 or body_count != 1 or hashlib.md5(body.encode()).hexdigest() != lane_after:
            raise ValueError("current lane source differs: " + name)
    return result

def block(path, marker):
    text = path.read_text()
    a = text.index("-- BEGIN " + marker)
    end = "-- END " + marker
    b = text.index(end, a) + len(end)
    return text[a:b] + "\n"

def compose(root, variant, probe_path=None):
    base = module(root / "scripts/dev/build-versioned-final-deal-probe.py", "deal_base")
    probe = probe_path or root / "scripts/ci/probes/final-deal-current-terminal-native.sql"
    lane = root / "supabase/migrations/20260910035245_the_settlement_lane_is_per_tournament_not_platform_wide.sql"
    sql = base.compose(root, probe, variant, lane)
    # The retained opening row predates the entry-club stamping trigger.
    # Match a real funded entrant's origin in this synthetic fixture before
    # consent: the current trigger would otherwise fill it during settlement.
    sql = once(sql, "'chips',CASE WHEN g.i<=5 THEN g.i*100 ELSE 0 END,",
        "'club_id','20000000-0000-0000-0000-000000000001',"
        "'chips',CASE WHEN g.i<=5 THEN g.i*100 ELSE 0 END,")
    # The retained fixture already has the exact tracked Stage-B raw payer
    # postimages. Authenticate the source transformation and owner-only ACLs
    # before temporarily restoring the tracked inputs for the isolated cutover.
    m4_source = root / "supabase/migrations/20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql"
    baseline_sql = ""
    for name, identity, before, after in [
        ("fn_ca_settle_tournament_place_raw", "uuid,integer,uuid,numeric", "329237bd65214e17d4ca3298f363f248", "3585ddbfdb0a197243d5e6eefb6b670f"),
        ("fn_ca_settle_tournament_bubble_raw", "uuid,uuid,numeric", "3a5a0f079b7884a5bd2e6bfe6a15ccb7", "f1fc7a0bf480b1034f0f1d9cba3b4d0b"),
        ("fn_ca_settle_final_table_deal_share_raw", "uuid,uuid,numeric", "58e2768644b692f23a9a071a8a5d1ee8", "852e35483b67c1fc59b6347b51c79cb8"),
    ]:
        original = definition(m4_source, name, before)
        tag = re.search(r"AS\s+(\$[A-Za-z_]*\$)", original)
        body = original[tag.end():original.index(tag.group(1), tag.end())]
        transformed = once(body, "public.fn_settle_tournament_obligation(",
                           "public.fn_settle_tournament_obligation_before_atomic_batch_gate(")
        if hashlib.md5(transformed.encode()).hexdigest() != after:
            raise ValueError("tracked retained payer transformation differs: " + name)
        signature = "public." + name + "(" + identity + ")"
        baseline_sql += ("DO $retained_payer$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc"
            " WHERE oid=" + quote(signature) + "::regprocedure AND md5(prosrc)=" + quote(after)
            + " AND pg_get_userbyid(proowner)='postgres' AND prosecdef"
            " AND proconfig=ARRAY['search_path=public']::text[]"
            " AND proacl=ARRAY['postgres=X/postgres']::aclitem[])"
            " THEN RAISE EXCEPTION 'retained tracked payer baseline differs'; END IF; END $retained_payer$;\n")
        baseline_sql += original + "\n"
    # Authenticate the retained strict public wrapper against the exact branch
    # base source before composing production's current refund-preserving wrapper.
    historical = subprocess.check_output(["git", "show",
        "852218608f3b67404c5fb3f95f105740eb3454f3:scripts/deploy/phase-three-strict-tournament-cutover.sql"],
        cwd=root, text=True)
    matches = re.findall(r"CREATE OR REPLACE FUNCTION public\.fn_settle_tournament_obligation\(.*?AS (\$[^$]*\$)(.*?)\1;", historical, re.S)
    if len(matches) != 1 or hashlib.md5(matches[0][1].encode()).hexdigest() != "7e4c7398d7daa25518b6737197fa3172":
        raise ValueError("retained baseline strict wrapper no longer matches tracked branch base")
    baseline_sql += """DO $retained_wrapper$ BEGIN IF NOT EXISTS(
        SELECT 1 FROM pg_proc WHERE oid='public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure
        AND md5(prosrc)='7e4c7398d7daa25518b6737197fa3172'
        AND pg_get_userbyid(proowner)='postgres' AND prosecdef
        AND proconfig=ARRAY['search_path=public, pg_temp']::text[]
        AND proacl=ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[])
        THEN RAISE EXCEPTION 'retained strict public wrapper differs'; END IF;
        END $retained_wrapper$;
"""
    baseline_sql += definition(root / "supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql",
        "fn_settle_tournament_obligation", "915f3ebd5c4a2efb97ad3a354dfeb365") + "\n"
    sql = once(sql, "BEGIN;", "BEGIN;\n" + baseline_sql)
    # full_stage1 already has the source fixture and the native M5/seat catalog.
    # Reuse that retained fixture rather than replaying either broad migration.
    fixture = (root / "scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql").read_text()
    fixture = once(once(fixture, "BEGIN;", ""), "COMMIT;", "")
    sql = once(sql, fixture, "")
    sql = once(sql, "current_database()<>'current_replay'", "current_database()<>'full_stage1'")
    sql = once(sql, "OR inet_server_addr() IS NOT NULL OR EXISTS(SELECT 1 FROM auth.users)",
               "OR inet_server_addr() IS NOT NULL OR (SELECT count(*) FROM auth.users)<>15 "
               "OR (SELECT count(*) FROM public.tournaments)<>12")
    sql = once(sql, "requires the empty root-owned local current_replay database with native cash authority",
               "requires the exclusively owned retained local full_stage1 baseline")
    sql = once(sql, "-- @FINAL_DEAL_RUNTIME@", runtime_sql(root))
    if len(re.findall(r"^BEGIN;$", sql, re.M)) != 1 or re.search(r"^COMMIT;$", sql, re.M):
        raise ValueError("native acceptance must remain one rollback-only outer transaction")
    return sql

def runtime_sql(root):
    # Install exact current narrow authorities inside this transaction only.
    m5 = root / "supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql"
    stage_b = module(root / STAGE_B_RESOLVER, "final_deal_stage_b_source").resolve(root)
    m4 = root / "supabase/migrations/20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql"
    stage = root / "scripts/deploy/phase-three-strict-tournament-cutover.sql"
    lane = root / "supabase/migrations/20260910035245_the_settlement_lane_is_per_tournament_not_platform_wide.sql"
    runtime = ""
    for name, signature, expected in [
        ("fn_ca_lock_settlement_lane_global", "", "343015440ea5c84ee4ca7ae583c73d30"),
        ("fn_ca_lock_settlement_lane_for_tournament", "uuid,uuid", "2bc939035496d764ff9d6c14b52fa1e7"),
        ("fn_ca_share_settlement_lane_for_table", "uuid", "006d78a441e65d000d1d78929649bb44"),
    ]:
        runtime += definition(lane, name, expected) + "\n"
        runtime += "REVOKE ALL ON FUNCTION public."+name+"("+signature+") FROM PUBLIC,anon,authenticated,service_role;\n"
        runtime += "GRANT EXECUTE ON FUNCTION public."+name+"("+signature+") TO service_role;\n"
    current_lane = json.loads((root / "docs/audits/2026-09-10-native-current-settlement-lane.json").read_text())
    lane_body = re.search(r"AS\s+(\$\w*\$)(.*?)\1", current_lane["definition"], re.S)[2]
    assert hashlib.md5(lane_body.encode()).hexdigest() == "3acb4c1d763181905cf5b64287f8f28f"
    runtime += current_lane["definition"] + ";\n"
    # Replay only the two reviewed current dependencies omitted from the
    # retained fixture. Both byte identities were read from production.
    money = json.loads((root / "docs/audits/2026-09-10-native-current-money-authorities.json").read_text())
    current_core = next(item for item in money["money_functions"]
        if item["signature"].startswith("fn_settle_tournament_obligation_before_atomic_batch_gate("))
    current_seat = json.loads((root / "docs/audits/2026-09-10-native-current-seat-authority.json").read_text())
    for item, expected in [(current_core,"ebabbaf0456d80335aaa2e04471d0ab6"),
                           (current_seat,"0f491a45693fcf3182719647c5ed7aee")]:
        body = re.search(r"AS\s+(\$\w*\$)(.*?)\1", item["definition"], re.S)[2]
        assert hashlib.md5(body.encode()).hexdigest() == expected
        runtime += item["definition"] + ";\n"
    for path, name, before, after in [
        (m5, "fn_complete_tournament_terminal", "589388ad7204fef460a1deebf32ecb69", "f4275f9fa8cb2711f19ffdf7b16a04e6"),
        (m5, "fn_resolve_tournament_terminal_outcome", "4c151073f56b53e4b0363bdd916b78d4", "022c1883533939caf8ebed0cb5699e8c"),
        (m5, "fn_settle_tournament_rake", "b945872c72d3414909d4b4b41cfb7849", "05a512317bb7bdcecfaec19ef8ee4e63"),
        (m4, "fn_settle_tournament_places", "351bfe3e401ad90eeb9b40bad366bb0e", "d0262f4928b12eea1cc5e9175cbf2737"),
    ]:
        text = definition(path, name, before, after)
        runtime += text + "\n"
    wrapper = definition(
        stage_b, "fn_complete_tournament_terminal",
        "96a61ea5e16560735bcb70b355aa79ab",
    )
    # Match production's first-install shape: implementation at the public
    # name, no retained private copy. The migration must create that copy and
    # install the wrapper itself; its second execution then tests reapplication.
    runtime += "DROP FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text);\n"
    owners = [
        "fn_ca_tournament_terminal_receipt(uuid,uuid)",
        "fn_guard_tournament_completed_certificate()",
        "fn_guard_tournament_completing_claim()",
        "fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)",
        "fn_ca_close_tournament_seat_exit_authority(uuid,boolean)",
        "fn_tournament_finish_readiness(uuid,uuid)",
        "fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)",
        "fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)",
        "fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)",
        "fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)",
    ]
    public_service = [
        "trg_lock_atomic_final_table_deal_status()",
        "fn_complete_tournament_terminal(uuid,uuid,text)",
        "fn_resolve_tournament_terminal_outcome(uuid,uuid,text)",
        "fn_settle_tournament_rake(uuid,text)",
        "fn_attribute_tournament_rake(uuid)", "credit_club_rake_to_treasury(uuid,numeric)",
        "fn_settle_tournament_places(uuid,uuid)", "fn_claim_tournament_finish(uuid,uuid,text)",
        "trg_tournament_atomic_place_completion_guard()",
        "trg_freeze_batched_tournament_place()", "trg_atomic_final_table_deal_completion_guard()",
        "trg_freeze_atomic_final_table_deal_obligation()",
    ]
    for identity in owners + public_service:
        runtime += "REVOKE ALL ON FUNCTION public." + identity + " FROM PUBLIC,anon,authenticated,service_role;\n"
    for identity in public_service:
        runtime += "GRANT EXECUTE ON FUNCTION public." + identity + " TO service_role;\n"
    runtime += "REVOKE ALL ON TABLE public.tournament_seat_exit_authorizations FROM PUBLIC,anon,authenticated,service_role;\n"
    for table in ("tournament_final_table_deal_batches", "tournament_final_table_deal_receipts"):
        runtime += "REVOKE ALL ON TABLE public." + table + " FROM PUBLIC,anon,authenticated,service_role;\n"
        runtime += "GRANT SELECT ON TABLE public." + table + " TO service_role;\n"
    retry = (root / "scripts/deploy/2026-09-10-restore-rake-attribution-retries.sql").read_text()
    if digest(retry) != "f912f858c7f35004bfc2447fdf70329afc8a52029970e052c85c8e106fc83f2c":
        raise ValueError("reviewed live rake restoration source changed")
    runtime += re.sub(r"^(BEGIN|COMMIT);$", "", retry, flags=re.M) + "\n"
    bundle = (root / "scripts/deploy/phase-three-final-deal-terminal-v2.sql").read_text()
    if len(re.findall(r"^BEGIN;$", bundle, re.M)) != 1 or len(re.findall(r"^COMMIT;$", bundle, re.M)) != 1:
        raise ValueError("final-deal deployment must have exactly one outer transaction")
    bundle = re.sub(r"^(BEGIN|COMMIT);$", "", bundle, flags=re.M)
    # Exercise every deployment preflight/postflight and exact reapplication.
    runtime += bundle + "\n" + bundle + "\n"
    for marker in ("CANONICAL TERMINAL PLACE BATCH CONTRACT", "CANONICAL TERMINAL READINESS DISPATCH"):
        runtime += block(stage, marker)
    runtime += definition(stage, "fn_settle_tournament_obligation", "642b0a5a4b5cd5ab2194e265eadba75c") + "\n"
    runtime += "\n".join("ALTER TABLE public.tournaments ENABLE TRIGGER " + name + ";" for name in GUARDS) + "\n"
    runtime += "SELECT 'FINAL_DEAL_NATIVE_COMPOSITION='||jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'body_md5',md5(prosrc),'definition_md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl,'config',proconfig,'security_definer',prosecdef) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN (to_regprocedure('public.fn_settle_tournament_final_table_deal(uuid)'),to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)'),to_regprocedure('public.trg_freeze_canonical_final_deal_batch()'),to_regprocedure('public.trg_freeze_atomic_final_table_deal_obligation()'),to_regprocedure('public.fn_claim_tournament_finish(uuid,uuid,text)'),to_regprocedure('public.fn_ca_tournament_terminal_receipt(uuid,uuid)'),to_regprocedure('public.fn_guard_tournament_completing_claim()'),to_regprocedure('public.trg_lock_atomic_final_table_deal_status()'),to_regprocedure('public.fn_guard_tournament_completed_certificate()'),to_regprocedure('public.fn_complete_tournament_terminal(uuid,uuid,text)'),to_regprocedure('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'),to_regprocedure('public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)'),to_regprocedure('public.fn_complete_tournament_terminal_proposal(uuid,uuid,text,uuid,text)'),to_regprocedure('public.fn_resolve_tournament_terminal_proposal_outcome(uuid,uuid,text,uuid,text)'),to_regprocedure('public.fn_tournament_finish_readiness(uuid,uuid)'),to_regprocedure('public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)'),to_regprocedure('public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)'),to_regprocedure('public.fn_tournament_live_seat_exit_requires_authority()'),to_regprocedure('public.fn_settle_tournament_rake(uuid,text)'),to_regprocedure('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)'),to_regprocedure('public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)'),to_regprocedure('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)'),to_regprocedure('public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'),to_regprocedure('public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'),to_regprocedure('public.trg_atomic_final_table_deal_completion_guard()'),to_regprocedure('public.fn_stamp_tournament_terminal_evidence_markers()'),to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)'),to_regprocedure('public.fn_ca_verify_terminal_place_batch(uuid,boolean)'))),'guards',(SELECT jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid)) ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgname ~ '(atomic.*(place|deal)|financial.*certif|completing.*claim|seat_exit|terminal_receipt|pending_bounty|canonical_final_deal_batch)'),'batch_constraints',(SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid),'md5',md5(pg_get_constraintdef(oid))) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.tournament_final_table_deal_batches'::regclass),'batch_version_column',(SELECT jsonb_build_object('type',atttypid::regtype::text,'not_null',attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.tournament_final_table_deal_batches'::regclass AND a.attname='contract_version'))::text;\n"
    return runtime

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--variant", choices=("paid", "unpaid", "partial"), action="append")
    args = parser.parse_args()
    root = args.root.resolve()
    baseline = read_sql("SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text"
        "||'|'||(SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)"
        "||'|'||(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())"
        "||'|'||EXISTS(SELECT 1 FROM public.tournaments WHERE id='" + TID + "')::text")
    if baseline != "full_stage1|postgres|true|15|12|0|false":
        raise RuntimeError("retained native database baseline differs: " + baseline)
    cash = module(root / "scripts/ci/rehearse-stage-b-cash-payers.py", "cash_snapshot")
    tables = list(cash.TABLES) + [
        "public.tournament_terminal_settlements", "public.tournament_finish_receipts",
        "public.tournament_seat_exit_authorizations", "public.tournament_rake_settlements",
        "public.rake_records", "public.rake_attributions", "public.agent_commissions",
        "public.club_wallets", "public.union_wallets", "public.unions", "public.hand_atomic_commits",
        "public.player_stats", "public.vip_points_carry", "public.engine_tournament_leases",
        "public.tournament_seat_move_receipts",
    ]
    before = snapshot(tables)
    output = Path(tempfile.mkdtemp(prefix="codex-final-deal-v2-native-"))
    evidence = {"recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "database": DB, "baseline": baseline, "production_ddl_applied": False,
        "whole_stage_b_executed": False, "entire_final_deal_bundle_applied_twice": True,
        "synthetic_opening_fixture_only": True,
        "runtime_session_replication_role": "origin", "guards_enabled": list(GUARDS),
        "before": before, "variants": [], "output_directory": str(output)}
    for variant in args.variant or ("paid", "unpaid", "partial"):
        sql = compose(root, variant)
        path = output / (variant + ".sql")
        path.write_text(sql)
        run = subprocess.run([PSQL, "-X", "-h", SOCKET, "-p", "55473", "-U", "postgres",
            "-d", DB, "-At", "-v", "ON_ERROR_STOP=1", "-f", str(path)], text=True, capture_output=True)
        log = run.stdout + run.stderr
        (output / (variant + ".log")).write_text(log)
        after = snapshot(tables)
        rows = [line[len("FINAL_DEAL_NATIVE_EVIDENCE="):] for line in run.stdout.splitlines()
                if line.startswith("FINAL_DEAL_NATIVE_EVIDENCE=")]
        compositions = [line[len("FINAL_DEAL_NATIVE_COMPOSITION="):] for line in run.stdout.splitlines()
                        if line.startswith("FINAL_DEAL_NATIVE_COMPOSITION=")]
        item = {"variant": variant, "exit_code": run.returncode,
                "assertions": len(re.findall(r"NOTICE:\s+PASS ", log)),
                "sql_sha256": digest(sql), "exact_rollback": before == after,
                "terminal_evidence": json.loads(rows[0]) if len(rows) == 1 else None,
                "runtime_composition": json.loads(compositions[0]) if len(compositions) == 1 else None}
        item["passed"] = run.returncode == 0 and before == after and item["terminal_evidence"] is not None and item["runtime_composition"] is not None
        evidence["variants"].append(item)
        evidence["after"] = after
        print(json.dumps(item), flush=True)
        if not item["passed"]:
            item["failure_tail"] = re.sub(r"psql:[^:\n]+:\d+:", "psql:", log).splitlines()[-24:]
            print("\n".join(item["failure_tail"]), flush=True)
            break
    evidence["status"] = "passed" if all(x["passed"] for x in evidence["variants"]) else "failed"
    stage_b = module(root / STAGE_B_RESOLVER, "final_deal_stage_b_evidence").resolve(root)
    evidence["source_sha256"] = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (Path(__file__), root / STAGE_B_RESOLVER, stage_b,
            root / "scripts/ci/probes/final-deal-current-terminal-native.sql",
            root / "scripts/deploy/phase-three-final-deal-terminal-v2.sql",
            root / "scripts/deploy/phase-three-strict-tournament-cutover.sql",
            root / "scripts/dev/build-versioned-final-deal-probe.py")}
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    if evidence["status"] != "passed":
        raise SystemExit(1)

if __name__ == "__main__":
    main()
