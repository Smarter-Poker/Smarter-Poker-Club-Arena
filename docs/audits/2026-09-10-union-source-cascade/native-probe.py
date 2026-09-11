#!/usr/bin/env python3
"""Actual captured-source dispatch, no synthetic money owners."""
import os, sys, json, hashlib, subprocess, time
from pathlib import Path
from decimal import Decimal
sys.path.insert(0,os.environ['ROUND1_HERE'])
from fixture_helpers import sql,setup,source,admit,pool,release,state,psql
here=Path(os.environ['CASCADE_HERE']);source_here=Path(os.environ['ROUND1_HERE'])
checks=[]
def check(name,predicate):
 assert predicate,name
 checks.append(name);print('PASS: '+name,flush=True)
def value(q,actor=100):return json.loads(sql(q,actor=actor).splitlines()[-1],parse_float=Decimal)
def refused(name,q,expected,actor=100):
 before=state();err=sql(q,False,actor)
 assert expected in err,err
 check(name,before==state())
def batch(n):
 r=value(f"SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object('user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,'source_type','rake_settlement','source_id',hand_id))) FROM ca_cash_commission_facts WHERE hand_id=test_id({n}) AND rake_credit>0;")
 assert r.get('failed')==0,r
def captured(n,rake='2',bank=True):
 if bank:source(n,rake,'2026-08-31T12:00:00Z','2026-09-01T12:00:00Z')
 else:sql(f"SELECT set_config('test.funding_accepted_at','2026-08-31T12:00:00Z',false);SELECT test_owner_amount({n},{rake});")
 if bank:batch(n)
def dispatch(union=901,actor=100):
 return value(f"BEGIN; SELECT fn_lock_rakeback_payer_clubs(fn_ca_union_captured_scope_clubs(test_id({union})));SELECT fn_ca_dispatch_union_captured_funding(test_id({union}),'2026-09-07T07:00Z','2026-09-07',fn_ca_union_captured_scope_clubs(test_id({union}))); COMMIT;",actor)
def money():
 return value("SELECT jsonb_build_object('release',(SELECT coalesce(sum(amount),0) FROM ca_source_club_cash_releases),'agent',(SELECT coalesce(sum(amount),0) FROM ca_source_agent_cash_payments),'player',(SELECT coalesce(sum(amount),0) FROM ca_source_player_cash_payments),'ledger',(SELECT count(*) FROM chip_ledger),'wallet',(SELECT count(*) FROM wallet_transactions),'treasury',(SELECT count(*) FROM chip_transactions));")
