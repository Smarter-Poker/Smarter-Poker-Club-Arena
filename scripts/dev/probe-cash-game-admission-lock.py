#!/usr/bin/env python3
"""Real join/cancel concurrency on disposable socket-only PostgreSQL 17.

Loads the reviewed production join and cancellation functions. Authentication,
VPIP eligibility and unrelated schema are fixture boundaries. No real users,
wallets, production connection strings or engine operations are accepted.
"""
from pathlib import Path
import json
import os
import re
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[2]
pg = Path(os.environ.get("PGBIN", "/opt/homebrew/opt/postgresql@17/bin"))
assert " 17." in subprocess.check_output([str(pg / "postgres"), "--version"], text=True)
migrations = repo / "supabase/migrations"
repair = (migrations / "20260917072315_cash_game_join_shares_cancellation_lock.sql").read_text()


def function_from(name, filename):
    matches = re.findall(
        rf"CREATE OR REPLACE FUNCTION public\.{name}\([\s\S]*?\$function\$[\s\S]*?\$function\$",
        (migrations / filename).read_text(),
    )
    assert len(matches) == 1, name
    return matches[0] + ";\n"


join = function_from("fn_cash_game_join", "20260910183043_the_join_door_holds_the_chair_it_hands_out.sql")
cancel = function_from("fn_cash_game_leave_waitlist", "20260914110751_cash_game_waitlist_cancellation_releases_its_offers.sql")
GAME = "11111111-1111-4111-8111-111111111111"
TABLE = "22222222-2222-4222-8222-222222222222"
USER = "33333333-3333-4333-8333-333333333333"

bootstrap = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
$$SELECT nullif(current_setting('test.auth_uid',true),'')::uuid$$;
CREATE TABLE cash_games(id uuid PRIMARY KEY,enabled boolean DEFAULT true,opening_hold_since timestamptz);
CREATE TABLE tables(id uuid PRIMARY KEY,cluster_id uuid REFERENCES cash_games(id),name text,role text,main_index integer,
 lifecycle text DEFAULT 'live',status text DEFAULT 'running',max_players integer DEFAULT 2,
 is_deleted boolean DEFAULT false,created_at timestamptz DEFAULT now());
CREATE TABLE table_seats(table_id uuid,user_id uuid,seat_number integer,left_at timestamptz);
CREATE TABLE table_waitlist(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,
 position integer,status text,notified_at timestamptz,hold_expires_at timestamptz);
