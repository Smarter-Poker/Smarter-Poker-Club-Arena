#!/usr/bin/env python3
"""Run by scripts/ci/test-data-console-postgres-contracts.sh (CI shard 2).

Qualify 20261017204111_the_club_data_report_reads_what_the_club_played on top
of 20261017160125, over production's own text for every writer it changes
(tests/fixtures/club-data-report-db/fixture.sql). Nothing reaches production.


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
MIG2 = ROOT / "supabase/migrations/20261017204111_the_club_data_report_reads_what_the_club_played.sql"
MIG3 = ROOT / "supabase/migrations/20261017221938_the_fourteen_day_club_data_screen_reads_only_what_it_shows.sql"
FIXTURE = ROOT / "tests/fixtures/club-data-fact-db/fixture.sql"
SCENARIO = ROOT / "tests/fixtures/club-data-fact-db/scenario.sql"
FIXTURE2 = ROOT / "tests/fixtures/club-data-report-db/fixture.sql"
SCENARIO2 = ROOT / "tests/fixtures/club-data-report-db/scenario.sql"
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
    run(psql("live"), FIXTURE2.read_text())
    run(psql("live"), MIG.read_text())
    report = MIG2.read_text()

    run(psql("live"), report.replace("\nCOMMIT;", "\nROLLBACK;"))
    require(q("live", "SELECT to_regprocedure('public.fn_ca_reporting_rollups_from_facts(date)') IS NULL") == "t",
            "a rolled-back run installs nothing")
    run(psql("live"), "SET ROLE authenticated;\n" + report, expect_fail="ERROR")
    require(q("live", "SELECT to_regprocedure('public.fn_ca_reporting_rollups_from_facts(date)') IS NULL") == "t",
            "a browser role cannot install it")

    run(psql("live"), report)
    require(q("live", "SELECT to_regprocedure('public.fn_ca_reporting_rollups_from_facts(date)') IS NOT NULL") == "t",
            "the migration installs over production's writers and readers")
    run(psql("live"), MIG3.read_text())
    require(q("live", "SELECT prosrc LIKE '%v_cands%' FROM pg_proc WHERE proname = 'ca_club_data_screen'") == "t",
            "the plain screen chooses its rows newest day first (20261017221938)")
    require(q("live", "SELECT count(*) FROM pg_proc WHERE proname IN ('ca_club_data_snapshot','ca_club_player_breakdown','ca_rake_snapshot') "
                      "AND prosrc ~ 'ca_can_(view_club_finances|read_club_production)\\('") == "0",
            "every Report reader asks the whole-club Report question")
    require(q("live", "SELECT count(*) FROM pg_proc WHERE proname LIKE 'ca_club_player%' AND prosrc ~ 'joined_at ASC'") == "0",
            "no Report player list is chosen by earliest-joined club")
    require(q("live", "SELECT has_function_privilege('authenticated', 'public.fn_ca_reporting_rollups_from_facts(date)', 'EXECUTE')") == "f",
            "a browser cannot rebuild the Report tables")

    p = run(psql("live"), SCENARIO.read_text().replace("@PORT@", str(PORT)))
    require("SCENARIO PASSED" in p.stderr + p.stdout, "the Club Data scenario still holds on the faster screen")
    p = run(psql("live"), SCENARIO2.read_text().replace("@PORT@", str(PORT)))
    require("REPORT SCENARIO PASSED" in p.stderr + p.stdout,
            "report scenario: live writers, rebuild from facts, club rake, Report access, player lists")
    history = (ROOT / "tests/fixtures/club-data-report-db/history-scenario.sql").read_text()
    before = run(psql("live"), history, expect_fail="history regression:")
    require("later receipt moved historical rake" in before.stderr
            and "later seat moved historical rake" in before.stderr,
            "the old calculator fails both dated funding regressions")
    run(psql("live"), (ROOT / "supabase/migrations/20261018134944_club_rake_history_follows_the_funding_at_the_hand.sql").read_text())
    require(q("live", "SELECT NOT has_function_privilege('anon', 'public.fn_ca_club_rake_daily_compute(timestamptz,timestamptz,uuid[])', 'EXECUTE') "
                      "AND NOT has_function_privilege('authenticated', 'public.fn_ca_club_rake_daily_compute(timestamptz,timestamptz,uuid[])', 'EXECUTE') "
                      "AND has_function_privilege('service_role', 'public.fn_ca_club_rake_daily_compute(timestamptz,timestamptz,uuid[])', 'EXECUTE')") == "t",
            "the history calculator preserves operator-only execution")
    after = run(psql("live"), history)
    require("HISTORY SCENARIO PASSED" in after.stderr + after.stdout,
            "historical receipts and seats, decimal contributions, witness precedence and conservation")
    print("PASS: the Club Data Report reads what the club played", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
