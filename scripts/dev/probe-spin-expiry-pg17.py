#!/usr/bin/env python3
"""Exercise the installed expiry/cancel control flow in isolated PostgreSQL 17.

SQL comes from the repository and its canonical function hashes must match the
reviewed production definitions. The fixture has no paid entries or money
triggers: this proves the expiry boundary, not refund or ledger conservation.
No remote DSN is accepted; the temporary cluster listens on a Unix socket only.
"""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[2]
configured = os.environ.get('POKER_AUDIT_PG_BIN')
pg = Path(configured) if configured else Path(subprocess.check_output(
    ['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-spin-expiry-pg17-'))
cluster = root / 'cluster'
sock = root / 'socket'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
log_path = Path('/tmp/codex-poker-audit-sep09-spin-expiry-pg17.log')
processes = []
passed = []
tid = 'bbbbbbbb-0000-0000-0000-000000000001'
table = 'bbbbbbbb-0000-0000-0000-000000000002'

def definition(path, name):
    source = (repo / path).read_text()
    start = source.index('CREATE OR REPLACE FUNCTION public.' + name + '(')
    match = re.search(r'\bAS\s+(\$\w*\$)', source[start:], re.I)
    assert match, name
    opening = start + match.end()
    end = source.index(match.group(1), opening) + len(match.group(1))
    return source[start:end] + ';'

with log_path.open('w') as log:
    def q(sql):
        result = subprocess.run(args + ['-c', sql], capture_output=True, text=True, timeout=15)
        log.write(result.stdout + result.stderr)
        log.flush()
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def check(name, condition):
        assert condition, name
        passed.append(name)
        log.write('PASS: ' + name + '\n')
        log.flush()

    def seed():
        q("TRUNCATE public.tournaments,public.tables,public.table_seats,"
          "public.tournament_players,public.cancel_transitions,public.spin_draw_receipts,"
          "public.spin_reserve_ledger; UPDATE public.spin_fill_policy SET unfilled_timeout_minutes=30;"
          f"INSERT INTO public.tournaments(id) VALUES('{tid}');"
          f"INSERT INTO public.tables(id,tournament_id) VALUES('{table}','{tid}');"
          f"INSERT INTO public.table_seats(table_id) VALUES('{table}'),('{table}');")

    def start_hold(sql, name):
        child = subprocess.Popen(args + ['-c',
            f"SET application_name='{name}'; BEGIN; {sql}; SELECT pg_sleep(1.2); COMMIT;"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(child)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            if q(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND wait_event='PgSleep'") == '1':
                return child
            time.sleep(.02)
        raise AssertionError('Concurrent holder did not reach its locked transaction boundary')

    def finish(child):
        out, err = child.communicate(timeout=10)
        log.write(out + err)
        assert child.returncode == 0, err

    def racing(label, change, expect_cancelled):
        seed()
        child = start_hold(
            f"SELECT id FROM public.tournaments WHERE id='{tid}' FOR UPDATE; " + change,
            'spin-expiry-' + label)
        result = json.loads(q("SELECT public.fn_spin_expire_unfilled(50)"))
        finish(child)
        cancelled = q(f"SELECT status='CANCELLED' FROM public.tournaments WHERE id='{tid}'") == 't'
        check(label, cancelled == expect_cancelled and result['expired'] == int(expect_cancelled))
        return result


    def cursor_race(label, expect_second_cancelled):
        seed()
        second = 'bbbbbbbb-0000-0000-0000-000000000003'
        second_table = 'bbbbbbbb-0000-0000-0000-000000000004'
        q(f"UPDATE public.tournaments SET created_at=now()-interval '2 hours' WHERE id='{tid}';"
          f"INSERT INTO public.tournaments(id) VALUES('{second}');"
          f"INSERT INTO public.tables(id,tournament_id) VALUES('{second_table}','{second}');"
          f"INSERT INTO public.table_seats(table_id) VALUES('{second_table}'),('{second_table}');")
        # Hold the first cancellation after the FOR cursor has selected its
        # candidates. The second board then starts before the loop reaches it.
        q("""CREATE OR REPLACE FUNCTION public.probe_cancel_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='CANCELLED' THEN
  INSERT INTO public.cancel_transitions VALUES(OLD.status);
  IF OLD.id='bbbbbbbb-0000-0000-0000-000000000001'::uuid
     AND current_setting('probe.pause_cancel',true)='on' THEN
   PERFORM pg_sleep(1.2);
  END IF;
 END IF;
 RETURN NEW;
END $$;""")
        child = subprocess.Popen(args + ['-c',
            "SET application_name='spin-expiry-cursor'; SET probe.pause_cancel='on'; "
            "SELECT public.fn_spin_expire_unfilled(50)"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(child)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            if q("SELECT count(*) FROM pg_stat_activity WHERE application_name='spin-expiry-cursor' AND wait_event='PgSleep'") == '1':
                break
            time.sleep(.02)
        else:
            raise AssertionError('First cursor cancellation did not reach the trigger boundary')
        q(f"BEGIN; UPDATE public.tournaments SET status='RUNNING',started_at=now() WHERE id='{second}';"
          f"INSERT INTO public.table_seats(table_id) VALUES('{second_table}'); COMMIT;")
        finish(child)
        check(label, q(f"SELECT status='CANCELLED' FROM public.tournaments WHERE id='{second}'")
              == ('t' if expect_second_cancelled else 'f')
              and q("SELECT count(*) FROM public.cancel_transitions")
              == ('2' if expect_second_cancelled else '1'))

    try:
        version = subprocess.check_output([str(pg/'postgres'), '--version'], text=True)
        assert ' 17.' in version, version
        subprocess.run([str(pg/'initdb'), '-D', str(cluster), '--auth=trust', '--no-locale'],
                       check=True, stdout=log, stderr=log)
        subprocess.run([str(pg/'pg_ctl'), '-D', str(cluster), '-o',
                        f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'],
                       check=True, stdout=log, stderr=log)
        args = [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                '-h', str(sock), '-p', port, '-d', 'postgres']
        q("""
CREATE SCHEMA auth;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION public.is_club_admin(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE TABLE public.spin_fill_policy(unfilled_timeout_minutes integer);
INSERT INTO public.spin_fill_policy VALUES(30);
CREATE TABLE public.tournaments(
 id uuid PRIMARY KEY,club_id uuid,name text DEFAULT 'Expiry fixture',
 variant text DEFAULT 'spin',status text DEFAULT 'REGISTERING',
 started_at timestamptz,ended_at timestamptz,updated_at timestamptz,
 created_at timestamptz DEFAULT now()-interval '1 hour',
 buy_in_amount numeric DEFAULT 1,max_players integer DEFAULT 3,
 spin_multiplier numeric,prize_pool numeric DEFAULT 0,
 bounty_pool numeric DEFAULT 0,total_rake numeric DEFAULT 0);
CREATE TABLE public.tables(
 id uuid PRIMARY KEY,tournament_id uuid,status text DEFAULT 'open',current_players integer DEFAULT 2);
CREATE TABLE public.table_seats(
 table_id uuid,left_at timestamptz,joined_at timestamptz DEFAULT now()-interval '1 hour');
CREATE TABLE public.tournament_players(
 id uuid,user_id uuid,tournament_id uuid,is_satellite_qualifier boolean,
 source_satellite_id uuid,status text,eliminated_at timestamptz);
CREATE TABLE public.wallet_transactions(
 user_id uuid,related_entity_id uuid,type text,category text,amount numeric);
CREATE TABLE public.chip_ledger(
 amount numeric,to_entity_id uuid,to_type text,idempotency_key text);
CREATE TABLE public.rake_records(
 id uuid,hand_id uuid,table_id uuid,club_id uuid,rake_amount numeric,pot_size numeric,
 num_players integer,bbj_contribution numeric,is_tournament boolean,
 tournament_id uuid,source text,metadata jsonb,player_contributions jsonb);
CREATE TABLE public.spin_draw_receipts(tournament_id uuid);
CREATE TABLE public.spin_reserve_ledger(tournament_id uuid,kind text);
CREATE TABLE public.cancel_transitions(previous_status text);
CREATE FUNCTION public.probe_cancel_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='CANCELLED' THEN INSERT INTO public.cancel_transitions VALUES(OLD.status); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER probe_cancel_transition BEFORE UPDATE ON public.tournaments
 FOR EACH ROW EXECUTE FUNCTION public.probe_cancel_transition();
CREATE FUNCTION public.fn_settle_tournament_obligation(uuid,text,uuid,uuid,numeric,text,text)
 RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'This fixture does not simulate financial settlement'; END $$;
CREATE FUNCTION public.fn_sync_seat_first_player_count(uuid)
 RETURNS void LANGUAGE sql AS $$ SELECT $$;
""")
        q(definition('supabase/migrations/20260831060000_a_seat_that_waits_forever_gets_its_chips_back.sql',
                     'fn_spin_expire_unfilled'))
        q(definition('supabase/migrations/20260907223616_spin_cancellation_covers_both_aggregate_fee_writers.sql',
                     'atomic_cancel_tournament'))
        check('expiry SQL exactly matches reviewed production definition',
              q("SELECT md5(pg_get_functiondef('public.fn_spin_expire_unfilled(integer)'::regprocedure))")
              == 'fe1480018bde7ed7659d1c73436378a9')
        check('cancellation SQL exactly matches reviewed production definition',
              q("SELECT md5(pg_get_functiondef('public.atomic_cancel_tournament(uuid,uuid)'::regprocedure))")
              == '5e2761a07fb9e5eb2b5bfcf6e6502fb9')
        started = f"UPDATE public.tournaments SET status='RUNNING',started_at=now() WHERE id='{tid}'; INSERT INTO public.table_seats(table_id) VALUES('{table}')"
        filled = f"INSERT INTO public.table_seats(table_id) VALUES('{table}')"
        departed = "UPDATE public.table_seats SET left_at=now()"
        racing('baseline-cancels-a-game-that-started', started, True)
        check('baseline cancellation actually sees RUNNING',
              q("SELECT previous_status FROM public.cancel_transitions") == 'RUNNING')
        racing('baseline-cancels-a-game-that-filled', filled, True)
        racing('baseline-cancels-after-the-waiter-left', departed, True)
        cursor_race('baseline-cached-candidate-cancels-a-newly-started-board', True)

        candidates = list((repo/'supabase/migrations').glob('*spin_expiry_rechecks_the_locked_board.sql'))
        assert len(candidates) == 1
        q(candidates[0].read_text())
        racing('locked-start-is-preserved', started, False)
        racing('locked-final-seat-is-preserved', filled, False)
        racing('locked-departure-is-preserved', departed, False)
        cursor_race('cached-candidate-rechecks-after-parent-lock', False)
        for label, change in [
            ('fresh-full-board', filled),
            ('fresh-started-board', started),
            ('fresh-departed-waiter', departed),
            ('draw-receipt-before-projection', f"INSERT INTO public.spin_draw_receipts VALUES('{tid}')"),
            ('legacy-reserve-draw', f"INSERT INTO public.spin_reserve_ledger VALUES('{tid}','jackpot_draw')"),
            ('projected-draw', f"UPDATE public.tournaments SET spin_multiplier=2 WHERE id='{tid}'"),
            ('timeout-disabled', 'UPDATE public.spin_fill_policy SET unfilled_timeout_minutes=0'),
        ]:
            seed()
            q(change)
            result = json.loads(q("SELECT public.fn_spin_expire_unfilled(50)"))
            check(label, result['expired'] == 0 and q("SELECT count(*) FROM public.cancel_transitions") == '0')
        seed()
        result = json.loads(q("SELECT public.fn_spin_expire_unfilled(50)"))
        check('a-still-unfilled-expired-board-reaches-the-canonical-cancel',
              result['expired'] == 1 and result['chips_refunded_estimate'] == 2
              and q("SELECT previous_status FROM public.cancel_transitions") == 'REGISTERING')
        check('repeated-expiry-does-not-cancel-twice',
              json.loads(q("SELECT public.fn_spin_expire_unfilled(50)"))['expired'] == 0
              and q("SELECT count(*) FROM public.cancel_transitions") == '1')
        check('expiry-remains-service-only', q(
            "SELECT NOT has_function_privilege('anon','public.fn_spin_expire_unfilled(integer)','EXECUTE') "
            "AND NOT has_function_privilege('authenticated','public.fn_spin_expire_unfilled(integer)','EXECUTE') "
            "AND has_function_privilege('service_role','public.fn_spin_expire_unfilled(integer)','EXECUTE')") == 't')
        print(f'{len(passed)} PostgreSQL checks passed. Log: {log_path}', flush=True)
    finally:
        for child in processes:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)
        if cluster.exists():
            subprocess.run([str(pg/'pg_ctl'), '-D', str(cluster), '-m', 'immediate', 'stop'],
                           stdout=log, stderr=log)
        shutil.rmtree(root)
