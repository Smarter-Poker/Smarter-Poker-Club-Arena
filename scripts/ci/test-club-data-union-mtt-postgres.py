#!/usr/bin/env python3
"""Private native qualification for union/MTT Club Data correction. No production access."""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path
from decimal import Decimal

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
    run(psql("live"), MIG.read_text())
    run(psql("live"), FIXTURE2.read_text())
    run(psql("live"), MIG2.read_text())
    run(psql("live"), MIG3.read_text())
    run(psql("live"), SCENARIO.read_text().replace("@PORT@",str(PORT)))
    q("live", "ALTER TABLE tables ADD COLUMN IF NOT EXISTS rake_percent numeric; ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url text; CREATE TABLE unions(id uuid PRIMARY KEY,name text,owner_id uuid); "
              "CREATE FUNCTION public.ca_can_oversee_union(p_union_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT 1 FROM unions WHERE id=p_union_id AND owner_id=auth.uid()) $$;")
    q("live", "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS alias text, ADD COLUMN IF NOT EXISTS display_name text, ADD COLUMN IF NOT EXISTS first_name text, ADD COLUMN IF NOT EXISTS last_name text, ADD COLUMN IF NOT EXISTS full_name text, ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS is_horse boolean DEFAULT false; "
       "CREATE TABLE member_record_daily_facts(club_id uuid,user_id uuid,played_on date,is_mtt boolean,net numeric,hands bigint,accounting_cutoff timestamptz); "
       "CREATE FUNCTION fn_ca_launch_accounting_cutoff(text,uuid) RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$; "
       "CREATE FUNCTION fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql AS $$SELECT coalesce($1,$2,$3,$4,$5,$6)$$; "
       "CREATE FUNCTION fn_can_see_horse_flag(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$; "
       "CREATE FUNCTION ca_club_member_fee_totals(uuid,date,date) RETURNS TABLE(user_id uuid,total_fees numeric) LANGUAGE sql AS $$SELECT f.user_id,sum(f.fee) FROM ca_club_data_fact f WHERE club_id=$1 AND stat_date BETWEEN $2 AND $3 GROUP BY f.user_id$$;")
    run(psql("live"), (ROOT / "tests/fixtures/club-data-report-db/reporting-preimages.sql").read_text())
    run(psql("live"), (ROOT / "tests/fixtures/club-data-report-db/rake-v2-fixture.sql").read_text())
    run(psql("live"), (ROOT / "tests/fixtures/club-data-report-db/game-export-before.sql").read_text())
    correction=(ROOT / "supabase/migrations/20261021202610_club_data_totals_use_exact_game_types_and_union_scope.sql").read_text()
    scenario=(ROOT / "tests/fixtures/club-data-report-db/union-mtt-scenario.sql").read_text().replace("@PORT@",str(PORT))
    setup,assertions=scenario.split('DO $test$',1)
    run(psql("live"),setup)
    require(q("live", "SELECT (ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE)->'summary'->>'games')::integer")=='1', "baseline reproduces missing member clubs")
    require(q("live", "SELECT (ca_club_data_screen('a0000000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE)->'summary'->>'mtt_winnings')::numeric")=='25.00', "baseline reproduces SNG contaminating MTT winnings")
    run(psql("live"), "SET ROLE authenticated;\n"+correction, expect_fail="must be owner of table rake_records")
    run(psql("live"), correction.replace("\nCOMMIT;\n","\nROLLBACK;\n"))
    require(q("live", "SELECT to_regprocedure('public.fn_ca_club_data_clubs(uuid)') IS NULL")=="t", "a rolled-back installation preserves reporting definitions; concurrent index remains valid")
    q("live", "ALTER INDEX public.idx_ca_club_data_cash_hand_window RENAME TO native_saved_hand_window; CREATE INDEX idx_ca_club_data_cash_hand_window ON public.rake_records(id);")
    run(psql("live"), correction[correction.index("BEGIN;\n"):], expect_fail="hand index invalid or changed")
    q("live", "DROP INDEX public.idx_ca_club_data_cash_hand_window; ALTER INDEX public.native_saved_hand_window RENAME TO idx_ca_club_data_cash_hand_window;")
    run(psql("live"), "BEGIN; ALTER FUNCTION public.ca_club_data_screen(uuid,date,date,text,text,text,integer) SET work_mem='1MB';\n"+correction[correction.index("BEGIN;\n"):], expect_fail="preimage changed")
    run(psql("live"), correction)
    run(psql("live"), correction, expect_fail="Club Data correction already installed")
    p=run(psql("live"), "DO $test$"+assertions)
    require("UNION MTT SCENARIO PASSED" in p.stdout+p.stderr, "MTT classification, union deduplication, exact fees, payouts, felt, pages, export and authorization")

    # Chicago days at the source (20261022103651), the one-time history load
    # (20261022120109/13/17) and the readers (20261022120121).
    M = ROOT / "supabase/migrations"
    run(psql("live"), (M / "20261022061048_the_club_game_page_counts_cash_players_for_visible_rows_only.sql").read_text())
    run(psql("live"), (M / "20261022061936_club_data_export_counts_cash_players_in_one_grouped_pass.sql").read_text())
    chicago_a = (M / "20261022103651_club_data_chicago_day_facts_and_writer.sql").read_text()
    readers = (M / "20261022120121_club_data_reads_chicago_days_and_separates_running_mtts.sql").read_text()
    loads = [(M / f).read_text() for f in ("20261022120109_club_data_chicago_days_load_september.sql",
                                           "20261022120113_club_data_chicago_days_load_early_october.sql",
                                           "20261022120117_club_data_chicago_days_load_through_the_cutover.sql")]
    run(psql("live"), readers, expect_fail="Club Data Chicago facts (20261022103651) are not installed")
    run(psql("live"), loads[0], expect_fail="Club Data Chicago facts (20261022103651) are not installed")
    run(psql("live"), "SET ROLE authenticated;\n" + chicago_a, expect_fail="maintained installer")
    run(psql("live"), chicago_a)
    run(psql("live"), chicago_a, expect_fail="Club Data Chicago facts already installed")
    before_load, after_load = (ROOT / "tests/fixtures/club-data-report-db/chicago-days-scenario.sql").read_text().split("-- @@ AFTER THE HISTORY LOAD @@", 1)
    run(psql("live"), before_load)
    require(True, "live writer fills the Chicago bucket only from its cutover, and the load refuses a live day")
    run(psql("live"), readers, expect_fail="Club Data Chicago history is not fully loaded")
    for load in loads:
        run(psql("live"), load)
    run(psql("live"), loads[2], expect_fail="already loaded")
    p = run(psql("live"), after_load.split("\n", 1)[1])
    require("CHICAGO SEED SCENARIO PASSED" in p.stdout, "history load preserves every UTC total and moves only the day")
    run(psql("live"), "BEGIN; ALTER FUNCTION public.fn_ca_rake_felt_v2(uuid[],date,date) SET work_mem='1MB';\n" + readers[readers.index("BEGIN;\n") + 7:], expect_fail="Club Data reader preimage changed: fn_ca_rake_felt_v2")
    run(psql("live"), readers)
    p = run(psql("live"), (ROOT / "tests/fixtures/club-data-report-db/chicago-readers-scenario.sql").read_text())
    require("CHICAGO READERS SCENARIO PASSED" in p.stdout, "Club Data and Union Data read Chicago days and separate running MTTs, reconciled to the cent")

    # 20261022134523 reads each thing once; every figure must be unchanged.
    once = (M / "20261022134523_club_data_union_reads_count_once.sql").read_text()
    probe = (
        "SELECT set_config('test.uid','00000000-0000-0000-0000-0000000000a1',false);"
        "SELECT jsonb_build_object("
        "'w', public.fn_ca_rake_window_v2(public.fn_ca_club_data_clubs(u), a, b) - 'generated_at',"
        "'wj', public.fn_ca_rake_window_v2(ARRAY['a0000000-0000-0000-0000-000000000001'::uuid], a, b),"
        "'c', public.fn_ca_rake_by_club_v2(public.fn_ca_club_data_clubs(u), a, b, 50, 0, NULL, 'rake'),"
        "'g', public.ca_club_game_page_core_20261006(u, a, b, 'ALL', 'ALL', NULL, 'fee', NULL, 200) - 'generated_at',"
        "'gj', public.ca_club_game_page_core_20261006('a0000000-0000-0000-0000-000000000001', a, b, 'ALL', 'ALL', NULL, 'fee', NULL, 200) - 'generated_at',"
        "'l', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.kind, x.id) FROM public.fn_ca_club_games(u, a, b, 'ALL', 'ALL', NULL) x),"
        "'ls', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.kind, x.id) FROM public.fn_ca_club_games(u, a, b, 'ALL', 'ALL', 'c1') x),"
        "'r', public.ca_club_data_snapshot_v2(u, a, b, 'ALL', 'ALL', NULL, 200) - 'generated_at'"
        ")::text FROM (VALUES ('fade0000-0000-0000-0000-000000000001'::uuid)) v(u),"
        " (VALUES (date '2026-10-19', date '2026-10-22'), (date '2026-10-20', date '2026-10-20'), (date '2026-10-21', date '2026-10-21')) d(a, b) ORDER BY a, b;"
    )
    before = q("live", probe)
    run(psql("live"), "BEGIN; ALTER FUNCTION public.fn_ca_rake_window_v2(uuid[],date,date) SET work_mem='1MB';\n" + once[once.index("BEGIN;\n") + 7:], expect_fail="Club Data reader preimage changed: fn_ca_rake_window_v2")
    run(psql("live"), once)
    after = q("live", probe)
    require(before == after and before.count('"fee"') > 0, "union reads counted once return exactly the figures they replaced")
    # Owner 2026-10-26: arbitrary-depth downlines, exact per-user totals,
    # and refusal of the whole report/union for every agent rank.
    # Setup and authenticated assertions use separate connections. Bind their
    # shared reporting date once in Chicago, including across local midnight.
    # UTC CURRENT_DATE can be tomorrow, which the real reader clamps away.
    report_day = date.fromisoformat(q("live", "SELECT (now() AT TIME ZONE 'America/Chicago')::date::text")).isoformat()
    boundary = (ROOT / "tests/fixtures/club-data-report-db/data-access-boundary.sql").read_text().replace("@REPORT_DAY@", report_day)
    setup, checks = boundary.split("-- AFTER MIGRATION", 1)
    run(psql("live"), setup)
    require(q("live", "SELECT cardinality(fn_ca_club_data_downline(md5('boundary-club')::uuid,md5('super_agent')::uuid))") == '21', "baseline reproduces the twenty-level downline cutoff")
    downline = (M / "20261026213551_club_data_downline_has_no_depth_cutoff.sql").read_text()
    run(psql("live"), "SET ROLE authenticated;\n" + downline, expect_fail="maintained installer")
    run(psql("live"), downline)
    run(psql("live"), downline, expect_fail="preimage changed")
    p = run(psql("live", user="authenticator"), checks)
    require("DATA ACCESS BOUNDARY PASSED" in p.stdout + p.stderr, "every rank: scoped facts, deep descendants, sibling exclusion, cycles, whole-club and union refusal")

    # Missing-club calls must authorize each returned club independently, even
    # when a descendant has an unrelated second agency with a higher rate.
    run(psql("live"), (ROOT / "tests/fixtures/club-data-report-db/legacy-rake-preimages.sql").read_text())
    legacy_setup, legacy_checks = (ROOT / "tests/fixtures/club-data-report-db/legacy-rake-scope.sql").read_text().split("-- AFTER MIGRATION", 1)
    run(psql("live"), legacy_setup)
    caller = "SET ROLE authenticated; SELECT set_config('test.role','authenticated',false); SELECT set_config('test.uid',md5('legacy-x')::uuid::text,false);"
    leaked = "SELECT sum(rake_generated) FROM fn_agent_downline_rake(md5('legacy-y')::uuid,NULL,now()-interval '1 hour',now(),NULL,100000);"
    require(Decimal(q("live", caller + leaked, user="authenticator").splitlines()[-1]) == 103, "baseline missing-club API reproduces 100 of unrelated-club rake")
    rate = "SELECT fn_agent_downline_rake_summary(md5('legacy-y')::uuid,NULL,now()-interval '1 hour',now())->>'commission_rate';"
    require(q("live", caller + rate, user="authenticator").splitlines()[-1] == '0.9', "baseline summary reproduces unrelated-club rate")
    legacy_migration = (M / "20261027002505_legacy_rake_data_authorizes_every_club_separately.sql").read_text()
    run(psql("live"), "SET ROLE authenticated;\n" + legacy_migration, expect_fail="maintained installer")
    run(psql("live"), legacy_migration.replace("\nCOMMIT;", "\nROLLBACK;"))
    require(Decimal(q("live", caller + leaked, user="authenticator").splitlines()[-1]) == 103, "rolled-back legacy repair leaves original definitions intact")
    run(psql("live"), legacy_migration)
    run(psql("live"), legacy_migration, expect_fail="preimage changed")
    run(psql("live"), (ROOT / "tests/fixtures/club-data-report-db/export-page-preimage.sql").read_text())
    q("live", "INSERT INTO ca_club_data_exports(id,user_id,club_id,kind,status,total_rows) VALUES(md5('legacy-export')::uuid,md5('legacy-x')::uuid,md5('legacy-a')::uuid,'games','ready',1),(md5('foreign-export')::uuid,md5('legacy-owner')::uuid,md5('legacy-a')::uuid,'games','ready',1);")
    for rank in ('super_agent', 'agent', 'sub_agent'):
        q("live", "UPDATE club_members SET role='" + rank + "' WHERE user_id=md5('legacy-x')::uuid; UPDATE agents SET role='" + rank + "' WHERE user_id=md5('legacy-x')::uuid;")
        result = run(psql("live", user="authenticator"), legacy_checks.replace('@RANK@', rank))
        require('LEGACY RAKE DATA BOUNDARY PASSED' in result.stdout + result.stderr, rank + ': missing/explicit club, deep descendants, summary rate, sibling/player refusal and private helper ACL')
        for kind, scope in [('games','club'),('players','club'),('rake','club'),('rake','union')]:
            q("live", "UPDATE ca_club_data_exports SET kind='"+kind+"',scope_type='"+scope+"',union_id='fade0000-0000-0000-0000-000000000001' WHERE id=md5('legacy-export')::uuid;")
            run(psql("live", user="authenticator"), caller + "SELECT ca_club_data_export_page(md5('legacy-export')::uuid);", expect_fail="export is no longer authorized")
        run(psql("live", user="authenticator"), caller + "SELECT ca_club_data_export_page(md5('foreign-export')::uuid);", expect_fail="export is unavailable")
        require(True, rank + ': real export page refuses owned whole-club/union jobs and another user export ID')

    q("live", "UPDATE agents SET parent_agent_id=md5('legacy-deep-agent25')::uuid WHERE id=md5('legacy-x-agent')::uuid; UPDATE club_members SET agent_id=md5('legacy-deep25')::uuid WHERE user_id=md5('legacy-x')::uuid; UPDATE agents SET parent_agent_id=md5('legacy-x-agent')::uuid WHERE id=md5('legacy-yb-agent')::uuid;")
    result = run(psql("live", user="authenticator"), legacy_checks.replace('@RANK@', 'sub_agent'))
    require('LEGACY RAKE DATA BOUNDARY PASSED' in result.stdout + result.stderr, 'cycles terminate and malformed cross-club agency edges cannot widen Data')

    evidence=os.environ.get('CLUB_DATA_CONTRACT_EVIDENCE')
    if evidence:
        import re
        names=sorted(set(re.findall(r'CREATE OR REPLACE FUNCTION public\.(\w+)',correction)))
        names_sql=','.join("'"+name+"'" for name in names)
        certificate=q("live", "SELECT jsonb_agg(jsonb_build_object('name',p.proname,'source_md5',md5(p.prosrc),'definition_md5',md5(pg_get_functiondef(p.oid)),'security_definer',p.prosecdef,'settings',p.proconfig)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ("+names_sql+")")
        Path(evidence).write_text(certificate+'\n')

finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)

# The same required Data qualification owns this reporting producer too.
# Use a separate source-bound world so neither fixture can supply the other's
# tables or receipts. Any refusal fails the existing accounting job.
for fixture_name, candidate_name in [
    ("reporting-rollup-cutoffs.sql", "20261027005822_reporting_rollups_read_each_club_cutoff_once.sql"),
    ("reporting-shared-day-facts.sql", "20261027063331_reporting_rollups_share_one_bounded_day_fact_read.sql"),
    ("reporting-catchup-club-probes.sql", "20261027063331_reporting_rollups_share_one_bounded_day_fact_read.sql"),
]:
    subprocess.run([
        sys.executable, "-B", str(ROOT / "scripts/ci/run_launch_reset_accounting_fixture.py"),
        "--fixture", str(ROOT / "scripts/ci/fixtures" / fixture_name),
        "--candidate", str(ROOT / "supabase/migrations" / candidate_name),
        "--work-root", os.environ.get("DATA_CONSOLE_PG_SCRATCH_PARENT", str(cluster.parent)),
        "--pg-bin", str(PG),
    ], cwd=ROOT, check=True, timeout=90)
