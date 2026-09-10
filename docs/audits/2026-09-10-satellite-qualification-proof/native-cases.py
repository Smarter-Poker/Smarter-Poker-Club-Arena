#!/usr/bin/env python3
"""Runs actual installed qualification functions on an isolated full PG17 fixture.
The source escrow is a seeded 600-chip liability. This proves terminal movement,
not original entry collection. Every case rolls back after forcing deferred checks.
"""
import json, subprocess
from pathlib import Path

HERE=Path(__file__).resolve().parent
PSQL=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-qAt','-h','/tmp/codex-satellite-cohort-pg17/socket','-p','55387','-d','satellite_qualification_verified','-v','ON_ERROR_STOP=1']
SOURCE='e1000000-0000-4000-8000-000000000001'
TARGET='e1000000-0000-4000-8000-000000000002'
A='10000000-0000-0000-0000-000000000001'
B='e1000000-0000-4000-8000-000000000004'
C='e1000000-0000-4000-8000-000000000005'
LEASE='e1000000-0000-4000-8000-000000000051'
COHORT=f"ARRAY['{A}','{B}','{C}']::uuid[]"
PREP=f"public.fn_prepare_satellite_qualification('{SOURCE}',{COHORT},'{LEASE}')"
PAY=f"public.fn_complete_satellite_qualification('{SOURCE}',{COHORT})"
RESOLVE=f"public.fn_resolve_satellite_qualification_outcome('{SOURCE}',{COHORT})"
full_seed=(HERE/'native-seed.sql').read_text()
prelaunch,base=full_seed.split('COMMIT;',1)
existing=subprocess.run(PSQL+['-c',f"SELECT 1 FROM public.tournaments WHERE id='{SOURCE}'"],text=True,capture_output=True,check=True)
if not existing.stdout.strip():
 setup_result=subprocess.run(PSQL,input=prelaunch+'COMMIT;',text=True,capture_output=True)
 if setup_result.returncode: raise SystemExit(setup_result.stderr)
helpers=r"""
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.expect_error(statement text, expected_state text, message_part text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE caught boolean:=false; BEGIN
 BEGIN EXECUTE statement;
 EXCEPTION WHEN OTHERS THEN
   IF SQLSTATE<>expected_state OR position(message_part IN SQLERRM)=0 THEN
     RAISE EXCEPTION 'Unexpected failure: % / %, expected % / %',SQLSTATE,SQLERRM,expected_state,message_part;
   END IF; caught:=true;
 END;
 IF NOT caught THEN RAISE EXCEPTION 'Expected rejection: %',statement; END IF;
END $$;
CREATE TEMP TABLE before_money AS SELECT COALESCE(sum(chip_balance),0) AS wallets FROM public.club_members;
"""
assert_empty=f"""
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.tournament_satellite_settlements WHERE tournament_id='{SOURCE}'),'No terminal receipt on refusal');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.tournament_payouts WHERE tournament_id='{SOURCE}'),'No payout on refusal');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.tournament_satellite_qualifiers WHERE tournament_id='{SOURCE}'),'No paid cohort on refusal');
SELECT pg_temp.assert_true((SELECT prize_balance=600 FROM public.tournament_escrow WHERE tournament_id='{SOURCE}'),'Source liability retained');
SELECT pg_temp.assert_true((SELECT COALESCE(sum(chip_balance),0) FROM public.club_members)=(SELECT wallets FROM before_money),'Wallets unchanged on refusal');
"""
assert_paid=f"""
SELECT pg_temp.assert_true((SELECT receipt_version=3 AND completion_kind='equal_qualifiers' AND winner_id IS NULL AND ticket_award_count=3 AND pool=600 AND remainder=0 FROM public.tournament_satellite_settlements WHERE tournament_id='{SOURCE}'),'Exact version-three cohort receipt');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND bool_and(status='winner' AND position IS NULL AND eliminated_at IS NULL AND elimination_sequence IS NULL) FROM public.tournament_players WHERE tournament_id='{SOURCE}'),'Qualification never fabricates rank or elimination');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND sum(amount)=600 FROM public.tournament_payouts WHERE tournament_id='{SOURCE}'),'Exactly three funded awards');
SELECT pg_temp.assert_true((SELECT prize_balance=0 AND bounty_balance=0 AND fee_balance=0 FROM public.tournament_escrow WHERE tournament_id='{SOURCE}'),'All source banks close at zero');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='{SOURCE}' AND s.left_at IS NULL),'Every source chair released');
"""

