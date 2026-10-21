#!/usr/bin/env python3
"""Private native qualification for union/MTT Club Data correction. No production access."""
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
