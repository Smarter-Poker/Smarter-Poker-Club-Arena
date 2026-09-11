#!/usr/bin/env python3
"""Execute the whole prepared Stage B twice in owned native PG, then roll back.

Runs one real final-deal terminal case through the complete cutover. Does not
deploy or certify engine adoption. Missing production break-bootstrap coverage
is reported separately and cannot be treated as Phase 3 completion.
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


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def q(text):
    return "'" + text.replace("'", "''") + "'"


def read_sql(query):
    return subprocess.check_output([PSQL, "-X", "-h", SOCKET, "-p", "55473",
        "-U", "postgres", "-d", DB, "-At", "-v", "ON_ERROR_STOP=1", "-c", query],
        text=True).strip()


def function(source, name, expected):
    matches = list(re.finditer(r"CREATE (?:OR REPLACE )?FUNCTION " + re.escape(name)
        + r"\(.*?\bAS\s+(\$\w*\$)(.*?)\1;", source, re.S | re.I))
    if len(matches) != 1 or hashlib.md5(matches[0][2].encode()).hexdigest() != expected:
        raise ValueError("exact function source differs: " + name)
    return matches[0][0]


def without_transaction(source):
    if len(re.findall(r"^BEGIN;$", source, re.M)) != 1 or len(re.findall(r"^COMMIT;$", source, re.M)) != 1:
        raise ValueError("source must have exactly one outer transaction")
    return re.sub(r"^(BEGIN|COMMIT);$", "", source, flags=re.M)


def replacement(source, start, end):
    expr = source.split(start, 1)[1].split(end, 1)[0]
    return "".join(x.replace("''", "'").replace("\\n", "\n")
        for x in re.findall(r"E'((?:[^']|'')*)'", expr))


def snapshot():
    catalogs = ("pg_proc", "pg_trigger", "pg_class", "pg_attribute", "pg_attrdef",
        "pg_constraint", "pg_index", "pg_policy", "pg_namespace", "pg_default_acl",
        "pg_db_role_setting", "pg_event_trigger", "pg_depend", "pg_shdepend", "pg_description")
    tables = json.loads(read_sql("""
SELECT COALESCE(json_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname,c.relname),'[]'::json)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','auth','smarter_private','cron') AND c.relkind IN ('r','p')
"""))
    queries = []
    for name in ["pg_catalog." + c for c in catalogs] + tables:
        queries.append("SELECT " + q(name) + " name,jsonb_build_object('count',count(*),"
            "'md5',md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' "
            "ORDER BY row_to_json(t)::text),''))) value FROM " + name + " t")
    result = {}
    for offset in range(0, len(queries), 60):
        result.update(json.loads(read_sql("SELECT jsonb_object_agg(name,value) FROM ("
            + " UNION ALL ".join(queries[offset:offset + 60]) + ") s")))
    return result


def request_dependencies(root):
    migrations = root / "supabase/migrations"
    busy = (migrations / "20260910063559_a_busy_manager_keeps_its_lease.sql").read_text()
    hook = function((migrations / "20260908043200_tournament_manager_requests_carry_lease_authority.sql").read_text(),
        "smarter_private.fn_smarter_data_api_pre_request", "79419c8aa9365edabf9b01b8a44d70a5")
    anchor = "     FOR SHARE;\n  END IF;"
    if hook.count(anchor) != 1:
        raise ValueError("Stage A hook anchor differs")
    hook = hook.replace(anchor, replacement(busy, "v_hook_new    text :=", "v_claim_anchor text :="), 1)
    hook = function(hook, "smarter_private.fn_smarter_data_api_pre_request", "ab227471f29f2944ebd64909622b6af7")
    claim = function((migrations / "20260908042900_tournament_leases_have_fencing_generations.sql").read_text(),
        "public.claim_tournament_lease_v2", "5396bfe7cfc936851d831aeb387d2751")
    anchor = "  INSERT INTO public.engine_tournament_leases AS l ("
    if claim.count(anchor) != 1:
        raise ValueError("takeover anchor differs")
    claim = claim.replace(anchor, replacement(busy, "v_claim_new    text :=", "BEGIN\n  -- 1. the hook"), 1)
    claim = function(claim, "public.claim_tournament_lease_v2", "d1b5100c2b9f92bec5fd1680b0b4f230")
    heartbeat = function((migrations / "20260908221010_lease_heartbeats_skip_busy_generations.sql").read_text(),
        "public.heartbeat_tournament_leases_v4", "5e6c99545e07c21efcb50e5cb3441c14")
    sql = """
