"""Native PostgreSQL17 proof of horse seat-touch session attribution.
Only the telemetry row and actual touch function are exercised; no money contracts
or production connections are part of this isolated fixture.
"""
import argparse, concurrent.futures, json, os, pathlib, shutil, subprocess, tempfile, uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=pathlib.Path, default=ROOT / "artifacts/horse-seat-touch-session")
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = pathlib.Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
env["LC_ALL"] = "C"
cluster = pathlib.Path(tempfile.mkdtemp(prefix="horse-touch-native-"))
sock = cluster / "socket"
sock.mkdir(mode=0o700)
psql = [str(pg / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
        "-h", str(sock), "-p", "55763", "-U", "postgres", "-d", "postgres"]
results = {"checks": [], "production_mutations": False,
           "scope": "Actual touch function and isolated telemetry rows; no financial qualification."}
horse, other, previous, current = [str(uuid.UUID(int=i)) for i in (1, 2, 3, 4)]
migration = (ROOT / "supabase/migrations/20260914072500_horse_seat_touch_session_scope.sql").read_text()

def command(argv, sql=None, timeout=30):
    result = subprocess.run(list(map(str, argv)), input=sql, text=True,
                            capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()

def run(sql):
    return command(psql, sql)

def literal(value):
    return "'" + str(value).replace("'", "''") + "'"

def check(name, condition):
    results["checks"].append({"name": name, "passed": bool(condition)})
    if not condition:
        raise AssertionError(name)

def state():
    return json.loads(run("SELECT to_jsonb(s) FROM ca_horse_fleet_state s WHERE horse_id=" + literal(horse)))

def reset(table=current, start="2026-09-14 07:00Z", action="2026-09-14 07:10Z"):
    def nullable(value):
        return "NULL" if value is None else literal(value)
    run("TRUNCATE ca_horse_fleet_state; INSERT INTO ca_horse_fleet_state VALUES (" +
        ",".join([literal(horse), nullable(table), nullable(action), "7", nullable(start),
                  literal("2026-09-14 07:10Z")]) + ");")

def row(table=current, hands=2, at="2026-09-14T07:11:00Z", who=horse):
    return {"horse_id": who, "table_id": table, "hands": hands, "at": at}

def touch(rows, role="service_role"):
    sql = "SET ROLE " + role + "; SELECT fn_ca_fleet_seat_touch(" + literal(json.dumps(rows)) + "::jsonb);"
    return int(run(sql).splitlines()[-1])

def refusal(name, sql, message):
    result = subprocess.run(psql, input=sql, text=True, capture_output=True, env=env, timeout=20)
    check(name, result.returncode != 0 and message in result.stderr)

try:
    check("native-postgresql17", command([pg / "postgres", "--version"]).startswith("postgres (PostgreSQL) 17."))
    command([pg / "initdb", "-D", cluster / "data", "-U", "postgres", "--auth-local=trust",
             "--auth-host=reject", "--no-locale", "--encoding=UTF8"])
    command([pg / "pg_ctl", "-D", cluster / "data", "-l", cluster / "server.log",
             "-o", f"-k {sock} -p 55763 -c listen_addresses='' -c timezone=UTC -c shared_buffers=16MB -c max_connections=10",
             "-w", "start"])
    run("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE ca_horse_fleet_state(horse_id uuid PRIMARY KEY, table_id uuid,
          last_action_at timestamptz, hands_this_session integer,
          session_started_at timestamptz, updated_at timestamptz);""")
    run((ROOT / "scripts/ci/probes/horse-seat-touch/baseline.sql").read_text())
    run("REVOKE ALL ON FUNCTION fn_ca_fleet_seat_touch(jsonb) FROM PUBLIC,anon,authenticated;"
        "GRANT EXECUTE ON FUNCTION fn_ca_fleet_seat_touch(jsonb) TO service_role;")
    check("exact-live-preimage", run("SELECT md5(pg_get_functiondef('fn_ca_fleet_seat_touch(jsonb)'::regprocedure))")
          == "0cdb26a288d0d570f184de7f97747e1a")
    reset()
    touch([row(previous, 2, "2026-09-14T06:50:00Z")])
    check("baseline-prior-table-overwrites-current-session", state()["hands_this_session"] == 2
          and state()["session_started_at"].startswith("2026-09-14T06:50:00"))
    reset(table=None)
    touch([row(previous)])
    check("baseline-departed-horse-still-accumulates", state()["hands_this_session"] == 9)
    reset()
    touch([row(previous), row(current, 1)])
    check("baseline-mixed-table-batch-corrupts-current-count", state()["hands_this_session"] == 3)
    reset()
    baseline_count = touch([row()])
    baseline_state = {k:v for k,v in state().items() if k != "updated_at"}

    run(migration)
    check("candidate-definition", run("SELECT md5(pg_get_functiondef('fn_ca_fleet_seat_touch(jsonb)'::regprocedure))")
          == "81166657f0d13fe290b449037726dfb4")
    for name, stored_table, supplied_table in [
        ("prior-table", current, previous), ("departed-horse", None, previous),
        ("unscoped-touch", current, None), ("empty-table", current, "")]:
        reset(table=stored_table)
        before = state()
        check(name + "-not-counted", touch([row(supplied_table)]) == 0)
        check(name + "-preserves-complete-row", state() == before)
    reset()
    check("matching-table-return-count-preserved", touch([row()]) == baseline_count)
    check("matching-table-state-preserved", {k:v for k,v in state().items() if k != "updated_at"} == baseline_state)
    reset()
    check("matching-table-does-not-backdate-action", touch([row(at="2026-09-14T06:50:00Z")]) == 1
          and state()["last_action_at"].startswith("2026-09-14T07:10:00"))
    check("out-of-order-current-table-hands-still-counted", state()["hands_this_session"] == 9)
    reset(start=None, action=None)
    touch([row()])
    check("first-current-touch-establishes-clock", state()["last_action_at"].startswith("2026-09-14T07:11:00")
          and state()["session_started_at"].startswith("2026-09-14T07:11:00"))
    for name, rows in [
        ("old-then-current", [row(previous), row(current, 1)]),
        ("current-then-old", [row(current, 1), row(previous)]),
        ("unscoped-then-current", [row(None), row(current, 1)])]:
        reset()
        check(name + "-counts-only-current", touch(rows) == 1 and state()["hands_this_session"] == 8)
        check(name + "-preserves-session-start", state()["session_started_at"].startswith("2026-09-14T07:00:00"))
    reset()
    before = state()
    check("unknown-horse-no-row", touch([row(who=other)]) == 0 and state() == before)
    for name, rows in [("empty", []), ("object", {}), ("scalar", "bad"), ("json-null", None)]:
        check(name + "-does-not-mutate", touch(rows) == 0 and state() == before)
    check("sql-null-does-not-mutate", run("SELECT fn_ca_fleet_seat_touch(NULL)") == "0" and state() == before)
    reset()
    before = state()
    bad = [row(), row(who="malformed-uuid")]
    refusal("malformed-later-row-rolls-back-complete-batch",
            "SET ROLE service_role; SELECT fn_ca_fleet_seat_touch(" + literal(json.dumps(bad)) + "::jsonb)",
            "invalid input syntax for type uuid")
    check("failed-batch-retains-first-row-preimage", state() == before)
    for role in ("anon", "authenticated"):
        refusal(role + "-cannot-call-telemetry-writer",
                "SET ROLE " + role + "; SELECT fn_ca_fleet_seat_touch('[]'::jsonb);",
                "permission denied for function")
    check("service-has-no-direct-table-authority",
          run("SELECT NOT has_table_privilege('service_role','ca_horse_fleet_state','UPDATE')") == "t")
    reset()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        counts = list(pool.map(lambda _: touch([row(hands=1)]), range(2)))
    check("concurrent-current-touches-serialize-without-lost-increment", counts == [1,1] and state()["hands_this_session"] == 9)
    before = state()
    run(migration)
    check("migration-replay-preserves-telemetry", state() == before)
    definition = run("SELECT pg_get_functiondef('fn_ca_fleet_seat_touch(jsonb)'::regprocedure)")
    run(definition.replace("declare n int", "declare\n-- unqualified change\nn int"))
    refusal("migration-refuses-drifted-function", migration, "horse seat touch changed")
    run(definition)
    check("candidate-table-stays-under-fleet-manager-control", state()["table_id"] == current)
    results["passed"] = True
finally:
    subprocess.run([str(pg / "pg_ctl"), "-D", str(cluster / "data"), "-m", "immediate", "-w", "stop"],
                   env=env, capture_output=True, timeout=20)
    shutil.rmtree(cluster)
    (out / "RESULTS.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps({"passed": results["passed"], "checks": len(results["checks"]),
                  "production_mutations": False, "evidence": str(out / "RESULTS.json")}))
