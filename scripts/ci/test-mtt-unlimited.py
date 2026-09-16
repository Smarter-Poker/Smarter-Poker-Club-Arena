#!/usr/bin/env python3
"""Exercise the R46 migration, three native probes and six actual lock races.

Directly invoked by the existing accounting PostgreSQL job. All writes target
this process's newly initialized Unix-socket-only PostgreSQL 17 cluster. No
production URL, existing cluster, package installation or scheduler is used.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

from mtt_isolation_results import validate_case_result
from mtt_unlimited_fixture import compose


MIGRATION = "supabase/migrations/20260915150000_mtts_have_no_entry_cap.sql"
ASSETS = "scripts/ci/probes/mtt-isolation"
PROBES = (
    ("mtt-unlimited-entry-cap-native.sql", "R46_UNLIMITED_ENTRY_CAP_NATIVE_PASS"),
    ("mtt-unlimited-ticket-redemption-native.sql", "EXISTING_TICKET_CURRENT_REDEMPTION_NATIVE_PASS"),
    ("mtt-satellite-creation-native.sql", "R46_SATELLITE_CREATION_NATIVE_PASS"),
)
CANCELLATION_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)


def interrupted(signum, _frame):
    raise InterruptedError(f"R46 execution cancelled by signal {signum}")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clean_environment():
    # The cluster's explicit local connection parameters are the sole target.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("PG") and key not in ("DATABASE_URL", "SUPABASE_DB_URL")}
    env.update(LC_ALL="C", LANG="C", TZ="UTC", PYTHONDONTWRITEBYTECODE="1")
    return env


def stock_isolationtester(pg):
    candidates = (
        pg.parent / "lib/pgxs/src/test/isolation/isolationtester",
        pg.parent / "lib/postgresql/pgxs/src/test/isolation/isolationtester",
    )
    for path in candidates:
        if path.is_file() and os.access(path, os.X_OK):
            return path.resolve()
    raise RuntimeError("PostgreSQL 17 stock isolationtester is missing; no install or fallback")


class Execution:
    def __init__(self, root, output, pg, work_parent, deadline):
        self.root, self.output, self.pg = root, output, pg
        self.env = clean_environment()
        self.expires = time.monotonic() + deadline
        self.scratch = Path(tempfile.mkdtemp(prefix="r46-mtt-", dir=work_parent))
        self.socket = Path(tempfile.mkdtemp(prefix="r46mtt-sock-", dir="/tmp"))
        self.cluster = self.scratch / "data"
        self.port = "55496"  # Private socket directory; TCP is disabled.
        self.index = 0
        self.stopped = False
        self.start_attempted = False
        self.report = {"status": "failed", "production_mutations": False,
                       "source_sha256": {}, "commands": [], "native": [], "races": [], "migration_refusals": [],
                       "cleanup": {"stopped": False, "removed": False},
                       "scratch": str(self.scratch), "socket": str(self.socket),
                       "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}

    def run(self, label, argv, *, text=None, seconds=60, check=True, cleanup=False):
        left = seconds if cleanup else min(seconds, self.expires - time.monotonic())
        if left <= 0:
            raise TimeoutError("R46 operation wall deadline expired")
        self.index += 1
        stem = f"{self.index:03d}-{label}"
        process = subprocess.Popen(
            [str(x) for x in argv], cwd=self.root, env=self.env,
            stdin=subprocess.PIPE if text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
        timed_out = False
        try:
            stdout, stderr = process.communicate(text, timeout=left)
        except BaseException:
            # Stop this exact client/process group, then separately stop our
            # postmaster in close(). A killed client is not rollback proof.
            timed_out = True
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stdout, stderr = process.communicate(timeout=10)
            (self.output / (stem + ".stdout")).write_text(stdout)
            (self.output / (stem + ".stderr")).write_text(stderr)
            self.report["commands"].append({"label": label, "exit_code": process.returncode,
                                            "interrupted": True, "stem": stem})
            raise
        (self.output / (stem + ".stdout")).write_text(stdout)
        (self.output / (stem + ".stderr")).write_text(stderr)
        self.report["commands"].append({"label": label, "exit_code": process.returncode,
                                        "interrupted": timed_out, "stem": stem})
        if check and process.returncode:
            raise RuntimeError(f"{label} exited {process.returncode}; see {stem}.stderr")
        return process.returncode, stdout, stderr

    def sql(self, database, query=None, *, file=None, label="sql", seconds=90, check=True):
        argv = [self.pg / "psql", "-X", "-qAt", "-h", self.socket, "-p", self.port,
                "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"]
        if file is not None:
            argv += ["-f", file]
        return self.run(label, argv, text=query, seconds=seconds, check=check)

    def catalog_snapshot(self, database, label):
        # Compare definitions/ownership/rights rather than volatile physical
        # statistics such as relpages. Failed DDL may allocate unused OIDs.
        query = """
