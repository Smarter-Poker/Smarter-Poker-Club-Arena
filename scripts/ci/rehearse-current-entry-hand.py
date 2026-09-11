#!/usr/bin/env python3
"""Rollback-only current entry acceptance on the coordinator's existing PG17 DB."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
P = argparse.ArgumentParser()
P.add_argument("--output", type=Path, required=True)
P.add_argument("--prepare-only", action="store_true")
P.add_argument("--without-entry-fix", action="store_true")
P.add_argument("--without-receipt-fix", action="store_true")
A = P.parse_args()
CMD = ["/opt/homebrew/opt/postgresql@17/bin/psql", "-X", "-qAt",
       "-h", "/tmp/codex-chip-drift-cutover-e2iav203/socket", "-p", "55473",
       "-U", "postgres", "-d", "full_stage1", "-v", "ON_ERROR_STOP=1"]
PROBE = ROOT / "scripts/ci/probes/tournament-current-entry-hand-acceptance.sql"
SOURCES = {
 "seater": "supabase/migrations/20260828023513_fix_late_registrant_seating_and_seat_first_guard.sql",
 "blinds": "supabase/migrations/20260910132723_booked_spin_continuation_preserves_floating_point_rounding.sql",
 "entry_fix": "supabase/migrations/20260910190537_late_entry_uses_canonical_capacity_and_charged_wallet_receip.sql",
 "request": "supabase/migrations/20260909210701_tournament_registration_retains_original_operation_receipt.sql",
 "resolver": "supabase/migrations/20260910020626_the_host_club_is_in_its_own_union.sql",
 "wallet": "supabase/migrations/20260910023919_the_entry_is_charged_to_the_wallet_the_entry_is_stamped_with.sql",
 "logger": "supabase/migrations/20260910012633_tournament_entry_receipts_use_the_charged_club_wallet.sql",
}
def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()
def run(sql):
    return subprocess.run(CMD, input=sql, text=True, capture_output=True, timeout=75)
def read(sql):
    r = run(sql)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()
def function(text, name):
    found = list(re.finditer(
        r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\."+re.escape(name)+
        r"\s*\(.*?\bAS\s+(\$[A-Za-z_0-9]*\$)(.*?)\1\s*;", text, re.S | re.I))
    if len(found) != 1:
        raise ValueError("exact function not unique: "+name)
    return found[0][0]
def compose():
    sources = {key:(ROOT/path).read_text() for key,path in SOURCES.items()}
    request = sources["request"]
    request = re.sub(r"^BEGIN;\s*", "", request)
    request = re.sub(r"\s*COMMIT;\s*$", "", request)
    # Reuse the exact tracked substitution, excluding its production-row assertion.
    resolver = sources["resolver"]
    resolver = resolver[resolver.index("DO $mig$"):resolver.index("  v_check :=")]
    resolver += """
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
      'public.fn_tournament_club_for_user(uuid,uuid,uuid)'::regprocedure)
       IS DISTINCT FROM 'f80eff4c311820670f1b71d15c29452d' THEN
    RAISE EXCEPTION 'current resolver postcondition differs';
  END IF;
END $mig$;
"""
    wallet = function(sources["wallet"], "atomic_deduct_wallet_and_log")
    logger = function(sources["logger"], "log_wallet_transaction")
    seater = function(sources["seater"], "fn_seat_late_registrant")
    seater = seater.replace("public.fn_seat_late_registrant(",
        "public.fn_seat_late_registrant_before_maintenance_gate(",1)
    marker = "  PERFORM set_config('app.money_path', 'fn_seat_late_registrant', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)\n"
    seater = seater.replace("\nBEGIN\n","\nBEGIN\n"+marker,1)
    seater_body = re.search(r"AS\s+(\$\w*\$)(.*?)\1",seater,re.S)[2]
    assert hashlib.md5(seater_body.encode()).hexdigest()=="d2970964d6eedb9babfd6c47ebe66e9b"
    blinds = function(sources["blinds"], "fn_resolve_tournament_blinds")
    fix = re.sub(r"^BEGIN;\s*", "", sources["entry_fix"], flags=re.M)
    fix = re.sub(r"\s*COMMIT;\s*$", "", fix)
    if A.without_entry_fix:
        fix = ""
    if A.without_receipt_fix:
        fix += "\n"+logger
    grants = """
