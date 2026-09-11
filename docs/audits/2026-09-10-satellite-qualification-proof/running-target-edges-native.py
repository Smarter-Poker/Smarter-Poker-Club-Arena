#!/usr/bin/env python3
"""Native rollback cases; only the explicitly owned private clone is permitted."""
import importlib.util,json
from pathlib import Path
P=Path(__file__).resolve().parent
sp=importlib.util.spec_from_file_location('native',P/'running-target-native.py');n=importlib.util.module_from_spec(sp);sp.loader.exec_module(n)
S,T,TT=n.SOURCE,n.TARGET,n.TARGET_TABLE
n.ensure_target_prelaunch()
def snapshot():
 return f"""CREATE TEMP TABLE initial_target AS SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) seats FROM table_seats s WHERE s.table_id='{TT}';
CREATE TEMP TABLE initial_tables AS SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) val FROM tables t WHERE t.tournament_id='{T}';
CREATE TEMP TABLE initial_receipts AS SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.table_id),'[]') val FROM tournament_capacity_table_receipts r WHERE r.tournament_id='{T}';
CREATE TEMP TABLE initial_wakes AS SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.id),'[]') val FROM tournament_manager_wakes w WHERE w.tournament_id='{T}';
"""
UNCHANGED=f"""SELECT pg_temp.assert_true((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM table_seats s WHERE s.table_id='{TT}' AND s.seat_number<=3)=(SELECT seats FROM initial_target),'Existing occupied chairs unchanged');"""
CAP=f"""SELECT pg_temp.assert_true((SELECT count(*)=2 FROM tables WHERE tournament_id='{T}'),'Exactly one capacity table created');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM tournament_capacity_table_receipts WHERE tournament_id='{T}'),'One durable capacity receipt');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM tournament_manager_wakes WHERE tournament_id='{T}' AND reason='late_registration' AND consumed_at IS NULL),'One pending wake');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM tournament_capacity_table_receipts r JOIN tournament_manager_wakes w ON w.id=r.manager_wake_id JOIN tables t ON t.id=r.table_id WHERE r.tournament_id='{T}' AND w.tournament_id='{T}' AND t.small_blind=10 AND t.big_blind=20),'Current blinds and exact wake receipt');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM tables t WHERE t.tournament_id='{T}' AND (SELECT count(*) FROM table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL)>LEAST(t.max_players,public.fn_ca_tournament_seat_cap('{T}'))),'No table exceeds legal physical capacity');
SELECT pg_temp.assert_true((public.fn_ensure_late_registration_capacity('{T}',0)->>'created')::boolean=false,'Retry creates no duplicate capacity');
"""
ROLLBACK=f"""SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM tournament_satellite_settlements WHERE tournament_id='{S}'),'No header');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM tournament_payouts WHERE tournament_id='{S}'),'All three payouts rolled back');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM tournament_satellite_awards WHERE tournament_id='{S}'),'All awards rolled back');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM tournament_players WHERE tournament_id='{T}' AND source_satellite_id='{S}'),'All target entries rolled back');
SELECT pg_temp.assert_true((SELECT prize_balance=600 FROM tournament_escrow WHERE tournament_id='{S}'),'Source600 retained');
SELECT pg_temp.assert_true((SELECT count(*)=3 FROM table_seats s JOIN tables t ON t.id=s.table_id WHERE t.tournament_id='{S}' AND s.left_at IS NULL),'Source chairs restored');
SELECT pg_temp.assert_true((SELECT current_players=3 FROM tournaments WHERE id='{T}'),'Target count restored');
SELECT pg_temp.assert_true((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM table_seats s WHERE s.table_id='{TT}')=(SELECT seats FROM initial_target),'Target chairs exactly restored');
SELECT pg_temp.assert_true((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM tables t WHERE t.tournament_id='{T}')=(SELECT val FROM initial_tables),'Capacity tables exactly restored');
SELECT pg_temp.assert_true((SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.table_id),'[]') FROM tournament_capacity_table_receipts r WHERE r.tournament_id='{T}')=(SELECT val FROM initial_receipts),'Capacity receipts restored');
SELECT pg_temp.assert_true((SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.id),'[]') FROM tournament_manager_wakes w WHERE w.tournament_id='{T}')=(SELECT val FROM initial_wakes),'Capacity wake restored');
SELECT pg_temp.assert_true((SELECT COALESCE(sum(chip_balance),0) FROM club_members)=(SELECT wallets FROM before_money),'Wallets unchanged');
"""
def dirty():
 return f"""INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,status,joined_at,left_at,is_sitting_out,is_away,leave_pending,scheduled_leave_hands,auto_rebuy,time_bank_remaining,time_bank_uses_remaining,club_id,sit_out_at,entry_post_agreed)
VALUES('e1000000-0000-4000-8000-000000000071','{TT}','{n.D}',4,777,'sitting_out',now()-interval '1day',now()-interval '1hour',true,true,true,7,true,999,999,'20000000-0000-0000-0000-000000000001',now()-interval '1day',true);
"""
DIRTY_ASSERT=f"""SELECT pg_temp.assert_true((SELECT user_id='{n.A}' AND seat_number=4 AND stack=10000 AND status='active' AND left_at IS NULL AND player_id IS NULL AND member_id IS NULL AND is_sitting_out=false AND is_away=false AND leave_pending=false AND scheduled_leave_hands IS NULL AND auto_rebuy=false AND time_bank_remaining<>999 AND time_bank_uses_remaining<>999 AND sit_out_at IS NULL AND entry_hold IS NULL AND entry_post_agreed=false AND joined_at>now()-interval '1minute' AND club_id='20000000-0000-0000-0000-000000000001' FROM table_seats WHERE id='e1000000-0000-4000-8000-000000000071'),'Dirty reused chair has new identity and session fields');"""
def fault():
 signature='public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)'
 r=n.run(f"SELECT pg_get_functiondef('{signature}'::regprocedure);")
 assert not r.returncode,r.stderr
 saved=r.stdout.replace('public.fn_ca_assign_tournament_player_seat_locked(', 'public.fn_satellite_proof_assign_real(',1)
 return saved+f""";
ALTER FUNCTION public.fn_satellite_proof_assign_real(uuid,uuid,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_satellite_proof_assign_real(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_assign_tournament_player_seat_locked(p_tournament_id uuid,p_user_id uuid,p_table_id uuid,p_seat_number integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='30s' AS $fault$
DECLARE r jsonb; BEGIN
 r:=public.fn_satellite_proof_assign_real(p_tournament_id,p_user_id,p_table_id,p_seat_number);
 IF p_tournament_id='{T}' AND p_user_id='{n.C}' THEN
  IF (SELECT count(*) FROM tournament_payouts WHERE tournament_id='{S}')<>3 OR (SELECT sum(amount) FROM tournament_payouts WHERE tournament_id='{S}')<>600 OR (SELECT count(*) FROM tournament_players p JOIN table_seats s ON s.user_id=p.user_id AND s.table_id=p.table_id AND s.seat_number=p.seat_number AND s.left_at IS NULL WHERE p.tournament_id='{T}' AND p.source_satellite_id='{S}')<>3 OR EXISTS(SELECT 1 FROM table_seats s JOIN tables t ON t.id=s.table_id WHERE t.tournament_id='{S}' AND s.left_at IS NULL) THEN RAISE EXCEPTION 'Fault was not after complete economic and seat effects'; END IF;
  RAISE EXCEPTION 'injected after actual final assignment' USING ERRCODE='P0903';
 END IF; RETURN r;
END $fault$;
"""
def run_case(name,sql):
 r=n.run(sql+'SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;')
 return {'case':name,'exit_code':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
results=[]
base=n.setup()+n.HELPERS+snapshot()
results.append(run_case('Dirty chair reuse preserves occupied slots',base+dirty()+f'SELECT {n.PREP};SELECT {n.PAY};'+n.ASSERT_PAID+UNCHANGED+DIRTY_ASSERT))
capacity=n.setup().replace(n.TARGET_LAUNCH, f"UPDATE tables SET max_players=3 WHERE id='{TT}';"+n.TARGET_LAUNCH)+n.HELPERS+snapshot()
results.append(run_case('Cohort capacity zero reservation creates one receipted table',capacity+f'SELECT {n.PREP};SELECT {n.PAY};'+n.ASSERT_PAID+UNCHANGED+CAP))
results.append(run_case('Final actual assignment failure rolls back money capacity receipts and chairs',capacity+f'SELECT {n.PREP};'+fault()+f"""DO $x$ BEGIN BEGIN PERFORM {n.PAY};RAISE EXCEPTION 'Expected final assignment fault';EXCEPTION WHEN SQLSTATE 'P0903' THEN IF SQLERRM<>'injected after actual final assignment' THEN RAISE;END IF;END;END $x$;"""+ROLLBACK))
(P/'running-target-edge-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps([{k:v for k,v in r.items() if k!='stdout'} for r in results],indent=2))
raise SystemExit(any(r['exit_code'] for r in results))
