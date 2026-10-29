#!/usr/bin/env python3
"""Qualify the exact pg_net removal with the real, privately built extension.

All downloads/builds/clusters stay below the explicitly supplied scratch parent.
No system extension installation or production connection is used. The fixture
uses the extension owner; Supabase's privileged-extension authority is a separate
provider installation check, not simulated by this test.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20261029181526_remove_unused_pg_net_before_private_listener_credentials.sql"
PG_SHA = "e0630a3600aea27511715563259ec2111cd5f4353a4b040e0be827f94cd7a8b0"
NET_COMMIT = "a7792bfd913c7859e14025d606624982706c2a7f"
NET_SHA = "855f33ecf738094a55f6ee4c89e620e12ca33d574a2b33f89d1fc730f6b62630"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(work):
    prefix = work / "install"
    for url, name, digest in [
        ("https://ftp.postgresql.org/pub/source/v17.6/postgresql-17.6.tar.bz2", "pg.tar.bz2", PG_SHA),
        (f"https://api.github.com/repos/supabase/pg_net/tarball/{NET_COMMIT}", "net.tar.gz", NET_SHA),
    ]:
        archive = work / name
        subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "180", url, "-o", str(archive)], check=True)
        if sha(archive) != digest:
            raise AssertionError(f"Official source digest mismatch: {name}")
        with tarfile.open(archive) as tar:
            tar.extractall(work, filter="data")
    pg = work / "postgresql-17.6"
    net = work / "supabase-pg_net-a7792bf"
    jobs = str(min(os.cpu_count() or 2, 12))
    with (work / "build.log").open("w") as log:
        for command, cwd in [
            ([str(pg / "configure"), f"--prefix={prefix}", "--without-icu", "--without-readline", "--without-zlib"], pg),
            (["make", f"-j{jobs}"], pg),
            (["make", "install"], pg),
            (["make", f"-j{jobs}", f"PG_CONFIG={prefix}/bin/pg_config"], net),
            (["make", f"PG_CONFIG={prefix}/bin/pg_config", "install"], net),
        ]:
            subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, check=True)
    return prefix


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scratch", required=True, type=Path)
    parser.add_argument("--pg-prefix", type=Path, help="Explicit existing private PG17.6/pg_net0.19.5 fixture prefix; default builds pinned sources")
    args = parser.parse_args()
    scratch = args.scratch.resolve(strict=True)
    work = Path(tempfile.mkdtemp(prefix="net-removal.", dir=scratch))
    socket = Path(tempfile.mkdtemp(prefix="ns.", dir=scratch))
    prefix = args.pg_prefix.resolve(strict=True) if args.pg_prefix else None
    started = False
    passed = []
    try:
        if prefix is None:
            prefix = build(work)
        binpath = prefix / "bin"
        version = subprocess.check_output([str(binpath / "postgres"), "--version"], text=True).strip()
        assert version == "postgres (PostgreSQL) 17.6", version
        subprocess.run([str(binpath / "initdb"), "-D", str(work / "data"), "-U", "supabase_admin", "--auth=trust", "--no-locale", "-E", "UTF8"], stdout=subprocess.DEVNULL, check=True)
        # The real worker runs, but in template1 (without pg_net). Poison queue
        # cases cannot send HTTP or disappear before the candidate checks them.
        options = f"-h '' -k '{socket}' -p 57657 -c shared_preload_libraries=pg_net -c pg_net.database_name=template1"
        subprocess.run([str(binpath / "pg_ctl"), "-D", str(work / "data"), "-l", str(work / "postgres.log"), "-o", options, "-w", "start"], stdout=subprocess.DEVNULL, check=True)
        started = True
        command = [str(binpath / "psql"), "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-h", str(socket), "-p", "57657", "-U", "supabase_admin"]

        def sql(body, database="postgres", ok=True):
            result = subprocess.run(command + ["-d", database], input=body, capture_output=True, text=True)
            if ok and result.returncode:
                raise AssertionError(result.stderr)
            return result

        sql("CREATE ROLE ca_record_gateway NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4; COMMENT ON ROLE ca_record_gateway IS 'ca-private-record-listener:v1:disabled:20261028154533'; CREATE DATABASE net_base TEMPLATE template0;")
        sql("""
