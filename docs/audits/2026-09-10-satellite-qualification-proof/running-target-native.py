#!/usr/bin/env python3
"""Owned PG17 clone only. Current funded helpers plus held exact-K/Stage B."""
import json, subprocess, hashlib, os
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
DB=os.environ.get('SATELLITE_PROOF_DATABASE','satellite_running_restart_sep10')
assert DB in ('satellite_running_restart_sep10','satellite_recovery_sep10')
SOCKET='/tmp/codex-satellite-recovery-pg17/socket' if DB=='satellite_recovery_sep10' else '/tmp/codex-satellite-cohort-pg17/socket'
PORT='55388' if DB=='satellite_recovery_sep10' else '55387'
DATA=SOCKET.rsplit('/',1)[0]+'/data'
PSQL=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-qAt','-h',SOCKET,'-p',PORT,'-d',DB,'-v','ON_ERROR_STOP=1']
SOURCE='e1000000-0000-4000-8000-000000000001'
TARGET='e1000000-0000-4000-8000-000000000002'
A='10000000-0000-0000-0000-000000000001'
B='e1000000-0000-4000-8000-000000000004'
C='e1000000-0000-4000-8000-000000000005'
D='e1000000-0000-4000-8000-000000000061'
E='e1000000-0000-4000-8000-000000000062'
F='e1000000-0000-4000-8000-000000000070'
LEASE='e1000000-0000-4000-8000-000000000051'
TARGET_LEASE='e1000000-0000-4000-8000-000000000063'
TARGET_TABLE='e1000000-0000-4000-8000-000000000064'
COHORT=f"ARRAY['{A}','{B}','{C}']::uuid[]"
PREP=f"public.fn_prepare_satellite_qualification('{SOURCE}',{COHORT},'{LEASE}')"
PAY=f"public.fn_complete_satellite_qualification('{SOURCE}',{COHORT})"
GUARD=f"""DO $$BEGIN IF current_database()<>'{DB}' OR current_setting('data_directory')<>'{DATA}' THEN RAISE EXCEPTION 'Owned private clone only'; END IF; END$$;
"""
HELPERS="""CREATE FUNCTION pg_temp.assert_true(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION: %',label; END IF; END$$;
CREATE TEMP TABLE before_money AS SELECT COALESCE(sum(chip_balance),0) wallets FROM public.club_members;
"""
BASE=(HERE/'native-seed.sql').read_text().split('COMMIT;',1)[1]
TARGET_SETUP=f"""
UPDATE public.tournaments SET prize_pool_finalized=false,ended_at=NULL,late_reg_mins=60,late_reg_levels=0,min_players=3,max_players=9,variant='nlh',blind_structure='[{{"level":1,"smallBlind":10,"bigBlind":20,"durationMinutes":3}}]'  WHERE id='{TARGET}';
INSERT INTO auth.users(id) VALUES('{D}'),('{E}'),('{F}');
SELECT set_config('app.club_membership_source','join_club',true);
INSERT INTO public.club_members(club_id,user_id,status,role) VALUES('20000000-0000-0000-0000-000000000001','{D}','active','player'),('20000000-0000-0000-0000-000000000001','{E}','active','player'),('20000000-0000-0000-0000-000000000001','{F}','active','player');
INSERT INTO public.tournament_players(tournament_id,user_id,status,chips) VALUES('{TARGET}','{D}','registered',0),('{TARGET}','{E}','registered',0),('{TARGET}','{F}','registered',0);
INSERT INTO public.tables(id,name,club_id,tournament_id,status,game_type) VALUES('{TARGET_TABLE}','Running Target Proof','20000000-0000-0000-0000-000000000001','{TARGET}','running','tournament');
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,lease_generation,protocol_version) VALUES('{TARGET}','qualification-target-proof','{TARGET_LEASE}',2);
SELECT public.fn_begin_tournament_launch_atomic('{TARGET}','e1000000-0000-4000-8000-000000000065',now(),'{TARGET_LEASE}');
SELECT public.fn_assign_tournament_player_seat_atomic('{TARGET}','{D}','{TARGET_TABLE}',1);
SELECT public.fn_assign_tournament_player_seat_atomic('{TARGET}','{E}','{TARGET_TABLE}',2);
SELECT public.fn_assign_tournament_player_seat_atomic('{TARGET}','{F}','{TARGET_TABLE}',3);
SELECT public.fn_complete_tournament_launch_atomic('{TARGET}','e1000000-0000-4000-8000-000000000065','{TARGET_LEASE}');
"""
def run(sql):
 return subprocess.run(PSQL,input=GUARD+sql,text=True,capture_output=True)
TARGET_PRELAUNCH,TARGET_LAUNCH=TARGET_SETUP.split('INSERT INTO public.engine_tournament_leases',1)
TARGET_LAUNCH='INSERT INTO public.engine_tournament_leases'+TARGET_LAUNCH
def ensure_target_prelaunch():
 exists=run(f"SELECT count(*) FROM public.tables WHERE id='{TARGET_TABLE}';")
 if exists.returncode: raise RuntimeError(exists.stderr)
 if exists.stdout.strip()=='0':
  r=run("BEGIN; SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';"+TARGET_PRELAUNCH+'SET CONSTRAINTS ALL IMMEDIATE; COMMIT;')
  if r.returncode: raise RuntimeError(r.stderr)
