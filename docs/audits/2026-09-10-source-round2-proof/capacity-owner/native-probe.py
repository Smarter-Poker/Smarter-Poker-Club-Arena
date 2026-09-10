#!/usr/bin/env python3
"""Actual source/bank/money composition; historical timestamps are fixture-only."""
import os,sys,json,hashlib,time,subprocess
from pathlib import Path
from decimal import Decimal
sys.path.insert(0,os.environ['ROUND1_HERE'])
from fixture_helpers import sql,setup,source,admit,pool,release,state,psql
here=Path(__file__).resolve().parent
checks=[]
started_at=time.monotonic()
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
def release(p,cutoff,request):
 return value(f"SELECT fn_release_captured_club_funding('{p}','{cutoff}',test_id({request}),test_id(100));")
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
sql((here/'04-agent-payment.sql').read_text())
# This local request builder varies synthetic input sizes; actual accepted and bank bodies remain unchanged.
body=sql("SELECT pg_get_functiondef('test_owner_amount(bigint,numeric)'::regprocedure);")
for old,new in [('test_owner_amount(', 'test_owner_small('),('100-p_rake','1-p_rake'),
 ('ELSE -100','ELSE -1'),("'pot_size',200","'pot_size',2"),("'pot',200","'pot',2"),
 ("'amount',200-p_rake","'amount',2-p_rake"),("'wagered',100","'wagered',1"),
 ("::text,100","::text,1")]:
 assert old in body,old
 body=body.replace(old,new)
