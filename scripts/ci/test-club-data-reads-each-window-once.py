#!/usr/bin/env python3
"""Native qualification for 20261022165130: Club Data and Union Data read each window once.

Installs every Club Data migration in order on a throwaway cluster (exactly as
scripts/ci/test-club-data-union-mtt-postgres.py does), proves each reader it
replaces is the production text (pg_get_functiondef md5 equal to the live
function), records every reader's output for union and club scope, several
windows, sorts, searches and page sizes, installs 20261022165130, and requires
every output to be identical. The newest-games walk is exercised on both of
its outcomes: rows proved and returned, and a refusal that falls back to the
page core. No production access.
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
    # 20261022165130 reads each window once; every figure, row and order must be unchanged.
    PINS = {
        "public.ca_club_data_screen(uuid,date,date,text,text,text,integer)": "33922bec7a85906e3a3925aeb269d0ce",
        "public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)": "01dde673050f62c1290ad3b74a138c4c",
        "public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)": "7f788701d61ae1a2137b8fe4d0f532a2",
        "public.ca_rake_snapshot_v2(text,uuid,uuid,date,date,uuid,integer,integer,text,text)": "f9d7e19f531145a8aea60af103aa95ed",
        "public.fn_ca_club_data_hand_count(uuid,date,date,text,text,text)": "81e9ebcdd7cce5ff2d08b858f9ce25d8",
        "public.fn_ca_rake_by_club_v2(uuid[],date,date,integer,integer,text,text)": "135f2c29ffd5ed7ad0440add76577fbd",
        "public.fn_ca_rake_window_v2(uuid[],date,date)": "29d518cdc9d32b7f923c758f569c9dc5",
        "public.fn_ca_rake_series_v2(uuid[],date,date,text)": "0c0f44a3b1626605af48d347b65b6499",
    }
    for sig, pin in PINS.items():
        require(q("live", f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))") == pin, f"{sig} is the production definition")
    reads = (M / "20261022165130_club_data_and_union_data_read_each_window_once.sql").read_text()
    U = "fade0000-0000-0000-0000-000000000001"
    J = "a0000000-0000-0000-0000-000000000001"
    windows = "(VALUES (date '2026-10-19', date '2026-10-22'), (date '2026-10-20', date '2026-10-20'), (date '2026-10-21', date '2026-10-21'), (date '2026-10-01', date '2026-10-22'), (date '2026-09-20', date '2026-10-05')) d(a, b)"
    probe2 = (
        "SELECT set_config('test.uid','00000000-0000-0000-0000-0000000000a1',false);"
        "SELECT jsonb_build_object("
        f"'w', public.fn_ca_rake_window_v2(public.fn_ca_club_data_clubs(u), a, b),"
        "'w1', (SELECT jsonb_object_agg(c::text, public.fn_ca_rake_window_v2(ARRAY[c], a, b)) FROM unnest(public.fn_ca_club_data_clubs(u)) c),"
        "'c', public.fn_ca_rake_by_club_v2(public.fn_ca_club_data_clubs(u), a, b, 50, 0, NULL, 'rake'),"
        "'cn', public.fn_ca_rake_by_club_v2(public.fn_ca_club_data_clubs(u), a, b, 2, 1, NULL, 'name'),"
        "'ch', public.fn_ca_rake_by_club_v2(public.fn_ca_club_data_clubs(u), a, b, 50, 0, 'a', 'hands'),"
        "'s', public.fn_ca_rake_series_v2(public.fn_ca_club_data_clubs(u), a, b, 'day'),"
        "'sw', public.fn_ca_rake_series_v2(public.fn_ca_club_data_clubs(u), a, b, 'week'),"
        "'hu', public.fn_ca_club_data_hand_count(u, a, b, 'ALL', 'ALL', NULL),"
        "'hj', public.fn_ca_club_data_hand_count(j, a, b, 'ALL', 'ALL', NULL),"
        "'hf', public.fn_ca_club_data_hand_count(u, a, b, 'HOLDEM', 'MICRO', 'c'),"
        "'ru', public.ca_rake_snapshot_v2('union', NULL, u, a, b, NULL, 50, 0, NULL, 'rake') - 'generated_at',"
        "'ru2', public.ca_rake_snapshot_v2('union', j, NULL, a, b, NULL, 1, 1, 'a', 'name') - 'generated_at',"
        "'rc', public.ca_rake_snapshot_v2('club', j, NULL, a, b, NULL, 50, 0, NULL, 'rake') - 'generated_at',"
        "'xu', public.ca_club_data_screen(u, a, b, 'ALL', 'ALL', NULL, 50) - 'generated_at',"
        "'xj', public.ca_club_data_screen(j, a, b, 'ALL', 'ALL', NULL, 50) - 'generated_at',"
        "'xm', public.ca_club_data_screen(j, a, b, 'MTT', 'ALL', NULL, 50) - 'generated_at',"
        "'n', (SELECT jsonb_agg(public.ca_club_data_snapshot_v2(x, a, b, g, 'ALL', NULL, l) - 'generated_at' ORDER BY x, g, l)"
        "      FROM unnest(ARRAY[u, j]) x, unnest(ARRAY['ALL', 'MTT']) g, unnest(ARRAY[1, 2, 3, 5, 100, 300]) l)"
        f")::text FROM (VALUES ('{U}'::uuid, '{J}'::uuid)) v(u, j), {windows} ORDER BY a, b;"
    )
    before2 = q("live", probe2)
    run(psql("live"), "SET ROLE authenticated;\n" + reads, expect_fail="maintained installer")
    run(psql("live"), "BEGIN; ALTER FUNCTION public.fn_ca_rake_window_v2(uuid[],date,date) SET work_mem='1MB';\n" + reads[reads.index("BEGIN;\n") + 7:], expect_fail="Club Data reader preimage changed: public.fn_ca_rake_window_v2(uuid[],date,date)")
    run(psql("live"), reads)
    run(psql("live"), reads, expect_fail="Club Data window reader already installed")
    after2 = q("live", probe2)
    require(before2 == after2 and before2.count('"fee"') > 0, "every Club Data and Union Data reader returns exactly what it returned before 20261022165130")
    # The newest-games walk: it must answer with the page core's own rows when it
    # can prove them, and NULL (the caller then reads the page core) when it cannot.
    walk = (
        "SELECT set_config('test.uid','00000000-0000-0000-0000-0000000000a1',false);"
        "SELECT count(*) FILTER (WHERE w IS NOT NULL), count(*) FILTER (WHERE w IS NOT NULL AND w <> p), count(*) FROM ("
        " SELECT public.fn_ca_club_game_recent_rows(x, a, b, l) w,"
        "        public.ca_club_game_page_core_20261006(x, a, b, 'ALL', 'ALL', NULL, 'recent', NULL, l)->'rows' p"
        f"   FROM unnest(ARRAY['{U}'::uuid, '{J}'::uuid]) x, unnest(ARRAY[1, 2, 3, 4, 5, 8, 13, 200]) l, {windows}) z;"
    )
    proved, differ, total = q("live", walk).splitlines()[-1].split("|")
    require(int(proved) > 0 and differ == "0", f"the newest-games walk returns the page core's rows whenever it answers ({proved} of {total} proved)")
    # 20,001 newer tournaments the clubs never played: the walk cannot reach
    # their games and must refuse; then the same tournaments older than every
    # game: the walk must still prove the page.
    q("live", "INSERT INTO tournaments (id, name, tournament_type, start_time, status) SELECT gen_random_uuid(), 'Elsewhere', 'SNG', now() + interval '1 day' + g * interval '1 second', 'REGISTERING' FROM generate_series(1, 20001) g;")
    proved_far, differ_far, _ = q("live", walk).splitlines()[-1].split("|")
    require(proved_far == "0" and differ_far == "0", "beyond the walk's bound it refuses and the page core answers")
    require(q("live", probe2) == before2, "with the walk refusing, every reader still returns exactly what it returned before")
    q("live", "UPDATE tournaments SET start_time = timestamptz '2020-01-01' + (random() * interval '1 day') WHERE name = 'Elsewhere';")
    proved_old, differ_old, _ = q("live", walk).splitlines()[-1].split("|")
    require(int(proved_old) > 0 and differ_old == "0", "with older tournaments below the bound the walk still proves the page")
    q("live", "DELETE FROM tournaments WHERE name = 'Elsewhere';")
    evidence=os.environ.get('CLUB_DATA_CONTRACT_EVIDENCE')
    if evidence:
        import re
        names=sorted(set(re.findall(r'CREATE OR REPLACE FUNCTION public\.(\w+)',correction)))
        names_sql=','.join("'"+name+"'" for name in names)
        certificate=q("live", "SELECT jsonb_agg(jsonb_build_object('name',p.proname,'source_md5',md5(p.prosrc),'definition_md5',md5(pg_get_functiondef(p.oid)),'security_definer',p.prosecdef,'settings',p.proconfig)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ("+names_sql+")")
        Path(evidence).write_text(certificate+'\n')

    # Personal earned fees call the real Player Management reader, including
    # standing shares, redemptions and its own date boundary. No money moves.
    q("live", "CREATE SCHEMA IF NOT EXISTS smarter_private; "
      "CREATE TABLE smarter_private.player_rake_share_rules(rule_key text,club_id uuid,from_user uuid,to_user uuid,share_bps int,effective_from timestamptz,effective_until timestamptz); "
      "CREATE TABLE smarter_private.player_fee_redemptions(club_id uuid,user_id uuid,effective_on date,amount_cents bigint); "
      "CREATE TABLE ca_club_rake_daily_user(club_id uuid,user_id uuid,day date,rake_cents bigint); "
      "CREATE TABLE ca_club_member_tournament_fee_daily(club_id uuid,user_id uuid,day date,fees numeric); "
      "ALTER TABLE rake_attributions ADD COLUMN IF NOT EXISTS rake_amount numeric, ADD COLUMN IF NOT EXISTS created_at timestamptz; "
      "CREATE FUNCTION fn_ca_fee_counting_start() RETURNS date LANGUAGE sql AS $$SELECT DATE '2026-10-12'$$;")
    share_source = (M / "20261025030629_a_standing_rake_share_replaces_the_woowoo_cron.sql").read_text()
    member_reader = share_source.split("CREATE OR REPLACE FUNCTION public.ca_club_member_fee_totals", 1)[1].split("$function$;", 1)[0]
    run(psql("live"), "CREATE OR REPLACE FUNCTION public.ca_club_member_fee_totals" + member_reader + "$function$;")
    a = "00000000-0000-0000-0000-0000000000a2"
    owner = "00000000-0000-0000-0000-0000000000a1"
    q("live", f"INSERT INTO ca_club_rake_daily_user VALUES('{J}','{a}','2026-10-20',10000); "
      f"INSERT INTO ca_club_member_tournament_fee_daily VALUES('{J}','{a}','2026-10-20',3.50); "
      f"INSERT INTO smarter_private.player_fee_redemptions VALUES('{J}','{a}','2026-10-20',2000); "
      f"INSERT INTO smarter_private.player_rake_share_rules VALUES('half','{J}','{a}','{owner}',5000,'2026-10-20T00:00Z',NULL); "
      f"INSERT INTO rake_attributions(player_id,club_id,rake_amount,created_at) VALUES('{a}','{J}',4,'2026-10-20T12:00Z');")
    personal = f"SET ROLE authenticated; SELECT set_config('test.role','authenticated',false); SELECT set_config('test.uid','{a}',false); SELECT ca_club_data_screen('{J}','2026-10-20','2026-10-20')->'member_fees'->>'total_fees';"
    require(q("live", personal, user="authenticator").splitlines()[-1] != '81.50', "baseline reproduces missing personal share reader")
    earned = (M / "20261027145338_club_data_shows_member_earned_fees_from_the_player_managemen.sql").read_text()
    run(psql("live"), "BEGIN; ALTER FUNCTION public.ca_club_data_screen(uuid,date,date,text,text,text,integer) SET work_mem='1MB';" + earned, expect_fail="preimage changed")
    run(psql("live"), earned.replace('COMMIT;', 'ROLLBACK;'))
    require(q("live", personal, user="authenticator").splitlines()[-1] != '81.50', "rollback preserves the original reader")
    run(psql("live"), earned)
    require(q("live", personal, user="authenticator").splitlines()[-1] == '81.50', "personal fees equal 100 gross minus 20 redemption minus 2 standing share plus 3.50 MTT")
    require(q("live", f"SET ROLE authenticated; SELECT set_config('test.role','authenticated',false); SELECT set_config('test.uid','{a}',false); SELECT ca_club_data_screen('{J}','2026-10-20','2026-10-20','MTT','ALL','no-game')->'member_fees'->>'total_fees';", user="authenticator").splitlines()[-1] == '81.50', "filtered and empty games retain explicitly labelled personal period totals")
    require(q("live", f"SET ROLE authenticated; SELECT set_config('test.role','authenticated',false); SELECT set_config('test.uid','{a}',false); SELECT ca_club_data_screen('{J}','2026-10-19','2026-10-19')->'member_fees'->>'total_fees';", user="authenticator").splitlines()[-1] == '0', "member ledger dates exclude other days")
    require(q("live", f"SET ROLE authenticated; SELECT set_config('test.role','authenticated',false); SELECT set_config('test.uid','{owner}',false); SELECT ca_club_data_screen('{J}','2026-10-20','2026-10-20')->'member_fees' = 'null'::jsonb;", user="authenticator").splitlines()[-1] == 't', "whole-club operator keeps gross club fees")
    q("live", f"INSERT INTO profiles(id,username,is_admin) VALUES('00000000-0000-0000-0000-00000000ffff','Scoped Player',false); INSERT INTO club_members(club_id,user_id,role,status) VALUES('{J}','00000000-0000-0000-0000-00000000ffff','player','active');")
    run(psql("live", user="authenticator"), f"SET ROLE authenticated; SELECT set_config('test.role','authenticated',false); SELECT set_config('test.uid','00000000-0000-0000-0000-00000000ffff',false); SELECT ca_club_data_screen('{J}');", expect_fail="not authorized")
    run(psql("live"), earned, expect_fail="preimage changed")
    require(True, "player authorization and replay refusal retained")
    print("EARNED_READER_MD5=" + q("live", "SELECT md5(pg_get_functiondef('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)'::regprocedure))"), flush=True)
    require(q("live", "SELECT NOT has_function_privilege('anon','public.ca_club_data_screen(uuid,date,date,text,text,text,integer)','EXECUTE') AND has_function_privilege('authenticated','public.ca_club_data_screen(uuid,date,date,text,text,text,integer)','EXECUTE')") == 't', "existing Data reader ACL preserved")

finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
