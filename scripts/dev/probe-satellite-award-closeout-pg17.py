#!/usr/bin/env python3
"""Run the unchanged funded-award cases in a caller-owned local PG17 cluster.

Only a Unix socket is accepted. Creates uniquely named fixture databases and
never stops the cluster, drops a database, or touches a production connection.
Auth, external lifecycle and relation grants are synthetic fixture boundaries.
"""
from pathlib import Path
import argparse, concurrent.futures, hashlib, json, os, subprocess, sys, tempfile, time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--socket", required=True)
parser.add_argument("--port", required=True)
parser.add_argument("--user", required=True)
args, unknown = parser.parse_known_args()
assert Path(args.socket).is_absolute() and Path(args.socket).is_dir()
assert args.port.isdigit()
PG = Path(os.environ.get("POKER_AUDIT_PG_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
out = Path(tempfile.mkdtemp(prefix="ca-satellite-award-closeout-"))
database = "postgres"
created = []
passed = []
waits = []
run_id = str(int(time.time()))[-7:]
prefix = "satellite_award_closeout_sep10_" + run_id + "_"
fixture = ROOT / "scripts/dev/fixtures/satellite-refund/fixture.sql"
overlay = ROOT / "scripts/dev/fixtures/registration-funding/installed.sql"
award_dir = ROOT / "scripts/dev/fixtures/satellite-award-funding"
installed = (award_dir / "installed.sql").read_text()
source = json.loads((award_dir / "current-closeout-source.json").read_text())
migration = next((ROOT / "supabase/migrations").glob("*_tournament_entry_receipts_use_the_charged_club_wallet.sql"))
log = (out / "results.log").open("w")

def env():
    return dict(os.environ, PGHOST=args.socket, PGHOSTADDR="", PGPORT=args.port,
                PGUSER=args.user, PGDATABASE=database)
def command():
    return [str(PG / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]
def q(sql, expected_error=None):
    # The unchanged case module installs the captured award subgraph. Restore
    # only the candidate's five captured function authority envelopes afterward.
    if sql == installed:
        sql += "\nGRANT USAGE ON SCHEMA public,auth,extensions TO postgres;\n"
        sql += "GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;\n"
        sql += "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres;\n"
        for row in source:
            sig = "public." + row["signature"]
            sql += f"ALTER FUNCTION {sig} OWNER TO postgres; SET ROLE postgres;\n"
            sql += f"REVOKE ALL ON FUNCTION {sig} FROM PUBLIC,anon,authenticated;\n"
            sql += f"GRANT EXECUTE ON FUNCTION {sig} TO service_role; RESET ROLE;\n"
    r = subprocess.run(command(), input=sql+"\n", capture_output=True, text=True, env=env(), timeout=25)
    log.write(r.stdout+r.stderr); log.flush()
    if expected_error:
        assert r.returncode != 0 and expected_error in r.stderr, r.stderr
    else:
        assert r.returncode == 0, r.stderr
    return r.stdout.strip()
def uid(n): return "c1000000-0000-4000-8000-" + str(n).zfill(12)
SOURCE = "c3000000-0000-4000-8000-000000000001"
CLUB = "c2000000-0000-4000-8000-000000000001"
def register(user, request):
    key = "c8000000-0000-4000-8000-" + str(request).zfill(12)
    return f"SET test.actor='{uid(user)}'; SELECT public.fn_register_for_tournament_request('{SOURCE}','{key}');"
def fresh(name, cap=100):
    global database
    database = "postgres"
    target = prefix + str(len(created)).zfill(2)
    assert len(target) < 63 and target.startswith("satellite_award_closeout_sep10_")
    q('CREATE DATABASE "'+target+'";')
    database = target
    created.append(dict(database=target, case=name))
    q(fixture.read_text())
    q(overlay.read_text())
    q(migration.read_text())
    q((award_dir / "current-reader.sql").read_text())
    q(f"INSERT INTO clubs(id) VALUES ('{CLUB}');")
    for n in range(1,5):
        q(f"INSERT INTO profiles(id,username,display_name) VALUES ('{uid(n)}','Fixture {n}','Fixture {n}'); INSERT INTO club_members(club_id,user_id,chip_balance,status,role) VALUES ('{CLUB}','{uid(n)}',500,'active','player');")
    q(f"INSERT INTO tournaments(id,club_id,name,buy_in_amount,buy_in_fee,start_time,max_players,status,current_players,prize_pool,bounty_pool,total_rake,variant) VALUES ('{SOURCE}','{CLUB}','Isolated Entry Funding',180,20,now()+interval '1 day',{cap},'REGISTERING',0,0,0,0,'mtt');")
def check(name):
    passed.append(name)
    print("PASS "+name, flush=True)
def overlap(first, second, closing=False):
    owner = subprocess.Popen(command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=env())
    try:
        owner.stdin.write("BEGIN; "+first+" SELECT 'owner-ready';\n")
        owner.stdin.flush()
        lines = []
        while True:
            line = owner.stdout.readline().strip()
            if line == "owner-ready": break
            if line: lines.append(line)
            assert owner.poll() is None, "owner exited: "+owner.stderr.read()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            application = "satellite-award-closeout-"+run_id
            contender = pool.submit(q, f"SET application_name='{application}'; "+second)
            observed = None
            for _ in range(80):
                observed = json.loads(q(f"SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',pid,'wait_event',wait_event,'blockers',pg_blocking_pids(pid))),'[]') FROM pg_stat_activity WHERE datname=current_database() AND application_name='{application}' AND wait_event_type='Lock';"))
                if observed: break
                time.sleep(.025)
            assert observed, "contender did not wait on a real database lock"
            waits.append(dict(database=database, observed=observed))
            owner.stdin.write("COMMIT;\n"); owner.stdin.close()
            owner.stdout.read()
            assert owner.wait(timeout=15) == 0, owner.stderr.read()
            other = contender.result(timeout=15)
        return (None if closing else json.loads(lines[-1])), json.loads(other)
    finally:
        if owner.poll() is None:
            owner.kill(); owner.wait(timeout=5)

try:
    assert q("SHOW server_version;").startswith("17.")
    from satellite_award_funding_cases import verify
    verify(q, fresh, overlap, register, check)
    if '--satellite-baseline' not in sys.argv and '--satellite-lock-reconciliation-only' not in sys.argv:
        sys.argv.append('--satellite-lock-reconciliation-only')
        try: verify(q, fresh, overlap, register, check)
        finally: sys.argv.remove('--satellite-lock-reconciliation-only')
        from satellite_award_closeout_cases import verify as verify_closeout
        verify_closeout(q,fresh,overlap,register,check)
finally:
    log.close()
    files = [fixture, overlay, migration, award_dir/"installed.sql", award_dir/"source-manifest.json",
             award_dir/"current-closeout-source.json", award_dir/"current-reader.sql",
             award_dir/"current-callable-envelope.json", award_dir/"current-dependency-hashes.json",
             ROOT/"scripts/dev/satellite_award_closeout_cases.py",
             ROOT/"scripts/dev/satellite_award_funding_cases.py", Path(__file__)]
    files += list((ROOT/"supabase/migrations").glob("*_satellite_seats_count_once_and_keep_the_funded_prize.sql"))
    evidence = dict(passed=passed, observed_waits=waits, databases=created, production_database_used=False,
                    fixture_auth_and_relation_grants_are_synthetic=True,
                    files={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files})
    (out/"results.json").write_text(json.dumps(evidence,indent=2)+"\n")
    print("Evidence: "+str(out/"results.json"), flush=True)
