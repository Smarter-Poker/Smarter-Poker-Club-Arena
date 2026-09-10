#!/usr/bin/env python3
"""Rehearse the complete current Spin migration in one local rollback transaction."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone

SOURCE_SHA = "0634d1da3856c1db483ea99fb9713838a5c7c5158e1d2f3ee6daf58f335dcf7f"
PREIMAGE = "1c911e3ada50ffe0493b9b375e3fa9ae"
PASS = "AUDIT_TEST_PASS: current zero-default Spin wrapper"
TABLES = (
    "auth.users", "public.profiles", "public.clubs", "public.club_members",
    "public.tournaments", "public.tournament_players", "public.tables",
    "public.table_seats", "public.engine_tournament_leases", "public.hand_history",
    "public.wallet_transactions", "public.chip_ledger", "public.tournament_escrow",
    "public.rake_records", "public.spin_bonus_pools", "public.spin_reserve_ledger",
    "public.spin_draw_receipts", "public.tournament_launch_receipts",
    "public.tournament_refund_entitlements",
)


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--psql", default="psql")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.socket.is_absolute() or not args.socket.is_dir():
        parser.error("an existing absolute Unix socket directory is required")
    if args.database != "full_stage1":
        parser.error("this checkpoint is scoped to the owned full_stage1 rehearsal database")
    source = args.source.read_text()
    if sha(source) != SOURCE_SHA:
        raise SystemExit("complete tracked 20260910034412 migration SHA256 mismatch")
    probe_path = Path(__file__).parent / "probes/spin-zero-projection-native.sql"
    probe = probe_path.read_text()
    if len(re.findall(r"^BEGIN;$", source, re.M)) != 1 or len(re.findall(r"^COMMIT;$", source, re.M)) != 1:
        raise SystemExit("migration transaction boundaries changed")
    if len(re.findall(r"^BEGIN;$", probe, re.M)) != 1:
        raise SystemExit("probe transaction boundary changed")
    cmd = [args.psql, "-X", "-h", str(args.socket), "-p", str(args.port),
           "-U", "postgres", "-d", args.database, "-v", "ON_ERROR_STOP=1", "-At"]

    def read(sql):
        result = subprocess.run(cmd, input=sql, text=True, capture_output=True, check=True)
        return result.stdout.strip()

    connection = json.loads(read("SELECT jsonb_build_object('database',current_database(),"
                                 "'user',current_user,'local',inet_server_addr() IS NULL,"
                                 "'other_sessions',(SELECT count(*) FROM pg_stat_activity "
                                 "WHERE datname=current_database() AND pid<>pg_backend_pid()));"))
    if connection != {"database": "full_stage1", "user": "postgres", "local": True, "other_sessions": 0}:
        raise SystemExit("owned idle local PostgreSQL connection is required")
    catalog_sql = """SELECT jsonb_build_object(
      'authority',(SELECT jsonb_build_object('body_md5',md5(prosrc),
       'definition_md5',md5(pg_get_functiondef(oid)),'acl',proacl,'config',proconfig,
       'owner',pg_get_userbyid(proowner),'security_definer',prosecdef)
       FROM pg_proc WHERE oid='public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,
       'name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid))
       ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE NOT tgisinternal));"""
    before_catalog = read(catalog_sql)
    catalog = json.loads(before_catalog)
    if catalog["authority"]["definition_md5"] != PREIMAGE:
        raise SystemExit("exact prior Spin authority is required")

    def state():
        pairs = []
        for table in TABLES:
            pairs.append("'" + table + "',(SELECT jsonb_agg(row ORDER BY row::text) "
                         "FROM (SELECT to_jsonb(t) AS row FROM " + table + " t) rows)")
        return read("SELECT jsonb_build_object(" + ",".join(pairs) + ");")

    before_state = state()
    composed = "BEGIN;\nSET LOCAL statement_timeout='45s';\nSET LOCAL lock_timeout='5s';\n"
    composed += re.sub(r"^(BEGIN|COMMIT);$", "", source, flags=re.M)
    composed += "\n" + re.sub(r"^BEGIN;$", "", probe, flags=re.M)
    result = subprocess.run(cmd, input=composed, text=True, capture_output=True)
    log = result.stdout + result.stderr
    args.output.with_suffix(".log").write_text(log)
    after_catalog = read(catalog_sql)
    after_state = state()
    passed = result.returncode == 3 and PASS in result.stderr
    restored = before_catalog == after_catalog and before_state == after_state
    evidence = {
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "source_sha256": SOURCE_SHA, "probe_sha256": sha(probe),
        "composed_sha256": sha(composed), "preimage": catalog["authority"],
        "native_exit": result.returncode, "expected_pass_exception": passed,
        "all_catalog_and_fixture_state_restored": restored,
        "catalog_before_sha256": sha(before_catalog), "catalog_after_sha256": sha(after_catalog),
        "state_before_sha256": sha(before_state), "state_after_sha256": sha(after_state),
        "fixture_tables_compared": list(TABLES), "production_mutations": False,
        "connection": connection,
    }
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"expected_pass_exception": passed, "rollback_exact": restored,
                      "native_exit": result.returncode, "evidence": str(args.output)}))
    if not passed or not restored:
        print(log[-4000:])
        raise SystemExit(1)


if __name__ == "__main__":
    main()