CREATE UNIQUE INDEX one_table_admission ON table_waitlist(table_id,user_id) WHERE status IN ('waiting','notified');
CREATE TABLE cash_game_waitlist(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_id uuid REFERENCES cash_games(id),user_id uuid,
 status text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX one_game_admission ON cash_game_waitlist(game_id,user_id) WHERE status IN ('waiting','notified');
CREATE TABLE cash_seat_moves(to_table_id uuid,state text,swap_move_id uuid);
CREATE TABLE cash_game_roster(game_id uuid REFERENCES cash_games(id),user_id uuid);
CREATE FUNCTION fn_cash_game_barred_seconds(uuid,uuid) RETURNS integer LANGUAGE sql AS $$SELECT NULL::integer$$;
-- Exact installed open-seat body, read back 2026-09-17. Holds and planned
-- transfers consume chairs; this probe does not invent an always-open door.
CREATE FUNCTION public.fn_cash_game_open_seats(p_table_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT GREATEST(0,
           coalesce(t.max_players, 9)
           - (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
           - (SELECT count(*) FROM public.table_waitlist w
               WHERE w.table_id = t.id AND w.status = 'notified' AND w.hold_expires_at > clock_timestamp())
           - (SELECT count(*) FROM public.cash_seat_moves m
               WHERE m.to_table_id = t.id AND m.state = 'pending' AND m.swap_move_id IS NULL))::integer
    FROM public.tables t WHERE t.id = p_table_id;
$function$;
""" + join + cancel + """
REVOKE ALL ON FUNCTION fn_cash_game_join(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION fn_cash_game_join(uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION fn_cash_game_leave_waitlist(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION fn_cash_game_leave_waitlist(uuid) TO authenticated,service_role;
"""

with tempfile.TemporaryDirectory(prefix="ca-admission-pg17-") as directory:
    root = Path(directory)
    cluster, sock = root / "cluster", root / "socket"
    sock.mkdir()
    port = str(35000 + os.getpid() % 10000)
    share = Path(subprocess.check_output([str(pg / "pg_config"), "--sharedir"], text=True).strip())
    if not (share / "postgres.bki").exists():
        share = pg.parent / "share/postgresql"
    cmd = [str(pg / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", str(sock),
           "-p", port, "-U", "postgres", "-d", "postgres"]

    def sql(query, check=True):
        return subprocess.run(cmd, input=query, text=True, capture_output=True, check=check, timeout=15)

    def value(query):
        return json.loads(sql(query).stdout.strip())

    def seed():
        sql(f"""TRUNCATE cash_games,tables,table_waitlist,cash_game_waitlist,table_seats,cash_game_roster;
        INSERT INTO cash_games(id) VALUES('{GAME}');
        INSERT INTO tables(id,cluster_id,name,role,main_index) VALUES('{TABLE}','{GAME}','Main 2','main',2);
        INSERT INTO cash_game_waitlist(game_id,user_id,status) VALUES('{GAME}','{USER}','notified');
        INSERT INTO table_waitlist(table_id,user_id,position,status,hold_expires_at)
          VALUES('{TABLE}','{USER}',0,'notified',now()+interval '1 minute');""")

    def cancellation_race():
        seed()
        holder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        contender = None
        try:
            holder.stdin.write(f"BEGIN; SET LOCAL statement_timeout='8s'; SET LOCAL test.auth_uid='{USER}';\n"
                               f"SELECT fn_cash_game_leave_waitlist('{GAME}');\n\\echo CANCEL_READY\n")
            holder.stdin.flush()
            while True:
                line = holder.stdout.readline()
                assert line, "Cancellation holder exited before acquiring its locks"
                if "CANCEL_READY" in line:
                    break
            contender = subprocess.Popen(cmd + ["-c", f"SET application_name='mustmove_join_race'; "
                f"BEGIN; SET LOCAL statement_timeout='8s'; SET LOCAL ROLE authenticated; "
                f"SET LOCAL test.auth_uid='{USER}'; SELECT fn_cash_game_join('{GAME}'); COMMIT;"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 4
            while value("SELECT count(*) FROM pg_stat_activity WHERE application_name='mustmove_join_race' AND wait_event_type='Lock'") != 1:
                assert contender.poll() is None, "Join failed before reaching the concurrent lock"
                assert time.monotonic() < deadline, "Join never reached the concurrent lock"
                time.sleep(0.02)
            holder.stdin.write("COMMIT;\n\\q\n")
            holder.stdin.flush()
            assert holder.wait(timeout=5) == 0
            output, error = contender.communicate(timeout=8)
            assert contender.returncode == 0, error
            result = json.loads(output.strip())
            assert result["ok"] is True and result["action"] == "seat" and result["table_id"] == TABLE
            return value(f"SELECT count(*) FROM table_waitlist WHERE table_id='{TABLE}' AND user_id='{USER}' "
                         "AND status='notified' AND hold_expires_at>clock_timestamp()")
        finally:
            for child in (contender, holder):
                if child is not None and child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)

    def roster_foreign_key_race():
        seed()
        sql("DELETE FROM table_waitlist; DELETE FROM cash_game_waitlist;")
        holder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        contender = None
        try:
            # Actual buy-in ordering: table capacity advisory lock, then the
            # roster trigger inserts a child referencing the cash game.
            holder.stdin.write("BEGIN; SET LOCAL statement_timeout='4s';\n"
                f"SELECT pg_advisory_xact_lock(hashtextextended('table_seat:' || '{TABLE}',0));\n\\echo CAPACITY_READY\n")
            holder.stdin.flush()
            while True:
                line = holder.stdout.readline()
                assert line, "Capacity holder exited before acquiring its lock"
                if "CAPACITY_READY" in line:
                    break
            contender = subprocess.Popen(cmd + ["-c", f"SET application_name='mustmove_roster_race'; "
                f"BEGIN; SET LOCAL statement_timeout='6s'; SET LOCAL ROLE authenticated; "
                f"SET LOCAL test.auth_uid='{USER}'; SELECT fn_cash_game_join('{GAME}'); COMMIT;"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 3
            while value("SELECT count(*) FROM pg_stat_activity WHERE application_name='mustmove_roster_race' AND wait_event='advisory'") != 1:
                assert contender.poll() is None, "Join failed before reaching the capacity lock"
                assert time.monotonic() < deadline, "Join never reached the capacity lock"
                time.sleep(0.02)
            holder.stdin.write(f"INSERT INTO cash_game_roster VALUES('{GAME}','{USER}'); COMMIT;\n\\q\n")
            holder.stdin.flush()
            assert holder.wait(timeout=6) == 0, holder.stderr.read()
            output, error = contender.communicate(timeout=7)
            assert contender.returncode == 0, error
            assert json.loads(output.strip())["action"] == "seat"
            assert value("SELECT count(*) FROM cash_game_roster") == 1
        finally:
            for child in (contender, holder):
                if child is not None and child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)

    started = False
    try:
        subprocess.run([str(pg / "initdb"), "-L", str(share), "-D", str(cluster), "-U", "postgres", "--auth=trust", "--no-locale"], check=True, capture_output=True, timeout=30)
        subprocess.run([str(pg / "pg_ctl"), "-D", str(cluster), "-l", str(root / "postgres.log"), "-o", f"-h '' -k {sock} -p {port}", "-w", "start"], check=True, capture_output=True, timeout=30)
        started = True
        sql(bootstrap)
        assert value("SELECT to_json(md5(pg_get_functiondef('fn_cash_game_join(uuid)'::regprocedure)))") == "1b9173dde43a3e6d4e887843deeaa9e7"
        assert cancellation_race() == 0, "The reviewed baseline no longer reproduces the stale-offer defect"
        print("PASS: original join confirms a cancelled offer (counterexample reproduced)", flush=True)
        sql(repair)
        sql(repair)
        assert cancellation_race() == 1, "A confirmed join must hold an actual live offer"
        print("PASS: repaired join waits for cancellation, rereads and creates one valid offer", flush=True)
        sql(f"SET ROLE authenticated; SET test.auth_uid='{USER}'; SELECT fn_cash_game_join('{GAME}');")
        assert value("SELECT count(*) FROM table_waitlist WHERE status='notified'") == 1
        sql(f"SET ROLE authenticated; SET test.auth_uid='{USER}'; SELECT fn_cash_game_leave_waitlist('{GAME}');")
        assert value("SELECT count(*) FROM table_waitlist WHERE status IN ('waiting','notified')") == 0
        print("PASS: repeated join keeps one offer and subsequent cancellation retires it", flush=True)
        assert value("SELECT json_build_array(has_function_privilege('anon','fn_cash_game_join(uuid)','EXECUTE'),has_function_privilege('authenticated','fn_cash_game_join(uuid)','EXECUTE'),has_function_privilege('service_role','fn_cash_game_join(uuid)','EXECUTE'))") == [False, True, True]
        bad = sql("SET ROLE authenticated; SET test.auth_uid=''; SELECT fn_cash_game_join('" + GAME + "');", check=False)
        assert bad.returncode != 0 and "NOT_AUTHENTICATED" in bad.stderr
        print("PASS: authentication, grants and idempotent migration preserved", flush=True)
        roster_foreign_key_race()
        print("PASS: join serialization permits concurrent roster foreign-key insertion without a lock cycle", flush=True)
        definition = sql("SELECT pg_get_functiondef('fn_cash_game_join(uuid)'::regprocedure)").stdout
        sql(definition.replace("sign in to join a game", "changed unreviewed definition"))
        drift = sql(repair, check=False)
        assert drift.returncode != 0 and "Unreviewed cash game join baseline" in drift.stderr
        print("PASS: unreviewed definition refused without overwrite", flush=True)
    finally:
        if started:
            subprocess.run([str(pg / "pg_ctl"), "-D", str(cluster), "-m", "fast", "-w", "stop"], check=True, capture_output=True, timeout=30)
