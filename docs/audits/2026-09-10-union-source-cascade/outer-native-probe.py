#!/usr/bin/env python3
"""Actual legacy and captured owners in the original outer dispatcher."""
import os,sys,json,hashlib,subprocess
from pathlib import Path
from decimal import Decimal
sys.path.insert(0,os.environ['ROUND1_HERE'])
from fixture_helpers import sql,setup,source,state
here=Path(os.environ['CASCADE_HERE']);source_input=Path(os.environ['CASCADE_SOURCE_INPUT']);payer=Path(os.environ['CASCADE_PAYER_INPUT'])
checks=[]
def check(name,p):
 assert p,name
 checks.append(name);print('PASS: '+name,flush=True)
def value(q,actor=100):return json.loads(sql(q,actor=actor).splitlines()[-1],parse_float=Decimal)
def load(p):sql(p.read_text())
def refused(name,q,error):
 before=state();e=sql(q,False);check(name,error in e and before==state())
setup()
for name in ['fixture-view.sql','00-expand.sql'] :load(source_input/name)
subprocess.run([os.environ['COMMISSION_PSQL'],'-X','-q','-v','ON_ERROR_STOP=1','-f',str(source_input/'00-online-index.sql')],check=True)
for name in ['00-preflight.sql','01-source-exclusion.sql','02-excluded-owners.sql','03-excluded-unpaid-rollups.sql']:load(source_input/name)
for name in ['01-shared-basis.sql','02-legacy-round1.sql','03-legacy-claim.sql','04-legacy-round3.sql']:load(payer/name)
load(Path(os.environ['ROUND1_INPUT'])/'capacity-owner/04-agent-payment.sql')
load(Path(os.environ['ROUND1_HERE']).parent/'player-capacity-proposal.sql')
load(here/'installed-period-finalizer.sql')
load(here/'01-source-dispatch.sql')
load(here/'02-outer-cascade.sql')
print('COMPOSITION INSTALLED: actual R1, R2, R3, captured payments and outer owner',flush=True)
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Outer Proof Union',test_id(100),'outer-proof-union');
INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);
UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);
UPDATE agents SET commission_rate=.25,player_rakeback_rate=.15 WHERE id=test_id(103);
UPDATE club_members SET player_rakeback_pct=.15 WHERE club_id=test_id(900) AND user_id IN(test_id(201),test_id(202));
ALTER TABLE agent_commissions ALTER COLUMN created_at SET DEFAULT '2026-08-31T12:00:00Z'::timestamptz;""")
refused('Actor-less service dispatch refuses before cache or money',"SELECT set_config('request.jwt.claim.sub','',false);SELECT fn_union_settlement_cascade(test_id(901),'2026-08-31T07:00Z','2026-09-07T07:00Z');",'captured_union_actor_required')
# Actual pre-cutover accepted hand, banked by the real rolling legacy owner.
# Only closed calendar stamps and the historical payable rows below are fixtures.
sql("CREATE TRIGGER aaa_test_funding_clock BEFORE INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION test_funding_clock();")
legacy_bank=value("SELECT set_config('test.funding_bank_at','2026-09-01T12:00:00Z',false);SELECT row_to_json(b) FROM atomic_distribute_rake(test_id(950),test_id(900),test_id(2500100),2500100,2,0,200,2,jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),NULL,'{}','WEIGHTED_CONTRIBUTED') b;")
check('Actual rolling bank owner accepts the original pre-capture hand',legacy_bank.get('error') is None and sql("SELECT commission_capture_version IS NULL FROM hand_atomic_commits WHERE hand_id=test_id(2500100);")=='t')
sql("""INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,contributing_user_id,created_at)
VALUES(test_id(900),test_id(303),.5,.25,'rake_settlement',test_id(2500100),test_id(201),'2026-09-01T12:00:00Z');
INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
VALUES(test_id(2500200),test_id(201),test_id(900),'2026-08-31','2026-09-06',11,.15,1.65,1.65,11,'pending');""")
source(2500001,'20','2026-08-31T12:00:00Z','2026-09-01T12:00:00Z')
batch=value("SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object('user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,'source_type','rake_settlement','source_id',hand_id))) FROM ca_cash_commission_facts WHERE hand_id=test_id(2500001) AND rake_credit>0;")
assert batch.get('failed')==0,batch
# Historical attribution is an explicitly simulated projection, calculated by
# the installed allocator over the actual two bank-owner rake records.
sql("""INSERT INTO ca_union_rake_attribution(rake_record_id,user_id,union_id,table_id,hand_id,played_at,club_id,rake_share)
SELECT rr.id,a.user_id,test_id(901),rr.table_id,rr.hand_id,rr.created_at,test_id(900),a.credit
FROM rake_records rr CROSS JOIN LATERAL fn_rake_shares_for_record(rr.hand_id,rr.rake_amount,rr.player_contributions,rr.rake_method) a
WHERE rr.hand_id IN(test_id(2500100),test_id(2500001));""")
outer="SELECT fn_union_settlement_cascade(test_id(901),'2026-08-31T07:00Z','2026-09-07T07:00Z');"
sql('ALTER FUNCTION fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) RENAME TO test_actual_round1;')
for label,patch in [('missing success',"actual-'success'"),('negative amount',"actual||jsonb_build_object('total_rakeback',-1)"),('fractional count',"actual||jsonb_build_object('clubs_paid',.5)"),('string success',"actual||jsonb_build_object('success','true'::text)")]:
 sql(f"CREATE OR REPLACE FUNCTION fn_union_weekly_rakeback_close(u uuid,s timestamptz,e timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $fault$ DECLARE actual jsonb; BEGIN actual:=test_actual_round1(u,s,e); RETURN {patch}; END $fault$;")
 refused('Round 1 '+label+' rolls back actual bank and treasury writes',outer,'round1_contract_violated_or_failed')
sql('DROP FUNCTION fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz);ALTER FUNCTION test_actual_round1(uuid,timestamptz,timestamptz) RENAME TO fn_union_weekly_rakeback_close;')
r=value("SELECT fn_union_settlement_cascade(test_id(901),'2026-08-31T07:00Z','2026-09-07T07:00Z');")
print('LEGACY BANK RESULT',json.dumps(legacy_bank,default=str),flush=True)
print('ROUND1 RESULT',json.dumps(r['round1_union_to_clubs'],default=str),flush=True)
print('OUTER ROUND AMOUNTS',json.dumps([r.get('round1_union_to_clubs',{}).get('total_rakeback'),r.get('round2_club_to_agents',{}).get('amount'),r.get('round3_agents_to_players',{}).get('amount')],default=str),flush=True)
check('Full original outer invokes captured payment and preserves finality hold',r['source_final'] is False and r['captured_source']['new_club_release']==18 and sql("SELECT count(*) FROM settlement_periods WHERE union_id=test_id(901);")=='0')
check('Actual mixed legacy rounds pay only historical basis',r['round1_union_to_clubs']['total_rakeback']==Decimal('1.8') and r['round2_club_to_agents']['amount']==Decimal('.5') and r['round3_agents_to_players']['amount']==Decimal('.15'))

def money_state():
 return value("SELECT jsonb_build_object('members',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM club_members x),'clubs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM clubs x),'union',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM union_wallets x),'wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM wallets x),'ledger',(SELECT count(*) FROM chip_ledger),'wallet_receipts',(SELECT count(*) FROM wallet_transactions),'treasury_receipts',(SELECT count(*) FROM chip_transactions),'bank_receipts',(SELECT count(*) FROM union_wallet_transactions),'agent_payments',(SELECT count(*) FROM ca_source_agent_cash_payments),'player_payments',(SELECT count(*) FROM ca_source_player_cash_payments),'legacy_payouts',(SELECT count(*) FROM rakeback_period_payouts));")
outer="SELECT fn_union_settlement_cascade(test_id(901),'2026-08-31T07:00Z','2026-09-07T07:00Z');"
before=money_state();replay=value(outer)
check('Whole outer replay adds no cash or money receipts',before==money_state() and replay['captured_source']['new_club_release']==0)
sql('ALTER FUNCTION fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) RENAME TO test_actual_replay_round1;')
for label,patch in [('negative total',"actual||jsonb_build_object('total_rakeback',-1)"),('fractional count',"actual||jsonb_build_object('clubs_paid',.5)"),('string total',"actual||jsonb_build_object('total_rakeback','1'::text)")]:
 sql(f"CREATE OR REPLACE FUNCTION fn_union_weekly_rakeback_close(u uuid,s timestamptz,e timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $fault$ DECLARE actual jsonb;BEGIN actual:=test_actual_replay_round1(u,s,e);RETURN {patch};END $fault$;")
 refused('Round1 real replay '+label+' refuses before summary writes',outer,'round1_contract_violated_or_failed')
sql('DROP FUNCTION fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz);ALTER FUNCTION test_actual_replay_round1(uuid,timestamptz,timestamptz) RENAME TO fn_union_weekly_rakeback_close;')
# Fresh historical payable rows allow every injected malformed return to occur
# after an actual legacy payout. These are fixture obligations, not backpay.
sql("""INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,contributing_user_id,created_at)
VALUES(test_id(900),test_id(302),.2,.10,'rake_settlement',test_id(2500100),test_id(202),'2026-09-01T12:00:00Z');
INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
VALUES(test_id(2500201),test_id(202),test_id(900),'2026-08-31','2026-09-06',11,.15,1.65,1.65,11,'pending');""")
for round_no,owner in [(2,'fn_settle_round2_club_to_agents'),(3,'fn_settle_round3_agents_to_players')]:
 signature=owner+'(uuid,timestamptz,timestamptz)'
 sql(f"ALTER FUNCTION {signature} RENAME TO test_actual_round{round_no};")
 for label,patch in [('missing amount',"actual-'amount'"),('negative amount',"actual||jsonb_build_object('amount',-1)"),('fractional count',"actual||jsonb_build_object('payees',.5)"),('missing shortfalls',"actual-'shortfalls'")]:
  # Fault injection wraps the original owner and corrupts only its response.
  # It contains no replacement money algorithm.
  sql(f"CREATE OR REPLACE FUNCTION {owner}(u uuid,s timestamptz,e timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $fault$ DECLARE actual jsonb; BEGIN actual:=test_actual_round{round_no}(u,s,e); RETURN {patch}; END $fault$;")
  refused(f'Round {round_no} {label} rolls back actual money and all public rows',outer,f'round{round_no}_contract_violated_or_failed')
 sql(f"DROP FUNCTION {signature};ALTER FUNCTION test_actual_round{round_no}(uuid,timestamptz,timestamptz) RENAME TO {owner};")
source(2500002,'20','2026-08-31T12:00:00Z','2026-09-01T12:00:00Z')
batch=value("SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object('user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,'source_type','rake_settlement','source_id',hand_id))) FROM ca_cash_commission_facts WHERE hand_id=test_id(2500002) AND rake_credit>0;")
assert batch.get('failed')==0,batch
# Invoke the real complete dispatcher, then inject an unsupported close claim.
# Its completed actual money writes must roll back before any partial/final return.
sql('ALTER FUNCTION fn_ca_dispatch_union_captured_funding(uuid,timestamptz,date,uuid[]) RENAME TO test_actual_captured_dispatch;')
sql("""CREATE FUNCTION fn_ca_dispatch_union_captured_funding(u uuid,b timestamptz,e date,c uuid[]) RETURNS jsonb LANGUAGE plpgsql AS $fault$
DECLARE actual jsonb;BEGIN actual:=test_actual_captured_dispatch(u,b,e,c);RETURN actual||jsonb_build_object('common_finality',true);END $fault$;
REVOKE ALL ON FUNCTION fn_ca_dispatch_union_captured_funding(uuid,timestamptz,date,uuid[]) FROM PUBLIC,anon,authenticated,service_role;""")
refused('Unsupported common finality rolls back actual helper payments and all legacy rounds',outer,'unsupported_common_finality_claim')
sql('DROP FUNCTION fn_ca_dispatch_union_captured_funding(uuid,timestamptz,date,uuid[]);ALTER FUNCTION test_actual_captured_dispatch(uuid,timestamptz,date,uuid[]) RENAME TO fn_ca_dispatch_union_captured_funding;')
sql("CREATE FUNCTION test_fail_outer_player_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected outer final player receipt';END$$; CREATE TRIGGER zzz_outer_player_fault BEFORE INSERT ON ca_source_player_cash_payments FOR EACH ROW EXECUTE FUNCTION test_fail_outer_player_receipt();")
refused('Last captured receipt failure rolls back legacy rounds and all captured money',outer,'injected outer final player receipt')
sql('DROP TRIGGER zzz_outer_player_fault ON ca_source_player_cash_payments;')
retry=value(outer)
check('Whole dispatch retry pays historical and captured amounts exactly once',retry['round2_club_to_agents']['amount']==Decimal('.2') and retry['round3_agents_to_players']['amount']==Decimal('.15') and retry['captured_source']['new_club_release']==18 and retry['captured_source']['new_agent_payout']==14 and retry['captured_source']['new_player_payout']==3)
check('All captured legacy projections remain unsettled and excluded',sql("SELECT bool_and(settled_at IS NULL AND commission_capture_version=1) FROM agent_commissions WHERE source_id IN(test_id(2500001),test_id(2500002));")=='t')
check('Paid legacy periods share one exact wallet receipt per beneficiary',sql("SELECT count(*)=2 AND bool_and(p.wallet_transaction_id=w.id AND p.payout_amount=w.amount AND p.user_id=w.user_id AND rp.status='paid') FROM rakeback_period_payouts p JOIN wallet_transactions w ON w.related_entity_id=p.id JOIN rakeback_periods rp ON rp.id=p.rakeback_period_id;")=='t')
before=money_state();replay=value(outer);check('Final replay has no second payouts or money receipts',before==money_state() and replay['source_final'] is False and sql("SELECT count(*) FROM settlement_periods WHERE union_id=test_id(901);")=='0')
# The archived body is the exact original bank algorithm under a test name.
# Its real record/leg triggers remain enabled, including deferred receipt checks.
old_bank=Path(os.environ['ROUND1_INPUT'])/'source-authority/bank-owner/actual-bank-owner.sql'
body=old_bank.read_text().replace('FUNCTION public.atomic_distribute_rake(', 'FUNCTION public.test_original_bank(',1)
load_text=body[:body.rfind('$function$')+len('$function$')]+';'
sql(load_text)
sql("SELECT set_config('test.funding_accepted_at','2026-08-25T12:00:00Z',false);SELECT test_owner_amount(2500003,20);")
q="""BEGIN;SELECT set_config('request.jwt.claim.sub',test_id(100)::text,false);SELECT set_config('test.funding_bank_at','2026-08-25T12:00:00Z',false);
SELECT row_to_json(b) FROM test_original_bank(test_id(950),test_id(900),test_id(2500003),2500003,20,0,200,2,jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),NULL,'{}','WEIGHTED_CONTRIBUTED') b;
SELECT jsonb_build_object('provisional_round1',fn_union_weekly_rakeback_close(test_id(901),'2026-08-24T07:00Z','2026-08-31T07:00Z'));COMMIT;"""
before=state();run=subprocess.run([os.environ['COMMISSION_PSQL'],'-X','-qAt','-v','ON_ERROR_STOP=1','-c',q],capture_output=True,text=True)
check('Old bank and direct Round1 cannot commit a captured credit without its exact bank receipt',run.returncode!=0 and 'Captured cash bank receipt is missing or conflicts with credited source' in run.stderr and before==state())
provisional=[json.loads(line) for line in run.stdout.splitlines() if line.startswith('{') and 'provisional_round1' in line]
check('Direct Round1 provisional retained income is fully rolled back by the actual bank barrier',len(provisional)==1 and provisional[0]['provisional_round1']['union_retained']==20 and sql("SELECT count(*) FROM union_wallet_transactions WHERE union_id=test_id(901) AND created_at>='2026-08-24T07:00Z' AND created_at<'2026-08-31T07:00Z';")=='0')
(here/'outer-native-proof.json').write_text(json.dumps({'checks':checks,'passing':len(checks),'production_applied':False,'source_commit':'d5300be77e19d08b887b3b851946c5c244b77ad9','payer_commit':'f39368fefe22b4385e9e89e5350bb671c587fb4a','first_result':r,'retry_result':retry,'source_sha256':{n:hashlib.sha256((here/n).read_bytes()).hexdigest() for n in ['01-source-dispatch.sql','02-outer-cascade.sql','outer-native-probe.py','prepare-outer-fixture.py','run-local.sh','installed-period-finalizer.sql']},'limits':['Historical commission and player payable rows plus attribution projections are explicit fixture inputs; accepted and bank owners are actual.','No complete producer, bank, fractional liability or common period finality is claimed.','No production activation or present-live owner hash equivalence is claimed.']},indent=2,default=str)+'\n')
