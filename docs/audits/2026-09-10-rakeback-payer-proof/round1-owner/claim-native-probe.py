#!/usr/bin/env python3
"""Actual funded player API composition; capability witness is explicitly synthetic."""
import os,runpy,json,time,subprocess,hashlib
from pathlib import Path
from decimal import Decimal
here=Path(__file__).resolve().parent
base=runpy.run_path(str(here/'player-native-probe.py'))
for k in ['sql','source','batch','small','admit','pool','release','psql','value','state','player','pay']:
 globals()[k]=base[k]
base_checks=base['checks'];checks=[]
def check(n,p):
 assert p,n
 checks.append(n);print('PASS API: '+n,flush=True)
def refused(n,s,expected=None,actor=201):
 before=state();err=sql(s,False,actor)
 if expected: assert expected in err,err
 check(n,before==state())
read_dir=here/'read-v2'
legacy=json.loads((read_dir/'legacy-owner-catalog.json').read_text())
sql('SET check_function_bodies=off;\n'+'\n'.join(x['definition']+';' for x in legacy)+'\nSET check_function_bodies=on;')
sql((here.parent/'player-payment-dto.sql').read_text())
sql((read_dir/'01-capability.sql').read_text())
sql((read_dir/'02-getter.sql').read_text())
sql((here.parent/'player-claim-wrapper.sql').read_text())
read=lambda: json.loads(sql('SELECT fn_get_captured_rakeback(NULL);',actor=201),parse_float=Decimal)
claim=lambda n: sql(f'SELECT fn_claim_captured_rakeback(test_id({n}),test_id(201),NULL);',actor=201)
inactive=read()
check('Real getter is inactive and empty without a coordinated witness',inactive['source_active'] is False and inactive['balances']==[] and inactive['pending_amount']=='0.00')
refused('New real claim refuses absent release capability', 'SELECT fn_claim_captured_rakeback(test_id(1500001),test_id(201),NULL);','not_active')
counter=1599999
def activate():
 global counter
 sql((read_dir/'synthetic-capability.sql').read_text().replace('test_id(1599999)',f'test_id({counter})'))
 counter+=1
activate()
r=read()
check('Real funded getter separates exact cross-week entitlement and whole-cent payments',
 r['schema_version']==2 and r['source_active'] and Decimal(r['paid_amount'])==sum(Decimal(x['amount']) for x in r['cash_payments'])
 and Decimal(r['consumed_exact'])==Decimal(r['paid_amount'])
 and Decimal(r['unpaid_exact'])==Decimal(r['closed_entitlement_exact'])-Decimal(r['consumed_exact']))
check('Every real payment DTO reconciles exact earning slices and preserves UTC microseconds',
 all(sum(Decimal(s['amount_exact']) for s in p['earning_slices'])==Decimal(p['amount']) and p['paid_at'].endswith('Z') and len(p['paid_at'].split('.')[-1])==7 for p in r['cash_payments']))