sql(body)
source(1300001,'2');batch(1300001);admit(1300001);direct=pool(1300001)
current_bank=sql('SELECT fn_union_week_start(clock_timestamp());')
current_earning=sql("SELECT date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date;")
r=release(direct,current_bank,1300101)
p=pay(direct,303,current_earning)
check('Actual current accepted and bank emissions refuse closed-period release and recipient admission',
 r['new_release']==0 and p['new_payout']==0 and sql('SELECT count(*) FROM ca_source_recipient_funding_admissions;')=='0')
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Capacity Union',test_id(100),'capacity-union'),
(test_id(902),'Other Capacity Union',test_id(100),'other-capacity-union');
INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);
UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);
UPDATE agents SET commission_rate=.25,player_rakeback_rate=.15 WHERE id=test_id(103);
UPDATE club_members SET player_rakeback_pct=.15 WHERE club_id=test_id(900) AND user_id IN(test_id(201),test_id(202));""")
# First source has a real applied receipt and positive actual treasury, but no admitted/released capacity.
small(1300002,'.04','2026-08-24T12:00:00Z','2026-08-30T12:00:00Z')
u=pool(1300002)
r=pay(u)
check('Positive treasury and applied source cannot replace club funding admission',r['new_payout']==0 and r['exact_entitlement']==0)
release(u,'2026-08-31T07:00:00Z',1300102)
before=amounts(u);r=pay(u);after=amounts(u)
check('Actual Round1 release funds exact captured Round2 allocation wallet once',
 r['new_payout']==Decimal('.01') and before['club']-after['club']==Decimal('.01') and after['agent']-before['agent']==Decimal('.01'))
before=state();r=pay(u)
check('Different requestless owner retry has no extra payment or public-row mutation',r['new_payout']==0 and state()==before)
# Both earning and bank windows vary, while original Union/club/route/generation stay compatible.
for i in range(100):
 small(1300200+i,'.01','2026-08-24T12:00:00Z' if i<50 else '2026-08-31T12:00:00Z',
       '2026-08-30T12:00:00Z' if i<50 else '2026-09-01T12:00:00Z')
 release(u,'2026-09-07T07:00:00Z',1301000+i)
 result=pay(u)
 assert result['paid']<=result['exact_entitlement']
 assert sql(f"SELECT coalesce(sum(c.amount),0)<=(SELECT coalesce(sum(amount),0) FROM ca_source_club_cash_releases WHERE pool_id='{u}') FROM ca_source_club_cash_consumptions c JOIN ca_source_club_cash_releases r ON r.id=c.release_id WHERE r.pool_id='{u}';")=='t'
check('100 sequential penny sources carry .25 captured direct entitlement across earning and bank weeks',
 amounts(u)['paid']==Decimal('.26'))
report=value(f"SELECT fn_captured_agent_funding_report('{u}',test_id(303));")
check('Fractional weekly attribution sums exactly to aggregate wallet cash without independent rounding',
 sum(x['cash_attributed'] for x in report['weekly_attribution'])==report['cash_paid']==Decimal('.26')
 and len(report['weekly_attribution'])==2)
# A captured hierarchy above its own club right remains ineligible even when this pool has other money.
sql("UPDATE union_clubs SET rate_cash=.60 WHERE union_id=test_id(901) AND club_id=test_id(900);")
small(1300400,'.10','2026-08-31T12:00:00Z','2026-09-01T12:00:00Z')
r=release(u,'2026-09-07T07:00:00Z',1301400);before=amounts(u);p=pay(u)
check('Valid club right releases while overpromised hierarchy cannot borrow other source capacity',
 r['new_release']==Decimal('.06') and p['new_payout']==0
 and sql("SELECT count(*) FROM ca_source_recipient_accruals WHERE hand_id=test_id(1300400);")=='0'
 and sql("SELECT bool_and(contract_state='overpromised') FROM ca_source_funding_lots WHERE hand_id=test_id(1300400);")=='t')
sql("UPDATE union_clubs SET rate_cash=.90 WHERE union_id=test_id(901) AND club_id=test_id(900);")
small(1300401,'.04','2026-08-24T13:00:00Z','2026-08-30T13:00:00Z')
r=release(u,'2026-08-31T07:00:00Z',1301401);p=pay(u,303,'2026-08-31')
check('Late older source adds only its delta while preserving prior admitted newer weeks',
 p['new_payout']==Decimal('.01') and p['paid']==Decimal('.27'))
# Missing allocation wallet defers while preserving immutable source liability.
small(1300403,'.04','2026-08-31T13:00:00Z','2026-09-01T13:00:00Z')
release(u,'2026-09-07T07:00:00Z',1301403)
sql("UPDATE agents SET status='suspended' WHERE id=test_id(103);UPDATE club_members SET status='suspended',is_active=false WHERE club_id=test_id(900) AND user_id=test_id(303);")
p=pay(u)
check('Captured historical recipient is paid after current agent and membership deactivation',p['new_payout']>=Decimal('.01'))
sql("UPDATE agents SET status='active' WHERE id=test_id(103);UPDATE club_members SET status='active',is_active=true WHERE club_id=test_id(900) AND user_id=test_id(303);")
# Preserve original source scope after the club moves and table switches routes.
sql("UPDATE union_clubs SET union_id=test_id(902) WHERE union_id=test_id(901) AND club_id=test_id(900);UPDATE tables SET union_id=test_id(902) WHERE id=test_id(950);")
small(1300404,'.04','2026-08-31T14:00:00Z','2026-09-01T14:00:00Z')
other=pool(1300404)
p=pay(other)
check('Other original Union cannot consume the first Union pool cash',other!=u and p['new_payout']==0)
release(other,'2026-09-07T07:00:00Z',1301404)
p=pay(other)
check('Original Union identity is preserved on actual Round2 payment ledger after club moves',
 p['new_payout']==Decimal('.01') and sql(f"SELECT bool_and(l.union_id=test_id(902)) FROM ca_source_agent_cash_payments p JOIN chip_ledger l ON l.id=p.ledger_id WHERE p.pool_id='{other}';")=='t')
# Force the last immutable recipient payment to fail after real club and wallet changes.
small(1300405,'.04','2026-08-31T15:00:00Z','2026-09-01T15:00:00Z')
sql("""CREATE FUNCTION test_fail_capacity_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected final capacity payment';END$$;
CREATE TRIGGER zzz_test_fail_capacity_receipt BEFORE INSERT ON ca_source_agent_cash_payments FOR EACH ROW EXECUTE FUNCTION test_fail_capacity_receipt();""")
refused('Actual Round1 and Round2 transaction rolls back every public row on final payment receipt failure',
 f"BEGIN;SELECT fn_release_captured_club_funding('{other}','2026-09-07T07:00:00Z',test_id(1301405),test_id(100));SELECT fn_pay_captured_agent_funding('{other}',test_id(303),'2026-09-07');COMMIT;",'injected final capacity')
sql('DROP TRIGGER zzz_test_fail_capacity_receipt ON ca_source_agent_cash_payments;')
release(other,'2026-09-07T07:00:00Z',1301405)
# A BEFORE trigger suppressing the actual member update must restore treasury and all support writes.
sql("""CREATE FUNCTION test_skip_capacity_member() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;
CREATE TRIGGER zzz_test_skip_capacity_member BEFORE UPDATE ON club_members FOR EACH ROW WHEN(OLD.user_id='00000000-0000-4000-8000-000000000303') EXECUTE FUNCTION test_skip_capacity_member();""")
refused('Suppressed actual recipient update refuses with NULL-safe all-public-row rollback',
 f"SELECT fn_pay_captured_agent_funding('{other}',test_id(303),'2026-09-07');",'did not conserve')
sql('DROP TRIGGER zzz_test_skip_capacity_member ON club_members;')

sql("""CREATE FUNCTION test_bad_capacity_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.idempotency_key LIKE 'captured-agent:%' THEN
 IF current_setting('test.bad_capacity_ledger',true)='status' THEN NEW.status:='pending';ELSE NEW.post_from_balance:=NULL;END IF;
 END IF;RETURN NEW;END$$;