def rejection(statement,state,reason):
 return "SELECT pg_temp.expect_error($call$SELECT "+statement+"$call$,'"+state+"','"+reason.replace("'","''")+"');\n"

cases=[]
def add(name,sql,open_target=False,max_players=None):
 setup=base
 target_updates=[]
 if open_target: target_updates.append("prize_pool_finalized=false,ended_at=NULL")
 if max_players: target_updates.append(f"max_players={max_players},buy_in_amount=200,buy_in_fee=0")
 if target_updates:
  before_launch='UPDATE public.tournaments SET '+','.join(target_updates)+f" WHERE id='{TARGET}';\n"
  setup=setup.replace('SELECT public.fn_tournament_management_readiness_for_row',before_launch+'SELECT public.fn_tournament_management_readiness_for_row',1)
 cases.append((name,setup+helpers+sql+'\nSET CONSTRAINTS ALL IMMEDIATE;\nROLLBACK;\n'))

add('Cash Cohort Conserves 600 Chips',f'SELECT {PREP}; CREATE TEMP TABLE result AS SELECT {PAY} AS receipt;'+assert_paid+f"SELECT pg_temp.assert_true((SELECT COALESCE(sum(chip_balance),0) FROM public.club_members)=(SELECT wallets+600 FROM before_money),'Cash transfer conserves liability plus wallet balance');")
add('Open Target Registers The Entire Cohort',f'SELECT {PREP}; SELECT {PAY};'+assert_paid+f"SELECT pg_temp.assert_true((SELECT count(*)=3 AND bool_and(delivery_kind='seat') FROM public.tournament_satellite_awards WHERE tournament_id='{SOURCE}'),'All three are target entries'); SELECT pg_temp.assert_true((SELECT COALESCE(sum(chip_balance),0) FROM public.club_members)=(SELECT wallets FROM before_money),'Seat awards never credit cash wallets'); SELECT pg_temp.assert_true((SELECT prize_balance+fee_balance=600 FROM public.tournament_escrow WHERE tournament_id='{TARGET}'),'All 600 chips move to target prize and fee liabilities');",True)
add('Missing Preparation Refuses Every Payment',rejection(PAY,'55000','durable settled-hand admission')+assert_empty)
add('Wrong Lease Is Refused',rejection(PREP.replace(LEASE,'e1000000-0000-4000-8000-000000000099'),'40001','lost its engine lease')+assert_empty)
add('Expired Lease Is Refused',f"UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE tournament_id='{SOURCE}';"+rejection(PREP,'40001','lost its engine lease')+assert_empty)
add('Duplicate Qualifiers Are Refused',rejection(PREP.replace(COHORT,f"ARRAY['{A}','{A}','{C}']::uuid[]"),'22023','distinct nonnull')+assert_empty)
add('Different Qualifiers Are Refused',rejection(PREP.replace(C,'e1000000-0000-4000-8000-000000000099'),'40001','cohort differs')+assert_empty)
add('A Smaller Cohort Cannot Borrow A Rank',rejection(PREP.replace(COHORT,f"ARRAY['{A}','{B}']::uuid[]"),'P0404','frozen funded entitlement')+assert_empty)
add('A Forged Session Marker Does Not Prepare A Cohort',f"SELECT set_config('app.atomic_satellite_qualification','{SOURCE}:{LEASE}',true);"+rejection(PAY,'55000','durable settled-hand admission')+assert_empty)
add('Partial Target Capacity Refuses The Whole Cohort',f'SELECT {PREP};'+rejection(PAY,'55000','partial target capacity')+assert_empty,True,2)
add('Immutable Boundary Cannot Be Reassigned',f'SELECT {PREP};'+"SELECT pg_temp.expect_error($call$UPDATE public.tournament_satellite_qualification_boundaries SET qualified_user_ids=ARRAY['"+A+"','"+B+"']::uuid[] WHERE tournament_id='"+SOURCE+"'$call$,'55000','immutable');"+assert_empty)
add('Last Receipt Failure Rolls Back Every Award',f'SELECT {PREP};'+"CREATE FUNCTION pg_temp.reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected final receipt failure' USING ERRCODE='P0901'; END $$; CREATE TRIGGER native_reject_receipt AFTER INSERT ON public.tournament_satellite_settlements FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_receipt();"+rejection(PAY,'P0901','injected final receipt failure')+assert_empty)
add('Lost Response Replay Returns The Original Receipt',f'SELECT {PREP}; CREATE TEMP TABLE result AS SELECT {PAY} AS receipt; SELECT pg_temp.assert_true({PAY}=(SELECT receipt FROM result),\'Replay preserves exact committed receipt\'); SELECT pg_temp.assert_true(({RESOLVE}->\'receipt\')=(SELECT receipt FROM result),\'Serialized resolver adopts original receipt\');'+assert_paid)
add('Prepared Outcome Is Proven Uncommitted',f'SELECT {PREP}; SELECT pg_temp.assert_true(({RESOLVE}->>\'definitively_not_committed\')::boolean,\'Prepared boundary has no paid outcome\');'+assert_empty)
add('Own Authenticated Read Never Returns Another Participant',f"SELECT {PREP}; SELECT {PAY}; SELECT set_config('request.jwt.claims','{{\"role\":\"authenticated\",\"sub\":\"{A}\"}}',true); SET LOCAL ROLE authenticated; SELECT pg_temp.assert_true((public.fn_get_my_satellite_qualification('{SOURCE}')->>'user_id')='{A}','DTO is scoped to auth.uid'); SELECT set_config('request.jwt.claims','{{\"role\":\"authenticated\",\"sub\":\"e1000000-0000-4000-8000-000000000099\"}}',true); SELECT pg_temp.assert_true(public.fn_get_my_satellite_qualification('{SOURCE}') IS NULL,'Nonparticipant sees no qualification'); RESET ROLE;")
cap_bookings=f"""
INSERT INTO auth.users(id) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d') ON CONFLICT(id) DO NOTHING;
DO $bookings$ DECLARE i integer; booked uuid; BEGIN
 FOR i IN 1..4 LOOP
  booked:=gen_random_uuid();
  INSERT INTO public.tournaments SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object('id',booked,'name','Native Cap Booking '||i,'prize_pool',0,'total_rake',0,'current_players',0))).* FROM public.tournaments t WHERE t.id='{TARGET}';
  INSERT INTO public.tournament_players(tournament_id,user_id,status,chips) VALUES(booked,'{A}','registered',0);
 END LOOP;
END; $bookings$;
SELECT pg_temp.assert_true(public.fn_concurrent_game_load('{A}',NULL,NULL,'{TARGET}')=4,'Four real booked game identities feed the cap');
"""
add('Capped Qualifier Gets Noncash Ticket With Conserved Escrow',f'SELECT {PREP};'+cap_bookings+f'SELECT {PAY};'+assert_paid+f"SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(holder_id='{A}' AND value=200 AND redemption_mode='tournament_entry_only') FROM public.tournament_tickets WHERE source_satellite_id='{SOURCE}'),'Exactly one funded entry ticket for the capped player'); SELECT pg_temp.assert_true((SELECT seat_count=2 AND entry_ticket_count=1 AND cash_ticket_count=0 FROM public.tournament_satellite_settlements WHERE tournament_id='{SOURCE}'),'Other two equal qualifiers receive target entries'); SELECT pg_temp.assert_true((SELECT COALESCE(sum(chip_balance),0) FROM public.club_members)=(SELECT wallets FROM before_money),'Entry ticket creates no spendable cash'); SELECT pg_temp.assert_true((SELECT prize_balance+fee_balance FROM public.tournament_escrow WHERE tournament_id='{TARGET}')+(SELECT sum(value) FROM public.tournament_tickets WHERE source_satellite_id='{SOURCE}')=600,'Target and ticket escrow conserve all 600 chips');",True)

results=[]
for name,sql in cases:
 result=subprocess.run(PSQL,input=sql,text=True,capture_output=True)
 results.append({'case':name,'exit_code':result.returncode,'error':result.stderr[-3500:] if result.returncode else None})
 print(('PASS ' if result.returncode==0 else 'FAIL ')+name,flush=True)
 if result.returncode: print(result.stderr[-1600:],flush=True)
(HERE/'native-case-results.json').write_text(json.dumps(results,indent=2)+'\n')
raise SystemExit(any(r['exit_code'] for r in results))