SELECT jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.oid::regprocedure::text,
   pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl) ORDER BY n.nspname,p.oid)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','auth') AND p.prokind='f'),
 'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,
   pg_get_userbyid(c.relowner),c.relacl,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth')),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.oid::regclass::text,a.attname,a.atttypid::regtype::text,
   a.attnotnull,a.attacl,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.oid,a.attnum)
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE n.nspname IN ('public','auth') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(conrelid::regclass::text,conname,pg_get_constraintdef(x.oid),convalidated)
   ORDER BY conrelid,conname) FROM pg_constraint x JOIN pg_namespace n ON n.oid=x.connamespace
   WHERE n.nspname IN ('public','auth')),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tgrelid::regclass::text,tgname,pg_get_triggerdef(t.oid),tgenabled)
   ORDER BY tgrelid,tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','auth')),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(indexrelid::regclass::text,pg_get_indexdef(indexrelid),indisvalid,indisready)
   ORDER BY indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','auth')),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname) FROM pg_policies p
   WHERE schemaname IN ('public','auth')));
"""
        _, output, _ = self.sql(database, query, label=label)
        return json.loads(output.strip())

    def snapshot(self, database, label):
        # Typed JSON rows are ordered explicitly; relation identity is retained.
        # Sequence allocation is nontransactional and is not a money movement.
        query = """