DO $native_request_preimages$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
  AND md5(prosrc)='5aa393562da8742a2f5ef99ab15fcca6' AND prosecdef AND proowner='postgres'::regrole)
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure
  AND md5(prosrc)='5396bfe7cfc936851d831aeb387d2751' AND prosecdef AND proowner='postgres'::regrole)
 OR to_regprocedure('public.heartbeat_tournament_leases_v4(text,jsonb,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'owned Stage A request baseline differs'; END IF;
END $native_request_preimages$;
"""
    sql += hook + "\n" + claim + "\n" + heartbeat + "\n"
    sql += """
-- Native clone restores the SELECT/UPDATE grants verified true on the bound production project.
GRANT SELECT,UPDATE ON public.tournaments TO service_role;
GRANT SELECT ON public.clubs,public.tournament_players,public.managed_game_contract_versions TO service_role;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT EXECUTE ON FUNCTION auth.role(),auth.uid() TO service_role;
REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() FROM PUBLIC,anon,authenticated,service_role,authenticator;
GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() TO anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v4(text,jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text,jsonb,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reveal(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reveal(uuid,uuid,boolean) TO authenticated,service_role;
"""
    return sql


REQUEST_PROBE = """
CREATE FUNCTION pg_temp.whole_stage_assert(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $assert$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 RAISE NOTICE 'PASS %',label;
END $assert$;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.headers','{}',true),set_config('request.method','POST',true),
 set_config('request.path','rpc/claim_tournament_lease_v2',true);
DO $unmarked$
DECLARE refused boolean:=false;
BEGIN
 BEGIN PERFORM smarter_private.fn_smarter_data_api_pre_request();
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 PERFORM pg_temp.whole_stage_assert(refused,'whole Stage B denies unmarked exact engine request');
END $unmarked$;
SELECT set_config('request.headers','{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',true);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.whole_stage_assert(granted,'current exact claim grants synthetic manager')
 FROM public.claim_tournament_lease_v2('87000000-0000-0000-0000-000000000001',
 'native-whole-phase-three','native-reviewed-source','87900000-0000-0000-0000-000000000001',30);
SELECT set_config('request.headers',
 '{"x-smarter-data-actor":"tournament-manager","x-smarter-data-protocol":"2","x-smarter-tournament-id":"87000000-0000-0000-0000-000000000001","x-smarter-tournament-lease-generation":"87900000-0000-0000-0000-000000000001"}',true),
 set_config('request.path','tournaments',true),set_config('request.method','PATCH',true);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.whole_stage_assert(current_setting('app.smarter_manager_request_fenced',true)='protocol-2',
 'whole Stage B request hook proves real current lease generation');
UPDATE public.tournaments SET name=name WHERE id='87000000-0000-0000-0000-000000000001';
DO $scope$
DECLARE refused boolean:=false;
BEGIN
 BEGIN
  UPDATE public.tournaments SET name=name WHERE id='30000000-0000-0000-0000-000000000001';
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 PERFORM pg_temp.whole_stage_assert(refused,'whole Stage B row trigger rejects cross-event manager write');
END $scope$;
RESET ROLE;
SELECT set_config('app.smarter_data_actor','',true),set_config('app.smarter_manager_request_fenced','',true),
 set_config('app.smarter_tournament_id','',true),set_config('app.smarter_tournament_lease_generation','',true),
 set_config('request.jwt.claims','{}',true),set_config('request.headers','{}',true);
SELECT 'WHOLE_STAGE_B_CATALOG='||jsonb_build_object(
 'hook_md5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='smarter_private.fn_smarter_data_api_pre_request()'::regprocedure),
 'legacy_hand_door',to_regprocedure('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'),
 'lease_table_service_write',has_table_privilege('service_role','public.engine_tournament_leases','UPDATE'),
 'scope_triggers',(SELECT count(*) FROM pg_trigger WHERE tgname='a0_tournament_manager_write_scope' AND tgenabled<>'D' AND NOT tgisinternal),
 'break_window_triggers',(SELECT COALESCE(jsonb_agg(evtname ORDER BY evtname),'[]'::jsonb) FROM pg_event_trigger
  WHERE evtname IN ('ca_break_window_refuses_ddl','ca_break_window_refuses_drops') AND evtenabled='O')
)::text;
"""


def compose(root, bootstrap=None):
    final = module(root / "scripts/ci/rehearse-final-deal-current-terminal.py", "whole_phase_final")
    original_runtime = final.runtime_sql
    stage = without_transaction((root / "scripts/deploy/phase-three-strict-tournament-cutover.sql").read_text())

    def runtime(selected_root):
        original = original_runtime(selected_root)
        marker = "-- BEGIN CANONICAL TERMINAL PLACE BATCH CONTRACT"
        if original.count(marker) != 1:
            raise ValueError("final runtime cutover marker differs")
        prefix = original.split(marker, 1)[0]
        marker = "SELECT 'FINAL_DEAL_NATIVE_COMPOSITION='"
        if original.count(marker) != 1:
            raise ValueError("composition evidence marker differs")
        manifest = marker + original.split(marker, 1)[1]
        preparation = request_dependencies(root)
        # Match expand state before the complete contraction. All seven guards
        # are enabled by Stage B before any acceptance payment is attempted.
        preparation += "\n".join("ALTER TABLE public.tournaments DISABLE TRIGGER " + n + ";"
            for n in final.GUARDS) + "\n"
        bootstrap_sql = without_transaction(bootstrap.read_text()) + "\n" if bootstrap else ""
        return prefix + preparation + bootstrap_sql + stage + "\n" + stage + "\n" + manifest + REQUEST_PROBE

    final.runtime_sql = runtime
    try:
        sql = final.compose(root, "paid")
    finally:
        final.runtime_sql = original_runtime
    if len(re.findall(r"^BEGIN;$", sql, re.M)) != 1 or re.search(r"^COMMIT;$", sql, re.M):
        raise ValueError("native SQL must contain one rollback-only transaction")
    if len(re.findall(r"^ROLLBACK;$", sql, re.M)) != 1:
        raise ValueError("native SQL must end with exactly one rollback")
    return sql


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--bootstrap-migration", type=Path)
    parser.add_argument("--emit-only", type=Path, help="compose SQL without a database connection")
    args = parser.parse_args()
    root = args.root.resolve()
    if "/.agent-trees/" not in str(root):
        raise SystemExit("requires the explicitly owned repository worktree")
    bootstrap = args.bootstrap_migration.resolve() if args.bootstrap_migration else None
    if bootstrap and (not bootstrap.is_file() or "20260910164655" not in bootstrap.name):
        raise SystemExit("requires exact available 20260910164655 bootstrap source")
    sql = compose(root, bootstrap)
    if args.emit_only:
        args.emit_only.write_text(sql)
        print(json.dumps({"sql":str(args.emit_only),"sha256":digest(sql),"database_connected":False}))
        return
    baseline = read_sql("""
SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text||'|'||
 (SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)||'|'||
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())||'|'||
 (SELECT count(*) FROM public.tournament_seat_move_receipts)||'|'||
 EXISTS(SELECT 1 FROM public.tournaments WHERE id='87000000-0000-0000-0000-000000000001')::text
""")
    if baseline != "full_stage1|postgres|true|15|12|0|3|false":
        raise SystemExit("exclusive retained baseline differs: " + baseline)
    before = snapshot()
    output = Path(tempfile.mkdtemp(prefix="codex-whole-phase-three-"))
    path = output / "whole-stage-b.sql"
    path.write_text(sql)
    run = subprocess.run([PSQL,"-X","-h",SOCKET,"-p","55473","-U","postgres","-d",DB,
        "-At","-v","ON_ERROR_STOP=1","-f",str(path)],capture_output=True,text=True)
    log = run.stdout + run.stderr
    (output / "whole-stage-b.log").write_text(log)
    after = snapshot()

    def row(prefix):
        values = [s[len(prefix):] for s in run.stdout.splitlines() if s.startswith(prefix)]
        return json.loads(values[0]) if len(values) == 1 else None

    terminal, cutover = row("FINAL_DEAL_NATIVE_EVIDENCE="), row("WHOLE_STAGE_B_CATALOG=")
    passed = run.returncode == 0 and before == after and terminal is not None and cutover is not None
    covered = bootstrap is not None and cutover is not None and len(cutover["break_window_triggers"]) == 2
    evidence = {"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "database":DB,"baseline":baseline,"status":"passed" if passed else "failed",
        "whole_stage_b_executed_twice":run.returncode == 0,"production_ddl_applied":False,
        "engine_adoption_verified":False,"production_break_bootstrap_covered":covered,
        "bootstrap_source":str(bootstrap) if bootstrap else None,
        "bootstrap_source_sha256":digest(bootstrap.read_text()) if bootstrap else None,
        "coverage_gaps":[] if covered else ["Current production break-window bootstrap compatibility is not certified."],
        "exit_code":run.returncode,"assertions":len(re.findall(r"NOTICE:\s+PASS ",log)),
        "exact_rollback":before == after,
        "changed_after_rollback":[k for k in sorted(set(before)|set(after)) if before.get(k) != after.get(k)],
        "terminal_evidence":terminal,"cutover_catalog":cutover,
        "runtime_composition":row("FINAL_DEAL_NATIVE_COMPOSITION="),
        "before":before,"after":after,"output_directory":str(output),"sql_sha256":digest(sql),
        "source_sha256":{str(p.relative_to(root)):digest(p.read_text()) for p in
            (Path(__file__),root/"scripts/ci/rehearse-final-deal-current-terminal.py",
             root/"scripts/deploy/phase-three-strict-tournament-cutover.sql",
             root/"scripts/deploy/phase-three-final-deal-terminal-v2.sql")},
        "failure_tail":[] if passed else log.splitlines()[-32:]}
    args.evidence.write_text(json.dumps(evidence,indent=2)+"\n")
    print(json.dumps({k:evidence[k] for k in ("status","exit_code","assertions","exact_rollback",
        "changed_after_rollback","production_break_bootstrap_covered","coverage_gaps","output_directory","failure_tail")}),
        flush=True)
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
