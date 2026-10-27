#!/usr/bin/env python3
"""Actual horse purchase wrappers + actual transaction lock, disposable PG only.
Unchanged economic delegates are fixture sinks: no claim to requalify their money rules.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import uuid

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
BASE = Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir())
if __import__('sys').platform == 'darwin' and not str(BASE).startswith('/Volumes/SmarterWork/agent-work/'):
    raise RuntimeError('Use owned external SSD scratch')
ENV = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
MIGRATION = ROOT/'supabase/migrations/20261027062132_horse_future_tournament_purchase_budget.sql'
def uid(s): return str(uuid.uuid5(uuid.NAMESPACE_URL,'horse-future-purchase/'+s))
def main():
    checks=[]
    def check(label, ok):
        if not ok: raise AssertionError(label)
        checks.append(label)
    with tempfile.TemporaryDirectory(prefix='horse-future-',dir=BASE) as d:
        d=Path(d); sock=d/'s';sock.mkdir()
        def command(args): return subprocess.run([str(x) for x in args],env=ENV,text=True,capture_output=True,check=True).stdout
        command([PG/'initdb','-D',d/'db','-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
        command([PG/'pg_ctl','-D',d/'db','-l',d/'log','-o',f"-k {sock} -p 55479 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",'-w','start'])
        def run(q, failure=False):
            r=subprocess.run([str(PG/'psql'),'-X','-At','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55479','-U','postgres','-d','postgres','-c',q],env=ENV,text=True,capture_output=True)
            if r.returncode and not failure: raise AssertionError(r.stderr)
            return r.stderr if failure else r.stdout.strip()
        def call(label,seat=False,horse='horse'):
            return f"SELECT {'fn_seat_horse_in_seat_first_game' if seat else 'fn_register_horse_for_tournament'}('{uid(label)}','{uid(horse)}'"+(');' if seat else ',true);')
        def entry(label,horse='horse',status='registered'):
            return f"INSERT INTO tournament_players VALUES(gen_random_uuid(),'{uid(label)}','{uid(horse)}','{status}');"
        def reset(horse='horse',n=4):
            run(f"TRUNCATE tournament_players,table_seats,purchases; INSERT INTO profiles VALUES('{uid(horse)}',true) ON CONFLICT DO NOTHING;"+''.join(entry('old'+str(i),horse) for i in range(n)))
        try:
            run("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA extensions;
CREATE TABLE profiles(id uuid PRIMARY KEY,is_horse boolean);
CREATE TABLE tournaments(id uuid PRIMARY KEY,status text,start_time timestamptz,prize_pool_finalized boolean DEFAULT false,club_id uuid,union_id uuid);
CREATE TABLE tournament_players(id uuid PRIMARY KEY,tournament_id uuid,user_id uuid,status text);
CREATE TABLE tables(id uuid PRIMARY KEY,tournament_id uuid,status text DEFAULT 'running');
CREATE TABLE table_seats(id uuid PRIMARY KEY,table_id uuid,user_id uuid,left_at timestamptz);
CREATE TABLE ca_operator_floor_hold(operation_id uuid,mode text);
CREATE TABLE ca_launch_operator_scopes(operation_id uuid,club_ids uuid[]);
CREATE TABLE tournament_launch_receipts(tournament_id uuid);
CREATE TABLE purchases(tournament_id uuid,user_id uuid);
CREATE FUNCTION fn_ca_lock_settlement_lane_for_tournament(uuid,uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_ca_lock_mtt_admission_contract() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_lock_daily_mission_user(uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.frozen',true)='true'$$;
CREATE FUNCTION fn_lightning_pilot_assignment_blocks(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_poker_diamond_tournament(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_ca_entry_paying_club(uuid,uuid) RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE FUNCTION fn_tournament_primary_table(uuid) RETURNS uuid LANGUAGE sql AS $$SELECT id FROM tables WHERE tournament_id=$1 LIMIT 1$$;
CREATE FUNCTION fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM tournament_players WHERE tournament_id=$1 AND user_id=$2 AND status IN ('registered','playing')) THEN RETURN '{"ok":true,"already_registered":true}'::jsonb;END IF;
 PERFORM pg_sleep(.05); INSERT INTO tournament_players VALUES(gen_random_uuid(),$1,$2,'registered');INSERT INTO purchases VALUES($1,$2);RETURN '{"ok":true}'::jsonb;END$$;
CREATE FUNCTION fn_seat_horse_in_seat_first_game_before_terminal_seat_gate(uuid,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE r jsonb;BEGIN
 r:=fn_register_horse_for_tournament($1,$2,true);IF (r->>'ok')::boolean IS NOT TRUE THEN RETURN r;END IF;
 IF NOT EXISTS(SELECT 1 FROM table_seats WHERE user_id=$2 AND table_id=fn_tournament_primary_table($1) AND left_at IS NULL) THEN INSERT INTO table_seats VALUES(gen_random_uuid(),fn_tournament_primary_table($1),$2,NULL);END IF;RETURN r;END$$;
""")
            run((ROOT/'tests/sql/fixtures/horse-future-purchase-lock.sql').read_text())
            run((ROOT/'tests/sql/fixtures/horse-future-purchase-before.sql').read_text())
            for sig in ['fn_register_horse_for_tournament(uuid,uuid,boolean)','fn_seat_horse_in_seat_first_game(uuid,uuid)']:
                run(f'REVOKE ALL ON FUNCTION {sig} FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION {sig} TO service_role;')
            labels=['old'+str(i) for i in range(6)]+['new','race-a','race-b','paid']
            for label in labels:
                run(f"INSERT INTO tournaments(id,status,start_time)VALUES('{uid(label)}','REGISTERING',now()+interval '3 hours');INSERT INTO tables(id,tournament_id)VALUES('{uid('table'+label)}','{uid(label)}');")
            reset(); check('actual preimage buys fifth far-future entry',json.loads(run(call('new')))['ok'])
            reset(); run(MIGRATION.read_text())
            for seat in [False,True]:
                reset();r=json.loads(run(call('new',seat)))
                check(('seat-first' if seat else 'MTT')+' new purchase refused at four',r.get('reason')=='horse_tournament_reservation_budget')
                check('refusal has no charge/roster/chair effect '+str(seat),run('SELECT (SELECT count(*) FROM tournament_players)||\':\'||(SELECT count(*) FROM purchases)||\':\'||(SELECT count(*) FROM table_seats)')=='4:0:0')
            reset(n=3); check('third allows fourth',json.loads(run(call('new')))['ok'])
            check('fourth prevents fifth through other format',json.loads(run(call('race-a',True))).get('reason')=='horse_tournament_reservation_budget')
            reset();run(f"UPDATE tournament_players SET status='eliminated' WHERE tournament_id='{uid('old0')}';")
            check('busting releases choice budget',json.loads(run(call('new')))['ok'])
            reset();run(f"UPDATE tournaments SET status='COMPLETED' WHERE id='{uid('old0')}';")
            check('finished event releases choice budget',json.loads(run(call('new')))['ok'])
            run(f"UPDATE tournaments SET status='REGISTERING' WHERE id='{uid('old0')}';")
            reset(n=3);run(entry('old0'))
            check('same-event duplicate roster counted once',json.loads(run(call('new')))['ok'])
            reset();run(entry('paid'))
            check('existing paid target seats even above budget',json.loads(run(call('paid',True)))['ok'])
            check('paid seating buys no new entry',run('SELECT count(*) FROM purchases')=='0')
            check('paid replay stays idempotent',json.loads(run(call('paid',True)))['ok'] and run('SELECT count(*) FROM table_seats')=='1')
            reset(n=3)
            barrier=threading.Barrier(2)
            def contender(x):
                barrier.wait(timeout=5)
                return json.loads(run(call(x[0],x[1])))
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results=list(pool.map(contender,[('race-a',False),('race-b',True)]))
            check('cross-wrapper concurrent last slot buys exactly once',sum(r.get('ok') is True for r in results)==1 and sum(r.get('reason')=='horse_tournament_reservation_budget' for r in results)==1)
            check('race leaves four promises and one charge',run('SELECT (SELECT count(*) FROM tournament_players)||\':\'||(SELECT count(*) FROM purchases)')=='4:1')
            reset();run(f"UPDATE tournaments SET status=NULL WHERE id='{uid('old0')}';")
            check('unknown event status cannot erase an outstanding promise',json.loads(run(call('new'))).get('reason')=='horse_tournament_reservation_budget')
            run(f"UPDATE tournaments SET status='CANCELLED' WHERE id='{uid('old0')}';")
            check('cancelled event releases choice budget',json.loads(run(call('new')))['ok'])
            run(f"UPDATE tournaments SET status='REGISTERING' WHERE id='{uid('old0')}';")
            reset(n=3);check('freeze precedes new choice guard',json.loads(run("SET test.frozen='true';"+call('new')).splitlines()[-1]).get('reason')=='platform_frozen')
            for sig in ['fn_register_horse_for_tournament(uuid,uuid,boolean)','fn_seat_horse_in_seat_first_game(uuid,uuid)']:
                check('service ACL preserved '+sig,run(f"SELECT proacl::text FROM pg_proc WHERE oid='{sig}'::regprocedure")=='{postgres=X/postgres,service_role=X/postgres}')
                check('public invocation remains denied '+sig,'permission denied' in run('SET ROLE anon;'+call('new',sig.startswith('fn_seat')),True))
            check('migration replay refuses drift','horse_future_purchase_preimage_changed' in run(MIGRATION.read_text(),True))
            print(json.dumps({'passed':len(checks),'checks':checks,'scope':'actual wrappers and actual cap lock; controlled unchanged economic delegate sinks'}))
        finally: command([PG/'pg_ctl','-D',d/'db','-m','immediate','-w','stop'])
if __name__=='__main__':main()
