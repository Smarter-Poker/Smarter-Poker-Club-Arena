#!/usr/bin/env python3
"""Actual accepted/bank/Round1/Round2/player read proof; dates/capability are synthetic."""
import os,sys,json,hashlib
from pathlib import Path
from decimal import Decimal
sys.path.insert(0,os.environ['ROUND1_HERE'])
from fixture_helpers import sql,setup,source,admit,pool,release,state
here=Path(__file__).resolve().parent
upstream=Path(os.environ['ROUND1_HERE']).parent
checks=[]
def check(name,predicate):
 assert predicate,name
 checks.append(name);print('PASS: '+name,flush=True)
def read(actor=201,club='NULL'):
 return json.loads(sql(f"SELECT fn_get_captured_rakeback({club});",actor=actor))
def batch(n):
 r=json.loads(sql(f"""SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object(
 'user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,'source_type','rake_settlement','source_id',hand_id)))
 FROM ca_cash_commission_facts WHERE hand_id=test_id({n}) AND rake_credit>0;"""))
 assert r.get('failed')==0,r
def pay_agent(p): return json.loads(sql(f"SELECT fn_pay_captured_agent_funding('{p}',test_id(303),'2026-09-07');"))
def pay_player(p): return json.loads(sql(f"SELECT fn_pay_captured_player_funding('{p}',test_id(201),test_id(303),'2026-09-07');"))
def bank(n):
 settings="SELECT set_config('test.funding_bank_at','2026-09-01T12:00:00Z',false);"
 sql(settings+f"""SELECT row_to_json(b) FROM atomic_distribute_rake(test_id(950),test_id(900),test_id({n}),{n},.18,0,200,2,
 jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),NULL,'{{}}','WEIGHTED_CONTRIBUTED') b;""")
def refused(name,s,actor=100):
 before=state();sql(s,False,actor);check(name,state()==before)