CREATE EXTENSION pg_net VERSION '0.19.5';
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint, command text);
CREATE TABLE public.ca_private_record_transport_state(singleton boolean PRIMARY KEY, supabase_enabled boolean, source_fingerprints jsonb);
INSERT INTO public.ca_private_record_transport_state VALUES(true,true,'{"original":"unchanged"}');
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION public.fn_private_record_transport_ready() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE public.unrelated_player_fixture(id integer PRIMARY KEY, amount numeric);
INSERT INTO public.unrelated_player_fixture VALUES(1,123.45);
""", "net_base")
        identity = sql("SELECT count(*)||':'||md5(string_agg(pg_describe_object(classid,objid,objsubid),E'\\n' ORDER BY pg_describe_object(classid,objid,objsubid) COLLATE \"C\")) FROM pg_depend WHERE refclassid='pg_extension'::regclass AND refobjid=(SELECT oid FROM pg_extension WHERE extname='pg_net') AND deptype='e';", "net_base").stdout.strip()
        assert identity == "28:9ef501c82bdd5516123287654d419c00", identity
        passed.append("actual-pg-net-0.19.5-production-member-identity")
        candidate = MIGRATION.read_text()
        snapshot_sql = """SELECT jsonb_build_object('state',(SELECT to_jsonb(s) FROM public.ca_private_record_transport_state s),'role',(SELECT to_jsonb(r) FROM pg_roles r WHERE rolname='ca_record_gateway'),'player',(SELECT to_jsonb(p) FROM public.unrelated_player_fixture p),'net',EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net'))::text;"""

        def database(name, setup=""):
            sql(f"CREATE DATABASE {name} TEMPLATE net_base;")
            if setup:
                sql(setup, name)
            return sql(snapshot_sql, name).stdout.strip()

        def refused(name, setup, reason):
            before = database(name, setup)
            retained = "SELECT jsonb_build_object('requests',(SELECT jsonb_agg(q) FROM net.http_request_queue q),'responses',(SELECT jsonb_agg(r) FROM net._http_response r))::text;"
            before_rows = sql(retained, name).stdout
            result = sql(candidate, name, ok=False)
            assert result.returncode != 0 and reason in result.stderr, (name, result.stderr)
            assert sql(snapshot_sql, name).stdout.strip() == before, name
            assert sql(retained, name).stdout == before_rows, name
            passed.append(name + ":atomic-refusal")

        before = database("net_success")
        sql(candidate, "net_success")
        after = json.loads(sql(snapshot_sql, "net_success").stdout)
        original = json.loads(before)
        assert after == {**original, "net": False}
        assert sql("SELECT to_regnamespace('net') IS NULL;", "net_success").stdout.strip() == "t"
        replay = sql(candidate, "net_success", ok=False)
        assert replay.returncode and "PRIVATE_LISTENER_NET_EXTENSION_DRIFT_OR_REPLAY" in replay.stderr
        passed.extend(["exact-migration-success-preserves-state-role-player", "exact-replay-refused"])

        rollback_before = database("net_rollback")
        assert candidate.count("\nCOMMIT;") == 1
        sql(candidate.replace("\nCOMMIT;", "\nROLLBACK;"), "net_rollback")
        assert sql(snapshot_sql, "net_rollback").stdout.strip() == rollback_before
        passed.append("exact-transaction-rollback-restores-extension-and-state")

        refused("net_request", "INSERT INTO net.http_request_queue(method,url,timeout_milliseconds) VALUES('GET','http://127.0.0.1:1/isolated-fixture',1);", "PRIVATE_LISTENER_NET_PENDING_REQUEST_OR_RESPONSE")
        refused("net_response", "INSERT INTO net._http_response(id,content) VALUES(1,'retained response fixture');", "PRIVATE_LISTENER_NET_PENDING_REQUEST_OR_RESPONSE")
        refused("net_cron", "INSERT INTO cron.job VALUES(1,'SELECT net.http_get(''http://127.0.0.1:1'')');", "PRIVATE_LISTENER_NET_CONSUMER_FOUND")
        refused("net_function", "CREATE FUNCTION public.live_http_consumer() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM net.http_get('http://127.0.0.1:1'); END $$;", "PRIVATE_LISTENER_NET_CONSUMER_FOUND")
        refused("net_internal_function", "CREATE FUNCTION public.live_internal_http_consumer() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM net._http_collect_response(1,false); END $$;", "PRIVATE_LISTENER_NET_CONSUMER_FOUND")
        refused("net_webhook", "CREATE SCHEMA supabase_functions; CREATE FUNCTION supabase_functions.http_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER live_webhook AFTER INSERT ON public.unrelated_player_fixture FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request();", "PRIVATE_LISTENER_NET_CONSUMER_FOUND")
        refused("net_dependency", "CREATE VIEW public.live_net_dependency AS SELECT id FROM net._http_response;", "depend on it")
        refused("net_members", "CREATE FUNCTION net.new_extension_member() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; ALTER EXTENSION pg_net ADD FUNCTION net.new_extension_member();", "PRIVATE_LISTENER_NET_MEMBERS_CHANGED")
        refused("net_paid", "UPDATE public.ca_private_record_transport_state SET supabase_enabled=false;", "PRIVATE_LISTENER_NET_PAID_TRANSPORT_REQUIRED")
        refused("net_freeze", "CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;", "PRIVATE_LISTENER_NET_RUNTIME_NOT_IDLE")
        refused("net_unready", "CREATE OR REPLACE FUNCTION public.fn_private_record_transport_ready() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;", "PRIVATE_LISTENER_NET_RUNTIME_NOT_IDLE")
        # The shared cluster role is changed only after the other cases finish.
        sql("ALTER ROLE ca_record_gateway LOGIN;")
        refused("net_enabled", "", "PRIVATE_LISTENER_NET_RUNTIME_NOT_IDLE")
        sql("ALTER ROLE ca_record_gateway NOLOGIN;")
        sql("COMMENT ON ROLE ca_record_gateway IS 'unqualified-listener-owner';")
        refused("net_marker", "", "PRIVATE_LISTENER_NET_RUNTIME_NOT_IDLE")
        sql("COMMENT ON ROLE ca_record_gateway IS 'ca-private-record-listener:v1:disabled:20261028154533';")

        locked_before = database("net_lock")
        holder = subprocess.Popen(command + ["-d", "net_lock"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            holder.stdin.write("BEGIN;\nLOCK TABLE net.http_request_queue IN ACCESS SHARE MODE;\n\\echo NET_LOCK_HELD\n")
            holder.stdin.flush()
            assert select.select([holder.stdout], [], [], 5)[0], "Isolated lock holder did not acknowledge"
            assert holder.stdout.readline().strip() == "NET_LOCK_HELD"
            locked = sql(candidate, "net_lock", ok=False)
            assert locked.returncode and "could not obtain lock on relation" in locked.stderr, locked.stderr
            assert sql(snapshot_sql, "net_lock").stdout.strip() == locked_before
            passed.append("net-lock:nowait-atomic-refusal")
        finally:
            holder.stdin.write("ROLLBACK;\n\\q\n")
            holder.stdin.flush()
            holder.communicate(timeout=5)

        print(json.dumps({"status": "passed", "postgres": version, "pg_net_commit": NET_COMMIT, "production_member_identity": identity, "source_sha256": {str(MIGRATION.relative_to(ROOT)): sha(MIGRATION), str(Path(__file__).resolve().relative_to(ROOT)): sha(Path(__file__).resolve())}, "cases": passed, "count": len(passed), "production_mutations": False, "authority_limit": "Native fixture executes as actual extension owner. Supabase supautils management authorization is verified separately by the protected installer.", "build": "explicit-private-prefix" if args.pg_prefix else "pinned-official-private-build"}, sort_keys=True))
    except Exception:
        for log in [work / "build.log", work / "postgres.log"]:
            if log.exists():
                print(f"--- {log.name} (last 30 lines) ---")
                print("\n".join(log.read_text(errors="replace").splitlines()[-30:]))
        raise
    finally:
        if started:
            subprocess.run([str(prefix / "bin/pg_ctl"), "-D", str(work / "data"), "-m", "immediate", "-w", "stop"], capture_output=True, check=True)
        shutil.rmtree(work)
        shutil.rmtree(socket)


if __name__ == "__main__":
    main()
