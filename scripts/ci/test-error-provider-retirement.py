"""Qualify provider retirement against an isolated PostgreSQL 17 catalog and rows."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "scripts/ci/probes/error-provider-retirement"
MIGRATION = ROOT / "supabase/migrations/20260916052500_retire_external_error_provider.sql"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, default=ROOT / "artifacts/error-provider-retirement")
output = parser.parse_args().output.resolve()
output.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
env["LC_ALL"] = "C"
cluster = Path(tempfile.mkdtemp(prefix="provider-retirement-"))
socket = cluster / "socket"
socket.mkdir(mode=0o700)
psql = [str(pg / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
        "-h", str(socket), "-p", "55791", "-U", "postgres", "-d", "postgres"]
receipt = {"checks": [], "production_mutations": False,
           "migration_sha256": hashlib.sha256(MIGRATION.read_bytes()).hexdigest()}
migration = MIGRATION.read_text()
custody = json.loads((FIXTURE / "catalog-custody.json").read_text())


def command(argv, sql=None, expect_success=True):
    result = subprocess.run(list(map(str, argv)), input=sql, text=True,
                            capture_output=True, env=env, timeout=35)
    if expect_success and result.returncode:
        raise RuntimeError(result.stderr)
    return result


def run(sql):
    return command(psql, sql).stdout.strip()


def check(name, condition):
    receipt["checks"].append({"name": name, "passed": bool(condition)})
    if not condition:
        raise AssertionError(name)


def refused(sql, message):
    result = command(psql, sql, expect_success=False)
    return result.returncode != 0 and message in result.stderr


def archive_hash():
    return run("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.archive_signup_errors(integer)'::regprocedure")


def provider_tables():
    return int(run("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                   "WHERE n.nspname='public' AND c.relname IN "
                   "('sentry_error_log','sentry_event_budget','sentry_event_fingerprints')"))


def forwarding_columns():
    return int(run("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' "
                   "AND table_name IN ('signup_errors','signup_errors_archive') "
                   "AND column_name='forwarded_to_sentry'"))


try:
    check("native-postgresql-17", "PostgreSQL) 17." in command([pg / "postgres", "--version"]).stdout)
    command([pg / "initdb", "-D", cluster / "data", "-U", "postgres", "--auth-local=trust",
             "--auth-host=reject", "--no-locale", "--encoding=UTF8"])
    command([pg / "pg_ctl", "-D", cluster / "data", "-l", cluster / "server.log", "-o",
             f"-k {socket} -p 55791 -c listen_addresses='' -c timezone=UTC "
             "-c shared_buffers=16MB -c max_connections=10 -c statement_timeout=10000", "-w", "start"])
    run((FIXTURE / "baseline.sql").read_text())
    check("baseline-is-exact-observed-archive-body", archive_hash() == custody["archive_function_body_md5"])
    check("baseline-demonstrates-provider-remains", provider_tables() == 3 and forwarding_columns() == 2)
    run("""INSERT INTO public.signup_errors
      (id,user_id,email,trigger_name,error_code,error_msg,raw_meta,occurred_at,forwarded_to_sentry)
      VALUES (101,'00000000-0000-0000-0000-000000000101','synthetic-old@example.test','synthetic-trigger','TEST','synthetic failure','{"fixture":101}',now()-interval '45 days',now()),
             (102,NULL,'synthetic-recent@example.test','synthetic-trigger','RECENT','synthetic recent','{"fixture":102}',now()-interval '2 days',NULL),
             (103,NULL,'synthetic-prior@example.test','synthetic-trigger','PRIOR','synthetic prior','{"fixture":103}',now()-interval '45 days',NULL);
      INSERT INTO public.signup_errors_archive
        (original_id,email,trigger_name,error_code,error_msg,raw_meta,occurred_at)
      VALUES (103,'synthetic-prior@example.test','synthetic-trigger','PRIOR','synthetic prior','{"fixture":103}',now()-interval '45 days');""")
    check("column-only-removal-breaks-existing-archive-before-repair", refused(
        "BEGIN; ALTER TABLE public.signup_errors DROP COLUMN forwarded_to_sentry; "
        "SELECT public.archive_signup_errors(30); COMMIT;", 'column "forwarded_to_sentry" does not exist'))
    check("failed-baseline-probe-rolled-back", forwarding_columns() == 2)

    provider_seeds = {
        "sentry_error_log": "(sentry_issue_id,title) VALUES ('synthetic-incident','synthetic audit evidence')",
        "sentry_event_budget": "(day,sent) VALUES (CURRENT_DATE,1)",
        "sentry_event_fingerprints": "(day,fingerprint,sent) VALUES (CURRENT_DATE,'synthetic-fingerprint',1)",
    }
    for table, seed in provider_seeds.items():
        run("INSERT INTO public." + table + seed)
        check(table + "-new-record-refuses-retirement", refused(migration, "acquired data; obtain a new protected export"))
        check(table + "-refused-retirement-retains-record", run("SELECT count(*) FROM public." + table) == "1")
        run("DELETE FROM public." + table)
    original_function = run("SELECT pg_get_functiondef('public.archive_signup_errors(integer)'::regprocedure)")
    changed_function = original_function.replace("moved_count int := 0;", "moved_count int := 1;")
    check("preimage-drift-probe-changes-the-function", changed_function != original_function)
    run(changed_function)
    check("changed-archive-definition-refuses-retirement", refused(migration, "archive definition changed"))
    run(original_function)
    run("CREATE VIEW public.provider_dependency AS SELECT day FROM public.sentry_event_budget")
    check("unexpected-catalog-dependent-refuses-drop", refused(migration, "other objects depend on it"))
    check("dependent-refusal-rolls-back-entire-migration",
          provider_tables() == 3 and forwarding_columns() == 2
          and archive_hash() == custody["archive_function_body_md5"])
    run("DROP VIEW public.provider_dependency")
    run("CREATE FUNCTION public.provider_caller() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM public.fn_sentry_budget_take('fixture'); RETURN true; END $$")
    check("untracked-procedural-caller-refuses-retirement", refused(migration, "still has function callers"))
    run("DROP FUNCTION public.provider_caller()")
    run("GRANT EXECUTE ON FUNCTION public.archive_signup_errors(integer) TO anon")
    check("unexpected-archive-authority-refuses-retirement", refused(migration, "archive authority changed"))
    run("REVOKE EXECUTE ON FUNCTION public.archive_signup_errors(integer) FROM anon")
    run("CREATE ROLE unexpected_archive_reader; GRANT EXECUTE ON FUNCTION public.archive_signup_errors(integer) TO unexpected_archive_reader")
    check("custom-role-archive-grant-refuses-retirement", refused(migration, "archive authority changed"))
    check("custom-role-refusal-preserves-catalog", provider_tables() == 3 and forwarding_columns() == 2)
    run("REVOKE EXECUTE ON FUNCTION public.archive_signup_errors(integer) FROM unexpected_archive_reader; DROP ROLE unexpected_archive_reader")
    run("GRANT EXECUTE ON FUNCTION public.archive_signup_errors(integer) TO service_role WITH GRANT OPTION")
    check("archive-grant-option-drift-refuses-retirement", refused(migration, "archive authority changed"))
    run("REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.archive_signup_errors(integer) FROM service_role")

    old_rows = run("SELECT jsonb_agg(to_jsonb(e)-'forwarded_to_sentry' ORDER BY id) FROM public.signup_errors e")
    prior_archive = run("SELECT to_jsonb(a)-'forwarded_to_sentry' FROM public.signup_errors_archive a WHERE original_id=103")
    run(migration)
    check("provider-tables-function-and-forwarding-columns-removed",
          provider_tables() == 0 and forwarding_columns() == 0
          and run("SELECT to_regprocedure('public.fn_sentry_budget_take(text,integer,integer)') IS NULL") == "t")
    check("first-party-rows-preserved-exactly",
          run("SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.signup_errors e") == old_rows)
    check("pre-existing-archive-record-preserved-exactly",
          run("SELECT to_jsonb(a) FROM public.signup_errors_archive a WHERE original_id=103") == prior_archive)
    check("signup-health-view-and-useful-index-survive",
          run("SELECT failures FROM public.signup_health_view WHERE trigger_name='synthetic-trigger'") == "3"
          and run("SELECT to_regclass('public.signup_errors_occurred_at_idx') IS NOT NULL") == "t"
          and run("SELECT to_regclass('public.signup_errors_pending_forward_idx') IS NULL") == "t")
    for role in ("anon", "authenticated"):
        check(role + "-archive-execution-remains-refused", refused(
            "SET ROLE " + role + "; SELECT public.archive_signup_errors(30)", "permission denied for function"))
    result = json.loads(run("SET ROLE service_role; SELECT public.archive_signup_errors(30)"))
    check("service-role-archive-retains-return-contract", result["moved"] == 1
          and result["older_than_days"] == 30 and bool(result["cutoff"]))
    check("only-newly-archived-old-row-is-deleted", run("SELECT string_agg(id::text,',' ORDER BY id) FROM public.signup_errors") == "102,103")
    check("archive-preserves-payload-and-identity", run("SELECT original_id::text||':'||(raw_meta->>'fixture') FROM public.signup_errors_archive WHERE original_id=101") == "101:101")
    repeated = json.loads(run("SET ROLE service_role; SELECT public.archive_signup_errors(30)"))
    check("archive-repeat-keeps-existing-idempotent-behavior", repeated["moved"] == 0
          and run("SELECT count(*) FROM public.signup_errors_archive") == "2")
    before_replay = run("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.signup_errors_archive a")
    run(migration)
    check("migration-replay-preserves-archive-data-and-authority",
          archive_hash() == custody["retired_archive_function_body_md5"]
          and run("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.signup_errors_archive a") == before_replay
          and run("SELECT has_function_privilege('service_role','public.archive_signup_errors(integer)','EXECUTE')") == "t")
    receipt["passed"] = True
finally:
    if (cluster / "data/postmaster.pid").exists():
        command([pg / "pg_ctl", "-D", cluster / "data", "-m", "fast", "-w", "stop"])
    if (cluster / "server.log").exists():
        shutil.copyfile(cluster / "server.log", output / "postgres.log")
    shutil.rmtree(cluster)
    receipt["owned_cluster_removed"] = not cluster.exists()
    (output / "RESULTS.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"passed": receipt.get("passed", False), "checks": len(receipt["checks"]), "output": str(output)}))
