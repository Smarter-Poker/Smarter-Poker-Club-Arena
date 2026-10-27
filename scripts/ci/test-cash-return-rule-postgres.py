#!/usr/bin/env python3
"""Cash return policy against real isolated PostgreSQL; no production writes."""
import os
from pathlib import Path
import subprocess
import tempfile
import shutil
ROOT = Path(__file__).resolve().parents[2]
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin' if Path('/Volumes/SmarterWork').is_dir() else '/usr/lib/postgresql/17/bin'))
scratch = ROOT/'work' if Path('/Volumes/SmarterWork').is_dir() else Path(tempfile.gettempdir())
scratch.mkdir(exist_ok=True)
cluster = Path(tempfile.mkdtemp(prefix='cash-return-', dir=scratch))
socket = cluster/'s'; socket.mkdir()
def run(command):
    r = subprocess.run([str(x) for x in command],capture_output=True,text=True,timeout=60)
    if r.returncode: raise RuntimeError(r.stdout+r.stderr)
    return r.stdout
psql = [pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-U','postgres','-d','postgres']
def query(sql):
    f=cluster/'query.sql'; f.write_text(sql)
    return run(psql+['-f',f])
try:
    shared=Path(run([pg/'pg_config','--sharedir']).strip())
    if not (shared/'postgres.bki').exists(): shared=pg.parent/'share/postgresql'
    run([pg/'initdb','-L',shared,'-D',cluster/'data','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
    run([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',f"-h '' -k {socket}",'-w','start'])
    assert query("select inet_server_addr() is null and current_setting('listen_addresses')='';").strip()=='t'
    query('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE public.tables(id uuid PRIMARY KEY,club_id uuid,game_variant text,small_blind numeric,big_blind numeric,tournament_id uuid,min_buy_in numeric,max_buy_in numeric);
CREATE TABLE public.cash_games(id uuid);
CREATE TABLE public.clubs(id uuid,union_id uuid);
CREATE FUNCTION public.fn_caller_session_is_live() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
CREATE TABLE public.chip_ledger(idempotency_key text);
CREATE FUNCTION public.fn_actor_can_manage_club_treasury(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE public.cash_player_session(id uuid DEFAULT gen_random_uuid(),player_id uuid,scope_type text,scope_id uuid,closed_at timestamptz,closed_reason text,baseline numeric,rejoin_window_ms integer,final_stack numeric,final_stack_captured_at timestamptz,financial_capture_status text,close_table_id uuid);
CREATE TABLE public.cash_rejoin_constraints(id uuid DEFAULT gen_random_uuid(),player_id uuid,club_id uuid,variant text,sb numeric,bb numeric,required_stack numeric CHECK(required_stack>0),left_at timestamptz,expires_at timestamptz,source_table_id uuid,barred_until timestamptz);
CREATE TABLE public.table_seats(id uuid,table_id uuid,user_id uuid,left_at timestamptz,stack numeric);
''')
    query((ROOT/'scripts/ci/fixtures/cash-return/installed-functions.sql').read_text())
    query('''CREATE FUNCTION public.test_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assert: %',label; END IF; END$$;
INSERT INTO tables VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','plo4',1,2,NULL,80,400),('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000010','plo4',1,2,NULL,80,400),('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000010','plo5',1,2,NULL,80,400),('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000010','plo4',2,4,NULL,160,800);
ALTER TABLE tables ADD COLUMN max_players integer, ADD COLUMN is_vip_only boolean, ADD COLUMN is_template boolean;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000100',false);
INSERT INTO cash_rejoin_constraints(player_id,club_id,variant,sb,bb,required_stack,left_at,expires_at) VALUES(auth.uid(),'00000000-0000-0000-0000-000000000010','plo4',1,2,650,now(),now()+interval '2 hours');
SELECT test_assert((fn_cash_effective_buyin('00000000-0000-0000-0000-000000000002')->>'min')::numeric=400,'baseline reproduces cap bypass');
''')
    migration=ROOT/'supabase/migrations/20261026213112_cash_returns_require_full_stack_without_ten_minute_leave_hol.sql'
    query(migration.read_text())
    query('''SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000100',false);
SELECT test_assert(fn_cash_stay_remaining_ms(600000,false,now())=0,'old paused clock retired');
SELECT test_assert(fn_cash_stay_remaining_ms(600000,true,now())=0,'old running clock retired');
SELECT test_assert((fn_cash_leave_check(auth.uid(),'00000000-0000-0000-0000-000000000001')->>'allowed')::boolean,'leave allowed');
SELECT test_assert((fn_cash_effective_buyin('00000000-0000-0000-0000-000000000002')->>'min')::numeric=650,'full stack across tables');
SELECT test_assert((fn_cash_effective_buyin('00000000-0000-0000-0000-000000000002')->>'max')::numeric=650,'return cap raised');
SELECT test_assert(fn_ca_cash_entry_need(auth.uid(),'00000000-0000-0000-0000-000000000002')=650,'wallet need not capped');
DO $$BEGIN
 BEGIN
  PERFORM atomic_table_buyin_before_maintenance_announcement_gate(auth.uid(),'00000000-0000-0000-0000-000000000002',1,649);
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'BUYIN_BELOW_FLOOR:%650%' THEN RETURN; END IF; RAISE;
 END;
 RAISE EXCEPTION 'chip entry accepted a reduced stack';
END$$;
DO $$BEGIN
 BEGIN
  PERFORM atomic_table_buyin_before_maintenance_announcement_gate(auth.uid(),'00000000-0000-0000-0000-000000000002',1,651);
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'Buy-in above table maximum%' THEN RETURN; END IF; RAISE;
 END;
 RAISE EXCEPTION 'chip entry lost the upper bound';
END$$;

SELECT test_assert(fn_horse_seat_from_treasury_before_maintenance_gate('00000000-0000-0000-0000-000000000002',auth.uid(),1,649)->>'error'='BUYIN_BELOW_FLOOR','treasury rejects less than full stack');
SELECT test_assert(fn_horse_seat_from_treasury_before_maintenance_gate('00000000-0000-0000-0000-000000000002',auth.uid(),1,651)->>'error'='BUYIN_ABOVE_MAX','treasury retains upper bound');
SELECT test_assert(fn_cash_rejoin_floor(auth.uid(),'00000000-0000-0000-0000-000000000003') IS NULL,'different variant');
SELECT test_assert(fn_cash_rejoin_floor(auth.uid(),'00000000-0000-0000-0000-000000000004') IS NULL,'different stakes');
UPDATE cash_rejoin_constraints SET expires_at=now();
SELECT test_assert(fn_cash_rejoin_floor(auth.uid(),'00000000-0000-0000-0000-000000000002') IS NULL,'two hours expires inclusively');
SELECT test_assert((fn_cash_effective_buyin('00000000-0000-0000-0000-000000000002')->>'max')::numeric=400,'normal cap restored');
INSERT INTO cash_player_session(player_id,scope_type,scope_id,baseline,rejoin_window_ms) VALUES(auth.uid(),'table','00000000-0000-0000-0000-000000000001',800,7200000);
SELECT fn_cash_session_close(auth.uid(),'00000000-0000-0000-0000-000000000001',500,'voluntary');
SELECT test_assert(fn_cash_rejoin_floor(auth.uid(),'00000000-0000-0000-0000-000000000002')=500,'losing player retains full stack');
SELECT test_assert((SELECT final_stack=500 AND financial_capture_status='exact' FROM cash_player_session),'financial capture retained');
SELECT test_assert((SELECT expires_at-left_at=interval '2 hours' FROM cash_rejoin_constraints WHERE expires_at>now()),'exact new window');
UPDATE cash_rejoin_constraints SET barred_until=now()+interval '1 hour';
DO $$BEGIN
 BEGIN PERFORM fn_cash_rejoin_floor(auth.uid(),'00000000-0000-0000-0000-000000000002');
 EXCEPTION WHEN check_violation THEN IF SQLERRM LIKE 'VPIP_BARRED:%' THEN RETURN; END IF; RAISE; END;
 RAISE EXCEPTION 'VPIP bar lost'; END$$;
''')
    # Exact patch preconditions refuse accidental replay and roll back atomically.
    try: query(migration.read_text())
    except RuntimeError as e: assert 'source drift' in str(e)
    else: raise AssertionError('migration replay should fail before changes')
    print('PASS: pre-change cap bypass reproduced; full return floor, game/stake scope, exact expiry, losing stack, old clocks, VPIP, capture, replay rollback')
finally:
    if (cluster/'data/postmaster.pid').exists(): run([pg/'pg_ctl','-D',cluster/'data','-m','immediate','-w','stop'])
    shutil.rmtree(cluster)