CREATE FUNCTION pg_temp.r46_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE r record; v jsonb; result jsonb:='{}';
BEGIN
 FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','auth') AND c.relkind IN ('r','p') ORDER BY 1,2 LOOP
   EXECUTE format('SELECT jsonb_build_object(''count'',count(*),''md5'',md5(COALESCE(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),''''))) FROM %I.%I t',r.nspname,r.relname) INTO v;
   result:=result||jsonb_build_object(r.nspname||'.'||r.relname,v);
 END LOOP;
 RETURN result;
END $fn$;
SELECT pg_temp.r46_snapshot();
"""
        _, output, _ = self.sql(database, query, label=label)
        return json.loads(output.strip())

    def start(self):
        _, version, _ = self.run("postgres-version", [self.pg / "postgres", "--version"])
        if " 17." not in version:
            raise RuntimeError("R46 requires PostgreSQL 17")
        self.report["postgres_version"] = version.strip()
        self.run("initdb", [self.pg / "initdb", "-D", self.cluster, "-A", "trust", "-U", "postgres",
                            "--no-locale", "--encoding=UTF8"])
        options = shlex.join(["-k", str(self.socket), "-p", self.port,
                              "-c", "listen_addresses=", "-c", "max_connections=16",
                              "-c", "shared_buffers=32MB", "-c", "max_locks_per_transaction=128",
                              "-c", "max_wal_size=128MB", "-c", "min_wal_size=32MB"])
        self.start_attempted = True
        self.run("start", [self.pg / "pg_ctl", "-D", self.cluster, "-l", self.output / "postgres.log",
                           "-o", options, "-w", "start"])
        _, actual, _ = self.sql("postgres", "SELECT current_user||'|'||(inet_server_addr() IS NULL)::text;", label="local-identity")
        if actual.strip() != "postgres|true":
            raise RuntimeError("new owned cluster identity mismatch")

    def database(self, template=None):
        name = "r46_mtt_isolation_" + uuid.uuid4().hex
        statement = f'CREATE DATABASE "{name}"'
        if template:
            statement += f' TEMPLATE "{template}"'
        self.sql("postgres", statement + ";", label="create-database")
        return name

    def discard(self, database):
        _, active, _ = self.sql("postgres", f"SELECT count(*) FROM pg_stat_activity WHERE datname='{database}';", label="database-connections")
        if active.strip() != "0":
            raise RuntimeError("owned case still has connections; outcome/cleanup requires investigation")
        self.sql("postgres", f'DROP DATABASE "{database}";', label="drop-database")
        _, remaining, _ = self.sql("postgres", f"SELECT count(*) FROM pg_database WHERE datname='{database}';", label="database-absent")
        if remaining.strip() != "0":
            raise RuntimeError("owned case database was not removed")

    def close(self):
        # Do not delete live cluster data, and do not suppress failed shutdown.
        if self.start_attempted:
            status, _, _ = self.run("pre-stop-status", [self.pg / "pg_ctl", "-D", self.cluster, "status"],
                                    seconds=5, check=False, cleanup=True)
            if status == 0:
                self.run("stop", [self.pg / "pg_ctl", "-D", self.cluster, "-m", "fast", "-w", "stop"],
                         seconds=40, cleanup=True)
            elif status != 3:
                raise RuntimeError("cannot establish original cluster status; retain its data")
            status, _, _ = self.run("stopped-status", [self.pg / "pg_ctl", "-D", self.cluster, "status"],
                                    seconds=5, check=False, cleanup=True)
            if status != 3 or (self.cluster / "postmaster.pid").exists():
                raise RuntimeError("owned PostgreSQL postmaster is not proven stopped")
        self.stopped = True
        self.report["cleanup"]["stopped"] = True
        shutil.rmtree(self.scratch)
        shutil.rmtree(self.socket)
        self.report["cleanup"]["removed"] = not self.scratch.exists() and not self.socket.exists()


def run_cases(execution):
    root = execution.root
    asset_dir = root / ASSETS
    catalog = json.loads((asset_dir / "catalog-candidate.json").read_text())
    if catalog["migration"]["path"] != MIGRATION or catalog["fixture"]["path"] != ASSETS + "/fixture.sql":
        raise ValueError("catalog must bind the actual migration and race fixture paths")
    expected_native = {"scripts/ci/probes/" + filename for filename, _ in PROBES}
    native_assets = catalog.get("native_probes", [])
    includes = catalog.get("included_probes", [])
    if (len(native_assets) != 3 or {x["path"] for x in native_assets} != expected_native
            or len(includes) != 1
            or includes[0]["path"] != "scripts/ci/probes/existing-ticket-current-redemption-native.sql"):
        raise ValueError("all three native probes and exact ticket include must be bound")
    for relative in (
        "scripts/ci/test-mtt-unlimited.py", "scripts/ci/mtt_isolation_results.py",
        "scripts/ci/mtt_unlimited_fixture.py", ASSETS + "/catalog-candidate.json",
        "scripts/ci/probes/existing-ticket-current-redemption-native.sql",
    ):
        execution.report["source_sha256"][relative] = sha(root / relative)
    cases = catalog["required_cases"]
    expected = {"creation_commit", "creation_rollback", "edit_after_creation", "edit_before_creation",
                "restart_commit", "restart_rollback"}
    if len(cases) != 6 or {x["case"] for x in cases} != expected:
        raise ValueError("all six distinct required R46 cases must be supplied")
    for asset in [catalog["migration"], catalog["fixture"], catalog["readme"], *cases, *native_assets, *includes]:
        path = root / asset["path"]
        if not path.resolve().is_relative_to(root) or sha(path) != asset["sha256"]:
            raise ValueError("R46 asset source binding changed: " + asset["path"])
        execution.report["source_sha256"][asset["path"]] = sha(path)
    foundation = compose(root)
    execution.report["source_sha256"].update(foundation["source_sha256"])
    execution.report["fixture_limits"] = foundation["limits"]
    foundation_file = execution.output / "composed-preimage.sql"
    foundation_file.write_text(foundation["sql"])
    execution.report["composed_sha256"] = sha(foundation_file)
    binary = stock_isolationtester(execution.pg)
    execution.report["isolationtester"] = {"path": str(binary), "sha256": sha(binary)}
    execution.start()
    template = execution.database()
    execution.sql(template, file=foundation_file, label="canonical-preimage", seconds=180)
    # Inject drift only in newly cloned disposable databases. Refusal must
    # roll back helpers, altered constraints, ACLs and every application row.
    drift_cases = (
        ("function", """DO $inject$ DECLARE definition text; body text; BEGIN
          SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc
          WHERE oid='public.fn_tournament_entry_cap_reached(uuid)'::regprocedure;
          EXECUTE replace(definition,body,E'\\n-- R46 isolated source drift\\n'||body);
        END $inject$;""", "R46 source drift: fn_tournament_entry_cap_reached, expected "),
        ("constraint", """ALTER TABLE public.tournaments DROP CONSTRAINT tournament_prize_math_contract_valid;
          ALTER TABLE public.tournaments ADD CONSTRAINT tournament_prize_math_contract_valid CHECK (true);""",
         "R46 constraint drift: tournament_prize_math_contract_valid"),
    )
    for kind, mutation, refusal in drift_cases:
        database = execution.database(template)
        execution.sql(database, mutation, label="inject-" + kind + "-drift")
        before_data = execution.snapshot(database, "before-drift-data")
        before_catalog = execution.catalog_snapshot(database, "before-drift-catalog")
        code, _, stderr = execution.sql(database, file=root / MIGRATION, label="refuse-" + kind + "-drift", check=False)
        errors = [line.split("ERROR:", 1)[1].strip() for line in stderr.splitlines() if "ERROR:" in line]
        exact_error = (len(errors) == 1 and (errors[0].startswith(refusal) if kind == "function" else errors[0] == refusal))
        if code != 3 or not exact_error:
            raise ValueError("migration did not refuse the exact " + kind + " drift")
        if (execution.snapshot(database, "after-drift-data") != before_data
                or execution.catalog_snapshot(database, "after-drift-catalog") != before_catalog):
            raise ValueError("rejected migration left partial changes after " + kind + " drift")
        execution.discard(database)
        execution.report["migration_refusals"].append({"kind": kind, "error": errors[0],
                                                       "exact_rollback": True, "database_removed": True})
    execution.sql(template, file=root / MIGRATION, label="candidate-migration", seconds=90)

    for filename, marker in PROBES:
        database = execution.database(template)
        before = execution.snapshot(database, "before-native")
        before_catalog = execution.catalog_snapshot(database, "before-native-catalog")
        path = root / "scripts/ci/probes" / filename
        execution.report["source_sha256"][str(path.relative_to(root))] = sha(path)
        _, stdout, stderr = execution.sql(database, file=path, label=filename[:-4], seconds=120)
        if stdout.splitlines().count(marker) != 1 or any(
            word in stderr for word in ("ERROR:", "FATAL:", "PANIC:", "WARNING:")
        ):
            raise ValueError("native probe lacks clean complete evidence: " + filename)
        after = execution.snapshot(database, "after-native")
        if before != after or before_catalog != execution.catalog_snapshot(database, "after-native-catalog"):
            raise ValueError("native probe did not restore original application/auth rows or schema: " + filename)
        execution.discard(database)
        execution.report["native"].append({"probe": filename, "marker": marker,
                                            "data_rollback": True, "database_removed": True})

    for case in cases:
        database = execution.database(template)
        execution.sql(database, file=root / catalog["fixture"]["path"], label="race-fixture")
        spec = (root / case["path"]).read_text()
        # libpq receives a fully specified local target, no ambient service/URL.
        conninfo = f"host={execution.socket} port={execution.port} dbname={database} user=postgres"
        code, stdout, stderr = execution.run(case["case"], [binary, conninfo], text=spec,
                                             seconds=45, check=False)
        result = validate_case_result(case, spec, stdout=stdout, stderr=stderr, returncode=code)
        execution.discard(database)
        execution.report["races"].append({"case": case["case"], "result": result,
                                           "database_removed": True})
    execution.discard(template)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--work-parent", type=Path, default=Path(tempfile.gettempdir()))
    parser.add_argument("--deadline-seconds", type=int, default=600)
    args = parser.parse_args()
    if not 60 <= args.deadline_seconds <= 900:
        parser.error("deadline must be bounded between 60 and 900 seconds")
    root = Path(__file__).resolve().parents[2]
    pg = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@17/bin")).resolve()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("output must be new or empty; previous attempt evidence cannot be overwritten")
    output.mkdir(parents=True, exist_ok=True)
    for name in ("postgres", "pg_ctl", "initdb", "psql"):
        if not (pg / name).is_file() or not os.access(pg / name, os.X_OK):
            parser.error("missing installed PG17 binary: " + name)
    for signum in CANCELLATION_SIGNALS:
        signal.signal(signum, interrupted)
    execution = Execution(root, output, pg, args.work_parent.resolve(), args.deadline_seconds)
    failure = None
    try:
        run_cases(execution)
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
    finally:
        # Preserve the first interruption and finish this bounded cleanup even
        # if the supervisor sends another normal termination signal.
        for signum in CANCELLATION_SIGNALS:
            signal.signal(signum, signal.SIG_IGN)
        try:
            execution.close()
        except BaseException as error:
            failure = (failure + "; " if failure else "") + f"cleanup {type(error).__name__}: {error}"
        execution.report["status"] = "passed" if failure is None else "failed"
        execution.report["failure"] = failure
        execution.report["ended_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output / "result.json").write_text(json.dumps(execution.report, indent=2) + "\n")
    print(json.dumps({"status": execution.report["status"], "failure": failure,
                      "native_probes": len(execution.report["native"]),
                      "race_cases": len(execution.report["races"]),
                      "cleanup": execution.report["cleanup"], "evidence": str(output)}))
    raise SystemExit(1 if failure else 0)


if __name__ == "__main__":
    main()
