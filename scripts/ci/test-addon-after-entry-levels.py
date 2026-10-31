#!/usr/bin/env python3
"""Real PG17 boundary qualification of exact installed entry-close/purchase bodies.
The money core is an explicit sentinel: no accounting outcome is claimed here.
Tests run in a private local cluster, never against production.
"""
import json, os, pathlib, shutil, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
FIX = ROOT / 'scripts/ci/fixtures/addon-after-entry-levels'
MIG = ROOT / 'supabase/migrations/20261031211918_add_on_waits_for_last_late_entry_level.sql'
PG = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
ENV = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
ENV.update(LC_ALL='C', LANG='C')
CLUSTER = pathlib.Path(tempfile.mkdtemp(prefix='addon-entry-'))
SOCK = CLUSTER / 'sock'; SOCK.mkdir()
PSQL = [PG/'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '55783', '-U', 'postgres']
checks=[]
def call(args, sql=None, ok=True):
    r=subprocess.run(list(map(str,args)), input=sql, text=True, capture_output=True, env=ENV, timeout=60)
    if ok and r.returncode: raise RuntimeError(r.stderr)
    return r

def run(sql): return call(PSQL, sql).stdout.strip()
def check(name, condition):
    if not condition: raise AssertionError(name)
    checks.append(name)
T='00000000-0000-4000-8000-000000000001'; U='00000000-0000-4000-8000-000000000002'
PURCHASE=f"SELECT process_tournament_rebuy('{T}','{U}','addon',15,10000,99,NULL);"
def refusal(): return call(PSQL,PURCHASE,False).stderr
try:
    call([PG/'initdb','-D',CLUSTER/'data','-U','postgres','--auth=trust','--no-locale'])
    call([PG/'pg_ctl','-D',CLUSTER/'data','-l',CLUSTER/'pg.log','-o','-k "" -p 55783 -h 127.0.0.1','-w','start'])
    run('''CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT 'service_role'::text$$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
    CREATE TABLE tournaments(id uuid PRIMARY KEY, status text, current_level int, late_reg_levels int,
      rebuy_levels int, late_reg_mins int, started_at timestamptz, prize_pool_finalized bool DEFAULT false,
      add_on_available bool DEFAULT true, addon_period_triggered bool DEFAULT true,
      addon_period_started_at timestamptz, addon_period_ends_at timestamptz, addon_from_start bool DEFAULT false,
      club_id uuid, union_id uuid);
    CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,status text,chips numeric,add_on bool);
    CREATE TABLE tournament_knockout_candidates(id uuid,table_id uuid);
    CREATE TABLE tables(id uuid,tournament_id uuid);
    CREATE TABLE table_seats(id uuid,table_id uuid,user_id uuid,left_at timestamptz,stack numeric,seat_number int);
    CREATE TABLE entry_purchase_idempotency_receipts(key_domain text,idempotency_key text,request jsonb,response jsonb);
    CREATE TABLE wallet_credit_idempotency(key text);
    CREATE TABLE ca_arena_settings(id int,club_id uuid,tournaments_enabled bool);
    CREATE TABLE poker_diamond_custody(id uuid,user_id uuid,purpose text,target_id uuid,state text);
    CREATE TABLE profiles(id uuid);
    CREATE FUNCTION fn_caller_session_is_live() RETURNS bool LANGUAGE sql AS $$SELECT true$$;
    CREATE FUNCTION fn_ca_lock_settlement_lane_for_tournament(uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
    CREATE FUNCTION fn_claim_entry_purchase_receipt(text,text,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"claimed":true}'::jsonb$$;
    CREATE FUNCTION fn_entry_purchases_frozen() RETURNS bool LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION fn_ca_tournament_unit_cents(uuid) RETURNS int LANGUAGE sql AS $$SELECT 1$$;
    CREATE FUNCTION fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,int,text)
      RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'MONEY_BOUNDARY_REACHED'; END$$;
    CREATE FUNCTION fn_finalize_tournament_entry_pool_locked(uuid,text,text) RETURNS jsonb LANGUAGE sql
      AS $$SELECT '{"ok":true,"finalized":true}'::jsonb$$;
    -- Preserve existing earliest-clock admission behavior; only transition is under test.
    CREATE FUNCTION fn_tournament_late_registration_open(uuid) RETURNS bool LANGUAGE sql AS $$
      SELECT NOT coalesce(prize_pool_finalized,false) AND
      current_level<coalesce(late_reg_levels,rebuy_levels,0) AND
      clock_timestamp()<started_at+make_interval(mins=>late_reg_mins) FROM tournaments WHERE id=$1$$;
    ''')
    for name in ('entry-close.sql','chip-purchase.sql','addon-close.sql'): run((FIX/name).read_text()+';')
    run(f"""INSERT INTO tournaments(id,status,current_level,late_reg_levels,late_reg_mins,started_at,
      addon_period_started_at,addon_period_ends_at) VALUES('{T}','RUNNING',3,8,80,now()-interval '81 minutes',now()-interval '1 second',now()+interval '59 seconds');
      INSERT INTO tables VALUES('{T}','{T}');
      INSERT INTO table_seats VALUES('{T}','{T}','{U}',NULL,1000,1);
      INSERT INTO tournament_players VALUES('{T}','{U}','playing',1000,false);""")
    close=lambda: json.loads(run(f"SELECT fn_close_tournament_entry_window('{T}');"))
    check('RED elapsed80 opens at displayedlevel4',close()['entry_closed'] is True)
    check('RED early purchase reaches money', 'MONEY_BOUNDARY_REACHED' in refusal())
    run(MIG.read_text())
    check('GREEN waits for last late entry level',close()['reason']=='addon_waiting_for_late_entry_levels')
    run("UPDATE tournaments SET addon_period_ends_at=now()-interval '1 second';")
    check('legacy expired window still closes without holding old engine', json.loads(run(f"SELECT fn_close_tournament_addon_period('{T}');"))['ok'] is True)
    run("UPDATE tournaments SET addon_period_ends_at=now()+interval '59 seconds';")
    check('GREEN early purchase refused even client claimslevel99','Add-On Period Is Closed' in refusal())
    run('UPDATE tournaments SET current_level=7;')
    check('last late level still running cannot purchase','Add-On Period Is Closed' in refusal())
    run('UPDATE tournaments SET current_level=8;')
    check('completed level boundary opens', close()['entry_closed'] is True)
    check('completed level boundary permits money authority','MONEY_BOUNDARY_REACHED' in refusal())
    run('UPDATE tournaments SET current_level=NULL;')
    check('unknown level refuses','Add-On Period Is Closed' in refusal())
    run("UPDATE tournaments SET current_level=2,late_reg_levels=NULL,rebuy_levels=6;")
    check('rebuy level fallback waits',close()['entry_closed'] is False)
    run("UPDATE tournaments SET current_level=8,late_reg_levels=8,addon_from_start=true,addon_period_started_at=now()-interval '1 hour';")
    check('legacy early Free Buy window refuses','Add-On Period Is Closed' in refusal())
    run("UPDATE tournaments SET addon_period_started_at=now()-interval '1 second',addon_period_ends_at=now()+interval '59 seconds';")
    check('bounded Free Buy after levels reaches authority','MONEY_BOUNDARY_REACHED' in refusal())
    run("UPDATE tournaments SET late_reg_levels=0,late_reg_mins=80,started_at=now();")
    check('clock-only event waits for its configured close','Add-On Period Is Closed' in refusal())
    run("UPDATE tournaments SET started_at=now()-interval '81 minutes';")
    check('clock-only expired reaches authority','MONEY_BOUNDARY_REACHED' in refusal())
    run("UPDATE tournaments SET prize_pool_finalized=true;")
    check('finalized pool refuses new purchase','Add-On Period Is Closed' in refusal())
    run(f"""INSERT INTO entry_purchase_idempotency_receipts VALUES('tournament_chip_purchase',
      'tourney:{T}:addon:{U}',jsonb_build_object('version','v1','tournament_id','{T}','user_id','{U}',
      'rebuy_type','addon','idempotency_key','tourney:{T}:addon:{U}'),
      '{{"success":true,"seated":true,"atomic_tournament_chip_purchase":"v1","rebuy_type":"addon","table_id":"{T}","seat_id":"{T}","stack":11000}}');""")
    check('immutable historical receipt replays after close',json.loads(run(PURCHASE))['stack']==11000)
    replay=call(PSQL,MIG.read_text(),False)
    check('preimage guard refuses repeat or drift',replay.returncode!=0 and 'PREIMAGE_CHANGED' in replay.stderr)
    print(json.dumps({'checks':checks,'production_mutations':False,'money_core':'sentinel only'},indent=2))
finally:
    call([PG/'pg_ctl','-D',CLUSTER/'data','-m','immediate','-w','stop'],ok=False)
    shutil.rmtree(CLUSTER)