CREATE TRIGGER zzz_test_bad_capacity_ledger BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION test_bad_capacity_ledger();""")
refused('Unposted actual Round2 ledger cannot certify payment and rolls back all public rows',
 f"SELECT set_config('test.bad_capacity_ledger','status',false);SELECT fn_pay_captured_agent_funding('{other}',test_id(303),'2026-09-07');")
refused('NULL actual Round2 balance witness cannot certify payment and rolls back all public rows',
 f"SELECT set_config('test.bad_capacity_ledger','balance',false);SELECT fn_pay_captured_agent_funding('{other}',test_id(303),'2026-09-07');")
sql('DROP TRIGGER zzz_test_bad_capacity_ledger ON chip_ledger;')

pay(other)
refused('Linked actual wallet transaction cannot change under maintenance',
 "SET app.maintenance_mode='on';UPDATE wallet_transactions SET related_entity_id=test_id(1) WHERE id=(SELECT wallet_transaction_id FROM ca_source_agent_cash_payments LIMIT 1);",'immutable')
refused('Linked actual treasury transaction cannot change under maintenance',
 "SET app.maintenance_mode='on';UPDATE chip_transactions SET metadata='{}' WHERE id=(SELECT treasury_transaction_id FROM ca_source_agent_cash_payments LIMIT 1);",'immutable')
# Request result is exact and account-bound; no repeated economic effect.
claim=f"SELECT fn_claim_captured_agent_funding(test_id(900),test_id(303),test_id(1301500),'2026-09-07');"
first=sql(claim,actor=303);before=state();again=sql(claim,actor=303)
check('Browser request exact replay is byte-equivalent and leaves all public rows unchanged',first==again and before==state())
refused('Browser request rejects account switching before request admission',
 "SELECT fn_claim_captured_agent_funding(test_id(900),test_id(303),test_id(1301500),'2026-09-07');",'account_changed',actor=302)
refused('Exact UUID cannot be repurposed with another closed cutoff',
 "SELECT fn_claim_captured_agent_funding(test_id(900),test_id(303),test_id(1301500),'2026-08-31');",'scope_conflict',actor=303)

def concurrent_pair(name,queries):
 holder=subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 holder.stdin.write("SET application_name='capacity-holder';BEGIN;SELECT fn_lock_rakeback_payer_clubs(ARRAY[test_id(900)]);\n");holder.stdin.flush()
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='capacity-holder' AND state='idle in transaction';")=='1':break
  time.sleep(.02)
 else: raise AssertionError('Holder never acquired shared admission')
 workers=[]
 for i,q in enumerate(queries):
  tag=f'capacity-race-{i}'
  stmt=f"SET application_name='{tag}';SELECT set_config('request.jwt.claim.sub',test_id(303)::text,false);"+q
  workers.append(subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',stmt],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True))
 deadline=time.monotonic()+10;observed=False
 while time.monotonic()<deadline:
  count=sql("""SELECT count(*) FROM pg_stat_activity a WHERE a.application_name IN('capacity-race-0','capacity-race-1')
   AND a.wait_event_type='Lock' AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND NOT l.granted)
   AND EXISTS(SELECT 1 FROM pg_stat_activity h WHERE h.application_name='capacity-holder' AND h.pid=ANY(pg_blocking_pids(a.pid)));""")
  if count=='2':observed=True;break
  time.sleep(.02)
 holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.communicate(timeout=10)
 results=[]
 for w in workers:
  out,err=w.communicate(timeout=30)
  assert w.returncode==0,err
  results.append(out.strip().splitlines()[-1])
 check(name+' observes both callers blocked on actual shared club admission',observed)
 return results

small(1300406,'.04','2026-08-31T16:00:00Z','2026-09-01T16:00:00Z')
release(other,'2026-09-07T07:00:00Z',1301406)
before=amounts(other)
q="SELECT fn_claim_captured_agent_funding(test_id(900),test_id(303),test_id(1301501),'2026-09-07');"
race=concurrent_pair('Same UUID claim race',[q,q])
check('Same UUID concurrent claims return exact result and move one funded cent',
 race[0]==race[1] and amounts(other)['paid']-before['paid']==Decimal('.01')
 and sql('SELECT count(*) FROM ca_source_agent_funding_requests WHERE request_id=test_id(1301501);')=='1')
small(1300407,'.04','2026-08-31T17:00:00Z','2026-09-01T17:00:00Z')
release(other,'2026-09-07T07:00:00Z',1301407)
before=amounts(other)
race=concurrent_pair('Claim versus service owner race',[
 "SELECT fn_claim_captured_agent_funding(test_id(900),test_id(303),test_id(1301502),'2026-09-07');",
 f"SELECT fn_pay_captured_agent_funding('{other}',test_id(303),'2026-09-07');"])
check('Different claim/service calls consume one cash cent and one exact liability delta',
 amounts(other)['paid']-before['paid']==Decimal('.01')
 and sum(Decimal(str(json.loads(x).get('amount',json.loads(x).get('new_payout',0)))) for x in race)==Decimal('.01'))


refused('Non-finite closed earning boundaries refuse before admission',
 f"SELECT fn_pay_captured_agent_funding('{other}',test_id(303),'-infinity'::date);",'Invalid closed earning')
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(903),'Unfunded Capacity Union',test_id(100),'unfunded-capacity-union');
UPDATE union_clubs SET union_id=test_id(903) WHERE union_id=test_id(902) AND club_id=test_id(900);
UPDATE tables SET union_id=test_id(903) WHERE id=test_id(950);""")
small(1300408,'.04','2026-08-31T18:00:00Z','2026-09-01T18:00:00Z')
unfunded=pool(1300408)
# Synthetic insufficiency setup uses the actual Union update and its enabled journal triggers.
sql("UPDATE union_wallets SET rake_wallet=0 WHERE union_id=test_id(903);")
release(unfunded,'2026-09-07T07:00:00Z',1301408)
before=amounts(unfunded);p=pay(unfunded)
check('Admitted positive recipient liability defers without real released capacity despite a positive club wallet',
 p['exact_entitlement']==Decimal('.01') and p['new_payout']==0 and p['cash_due']==Decimal('.01')
 and p['deferred']=='released_capacity_short' and amounts(unfunded)['agent']==before['agent'])

