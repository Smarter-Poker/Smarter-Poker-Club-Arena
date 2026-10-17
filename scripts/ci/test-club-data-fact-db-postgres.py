#!/usr/bin/env python3
"""Run by scripts/ci/test-data-console-postgres-contracts.sh (CI shard 2).

Qualify 20261017160125_club_data_counts_what_the_club_played on a private
PostgreSQL cluster (127.0.0.1, a free port, trust auth, a temporary data
directory under $TMPDIR). Nothing here reaches production.

Production read 2026-10-17 03:30 UTC: Club JAQK's Club Data screen showed 5
games and 132.71 of fee for a morning in which its players had bought into
2,683 tournaments and paid 13,182.27 of cash rake through Club JAQK on union
tables. Every union fact was filed under the player's EARLIEST joined union
club (SHARK CLUB), never the club the money moved through.

The scenario (tests/fixtures/club-data-fact-db/scenario.sql) builds that
shape - two clubs in one union, the player joined to SHARK first and playing
through JAQK - and proves, against the real migration:
  * the insert triggers file cash rake, buy-ins, cash-outs, tournament fees,
    entries and prizes under the club the money moved through;
  * the owner reads the whole club, an agent reads himself and his downline,
    a player and a signed-out caller are refused;
  * chips on the felt count as the club's, not as a loss;
  * the seed rebuilds exactly what the triggers wrote, refuses to run before
    live_from has settled, and refuses an overlapping window.
It also proves a rolled-back run installs nothing and a browser role cannot
install it.
"""
import os
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "supabase/migrations/20261017160125_club_data_counts_what_the_club_played.sql"
FIXTURE = ROOT / "tests/fixtures/club-data-fact-db/fixture.sql"
SCENARIO = ROOT / "tests/fixtures/club-data-fact-db/scenario.sql"
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin",
                                                        "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "PGTZ": "UTC"}

cluster = Path(tempfile.mkdtemp(prefix="club-data-fact-", dir=os.environ.get("TMPDIR")))
data = cluster / "data"
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    PORT = s.getsockname()[1]
started = False


def psql(db, user="postgres"):
    return [str(PG / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", str(PORT), "-U", user, "-d", db]


def run(argv, text=None, expect_fail=None):
    p = subprocess.run(argv, input=text, capture_output=True, text=True, env=ENV, timeout=300)
    if expect_fail is not None:
        if p.returncode == 0 or expect_fail not in p.stderr:
            raise AssertionError(f"expected failure containing {expect_fail!r}\n{p.stdout}\n{p.stderr[-3000:]}")
        return p
    if p.returncode:
        raise RuntimeError(p.stdout[-3000:] + p.stderr[-3000:])
    return p


def q(db, sql, user="postgres"):
    return run(psql(db, user), sql).stdout.strip()


def require(cond, label):
    if not cond:
        raise AssertionError("FAIL: " + label)
    print("PASS: " + label, flush=True)


def installed(db):
    return q(db, "SELECT to_regclass('public.ca_club_data_fact') IS NOT NULL") == "t"


try:
    run([PG / "initdb", "-D", data, "-U", "fixture_bootstrap", "--auth-local=trust", "--auth-host=trust", "--no-locale", "-E", "UTF8"])
    with (data / "postgresql.conf").open("a") as f:
        f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nunix_socket_directories=''\nfsync=off\nautovacuum=off\ntimezone='UTC'\n")
    run([PG / "pg_ctl", "-D", data, "-l", cluster / "server.log", "-w", "start"])
    started = True
    q("postgres", "CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE; CREATE ROLE anon; CREATE ROLE authenticated; "
                  "CREATE ROLE service_role; CREATE ROLE supabase_admin; GRANT anon, authenticated, service_role TO postgres; "
                  "CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon, authenticated, service_role TO authenticator;",
      user="fixture_bootstrap")
    q("postgres", "CREATE DATABASE live OWNER postgres;", user="fixture_bootstrap")
    run(psql("live"), FIXTURE.read_text())
    migration = MIG.read_text()

    run(psql("live"), migration.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(not installed("live"), "a rolled-back run installs nothing")
    run(psql("live"), "SET ROLE authenticated;\n" + migration, expect_fail="ERROR")
    require(not installed("live"), "a browser role cannot install it")

    run(psql("live"), migration)
    require(installed("live"), "the migration installs on the fixture")
    require(q("live", "SELECT count(*) FROM pg_trigger WHERE tgname IN ('ca_club_data_fact_rake','ca_club_data_fact_wallet')") == "2",
            "both live writers are attached")
    require(q("live", "SELECT has_function_privilege('anon', 'public.ca_club_data_screen(uuid,date,date,text,text,text,integer)', 'EXECUTE')") == "f",
            "a signed-out caller cannot call the screen")
    require(q("live", "SELECT has_table_privilege('authenticated', 'public.ca_club_data_fact', 'SELECT')") == "f",
            "the facts are read only through the scoped screen")

    p = run(psql("live"), SCENARIO.read_text().replace("@PORT@", str(PORT)))
    require("SCENARIO PASSED" in p.stderr + p.stdout, "scenario.sql: facts, scopes, felt, filters and seed all hold")
    print("PASS: Club Data counts what the club played", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