REVOKE ALL ON FUNCTION public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_resolve_tournament_blinds(text,integer,text,text,numeric) FROM PUBLIC,anon,authenticated,service_role;
"""


    return ("BEGIN;\nSET LOCAL statement_timeout='60s';\nSET LOCAL lock_timeout='5s';\n"+
            request+"\n"+resolver+"\n"+wallet+"\n"+logger+"\n"+seater+"\n"+blinds+"\n"+grants+"\n"+fix+"\n"+
            PROBE.read_text()+"\nROLLBACK;\n")
TABLES = [
 "auth.users","auth.sessions","public.users","public.profiles","public.clubs",
 "public.unions","public.union_clubs","public.club_members","public.tournaments",
 "public.tournament_players","public.tables","public.table_seats",
 "public.chip_transactions","public.chip_ledger","public.wallet_transactions",
 "public.tournament_escrow","public.rake_records","public.tournament_refund_entitlements",
 "public.entry_purchase_idempotency_receipts","public.tournament_capacity_table_receipts",
 "public.tournament_manager_wakes","public.tournament_seat_exit_authorizations",
]
def snapshot():
    result = {}
    for relation in TABLES:
        result[relation] = read("SELECT json_build_object('count',count(*),'md5',"
            "md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),''))) "
            "FROM "+relation+" t;")
    for catalog in ["pg_proc","pg_trigger","pg_class","pg_attribute","pg_attrdef",
                    "pg_constraint","pg_index","pg_policy"]:
        result[catalog] = read("SELECT md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n'"
            " ORDER BY row_to_json(t)::text),'')) FROM pg_catalog."+catalog+" t;")
    return result
payload = compose()
report = {
 "production_mutations":False, "phase_complete":False, "entry_fix_applied":not A.without_entry_fix, "receipt_fix_applied":not(A.without_entry_fix or A.without_receipt_fix),
 "source_checkout":subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip(),
 "source_sha256":{path:digest((ROOT/path).read_text()) for path in SOURCES.values()},
 "probe_sha256":digest(PROBE.read_text()), "composed_sha256":digest(payload),
 "scope":"Actual authenticated request-bound late entry and exact funding provenance",
 "limitations":["Synthetic local fixture; no production mutation",
 "The complete current client, engine, HTTP and staged activation are separate acceptance gates",
 "Existing committed move races and regression evidence are reused and not rerun"],
}
if A.prepare_only:
    print(json.dumps(dict(report,prepared=True,executed=False),indent=2))
else:
    connection=json.loads(read("SELECT jsonb_build_object('database',current_database(),"
        "'user',current_user,'local',inet_server_addr() IS NULL,'others',"
        "(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));"))
    assert connection=={"database":"full_stage1","user":"postgres","local":True,"others":0},connection
    before = snapshot()
    result = run(payload)
    after = snapshot()
    report.update(
        recorded_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        exit_code=result.returncode, rollback_exact=(before==after),
        restored_relations=list(before), before_sha256=digest(json.dumps(before,sort_keys=True)),
        after_sha256=digest(json.dumps(after,sort_keys=True)),
        output=result.stdout, error=result.stderr, passed=False)
    if result.returncode==0:
        rows=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{"probe"')]
        assert len(rows)==1, "missing unambiguous terminal result"
        report["result"]=rows[0]
        report["passed"]=rows[0].get("passed") is True and before==after
    A.output.parent.mkdir(parents=True,exist_ok=True)
    A.output.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({k:report[k] for k in ["passed","rollback_exact","exit_code","error"]}))
    assert report["passed"], "native acceptance did not pass; evidence retained"
