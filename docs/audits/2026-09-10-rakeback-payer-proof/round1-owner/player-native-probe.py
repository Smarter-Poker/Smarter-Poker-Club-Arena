#!/usr/bin/env python3
"""Actual source/bank/money composition; historical timestamps are fixture-only."""
import os,sys,json,hashlib,time,subprocess
from pathlib import Path
from decimal import Decimal
sys.path.insert(0,os.environ['ROUND1_HERE'])
from fixture_helpers import sql,setup,source,admit,pool,release,state,psql
here=Path(__file__).resolve().parent
checks=[]
def check(name,predicate):
 assert predicate,name
 checks.append(name);print('PASS: '+name,flush=True)
def refused(name,query,expected=None,actor=100):
 before=state();err=sql(query,False,actor)
 if expected: assert expected in err,err
 check(name,before==state())
def value(q): return json.loads(sql(q),parse_float=Decimal)
def pay(p,user=303,cutoff='2026-09-07'):
 return value(f"SELECT fn_pay_captured_agent_funding('{p}',test_id({user}),'{cutoff}');")
def batch(n):
 r=value(f"""SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object(
 'user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,'source_type','rake_settlement','source_id',hand_id)))
 FROM ca_cash_commission_facts WHERE hand_id=test_id({n}) AND rake_credit>0;""")
 assert r.get('failed')==0,r
def small(n,rake,accepted,bank):
 settings=f"SELECT set_config('test.funding_accepted_at','{accepted}',false);SELECT set_config('test.funding_bank_at','{bank}',false);"
 sql(settings+f"SELECT test_owner_small({n},{rake});")
 sql(settings+f"""SELECT row_to_json(b) FROM atomic_distribute_rake(test_id(950),test_id(900),test_id({n}),{n},{rake},0,2,2,
 jsonb_build_object(test_id(201)::text,1,test_id(202)::text,1),NULL,'{{}}','WEIGHTED_CONTRIBUTED') b;""")
 batch(n);admit(n)
def amounts(p):
 return value(f"""SELECT jsonb_build_object('club',(SELECT chip_treasury FROM clubs WHERE id=test_id(900)),
 'agent',(SELECT chip_balance FROM club_members WHERE club_id=test_id(900) AND user_id=test_id(303)),
 'released',(SELECT coalesce(sum(amount),0) FROM ca_source_club_cash_releases WHERE pool_id='{p}'),
 'paid',(SELECT coalesce(sum(amount),0) FROM ca_source_agent_cash_payments WHERE pool_id='{p}' AND recipient_id=test_id(303)));""")
setup()
sql((Path(os.environ['ROUND1_INPUT'])/'capacity-owner/04-agent-payment.sql').read_text())
sql((here.parent/'player-capacity-proposal.sql').read_text())
# This local request builder varies synthetic input sizes; actual accepted and bank bodies remain unchanged.
body=sql("SELECT pg_get_functiondef('test_owner_amount(bigint,numeric)'::regprocedure);")
for old,new in [('test_owner_amount(', 'test_owner_small('),('100-p_rake','1-p_rake'),
 ('ELSE -100','ELSE -1'),("'pot_size',200","'pot_size',2"),("'pot',200","'pot',2"),
 ("'amount',200-p_rake","'amount',2-p_rake"),("'wagered',100","'wagered',1"),
 ("::text,100","::text,1")]:
 assert old in body,old
 body=body.replace(old,new)
sql(body)
source(1400001,'2');batch(1400001);admit(1400001)
current_bank=sql('SELECT fn_union_week_start(clock_timestamp());')
current_earning=sql("SELECT date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date;")
def player(p,user=201,payer=303,cutoff='2026-09-07'):
 return value(f"SELECT fn_pay_captured_player_funding('{p}',test_id({user}),test_id({payer}),'{cutoff}');")