setup()
sql((Path(os.environ['ROUND1_INPUT'])/'capacity-owner/04-agent-payment.sql').read_text())
sql((here/'vendor/player-capacity-proposal.sql').read_text())
sql((here/'vendor/player-payment-dto.sql').read_text())
# Exact captured legacy declarations only; no legacy payment owner is executed.
legacy=json.loads((here/'legacy-owner-catalog.json').read_text())
sql('SET check_function_bodies=off;'+ ';\n'.join(r['definition'] for r in legacy)+';SET check_function_bodies=on;')
sql((here/'01-capability.sql').read_text())
sql((here/'02-getter.sql').read_text())
sql((here/'vendor/player-claim-wrapper.sql').read_text())
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Getter Native Union',test_id(100),'getter-native-union');
 INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);
 UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);""")
sql("SELECT set_config('test.funding_accepted_at','2026-08-24T12:00:00Z',false);SELECT test_owner_amount(1500001,.18);")
r=read()
check('Capture generation alone exposes no V2 source capability or amounts',
 r['source_active'] is False and r['pending_amount']=='0.00' and r['balances']==[] and r['cash_payments']==[])
refused('Authenticated callers cannot insert a coordinated release witness',
 "SET ROLE authenticated;"+(here/'synthetic-capability.sql').read_text(),201)
sql((here/'synthetic-capability.sql').read_text())
before=state();r=read()
(here/'native-read-prebank.json').write_text(json.dumps(r,indent=2)+'\n')
check('Real accepted prebank entitlement survives with null pool and exact fraction',
 r['source_active'] and r['closed_entitlement_exact']=='0.009' and r['pending_amount']=='0.00'
 and len(r['balances'])==1 and r['balances'][0]['pool_id'] is None and before==state())
source(1500002,'.18','2026-08-31T12:00:00Z','2026-09-01T12:00:00Z');batch(1500002);admit(1500002)
p=pool(1500002);r=read()
check('Compatible closed weeks carry exact cents before all source funding arrives',
 r['closed_entitlement_exact']=='0.018' and r['pending_amount']=='0.01' and len(r['balances'])==1
 and r['balances'][0]['pool_id']==p and len(r['balances'][0]['earning_weeks'])==2)
release(p,'2026-09-07T07:00:00Z',1501001);pay_agent(p);paid=pay_player(p)
check('Unbanked liability does not create actual player cash',Decimal(str(paid['new_payout']))==0 and read()['paid_amount']=='0.00')
bank(1500001);batch(1500001);admit(1500001)
release(p,'2026-09-07T07:00:00Z',1501002);pay_agent(p);paid=pay_player(p)
r=read();w=r['balances'][0]['earning_weeks']
(here/'native-read-cross-week-payment.json').write_text(json.dumps(r,indent=2)+'\n')
check('Actual funded cross-week payment reconciles whole cash and fractional source slices',
 Decimal(str(paid['new_payout']))==Decimal('.01') and r['paid_amount']=='0.01' and r['consumed_exact']=='0.01'
 and r['unpaid_exact']=='0.008' and r['pending_amount']=='0.00'
 and w[0]['consumed_exact']=='0.009' and w[1]['consumed_exact']=='0.001'
 and sum(Decimal(x['amount_exact']) for q in r['cash_payments'] for x in q['earning_slices'])==Decimal('.01'))
source(1500003,'.18')
r=read()
check('Open UTC earning week remains visible without adding closed cash',
 r['closed_entitlement_exact']=='0.018' and r['unpaid_exact']=='0.008'
 and any(not x['closed'] and x['entitlement_exact']=='0.009' for x in r['balances'][0]['earning_weeks']))
before=read()
sql("UPDATE agents SET status='suspended' WHERE id=test_id(103);UPDATE club_members SET status='suspended',is_active=false WHERE club_id=test_id(900) AND user_id=test_id(201);")
check('Departure and captured payer deactivation do not erase source debt or actual paid receipts',read()==before)
sql("UPDATE agents SET status='active' WHERE id=test_id(103);UPDATE club_members SET status='active',is_active=true,agent_id=test_id(302),player_rakeback_pct=.10 WHERE club_id=test_id(900) AND user_id=test_id(201);")
source(1500004,'.18','2026-08-31T13:00:00Z','2026-09-01T13:00:00Z')
r=read()
check('Different captured payers cannot combine unpaid fractional cents',
 r['unpaid_exact']=='0.017' and r['pending_amount']=='0.00' and len(r['balances'])==2)
sql("UPDATE club_members SET agent_id=NULL WHERE club_id=test_id(900) AND user_id=test_id(201);")
source(1500005,'.18','2026-08-31T14:00:00Z','2026-09-01T14:00:00Z')
r=read()
check('Genuine unassigned policy is explicit and cannot invent entitlement',
 r['unpaid_exact']=='0.017' and any('assignment_unassigned' in x['reasons'] for x in r['unresolved_earnings']))
refused("Actual member rate storage refuses whole-percent15 without mutation","UPDATE club_members SET player_rakeback_pct=15 WHERE club_id=test_id(900) AND user_id=test_id(201);")
sql("UPDATE club_members SET agent_id=test_id(303),player_rakeback_pct=1.5 WHERE club_id=test_id(900) AND user_id=test_id(201);")
source(1500006,'.18','2026-08-31T15:00:00Z','2026-09-01T15:00:00Z')
r=read()
check('Raw invalid player terms remain unresolved without clipping or whole-percent conversion',
 r['unpaid_exact']=='0.017' and any('accepted_player_rebate_rate_invalid' in x['reasons'] for x in r['unresolved_earnings']))
before=state();other=read(100);filtered=read(201,'test_id(999)')
check('Account and club filters cannot expose another beneficiary source or payment',
 other['balances']==[] and other['cash_payments']==[] and filtered['balances']==[] and before==state())
refused('Getter requires an authenticated beneficiary',"SELECT set_config('request.jwt.claim.sub','',false);SELECT fn_get_captured_rakeback(NULL);")
refused('Coordinated capability evidence cannot be rewritten',"UPDATE ca_captured_rakeback_release_authority SET integration_evidence_sha256=repeat('a',64);")
refused('Coordinated capability evidence cannot be truncated',"TRUNCATE ca_captured_rakeback_release_authority;")
bad=(here/'synthetic-capability.sql').read_text().replace('test_id(1599999)','test_id(1599998)').replace(
 "('legacy_direct_agent','public.fn_agent_claim_commission(uuid,uuid,integer)')",
 "('legacy_direct_agent','public.fn_claim_rakeback(uuid)')")
refused('A matching hash under the wrong legacy owner alias cannot activate capability',bad)
def digest(f):
 raw=json.dumps(json.loads(f.read_text()),sort_keys=True,separators=(',',':')).encode() if f.suffix=='.json' else f.read_bytes()
 return hashlib.sha256(raw).hexdigest()
proof={'hash_encoding':'Sorted compact semantic JSON UTF-8 for JSON; raw bytes otherwise','status':'native_v2_getter_candidate_verified_unactivated','checks':checks,
 'runtime':sql('SELECT version();'),'limitations':['Closed source timestamps and capability witness are explicitly synthetic.',
 'Actual accepted/bank/Round1/Round2/player money owners run; legacy declarations are neither excluded nor executed.',
 'No production capability witness, final producer/funding closure or full outer cascade/browser activation.'],
 'inputs':{str(f.relative_to(here)):digest(f) for f in sorted(here.rglob('*'))
 if f.is_file() and f.suffix in ['.sql','.py','.sh','.json'] and f.name not in ['native-proof.json'] and not f.name.startswith('native-read-')}}
proof['read_output_sha256']={f.name:digest(f) for f in here.glob('native-read-*.json')}
proof['companion_runner_sha256']={str(f.relative_to(upstream)):digest(f) for f in [upstream/'round1-owner/run-local.sh',upstream/'round1-owner/activate-fixture.py',upstream/'round1-owner/fixture_helpers.py',upstream/'round1-owner/fixture-clock.sql',upstream/'round1-owner/fixture-seed.sql',upstream/'round1-owner/01-release-writer.sql']}
(here/'native-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'passed':len(checks)}),flush=True)