# Create a valid accepted source for a new original Union without banking it.
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(903),'Unbanked API Union',test_id(100),'unbanked-api-union');
UPDATE union_clubs SET union_id=test_id(903) WHERE union_id=test_id(902) AND club_id=test_id(900);
UPDATE tables SET union_id=test_id(903) WHERE id=test_id(950);
SELECT set_config('test.funding_accepted_at','2026-08-31T16:00:00Z',false);
SELECT test_owner_small(1500100,.14);""")
r=read();unbanked=next(x for x in r['balances'] if (x['scope']['funding_union_id'] or '').endswith('000000000903'))
check('Accepted prebank liability stays visible with stable original scope and no fabricated pool UUID',
 unbanked['pool_id'] is None and unbanked['closed_entitlement_exact']=='0.0105' and unbanked['pending_amount']=='0.01')
zero=claim(1500200);z=json.loads(zero)
check('Authoritative unfunded attempt has zero cash and explicit per-scope deferral',
 z['new_payout']=='0.00' and z['payments']==[] and any(x['deferred'] for x in z['scopes']))
# Bank this same immutable source, fund R1/R2, then recover the original zero attempt.
sql("""SELECT set_config('test.funding_bank_at','2026-09-01T16:00:00Z',false);
SELECT atomic_distribute_rake(test_id(950),test_id(900),test_id(1500100),1500100,.14,0,2,2,
jsonb_build_object(test_id(201)::text,1,test_id(202)::text,1),NULL,'{}','WEIGHTED_CONTRIBUTED');""")
batch(1500100);admit(1500100);p=pool(1500100);release(p,'2026-09-07T07:00:00Z',1500300);pay(p)
before=state()
check('Lost zero response replays exact original receipt after funding without moving new cash',claim(1500200)==zero and before==state())
paid=claim(1500201);q=json.loads(paid)
check('New real claim binds exactly its newly committed payment receipt',q['new_payout']=='0.01' and q['payment_count']==1
 and len(q['payments'])==1 and sum(Decimal(s['new_payout']) for s in q['scopes'])==Decimal('.01')
 and [i for s in q['scopes'] for i in s['payment_ids']]==[x['payment_id'] for x in q['payments']])
before=state()
check('Lost paid response replays byte-equivalent original receipt without extra public writes',claim(1500201)==paid and before==state())
refused('Request recovery rejects switched expected account', 'SELECT fn_claim_captured_rakeback(test_id(1500201),test_id(201),NULL);','account_or_request',actor=302)
refused('Request UUID cannot change its original club filter', 'SELECT fn_claim_captured_rakeback(test_id(1500201),test_id(201),test_id(900));','scope_conflict')
# Native malformed getter substitutions exercise wrapper checks, never production capability.
original=sql("SELECT pg_get_functiondef('fn_get_captured_rakeback(uuid)'::regprocedure);")
saved=read()
def replace_getter(payload):
 text=json.dumps(payload,separators=(',',':')).replace("'","''")
 sql("CREATE OR REPLACE FUNCTION fn_get_captured_rakeback(p_club_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $f$ BEGIN RETURN '"+text+"'::jsonb;END $f$;")
 activate()
for idx,kind in enumerate(['missing_club','wrong_pool_scope']):
 broken=json.loads(json.dumps(saved))
 if kind=='missing_club': broken['balances'][0]['scope'].pop('club_id')
 else: broken['balances'][0]['scope']['funding_union_id']='00000000-0000-4000-8000-000000000999'
 replace_getter(broken)
 refused('Malformed real-getter contract refuses before money: '+kind,
  f'SELECT fn_claim_captured_rakeback(test_id({1500400+idx}),test_id(201),NULL);','scope')
# Explicit native getter-snapshot fault: a valid late club was absent at pre-lock discovery.
late=json.loads(json.dumps(saved));extra=json.loads(json.dumps(late['balances'][0]))
extra['scope']['club_id']='00000000-0000-4000-8000-000000000998';extra['pool_id']=None
late['balances'].append(extra);replace_getter(late)
before=json.loads(state())
late_lines=sql("""BEGIN;
SELECT fn_claim_captured_rakeback(test_id(1500402),test_id(201),NULL);
SELECT jsonb_build_object('unexpected_club_lock',EXISTS(
 SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND objsubid=2
 AND classid=(hashtext('club-arena:rakeback-payer')::bigint & 4294967295)
 AND objid=(hashtext(test_id(998)::text)::bigint & 4294967295)));