def setup():
 return BASE.replace('SELECT public.fn_tournament_management_readiness_for_row',TARGET_LAUNCH+'\nSELECT public.fn_tournament_management_readiness_for_row',1)
ASSERT_PAID=f"""
SELECT pg_temp.assert_true((SELECT receipt_version=3 AND completion_kind='equal_qualifiers' AND winner_id IS NULL AND ticket_award_count=3 AND pool=600 AND remainder=0 FROM public.tournament_satellite_settlements WHERE tournament_id='{SOURCE}'),'Exact placeless cohort');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND bool_and(status='winner' AND position IS NULL AND eliminated_at IS NULL) FROM public.tournament_players WHERE tournament_id='{SOURCE}'),'No invented rank');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND sum(amount)=600 FROM public.tournament_payouts WHERE tournament_id='{SOURCE}'),'Three exact payments');
SELECT pg_temp.assert_true((SELECT prize_balance=0 AND bounty_balance=0 AND fee_balance=0 FROM public.tournament_escrow WHERE tournament_id='{SOURCE}'),'Zero source banks');
SELECT pg_temp.assert_true((SELECT count(*)=3 FROM public.tournament_players p JOIN public.table_seats s ON s.table_id=p.table_id AND s.seat_number=p.seat_number AND s.user_id=p.user_id AND s.left_at IS NULL WHERE p.tournament_id='{TARGET}' AND p.source_satellite_id='{SOURCE}' AND p.status='playing' AND p.chips=s.stack AND p.chips>0),'Every funded target entry has its exact physical chair');
SELECT pg_temp.assert_true((SELECT current_players=6 FROM public.tournaments WHERE id='{TARGET}'),'Three old players plus three qualifiers counted once');
SELECT pg_temp.assert_true((SELECT prize_balance=540 AND fee_balance=60 AND bounty_balance=0 FROM public.tournament_escrow WHERE tournament_id='{TARGET}'),'540 prize plus60 fee preserves600 funding');
SELECT pg_temp.assert_true((SELECT COALESCE(sum(chip_balance),0) FROM public.club_members)=(SELECT wallets FROM before_money),'No cash created by target seats');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='{SOURCE}' AND s.left_at IS NULL),'Every source chair closed');
"""
def main():
 ensure_target_prelaunch()
 sql=setup()+HELPERS+f'SELECT {PREP}; SELECT {PAY};'+ASSERT_PAID+'SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;'
 r=run(sql)
 result={'case':'Current Funded Helpers Assign All Exact-K Qualifiers To A Running Target','exit_code':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
 (HERE/'running-target-results.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2))
 raise SystemExit(r.returncode)
def negative_control():
 ensure_target_prelaunch()
 sql=setup()+HELPERS+f'SELECT {PREP};'+f"""
 CREATE TEMP TABLE before_target AS SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) seats FROM table_seats s WHERE s.table_id='{TARGET_TABLE}';
 DO $negative$ BEGIN
  BEGIN PERFORM {PAY}; RAISE EXCEPTION 'Expected old null-coordinate refusal';
  EXCEPTION WHEN SQLSTATE '22023' THEN
   IF position('tournament, player, table and legal seat are required' IN SQLERRM)=0 THEN RAISE; END IF;
  END;
 END $negative$;
 SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM tournament_satellite_settlements WHERE tournament_id='{SOURCE}'),'No committed header');
 SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM tournament_payouts WHERE tournament_id='{SOURCE}'),'All candidate payouts rolled back');
 SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM tournament_satellite_awards WHERE tournament_id='{SOURCE}'),'All candidate awards rolled back');
 SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM tournament_players WHERE tournament_id='{TARGET}' AND source_satellite_id='{SOURCE}'),'All candidate entries rolled back');
 SELECT pg_temp.assert_true((SELECT prize_balance=600 FROM tournament_escrow WHERE tournament_id='{SOURCE}'),'All source600 retained');
 SELECT pg_temp.assert_true((SELECT count(*)=3 FROM table_seats WHERE table_id='e1000000-0000-4000-8000-000000000009' AND left_at IS NULL),'All source chairs restored');
 SELECT pg_temp.assert_true((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM table_seats s WHERE s.table_id='{TARGET_TABLE}')=(SELECT seats FROM before_target),'Existing target chairs byte-for-byte unchanged');
 SELECT pg_temp.assert_true((SELECT COALESCE(sum(chip_balance),0) FROM club_members)=(SELECT wallets FROM before_money),'Wallets unchanged');
 SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;
 """
 r=run(sql)
 result={'case':'Old Null Assignment Refuses And Rolls Back The Entire Cohort','exit_code':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
 (HERE/'running-target-negative-control.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2));raise SystemExit(r.returncode)
if __name__=='__main__':
 import sys
 if '--baseline' in sys.argv: negative_control()
 else: main()
