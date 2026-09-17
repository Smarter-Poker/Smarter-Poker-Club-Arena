"""Bounded real-pg_cron probe, last in the disposable full-acceptance cluster.

The earlier accepted catalogs remain the full candidate receipt. This probe
recreates only the disabled fixture extension under its own extension owner,
then commits a SELECT-only/non-superuser postgres caller before opening any
tested transaction. It does not model a table-wide lock or alter production.
"""
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import tempfile
import time


def main(password_file):
    if len(sys.argv) != 6:
        raise SystemExit("absolute psql, isolated socket, port, postgres, captured cron JSON required")
    executable, socket, port, database, captured = sys.argv[1:]
    if not Path(executable).is_absolute() or not Path(socket).is_absolute() or database != "postgres":
        raise SystemExit("invalid disposable endpoint")
    if not port.isdecimal() or not 1024 <= int(port) <= 65535:
        raise SystemExit("invalid disposable port")
    root = Path(__file__).resolve().parents[3]
    components = root / "supabase/accounting/weekly-v3/components"
    owner = "accounting_fixture_cron_extension_owner"
    environment = {"PATH": os.environ.get("PATH", ""), "LC_ALL": "C",
                   "PGCONNECT_TIMEOUT": "5", "PGPASSFILE": password_file}
    command = [executable, "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
               "-v", "VERBOSITY=verbose", "-h", socket, "-p", port, "-d", database]
    prefix = "SET statement_timeout='30s';SET lock_timeout='3s';\n"
    jobs_sql = "SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.jobid),'[]'::jsonb) FROM cron.job j;"
    active = []

    def query(sql, role="postgres", refusal=None):
        result = subprocess.run(command + ["-U", role], input=prefix + sql, text=True,
                                capture_output=True, env=environment, timeout=40)
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
        if refusal is not None:
            errors = re.findall(r"^ERROR:\s+([0-9A-Z]{5}): ([^\n]+)$", result.stderr, re.M)
            if result.returncode == 0 or len(errors) != 1 or errors[0] not in refusal:
                raise AssertionError(f"unexpected refusal: {result.returncode}, {errors}")
        elif result.returncode:
            raise AssertionError(f"fixture query failed: {result.returncode}: {result.stderr}")
        return result.stdout.strip()

    def component(name):
        text = (components / name).read_text()
        lines = text.splitlines(keepends=True)
        if sum(line.strip() == "BEGIN ISOLATION LEVEL SERIALIZABLE;" for line in lines) != 1 \
                or sum(line.strip() == "COMMIT;" for line in lines) != 1:
            raise AssertionError("component transaction boundary changed: " + name)
        # Preserve every guard/write/postcondition. The probe owns one outer
        # transaction so its successful transition can be rolled back.
        return "".join(line for line in lines if line.strip() not in
                       ("BEGIN ISOLATION LEVEL SERIALIZABLE;", "COMMIT;"))

    transition = component("20260914155450_captured_cron_enters_the_sealed_accounting_transition.sql")
    timing = component("20260914163000_canonical_cron_wakes_on_the_hour.sql")
    retirement_paths = list(components.glob("20260914155500_*.sql"))
    if len(retirement_paths) != 1:
        raise AssertionError("ambiguous existing retirement component")
    retire_blocks = re.findall(r"DO \$retire\$.*?END \$retire\$;", retirement_paths[0].read_text(), re.S)
    if len(retire_blocks) != 1:
        raise AssertionError("existing exact retirement block missing")
    retire = retire_blocks[0]

    guard = json.loads(query("SELECT jsonb_build_object('user',current_user,'database',current_database(),"
        "'data',current_setting('data_directory'),'port',current_setting('port'),"
        "'socket',inet_server_addr() IS NULL,'version',current_setting('server_version_num')::integer,"
        "'launch',current_setting('cron.launch_active_jobs'),'cron_database',current_setting('cron.database_name'),"
        "'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),"
        "'owner_absent',NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='" + owner + "'),"
        "'runs_empty',NOT EXISTS(SELECT 1 FROM cron.job_run_details));"))
    if guard != {"user": "postgres", "database": "postgres", "data": str(Path(socket).parent / "data"),
                 "port": port, "socket": True, "version": guard["version"], "launch": "off",
                 "cron_database": "postgres", "superuser": True, "owner_absent": True, "runs_empty": True} \
            or not 170000 <= guard["version"] < 180000:
        raise AssertionError("not the final disposable PG17 acceptance cluster")
    incoming = json.loads(Path(captured).read_text())
    if [row["jobid"] for row in incoming if row["jobid"] in (271, 272)] != [271, 272]:
        raise AssertionError("captured two-job input missing")
    literal = json.dumps(incoming).replace("'", "''")
    # CronExtensionOwner() uses pg_extension.extowner, not cron.job.relowner.
    # A real reinstall is confined to this exhausted, disabled scratch cluster.
    # No CASCADE, catalog-owner spoofing, function stub, or production grant.
    query("BEGIN;CREATE ROLE " + owner + " LOGIN SUPERUSER;DROP EXTENSION pg_cron;"
          "SET LOCAL ROLE " + owner + ";CREATE EXTENSION pg_cron;RESET ROLE;"
          "INSERT INTO cron.job SELECT * FROM jsonb_populate_recordset(NULL::cron.job,'" + literal + "'::jsonb);"
          "REVOKE ALL ON cron.job FROM PUBLIC,postgres;GRANT SELECT ON cron.job TO postgres;"
          "GRANT USAGE ON SCHEMA cron TO postgres;"
          "GRANT EXECUTE ON FUNCTION cron.alter_job(bigint,text,text,text,text,boolean) TO postgres;"
          "DO $grant$ DECLARE target regprocedure;BEGIN FOR target IN SELECT p.oid::regprocedure"
          " FROM pg_proc p WHERE p.pronamespace='cron'::regnamespace AND p.proname='unschedule'"
          " AND p.pronargs=1 AND p.proargtypes[0] IN('text'::regtype,'name'::regtype) LOOP"
          " EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres',target);END LOOP;END $grant$;"
          "COMMIT;")
    # The runner keeps its separate bootstrap account unchanged. The distinct
    # fixture administrator commits this before the tested caller connects.
    # Production postgres inherits pg_monitor, including the read-only settings
    # privilege required by the unmodified provider/timezone guards.
    query("GRANT pg_monitor TO postgres;ALTER ROLE postgres NOSUPERUSER BYPASSRLS;", role=owner)
    privileges = json.loads(query("SELECT jsonb_build_object('superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),"
        "'bypass_rls',(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),"
        "'monitor',pg_has_role(current_user,'pg_monitor','USAGE'),"
        "'owner',(SELECT pg_get_userbyid(extowner) FROM pg_extension WHERE extname='pg_cron'),"
        "'select',has_table_privilege(current_user,'cron.job','SELECT'),'writes',"
        "EXISTS(SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])p"
        " WHERE has_table_privilege(current_user,'cron.job',p)),"
        "'alter',has_function_privilege(current_user,'cron.alter_job(bigint,text,text,text,text,boolean)','EXECUTE'));"))
    if privileges != {"superuser": False, "bypass_rls": True, "monitor": True, "owner": owner,
                      "select": True, "writes": False, "alter": True}:
        raise AssertionError("managed caller privileges do not reproduce the observed restriction")

    snapshot_source = (root / "tests/fixtures/full-weekly-accounting/capture-rollback-state.sql").read_text()

    def snapshot():
        return query(snapshot_source, role=owner)

    initial = snapshot()
    query("BEGIN;LOCK TABLE cron.job IN SHARE ROW EXCLUSIVE MODE;ROLLBACK;",
          refusal={("42501", "permission denied for table job")})
    if snapshot() != initial:
        raise AssertionError("denied legacy lock changed the fixture")
    print("PASS: real SELECT-only managed caller refuses old cron.job table LOCK with42501")
    for body in (transition, timing):
        query("BEGIN ISOLATION LEVEL READ COMMITTED;\n" + body + "\nROLLBACK;",
              refusal={("25000", "accounting_cron_requires_serializable")})
    if snapshot() != initial:
        raise AssertionError("isolation refusal changed the fixture")

    api_lock_assertion = """DO $api_lock$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
        AND relation='cron.job'::regclass AND mode='RowExclusiveLock' AND granted)
        OR EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
          AND relation='cron.job'::regclass
          AND mode IN('ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock') AND granted)
      THEN RAISE EXCEPTION 'actual API relation lock differs; no table-wide exclusion is claimed';END IF;
    END $api_lock$;"""
    final_rows = json.loads(query("BEGIN ISOLATION LEVEL SERIALIZABLE;\n" + transition + "\n" +
        api_lock_assertion + "\n" + retire + "\n" + timing + "\n" + api_lock_assertion +
        "\n" + jobs_sql + "\nROLLBACK;"))
    expected_rows = [dict(row, schedule="0,30 * * * *") if row["jobid"] == 272 else row
                     for row in incoming if row["jobid"] != 271]
    if final_rows != expected_rows or snapshot() != initial:
        raise AssertionError("managed exact component transition or whole-book rollback differs")
    print("PASS: actual components preserve exact preimages, retire271, change only272 schedule, and roll back")

    def send(process, sql):
        process.stdin.write(sql.encode()); process.stdin.flush()

    def barrier(process):
        selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
        pending = b""; lines = []; deadline = time.monotonic() + 15
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError("missing serializable snapshot barrier")
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise AssertionError("snapshot process exited: " + repr(lines))
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1); line = line.decode().strip()
                    if line == "managed_snapshot_ready":
                        if pending.strip(): raise AssertionError("ambiguous snapshot barrier")
                        return lines
                    if line: lines.append(line)
        finally:
            selector.close()

    def race(job_id, schedule, body, allowed):
        before = json.loads(query(jobs_sql))
        actor = subprocess.Popen(command + ["-U", "postgres"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment, bufsize=0)
        active.append(actor)
        send(actor, prefix + "BEGIN ISOLATION LEVEL SERIALIZABLE;" + jobs_sql + "\n\\echo managed_snapshot_ready\n")
        lines = barrier(actor)
        if len(lines) != 1 or json.loads(lines[0]) != before:
            raise AssertionError("actual serializable transaction did not retain the exact old job snapshot")
        query(f"SELECT cron.alter_job(job_id:={job_id},schedule:='{schedule}');")
        concurrent_rows = json.loads(query(jobs_sql))
        if concurrent_rows != [dict(row, schedule=schedule) if row["jobid"] == job_id else row for row in before]:
            raise AssertionError("concurrent actual API changed more than its target schedule")
        concurrent_book = snapshot()
        send(actor, body + "\nCOMMIT;\n\\quit\n")
        output, _ = actor.communicate(timeout=40)
        text = output.decode(); print(text, end="")
        errors = re.findall(r"^ERROR:\s+([0-9A-Z]{5}): ([^\n]+)$", text, re.M)
        if actor.returncode == 0 or len(errors) != 1 or errors[0] not in allowed:
            raise AssertionError(f"unexpected managed job{job_id} race result: {actor.returncode}, {errors}")
        if json.loads(query(jobs_sql)) != concurrent_rows or snapshot() != concurrent_book:
            raise AssertionError("refused transaction overwrote concurrent cron drift or retained partial effects")
        old_schedule = next(row["schedule"] for row in before if row["jobid"] == job_id)
        query(f"SELECT cron.alter_job(job_id:={job_id},schedule:='{old_schedule}');")
        print(f"PASS: actual job{job_id} concurrent change refuses {errors[0][0]} and preserves the complete concurrent book")

    serialization = {("40001", "could not serialize access due to concurrent update"),
                     ("40001", "could not serialize access due to read/write dependencies among transactions")}
    try:
        race(272, "1,31 * * * *", transition, serialization)
        race(271, "46 6,7 * * 1", retire, serialization | {
            ("P0001", "legacy recompute cron remains active"),
            ("XX000", "tuple concurrently updated"), ("XX000", "tuple concurrently deleted")})
        if snapshot() != initial:
            raise AssertionError("restored concurrent probes changed the original book")
        # Stage the actual intermediate source contract; no stand-in writer.
        query("BEGIN ISOLATION LEVEL SERIALIZABLE;\n" + transition + "\n" + retire + "\nCOMMIT;")
        intermediate = snapshot()
        race(272, "2,32 * * * *", timing, serialization)
        if snapshot() != intermediate:
            raise AssertionError("timing refusal did not preserve its intermediate fixture book")
        if query("SELECT count(*) FROM cron.job_run_details;") != "0":
            raise AssertionError("disabled fixture unexpectedly launched a job")
        print("PASS: both actual scheduler components refuse concurrent target drift; no fixture job launched")
    finally:
        for process in active:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)
        # The owning runner now stops and removes this isolated cluster. The
        # managed extension/caller setup is deliberate fixture state, not a
        # modification of the earlier accepted-authority capture or production.


if __name__ == "__main__":
    # Match the existing native concurrency harness: an absent regular-path
    # password file prevents credential discovery without libpq's /dev/null
    # warning contaminating the exact process barriers.
    with tempfile.TemporaryDirectory(prefix="managed-cron-auth-") as directory:
        main(str(Path(directory) / "absent.pgpass"))