COMMIT;""",actor=201).splitlines()
assert len(late_lines)==2,late_lines
late_result=json.loads(late_lines[0]);lock_result=json.loads(late_lines[1])
check('Late discovered club defers without acquiring its unsorted payer scope',
 any(s['scope']['club_id'].endswith('000000000998') and s['deferred']==[{'reason':'source_discovered_after_scope_admission'}] for s in late_result['scopes'])
 and lock_result['unexpected_club_lock'] is False)
after=json.loads(state())
old_requests=before.pop('ca_source_player_claim_requests');new_requests=after.pop('ca_source_player_claim_requests')
check('Late scope attempt creates only its immutable request receipt',
 before==after and len(new_requests)==len(old_requests)+1)
sql(original);activate()
# A stale component definition withdraws capability, but original receipt recovery remains available.
sql("COMMENT ON FUNCTION fn_get_captured_rakeback(uuid) IS 'Fixture comment does not change the function body';")
sql("CREATE OR REPLACE FUNCTION fn_ca_captured_player_payment_dto(p_payment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $$SELECT NULL::jsonb$$;")
check('Changed pinned component withdraws real capability',read()['source_active'] is False)
before=state()
check('Committed request remains recoverable while capability is withdrawn',claim(1500201)==paid and before==state())
sql((here.parent/'player-payment-dto.sql').read_text().replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1));activate()
# Prepare one funded cent for actual concurrent request admission.
def due(n,req):
 small(n,'.14','2026-08-31T17:00:00Z','2026-09-01T17:00:00Z')
 release(p,'2026-09-07T07:00:00Z',req);pay(p)
def race(name,ids):
 holder=subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 holder.stdin.write("BEGIN;SELECT fn_lock_rakeback_payer_clubs(ARRAY[test_id(900)]);SELECT 'LOCKED';\n");holder.stdin.flush()
 while True:
  line=holder.stdout.readline()
  assert line,holder.stderr.read()
  if line.strip()=='LOCKED':break
 children=[]
 for i,n in enumerate(ids):
  env=dict(os.environ);env['PGAPPNAME']='player_v2_race_'+str(i)
  query=f"SELECT set_config('request.jwt.claim.sub',test_id(201)::text,false);SELECT fn_claim_captured_rakeback(test_id({n}),test_id(201),NULL);"
  children.append(subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',query],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True))
 deadline=time.monotonic()+8;observed=False
 while time.monotonic()<deadline:
  if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'player_v2_race_%' AND wait_event='advisory';")=='2': observed=True;break
  time.sleep(.03)
 holder.stdin.write('COMMIT;\n');holder.stdin.flush();holder.stdin.close();holder.wait(timeout=10)
 results=[]
 for child in children:
  out,err=child.communicate(timeout=20);assert child.returncode==0,err
  results.append(out.strip().splitlines()[-1])
 check(name+' waits on the shared club admission',observed)
 return results
due(1500101,1500301)
rr=race('Distinct funded UUID race',[1500500,1500501])
check('Distinct funded UUIDs pay the due cent only once',sum(Decimal(json.loads(x)['new_payout']) for x in rr)==Decimal('.01'))
due(1500102,1500302)
rr=race('Same funded UUID race',[1500502,1500502])
check('Same funded UUIDs return byte-equivalent original payment receipt',rr[0]==rr[1] and json.loads(rr[0])['new_payout']=='0.01')
due(1500103,1500303)
sql("""CREATE FUNCTION test_fail_claim_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected final claim receipt';END$$;
CREATE TRIGGER zzz_test_fail_claim_receipt BEFORE INSERT ON ca_source_player_claim_requests FOR EACH ROW EXECUTE FUNCTION test_fail_claim_receipt();""")
refused('Final real request receipt failure rolls back actual player money and every public row',
 'SELECT fn_claim_captured_rakeback(test_id(1500600),test_id(201),NULL);','injected final claim')
sql('DROP TRIGGER zzz_test_fail_claim_receipt ON ca_source_player_claim_requests;')
check('Failed request UUID can retry its actual remaining cash once',json.loads(claim(1500600))['new_payout']=='0.01')
refused('Real player owner rejects nonfinite closed boundaries',
 f"SELECT fn_pay_captured_player_funding('{p}',test_id(201),test_id(303),'-infinity'::date);",'invalid_closed')
final=read()
check('Read after concurrent and recovered claims still reconciles exact cash and earning slices',
 Decimal(final['paid_amount'])==sum(Decimal(x['amount']) for x in final['cash_payments'])
 and Decimal(final['consumed_exact'])==Decimal(final['paid_amount']))
(here/'native-claim-paid-v2.json').write_text(json.dumps(q,indent=2)+'\n')
(here/'native-read-after-claims-v2.json').write_text(json.dumps(final,indent=2)+'\n')
inputs=[here/'claim-native-probe.py',here/'player-native-probe.py',here/'fixture_helpers.py',here/'fixture-clock.sql',
 here/'fixture-seed.sql',here/'activate-fixture.py',here/'run-local.sh',here/'vendor-input-hashes.json',
 here.parent/'player-capacity-proposal.sql',here.parent/'player-payment-dto.sql',here.parent/'player-claim-wrapper.sql']+sorted(read_dir.glob('*'))+sorted(here.glob('*catalog*.json'))
receipt={'status':'native_v2_api_candidate_checkpoint','base_player_checks':len(base_checks),'api_checks':checks,
 'runtime':sql('SELECT version();'),'capability_scope':'Explicit synthetic native witness only. Actual legacy bodies are pinned but not executed/excluded. No production activation.',
 'remaining':['Actual legacy source exclusion/retirement and full outer cascade','Common producer/bank/funding final close witness','Composed browser release'],
 'response_sha256':{n:hashlib.sha256((here/n).read_bytes()).hexdigest() for n in ['native-claim-paid-v2.json','native-read-after-claims-v2.json']},
 'inputs':{str(f.relative_to(here.parent)):hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs if f.is_file()}}
(here/'claim-native-proof.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'base_player_passed':len(base_checks),'api_passed':len(checks)}),flush=True)