check('Financial evidence tables reject direct authenticated and service writes',
 sql("SELECT bool_and(NOT has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'ca_source_%';")=='t')
check('Full admitted source and actual payment assertions all pass',
 sql("DO $$DECLARE r record;BEGIN FOR r IN SELECT id FROM ca_source_agent_cash_payments LOOP PERFORM fn_ca_assert_source_agent_payment(r.id);END LOOP;FOR r IN SELECT id FROM ca_source_club_cash_releases LOOP PERFORM fn_ca_assert_source_club_release(r.id);END LOOP;END$$;")=='')
receipt={'status':'native_capacity_candidate_checkpoint','checks':checks,
'temporal_scope':'Actual current accepted/bank emission proves open refusal. Closed history is synthetic fixture-only INSERT timestamp stamping; actual money owners and constraints are unchanged.',
'limitations':['No production activation','Legacy Round1/Round2/direct-claim exclusion not activated','Player bridge and actual outer Union cascade not certified by this probe','Common source-final close remains a release gate'],
'runtime':sql('SELECT version();'),'elapsed_seconds':round(time.monotonic()-started_at,6),
'inputs':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(here.glob('*.sql'))+sorted(here.glob('*.json'))+sorted(here.glob('*.py'))+sorted(here.glob('*.sh')) if f.name!='native-proof.json'}}
receipt['fixture_inputs']={str(f.relative_to(Path(os.environ['ROUND1_INPUT']))):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(Path(os.environ['ROUND1_INPUT']).rglob('*')) if f.is_file() and f.suffix in ('.sql','.py','.json')}
(here/'native-proof.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'passed':len(checks)}),flush=True)
