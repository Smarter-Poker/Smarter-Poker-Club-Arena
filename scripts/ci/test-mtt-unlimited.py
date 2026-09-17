#!/usr/bin/env python3
"""Exercise the R46 preparation slices in the existing accounting PG17 job.

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

from mtt_isolation_results import validate_case_result, validate_format_lock_result
from mtt_unlimited_fixture import compose, preparation_supplement_sql
from mtt_format_qualification import qualification_sql
from mtt_historical_freebuy_proof import qualify as qualify_historical_freebuy


PREPARATION_CATALOG = "scripts/ci/fixtures/mtt-format-preparation/source-binding.json"
SUCCESSOR_CAPTURE = "scripts/ci/fixtures/mtt-format-preparation/current-satellite-successor-20260917.json"
PREPARATION_STAGES = (
    ("foundation", "20260917060000_mtt_persisted_format_preparation.sql", "mtt-format-preparation-native.sql", "MTT_FORMAT_PREPARATION_NATIVE_PASS", "FORMAT PASS:", 34),
    ("capacity", "20260917061000_mtt_dual_capacity_admission_preparation.sql", "mtt-dual-capacity-preparation-native.sql", "MTT_DUAL_CAPACITY_PREPARATION_NATIVE_PASS", "DUAL CAP PASS:", 28),
    ("launch", "20260917062000_mtt_launch_format_preparation.sql", "mtt-launch-format-preparation-native.sql", "MTT_LAUNCH_FORMAT_PREPARATION_NATIVE_PASS", "LAUNCH FORMAT PASS:", 22),
    ("projections", "20260917063000_mtt_format_read_projections.sql", "mtt-format-read-projections-native.sql", "MTT_FORMAT_READ_PROJECTIONS_NATIVE_PASS", "FORMAT PROJECTION PASS:", 17),
    ("seats", "20260917064000_mtt_recorded_format_seat_consumers_preparation.sql", "mtt-seat-consumers-preparation-native.sql", "MTT_SEAT_CONSUMERS_PREPARATION_NATIVE_PASS", "SEAT CONSUMER PASS:", 31),
    ("creation", "20260917065000_mtt_dual_creation_preparation.sql", "mtt-dual-creation-preparation-native.sql", "MTT_DUAL_CREATION_PREPARATION_NATIVE_PASS", "DUAL CREATION PASS:", 35),
    ("satellite_restart", "20260917070000_mtt_dual_satellite_restart_preparation.sql", "mtt-dual-satellite-restart-preparation-native.sql", "MTT_DUAL_SATELLITE_RESTART_PREPARATION_NATIVE_PASS", "DUAL SATELLITE PASS:", 44),
    ("read_capacity", "20260917071000_mtt_read_capacity_preparation.sql", "mtt-read-capacity-preparation-native.sql", "MTT_READ_CAPACITY_PREPARATION_NATIVE_PASS", "READ CAPACITY PASS:", 38),
)
LOCK_SPECS = {
    "format_admission": "scripts/ci/probes/mtt-format-admission-lock.spec",
    "registration_admission": "scripts/ci/probes/mtt-registration-admission-lock.spec",
    "seat_capacity_admission": "scripts/ci/probes/mtt-seat-capacity-admission-lock.spec",
}
PENDING_ACTIVATION_CASES = (
    "creation_commit", "creation_rollback", "edit_after_creation", "edit_before_creation",
    "restart_commit", "restart_rollback",
)
PREPARATION_RACES = {
    "synthetic_future": ("satellite-restart-future.sql", PENDING_ACTIVATION_CASES),
    "legacy": ("satellite-creator-legacy.sql", ("creation_commit", "creation_rollback")),
}
CANCELLATION_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
# The foundation probe deliberately installs a normalizer that tries to change
# one historical business row. Its rollback and unqualified marker are asserted
# by the probe; this exact warning is required evidence of that refusal.
FOUNDATION_REFUSAL_WARNING = (
    "MTT format unqualified for event 46463000-0000-4000-8000-000000000024: "
    "MTT_FORMAT_METADATA_BACKFILL_CHANGED_BUSINESS_ROW (55000)"
)


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
    # The existing accounting job already builds the matching PostgreSQL tool.
    # An explicit path is authoritative: do not silently fall back if broken.
    requested = os.environ.get("PG_ISOLATION_TESTER")
    if requested is not None:
        path = Path(requested)
        if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
            raise RuntimeError("configured PostgreSQL isolationtester is not executable")
        return path.resolve()
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


def bound_asset(root, entry, expected_path=None):
    if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
        raise ValueError("bound asset requires an exact repository path")
    relative = entry["path"]
    if expected_path is not None and relative != expected_path:
        raise ValueError("catalog must bind the actual preparation asset path: " + expected_path)
    path = (root / relative).resolve()
    if Path(relative).is_absolute() or not path.is_relative_to(root) or sha(path) != entry.get("sha256"):
        raise ValueError("preparation asset source binding changed: " + relative)
    return path


def preparation_inputs(execution):
    root = execution.root
    catalog_path = root / PREPARATION_CATALOG
    catalog = json.loads(catalog_path.read_text())
    if catalog.get("version") != 1 or catalog.get("mode") != "preparation":
        raise ValueError("exact preparation catalog version/mode required")
    stages = catalog.get("stages")
    if not isinstance(stages, list) or [s.get("id") for s in stages] != [s[0] for s in PREPARATION_STAGES]:
        raise ValueError("all eight ordered preparation stages are required; no partial success")
    assets = []
    for stage, (name, migration, probe, marker, prefix, count) in zip(stages, PREPARATION_STAGES):
        bound_asset(root, stage.get("migration"), "supabase/migrations/" + migration)
        bound_asset(root, stage.get("probe"), "scripts/ci/probes/" + probe)
        if (stage.get("marker") != marker or stage.get("notice_prefix") != prefix
                or type(stage.get("assertions")) is not int or stage["assertions"] <= 0
                or (count is not None and stage["assertions"] != count)):
            raise ValueError("native assertion contract is missing or changed: " + name)
        assets.extend([stage["migration"], stage["probe"]])
    locks = catalog.get("locks")
    if not isinstance(locks, list) or [entry.get("case") for entry in locks] != list(LOCK_SPECS):
        raise ValueError("all preparation, registration and physical-seat lock contracts are required")
    for lock in locks:
        bound_asset(root, lock, LOCK_SPECS[lock["case"]])
        if lock.get("permutations") != 2:
            raise ValueError("both real preparation lock permutations required")
        assets.append(lock)
    fixtures = catalog.get("fixtures")
    if not isinstance(fixtures, list) or not fixtures:
        raise ValueError("exact captured preparation supplements required")
    if len({f.get("path") for f in fixtures}) != len(fixtures):
        raise ValueError("duplicate preparation capture")
    if (fixtures[0].get("path") != SUCCESSOR_CAPTURE
            or fixtures[0].get("kind") != "function-successor"
            or fixtures[0].get("presence") != "exact-predecessor"):
        raise ValueError("exact current satellite successor must precede other supplements")
    for fixture in fixtures:
        path = bound_asset(root, fixture)
        if (path.parent != (root / PREPARATION_CATALOG).parent.resolve()
                or path.suffix != ".json" or fixture.get("kind") not in ("functions", "registry", "tables", "function-successor")
                or fixture.get("presence") not in ("absent", "exact", "exact-or-absent", "exact-predecessor")):
            raise ValueError("unsupported captured preparation fixture")
        if (fixture.get("kind") == "function-successor" or fixture.get("presence") == "exact-predecessor") and fixture is not fixtures[0]:
            raise ValueError("only the exact first satellite successor may replace a captured predecessor")
        assets.append(fixture)
        if fixture["kind"] == "tables":
            if (fixture["path"] != "scripts/ci/fixtures/mtt-format-preparation/projection-tables-20260917.json"
                    or fixture["presence"] != "absent"):
                raise ValueError("only the exact absent projection table supplement is supported")
            bound_asset(root, fixture.get("schema"),
                        "scripts/ci/fixtures/mtt-format-preparation/projection-tables-20260917.sql")
            assets.append(fixture["schema"])
    if catalog.get("pending_activation_cases") != list(PENDING_ACTIVATION_CASES):
        raise ValueError("six pending activation race requirements must remain visible")
    races = catalog.get("preparation_races")
    if not isinstance(races, list) or [r.get("mode") for r in races] != list(PREPARATION_RACES):
        raise ValueError("both synthetic-future and legacy preparation race groups required")
    for group in races:
        fixture_name, required_cases = PREPARATION_RACES[group["mode"]]
        fixture_path = bound_asset(root, group.get("fixture"),
            "scripts/ci/fixtures/mtt-format-preparation/" + fixture_name)
        if any(line.lstrip().startswith(("\\i ", "\\ir ")) for line in fixture_path.read_text().splitlines()):
            raise ValueError("unbound preparation race fixture include")
        cases = group.get("cases")
        if not isinstance(cases, list) or [c.get("case") for c in cases] != list(required_cases):
            raise ValueError("all eight ordered preparation race cases required")
        assets.append(group["fixture"])
        for case in cases:
            bound_asset(root, case, "scripts/ci/probes/mtt-isolation/" + case["case"].replace("_", "-") + ".spec")
            if type(case.get("permutations")) is not int or case["permutations"] != 1:
                raise ValueError("one exact preparation race permutation required")
            assets.append(case)
    # Includes are part of executable source, not just the top-level probe hash.
    foundation = stages[0]
    include = "\\ir ../../../" + foundation["migration"]["path"]
    if (root / foundation["probe"]["path"]).read_text().splitlines().count(include) != 1:
        raise ValueError("foundation probe must include its actual bound migration exactly once")
    for stage in stages[1:]:
        if any(line.lstrip().startswith(("\\i ", "\\ir ")) for line in (root / stage["probe"]["path"]).read_text().splitlines()):
            raise ValueError("additional unbound native include requires explicit review")
    for relative in ("scripts/ci/test-mtt-unlimited.py", "scripts/ci/mtt_isolation_results.py",
                     "scripts/ci/mtt_unlimited_fixture.py", "scripts/ci/mtt_format_qualification.py", PREPARATION_CATALOG):
        execution.report["source_sha256"][relative] = sha(root / relative)
    for asset in assets:
        execution.report["source_sha256"][asset["path"]] = asset["sha256"]
    return catalog


def assert_probe_result(stage, stdout, stderr):
    if stdout.splitlines().count(stage["marker"]) != 1 or any(
            word in stderr or word in stdout for word in ("ERROR:", "FATAL:", "PANIC:")):
        raise ValueError("native probe lacks clean complete evidence: " + stage["id"])
    warnings = [line.split("WARNING:", 1)[1].strip()
                for line in stderr.splitlines() if "WARNING:" in line]
    expected = [FOUNDATION_REFUSAL_WARNING] if stage["id"] == "foundation" else []
    if "WARNING:" in stdout or warnings != expected:
        raise ValueError("native probe warning evidence differs: " + stage["id"])
    if stderr.count(stage["notice_prefix"]) != stage["assertions"]:
        raise ValueError("native assertion count differs: " + stage["id"])


def assert_rollback(execution, database, before_data, before_catalog, label):
    after_data = execution.snapshot(database, label + "-after-data")
    after_catalog = execution.catalog_snapshot(database, label + "-after-catalog")
    if after_data != before_data or after_catalog != before_catalog:
        raise ValueError(label + " did not preserve full application/auth data and catalog")


def run_drift_cases(execution, template, stage, cases):
    for kind, mutation, refusal in cases:
        database = execution.database(template)
        execution.sql(database, mutation, label="inject-" + kind + "-drift")
        before_data = execution.snapshot(database, "before-drift-data")
        before_catalog = execution.catalog_snapshot(database, "before-drift-catalog")
        code, _, stderr = execution.sql(database, file=execution.root / stage["migration"]["path"],
                                        label="refuse-" + kind + "-drift", check=False)
        errors = [line.split("ERROR:", 1)[1].strip() for line in stderr.splitlines() if "ERROR:" in line]
        if code != 3 or errors != [refusal]:
            raise ValueError("preparation did not refuse exact " + kind + " drift")
        assert_rollback(execution, database, before_data, before_catalog, "drift")
        execution.discard(database)
        execution.report["migration_refusals"].append({"stage": stage["id"], "kind": kind, "error": refusal,
            "exact_rollback": True, "database_removed": True})


def run_lock_cases(execution, template, entry, binary):
    spec_text = (execution.root / entry["path"]).read_text()
    signature, needle = {
        "format_admission": ("public.fn_ca_lock_mtt_admission_contract()", " FOR SHARE"),
        "registration_admission": ("public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)",
            "  PERFORM public.fn_ca_lock_mtt_admission_contract();"),
        "seat_capacity_admission": ("public.fn_ensure_late_registration_capacity(uuid,integer)",
            "  PERFORM public.fn_ca_lock_mtt_admission_contract();"),
    }[entry["case"]]
    for negative in (False, True):
        database = execution.database(template)
        if negative:
            execution.sql(database, """DO $fault$ DECLARE d text; n text:=$needle$""" + needle + """$needle$; BEGIN
              SELECT pg_get_functiondef('""" + signature + """'::regprocedure) INTO d;
              IF length(d)-length(replace(d,n,''))<>length(n) THEN RAISE EXCEPTION 'exact lock call missing';END IF;
              EXECUTE replace(d,n,'');
            END $fault$;""", label="fixture-only-missing-" + entry["case"])
        before_data = execution.snapshot(database, "lock-before-data")
        before_catalog = execution.catalog_snapshot(database, "lock-before-catalog")
        code, stdout, stderr = execution.run(entry["case"] + ("-negative" if negative else "-actual"),
            [binary, f"host={execution.socket} port={execution.port} dbname={database} user=postgres"],
            text=spec_text, seconds=45, check=False)
        result = validate_format_lock_result(entry, spec_text, stdout=stdout,
                                             stderr=stderr, returncode=code, negative=negative)
        assert_rollback(execution, database, before_data, before_catalog, "lock")
        execution.discard(database)
        execution.report["races"].append({"case": entry["case"], "negative_control": negative,
            "result": result, "exact_rollback": True, "database_removed": True})


def run_preparation_races(execution, template, groups, binary):
    # Commit/rollback races intentionally retain their local accepted result.
    # Each case owns a new database, exact economic assertions, then disposal.
    for group in groups:
        for entry in group["cases"]:
            label = group["mode"] + "-" + entry["case"]
            database = execution.database(template)
            execution.sql(database, file=execution.root / group["fixture"]["path"],
                          label="fixture-" + label)
            spec_text = (execution.root / entry["path"]).read_text()
            code, stdout, stderr = execution.run("race-" + label,
                [binary, f"host={execution.socket} port={execution.port} user=postgres dbname={database}"],
                text=spec_text, seconds=35, check=False)
            result = validate_case_result(entry, spec_text, stdout=stdout,
                                          stderr=stderr, returncode=code)
            execution.discard(database)
            execution.report["races"].append({"case": entry["case"], "mode": group["mode"],
                "qualification_scope": "preparation_branch_only", "result": result,
                "database_removed": True})


def run_cases(execution):
    root = execution.root
    catalog = preparation_inputs(execution)
    foundation = compose(root)
    supplement = preparation_supplement_sql(root, catalog["fixtures"])
    execution.report["source_sha256"].update(foundation["source_sha256"])
    execution.report["retained_preimage_capture_limits"] = foundation["limits"]
    execution.report["fixture_limits"] = [
        "The retained catalog is a captured PRE-R46 baseline; the old unlimited-entry migration is not executed.",
        "This run qualifies only the explicitly bound preparation stages and exercised branches.",
        "Six activation race cases remain pending; this run does not activate unlimited MTT admission.",
        "Six synthetic-future and two legacy creator/restart races qualify preparation branches, not the real activation transaction.",
        "The current satellite terminal body/ACL is pinned, but funded settlement and its new finish-lane/accounting dependencies are not exercised by these preparation probes.",
        "The private local PostgreSQL owner does not reproduce managed-provider administrator topology.",
    ]
    execution.report["qualification_scope"] = "preparation_only_no_activation"
    execution.report["activation"] = {"status": "pending", "required_cases": list(PENDING_ACTIVATION_CASES)}
    foundation_file = execution.output / "composed-preimage.sql"
    foundation_file.write_text(foundation["sql"] + "\n" + supplement)
    execution.report["composed_sha256"] = sha(foundation_file)
    baseline_file = execution.output / "historical-preimage.sql"
    baseline_file.write_text(foundation["sql"])
    supplement_file = execution.output / "preparation-supplements.sql"
    supplement_file.write_text(supplement)
    binary = stock_isolationtester(execution.pg)
    execution.report["isolationtester"] = {"path": str(binary), "sha256": sha(binary)}
    execution.start()
    template = execution.database()
    execution.sql(template, file=baseline_file, label="canonical-preimage", seconds=180)
    execution.report["historical_freebuy"] = qualify_historical_freebuy(
        execution, root, template, assert_rollback)
    # The first supplement upgrades exactly one observed installed successor.
    # Refuse wrong historical body or ACL before any replacement or commit.
    successor_stage = {"id": "current-satellite-successor",
                       "migration": {"path": str(supplement_file)}}
    run_drift_cases(execution, template, successor_stage, (
        ("satellite-predecessor-function", """DO $fault$ DECLARE d text; b text; BEGIN
          SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc
          WHERE oid='public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure;
          EXECUTE replace(d,b,E'\\n-- isolated predecessor drift\\n'||b);
        END $fault$;""", "captured preparation predecessor identity mismatch: public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)"),
        ("satellite-predecessor-acl", "GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid) TO authenticated;",
         "captured preparation predecessor ACL mismatch: public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)"),
    ))
    execution.sql(template, file=supplement_file, label="captured-preparation-supplements", seconds=180)

    # The original foundation probe intentionally commits historical synthetic
    # input before migration, then independently compares all business fields.
    # It is never mislabeled as a whole-database rollback test.
    stage = catalog["stages"][0]
    database = execution.database(template)
    probe = (root / stage["probe"]["path"]).read_text()
    include = "\\ir ../../../" + stage["migration"]["path"]
    probe = probe.replace(include, "\\ir '" + str(root / stage["migration"]["path"]) + "'")
    # Keep one psql session: the public fixture and its TEMP before-images are
    # intentional committed preparation inputs. Every metadata batch is its
    # own transaction after DDL, using the same source renderer as installation.
    first = "46463000-0000-4000-8000-000000000010"
    remaining = ["46463000-0000-4000-8000-" + str(n).zfill(12)
                 for n in (11, 12, 13, 20, 21, 22, 23, 24)]
    remaining += ["46463100-0000-4000-8000-" + str(n).zfill(12) for n in range(1, 1115)]
    if probe.count("-- QUALIFY_FIRST_FORMAT") != 1 or probe.count("-- REPLAY_FIRST_FORMAT") != 1 or probe.count("-- QUALIFY_REMAINING_FORMATS") != 1:
        raise ValueError("foundation must exercise explicit partial/replay/bounded qualification")
    probe = probe.replace("-- QUALIFY_FIRST_FORMAT", qualification_sql([first]))
    probe = probe.replace("-- REPLAY_FIRST_FORMAT", qualification_sql([first]))
    probe = probe.replace("-- QUALIFY_REMAINING_FORMATS",
        "\n".join(qualification_sql(remaining[i:i + 128]) for i in range(0, len(remaining), 128)))
    expanded_probe = execution.output / "foundation-native-expanded.sql"
    expanded_probe.write_text(probe)
    execution.report["foundation_qualification_batches"] = 2 + (len(remaining) + 127) // 128
    _, stdout, stderr = execution.sql(database, file=expanded_probe,
                                      label="foundation-native", seconds=120)
    assert_probe_result(stage, stdout, stderr)
    execution.discard(database)
    execution.report["native"].append({"stage": stage["id"], "assertions": stage["assertions"],
        "business_preimage_assertions": True, "data_rollback": False,
        "intentional_seed_and_preparation_commit": True, "database_removed": True})

    # Prove rejected preparation cannot leak DDL, ownership/ACL, or data changes.
    run_drift_cases(execution, template, stage, (
        ("function", """DO $fault$ DECLARE d text; b text; BEGIN
          SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc
          WHERE oid='public.fn_managed_game_contract_document(text,jsonb)'::regprocedure;
          EXECUTE replace(d,b,E'\\n-- isolated preparation drift\\n'||b);
        END $fault$;""", "MTT format provenance authority drift: public.fn_managed_game_contract_document(text,jsonb)"),
        ("constraint", "ALTER TABLE public.tournament_launch_receipts DROP CONSTRAINT tournament_launch_receipts_tournament_id_fkey;",
         "MTT format requires the existing restrictive launch-parent FK"),
        ("row-emitter-function", """DO $fault$ DECLARE d text; b text; BEGIN
          SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc
          WHERE oid='public.fn_emit_managed_game_row_event()'::regprocedure;
          EXECUTE replace(d,b,E'\\n-- isolated row emitter drift\\n'||b);
        END $fault$;""", "MTT format row event emitter preimage drift"),
        ("row-emitter-acl", "GRANT EXECUTE ON FUNCTION public.fn_emit_managed_game_row_event() TO authenticated;",
         "MTT format row event emitter preimage drift"),
        ("status-domain-absent", "ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_status_check;",
         "MTT format requires the exact validated status domain"),
        ("status-domain-unvalidated", """ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_status_check;
          ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_status_check
          CHECK ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text, 'LATE_REG'::text, 'RUNNING'::text, 'COMPLETING'::text, 'COMPLETED'::text, 'CANCELLED'::text]))) NOT VALID;""",
         "MTT format requires the exact validated status domain"),
        ("status-domain-widened", """ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_status_check;
          ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_status_check
          CHECK (upper(status) IN ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING','COMPLETING','COMPLETED','CANCELLED'));""",
         "MTT format requires the exact validated status domain"),
    ))

    execution.sql(template, file=root / stage["migration"]["path"], label="prepare-foundation")
    run_lock_cases(execution, template, catalog["locks"][0], binary)

    for stage in catalog["stages"][1:]:
        if stage["id"] == "launch":
            run_drift_cases(execution, template, stage, (
                ("unqualified-active-parent", """BEGIN;
                  SET LOCAL session_replication_role=replica;
                  INSERT INTO public.tournaments(id,name,tournament_type,variant,max_players,
                    min_players,table_size,buy_in_amount,buy_in_fee,starting_chips,
                    current_players,status,start_time,blind_structure,payout_structure)
                  VALUES('46464200-0000-4000-8000-000000000099','Unqualified historical MTT',
                    'MTT','freezeout',100,3,9,0,0,10000,0,'REGISTERING',now(),
                    '[{"level":1,"smallBlind":25,"bigBlind":50,"duration":600}]',
                    '[{"place":1,"percentage":100}]');
                  COMMIT;""",
                 "MTT_LAUNCH_REQUIRES_COMPLETE_ACTIVE_FORMAT_QUALIFICATION"),
            ))
        if stage["id"] == "projections":
            run_drift_cases(execution, template, stage, (
                ("projection-function", """DO $fault$ DECLARE d text; b text; BEGIN
                  SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc
                  WHERE oid='public.get_club_home(text)'::regprocedure;
                  EXECUTE replace(d,b,E'\\n-- isolated projection drift\\n'||b);
                END $fault$;""", "MTT_FORMAT_PROJECTION_pre_AUTHORITY_DRIFT: public.get_club_home(text)"),
                ("projection-acl", "GRANT EXECUTE ON FUNCTION public.get_club_home(text) TO anon;",
                 "MTT_FORMAT_PROJECTION_pre_ACL_DRIFT: public.get_club_home(text)"),
            ))
        if stage["id"] == "seats":
            database = execution.database(template)
            before_data = execution.snapshot(database, "original-seats-before-data")
            before_catalog = execution.catalog_snapshot(database, "original-seats-before-catalog")
            code, stdout, stderr = execution.sql(database, file=root / stage["probe"]["path"],
                label="original-seats-red", check=False)
            errors = [line.split("ERROR:", 1)[1].strip() for line in stderr.splitlines() if "ERROR:" in line]
            if code != 3 or len(errors) != 1 or not errors[0].startswith("SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS:"):
                raise ValueError("original seat consumer did not reproduce the direct MTT stack failure")
            assert_rollback(execution, database, before_data, before_catalog, "original-seats")
            execution.discard(database)
            execution.report["native"].append({"stage": "original-seats-negative-control",
                "expected_failure": errors[0], "data_rollback": True, "catalog_rollback": True, "database_removed": True})
        execution.sql(template, file=root / stage["migration"]["path"], label="prepare-" + stage["id"])
        database = execution.database(template)
        before_data = execution.snapshot(database, stage["id"] + "-before-data")
        before_catalog = execution.catalog_snapshot(database, stage["id"] + "-before-catalog")
        _, stdout, stderr = execution.sql(database, file=root / stage["probe"]["path"],
                                          label=stage["id"] + "-native", seconds=120)
        assert_probe_result(stage, stdout, stderr)
        assert_rollback(execution, database, before_data, before_catalog, stage["id"])
        execution.discard(database)
        execution.report["native"].append({"stage": stage["id"], "assertions": stage["assertions"],
            "marker": stage["marker"], "data_rollback": True, "catalog_rollback": True, "database_removed": True})
        if stage["id"] == "capacity":
            run_lock_cases(execution, template, catalog["locks"][1], binary)
        elif stage["id"] == "seats":
            run_lock_cases(execution, template, catalog["locks"][2], binary)
    run_preparation_races(execution, template, catalog["preparation_races"], binary)
    execution.discard(template)
    for relative, expected in execution.report["source_sha256"].items():
        if sha(root / relative) != expected:
            raise ValueError("executable input changed during preparation: " + relative)
    execution.report["source_binding_verified_at_completion"] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("preparation",), required=True)
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
    execution.report["mode"] = args.mode
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