setup()
sql((Path(os.environ['ROUND1_INPUT'])/'capacity-owner/04-agent-payment.sql').read_text())
sql((source_here.parent/'player-capacity-proposal.sql').read_text())
sql((here/'01-source-dispatch.sql').read_text())
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Cascade Original Union',test_id(100),'cascade-original-union'),(test_id(902),'Cascade Other Union',test_id(100),'cascade-other-union');
INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);
UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);
UPDATE agents SET commission_rate=.25,player_rakeback_rate=.15 WHERE id=test_id(103);
UPDATE club_members SET player_rakeback_pct=.15 WHERE club_id=test_id(900) AND user_id IN(test_id(201),test_id(202));""")
captured(2400001)
refused('Actor-less captured dispatch refuses before admission or money',"SELECT set_config('request.jwt.claim.sub','',false);SELECT fn_ca_dispatch_union_captured_funding(test_id(901),'2026-09-07T07:00Z','2026-09-07',ARRAY[test_id(900)]);",'captured_union_actor_required')
refused('No club lock means no source admission or money mutation',"SELECT fn_ca_dispatch_union_captured_funding(test_id(901),'2026-09-07T07:00Z','2026-09-07',ARRAY[test_id(900)]);",'lock_not_owned')
refused('A player cannot dispatch the original Union source',"SELECT set_config('request.jwt.claim.role','authenticated',false);SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\"}',false);SELECT fn_ca_dispatch_union_captured_funding(test_id(901),'2026-09-07T07:00Z','2026-09-07',ARRAY[test_id(900)]);",'not_authorised',201)
refused('Authenticated RPC role cannot call the private captured dispatcher',"SET ROLE authenticated;SELECT fn_ca_dispatch_union_captured_funding(test_id(901),'2026-09-07T07:00Z','2026-09-07',ARRAY[test_id(900)]);",'permission denied',201)
r=dispatch()
check('Actual accepted hand through bank release agent payment and player payment conserves',r['new_club_release']==Decimal('1.8') and r['new_agent_payout']==Decimal('1.4') and r['new_player_payout']==Decimal('.3'))
check('Complete observed receipts do not fabricate common period finality',r['source_final'] is False and r['finality_reason']=='producer_and_funding_close_witness_unavailable')
before=money();r=dispatch()
check('Repeated outer source dispatch adds no cash or money receipts',r['new_club_release']==0 and r['new_agent_payout']==0 and r['new_player_payout']==0 and before==money())
captured(2400002)
sql("CREATE FUNCTION test_fail_cascade_player() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected final player receipt';END$$; CREATE TRIGGER zzz_test_fail_cascade_player BEFORE INSERT ON ca_source_player_cash_payments FOR EACH ROW EXECUTE FUNCTION test_fail_cascade_player();")
refused('Final player receipt failure rolls back every actual source round and public row',"BEGIN;SELECT fn_lock_rakeback_payer_clubs(fn_ca_union_captured_scope_clubs(test_id(901)));SELECT fn_ca_dispatch_union_captured_funding(test_id(901),'2026-09-07T07:00Z','2026-09-07',fn_ca_union_captured_scope_clubs(test_id(901)));COMMIT;",'injected final player receipt')
sql('DROP TRIGGER zzz_test_fail_cascade_player ON ca_source_player_cash_payments;')
r=dispatch();check('The failed whole-source dispatch retries once from durable rights',r['new_club_release']==Decimal('1.8') and r['new_player_payout']==Decimal('.3'))
captured(2400003)
sql("UPDATE union_clubs SET union_id=test_id(902) WHERE union_id=test_id(901) AND club_id=test_id(900);UPDATE tables SET union_id=test_id(902) WHERE id=test_id(950);")
r=dispatch();check('Departed club retains its original Union funding and source allocation',r['new_club_release']==Decimal('1.8') and r['new_player_payout']==Decimal('.3') and all(x['funding_union_id'].endswith('901') for x in r['pools']))
captured(2400004);before=money();r=dispatch()
check('Another Union source cannot fund the original Union cascade',r['new_club_release']==0 and before==money())
r=dispatch(902);check('The new Union dispatches only its own captured pool',r['new_club_release']==Decimal('1.8') and r['new_player_payout']==Decimal('.3') and all(x['funding_union_id'].endswith('902') for x in r['pools']))
captured(2400005,bank=False)
unbanked=value("SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object('user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,'source_type','rake_settlement','source_id',hand_id))) FROM ca_cash_commission_facts WHERE hand_id=test_id(2400005) AND rake_credit>0;")
check('Actual commission batch refuses both unbanked source contributors',unbanked['failed']==2 and 'has not banked matching rake' in unbanked['first_error'])
r=dispatch(902)
check('Unbanked accepted source stays visible and cannot be finalized',r['diagnostics']['unbanked_captured_hands']==1 and r['source_final'] is False)
# Late scope admission is a fixture fault. It changes no accepted hand or money
# owner, and must force retry before the caller can acquire an unsorted club.
sql("CREATE FUNCTION test_cascade_saved_scope() RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE clubs uuid[];BEGIN clubs:=fn_ca_union_captured_scope_clubs(test_id(902));PERFORM fn_lock_rakeback_payer_clubs(clubs);PERFORM pg_advisory_xact_lock(243000,1);RETURN fn_ca_dispatch_union_captured_funding(test_id(902),'2026-09-07T07:00Z','2026-09-07',clubs);END$$;")
blocker=subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
blocker.stdin.write('BEGIN;SELECT pg_advisory_xact_lock(243000,1);SELECT 243001;\n');blocker.stdin.flush()
while blocker.stdout.readline().strip()!='243001':pass
worker=subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',"SELECT set_config('request.jwt.claim.sub',test_id(100)::text,false);SELECT test_cascade_saved_scope();"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
before_race_money=money()
observed=False
for _ in range(100):
 if sql("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=243000 AND objid=1 AND NOT granted);")=='t':observed=True;break
 time.sleep(.02)
assert observed,'Expected source-dispatch wait not observed'
blocker.stdin.write("INSERT INTO ca_source_funding_pools(club_id,funding_union_id,funding_route,contract_version) VALUES(test_id(999),test_id(902),'union_rake_wallet',1);COMMIT;\\q\n");blocker.stdin.flush()
blocker.communicate(timeout=10)
worker_out,worker_err=worker.communicate(timeout=10)
check('Observed late-club race refuses without unsorted locking or payment',worker.returncode!=0 and 'captured_union_scope_changed_retry' in worker_err and before_race_money==money())
# Database evidence, not a replacement 'mocked rounds' table.
proof={'schema_version':1,'scope':'Actual captured Union source dispatch; legacy outer composition still pending','source_final':False,'production_applied':False,'checks':checks,'passing':len(checks),'observed_waits':1,'input_commit':'7adbfb02544b68ccc1754c51f11d2f61fa406180','source_sha256':hashlib.sha256((here/'01-source-dispatch.sql').read_bytes()).hexdigest(),'final_money':money(),'limits':['Local calendar fixtures create closed accepted/bank timestamps; these are not historical production source ownership.','Actual original outer legacy dispatch and coordinated legacy exclusions are not claimed by these groups.','No common producer/funding close witness exists; fractions remain owed.']}
(here/'native-proof.json').write_text(json.dumps(proof,indent=2,default=str)+'\n')
print(json.dumps(proof,default=str),flush=True)