direct=pool(1400001);release(direct,current_bank,1400101);pay(direct,303,current_earning)
r=player(direct,201,303,current_earning)
check('Actual current-time sources cannot create closed player funding admission',r['new_payout']==0 and r['exact_entitlement']==0)
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Player Funding Union',test_id(100),'player-funding-union'),
(test_id(902),'Other Player Union',test_id(100),'other-player-union');
INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);
UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);
UPDATE agents SET commission_rate=.25,player_rakeback_rate=.15 WHERE id=test_id(103);
UPDATE club_members SET player_rakeback_pct=.15 WHERE club_id=test_id(900) AND user_id IN(test_id(201),test_id(202));""")
zero_agent_progress=False
for i in range(100):
 small(1400200+i,'.01','2026-08-24T12:00:00Z' if i<50 else '2026-08-31T12:00:00Z',
       '2026-08-30T12:00:00Z' if i<50 else '2026-09-01T12:00:00Z')
 u=pool(1400200+i)
 release(u,'2026-09-07T07:00:00Z',1401000+i)
 a=pay(u)
 r=player(u)
 if a['new_payout']==0 and r['new_payout']>0: zero_agent_progress=True
 assert r['paid']<=r['exact_entitlement']
check('100 sequential one-cent sources at15percent pay .15 from actual funded agent allocation',r['paid']==Decimal('.15') and r['exact_entitlement']==Decimal('.15'))
check('New player source progresses using existing pooled agent cash when Round2 adds zero cash',zero_agent_progress)
check('Cross-week exact player slices sum to whole-cent actual receipts',value(f"""SELECT jsonb_build_object(
 'cash',(SELECT sum(amount) FROM ca_source_player_cash_payments WHERE pool_id='{u}'),
 'slices',(SELECT sum(s.amount) FROM ca_source_player_payment_slices s JOIN ca_source_player_cash_payments p ON p.id=s.payment_id WHERE p.pool_id='{u}'),
 'weeks',(SELECT count(DISTINCT a.earning_week) FROM ca_source_player_payment_slices s JOIN ca_source_player_funding_admissions a USING(hand_id,player_id)));""")=={'cash':Decimal('.15'),'slices':Decimal('.15'),'weeks':2})
before=state();r=player(u)
check('Repeated player owner call has no extra cash or public-row mutation',r['new_payout']==0 and before==state())
# One actual transaction must roll back all three funding rounds on final player receipt failure.
small(1400400,'.14','2026-08-31T13:00:00Z','2026-09-01T13:00:00Z')
sql("""CREATE FUNCTION test_fail_player_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected final player receipt';END$$;
CREATE TRIGGER zzz_test_fail_player_receipt BEFORE INSERT ON ca_source_player_cash_payments FOR EACH ROW EXECUTE FUNCTION test_fail_player_receipt();""")
refused('Final player receipt failure rolls back actual Round1 Round2 and player money plus every public row',
 f"BEGIN;SELECT fn_release_captured_club_funding('{u}','2026-09-07T07:00:00Z',test_id(1401400),test_id(100));SELECT fn_pay_captured_agent_funding('{u}',test_id(303),'2026-09-07');SELECT fn_pay_captured_player_funding('{u}',test_id(201),test_id(303),'2026-09-07');COMMIT;",'injected final player receipt')
sql('DROP TRIGGER zzz_test_fail_player_receipt ON ca_source_player_cash_payments;')
release(u,'2026-09-07T07:00:00Z',1401400);pay(u)
# Suppress the payer update in the actual target table. No NULL arithmetic can count it as money.
sql("""CREATE FUNCTION test_skip_player_payer() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;
CREATE TRIGGER zzz_test_skip_player_payer BEFORE UPDATE ON club_members FOR EACH ROW WHEN(OLD.user_id='00000000-0000-4000-8000-000000000303') EXECUTE FUNCTION test_skip_player_payer();""")
refused('Suppressed payer debit refuses and restores every public row',f"SELECT fn_pay_captured_player_funding('{u}',test_id(201),test_id(303),'2026-09-07');",'update_missing')
sql('DROP TRIGGER zzz_test_skip_player_payer ON club_members;')
r=player(u)
check('Failed player payment retries its remaining immutable entitlement once',r['new_payout']==Decimal('.01'))
refused('Actual player debit wallet receipt cannot change under maintenance',
 "SET app.maintenance_mode='on';UPDATE wallet_transactions SET related_entity_id=test_id(1) WHERE id=(SELECT debit_transaction_id FROM ca_source_player_cash_payments LIMIT 1);",'immutable')
refused('Actual player credit wallet receipt cannot change under maintenance',
 "SET app.maintenance_mode='on';UPDATE wallet_transactions SET balance_after=balance_after+1 WHERE id=(SELECT credit_transaction_id FROM ca_source_player_cash_payments LIMIT 1);",'immutable')
# Historical owed source keeps its captured payer even when current assignment/role changes.
small(1400401,'.14','2026-08-31T14:00:00Z','2026-09-01T14:00:00Z')
release(u,'2026-09-07T07:00:00Z',1401401);pay(u)
sql("""UPDATE agents SET status='suspended' WHERE id=test_id(103);
UPDATE club_members SET agent_id=test_id(302),status='suspended',is_active=false WHERE club_id=test_id(900) AND user_id=test_id(201);""")
r=player(u)
check('Captured payer remains liable after beneficiary departure and agent deactivation',r['new_payout']==Decimal('.01'))
sql("""UPDATE agents SET status='active' WHERE id=test_id(103);
UPDATE club_members SET agent_id=test_id(303),status='active',is_active=true WHERE club_id=test_id(900) AND user_id=test_id(201);
UPDATE union_clubs SET union_id=test_id(902) WHERE union_id=test_id(901) AND club_id=test_id(900);
UPDATE tables SET union_id=test_id(902) WHERE id=test_id(950);""")
small(1400402,'.10','2026-08-31T15:00:00Z','2026-09-01T15:00:00Z');other=pool(1400402)
r=player(other)
check('Positive payer wallet and another Union cash cannot replace source-matched funding',r['new_payout']==0 and sql("SELECT chip_balance>0 FROM club_members WHERE club_id=test_id(900) AND user_id=test_id(303);")=='t')
release(other,'2026-09-07T07:00:00Z',1401402);pay(other)
r=player(other)
check('First isolated Union source retains fractional player liability',r['new_payout']==0 and r['exact_entitlement']==Decimal('.0075'))
# Each player received half the .10 source, hence .0075 remains fractional; another source completes it.
small(1400403,'.10','2026-08-31T15:00:01Z','2026-09-01T15:00:01Z');release(other,'2026-09-07T07:00:00Z',1401403);pay(other);r=player(other)
check('Compatible late source completes pending player fraction without another Union pool',r['new_payout']==Decimal('.01') and sql(f"SELECT bool_and(l.union_id=test_id(902)) FROM ca_source_player_cash_payments p JOIN chip_ledger l ON l.id=p.ledger_id WHERE p.pool_id='{other}';")=='t')
check('All actual player cash and source capacity assertions pass',
 sql("DO $$DECLARE r record;BEGIN FOR r IN SELECT id FROM ca_source_player_cash_payments LOOP PERFORM fn_ca_assert_source_player_payment(r.id);END LOOP;END$$;")=='')
receipt={'status':'native_player_capacity_candidate_checkpoint','checks':checks,'runtime':sql('SELECT version();'),
 'temporal_scope':'Current actual source proves open refusal; closed periods are fixture-only synthetic timestamp stamps, with unchanged actual accepted/bank and financial functions.',
 'remaining':['Real version2 getter and UUID claim wrapper','Legacy funding/claim exclusion and actual outer cascade cutover','Common final producer/funding close witness','Composed browser release'],
 'inputs':{str(f.relative_to(here.parent)):hashlib.sha256(f.read_bytes()).hexdigest() for f in [here/'player-native-probe.py',here.parent/'player-capacity-proposal.sql',here/'01-release-writer.sql',here/'fixture_helpers.py',here/'fixture-clock.sql',here/'vendor/capacity-owner/04-agent-payment.sql']}}
(here/'player-native-proof.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'passed':len(checks)}),flush=True)
