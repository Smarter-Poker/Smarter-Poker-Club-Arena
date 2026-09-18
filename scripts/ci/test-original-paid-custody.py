"""Qualify original paid scoring custody with the existing real PG17 fixture."""
from pathlib import Path
import argparse
import copy
import datetime
import json
import signal
import re
from collections import Counter
import sys
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import compose,module,sha,table_sql,exact_table_sql
import mtt_activation_native as activation
from mtt_activation_funding import HUMAN
from original_paid_custody_native import lease_foundation, owner_races, installer_refusals, postimage, paid_purchase_prevention, private_rows, validate_complete, acknowledged_install
ROOT=Path(__file__).resolve().parents[2]
FIX=Path('scripts/ci/fixtures/original-paid-custody')
MIGRATION=Path('supabase/migrations/20260918093004_original_paid_tournament_stack_keeps_its_custody.sql')
SUCCESSOR=Path('supabase/migrations/20260918123506_original_paid_custody_preserves_acknowledged_supply.sql')
CALL="SELECT public.fn_ca_resume_original_paid_tournament_entry('b7c00000-0000-4000-8000-000000000001',(SELECT expected FROM original_paid_fixture.input));"
T="'b7200000-0000-4000-8000-000000000001'"
U="'b7100000-0000-4000-8000-000000000001'"
CHANGED={'public.tournament_players','public.table_seats','public.tables','public.tournament_knockout_candidates','public.tournament_paid_stack_custody_receipts','public.tournament_manager_wakes','public.union_pnl_inventory_events','public.union_pnl_transaction_frames'}

def validate_race(code,stdout,stderr,step,ending):
 notices=re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*(CUSTODY_RACE_[A-Z_]+)\s*$',stdout+'\n'+stderr,re.M)
 expected=['CUSTODY_RACE_RESULT_PROVEN','CUSTODY_RACE_WAIT_PROVEN',
           'CUSTODY_RACE_REFUSAL_PROVEN' if step=='b_other_commit' else 'CUSTODY_RACE_RESULT_PROVEN','CUSTODY_RACE_EFFECTS_PROVEN']
 steps=Counter({'a_begin':1,'a_resume':1,step:2,'observed_wait':1,ending:1,'final_state':1})
 if (code or stderr.strip() or re.search(r'\b(?:ERROR|FATAL|PANIC|WARNING):',stdout)
  or notices!=expected or Counter(re.findall(r'^step ([a-z_]+):',stdout,re.M))!=steps
  or stdout.count('<waiting ...>')!=1 or stdout.count('<... completed>')!=1
  or re.findall(r'^starting permutation: (.*)$',stdout,re.M)!=['a_begin a_resume '+step+' observed_wait '+ending+' final_state']):
  raise RuntimeError('actual custody concurrency proof failed')

def races(e,db,native):
 spec=(ROOT/FIX/'races.spec').read_text();body=re.sub(r'^permutation .+$','',spec,flags=re.M)
 binary=native.stock_isolationtester(e.pg)
 e.report['isolationtester']={'path':str(binary),'sha256':sha(binary)}
 permutations=re.findall(r'^permutation .+$',spec,re.M)
 if len(permutations)!=4:raise ValueError('four exact custody permutations required')
 for permutation in permutations:
  names=re.findall(r'"([a-z_]+)"',permutation);step=names[2];ending=names[4]
  case=e.database(db);before=e.snapshot(case,step+'-before')
  private_before=private_rows(e,case,step+'-private-before')
  unused={'a_commit','a_rollback','b_same_commit','b_same_rollback','b_other_commit','b_other_rollback'}-{step,ending}
  rendered=re.sub(r'^step "(?:'+'|'.join(unused)+r')" .*\n','',body,flags=re.M)
  code,stdout,stderr=e.run(step,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered+'\n'+permutation+'\n',check=False,seconds=40)
  validate_race(code,stdout,stderr,step,ending)
  controls=[(1,stdout,stderr),(0,'',stderr),(0,stdout,'transport failed'),(0,stdout.replace('<waiting ...>',''),stderr),(0,stdout.replace('CUSTODY_RACE_EFFECTS_PROVEN',''),stderr),(0,stdout+'\nERROR: false pass',stderr)]
  for badcode,badout,baderr in controls:
   try:validate_race(badcode,badout,baderr,step,ending)
   except RuntimeError:pass
   else:raise RuntimeError('missing race evidence accepted')
  after=e.snapshot(case,step+'-after')
  if private_rows(e,case,step+'-private-after')!=private_before:raise RuntimeError('race changed private custody')
  if {n for n in before if before[n]!=after[n]}!=CHANGED:raise RuntimeError('race changed money outside custody')
  assert_inventory(e,case,step)
  e.discard(case);e.report['races'].append({'case':step,'actual_wait':True,'exact_custody_delta':True,'financial_rows_unchanged':True,'false_evidence_refused':6})

def assert_inventory(e,db,label):
 code,out,err=e.sql(db,"""DO $$ BEGIN
 IF (SELECT count(*)=1 AND bool_and(reason='rebuy' AND tournament_id='b7200000-0000-4000-8000-000000000001') FROM public.tournament_manager_wakes) IS DISTINCT FROM true
 OR (SELECT count(*) FROM public.union_pnl_transaction_frames)<>1
 OR (SELECT count(*) FROM public.union_pnl_inventory_events)<>1
 OR NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_events ev
 JOIN public.table_seats s ON s.id=ev.row_id JOIN public.tournament_paid_stack_custody_receipts r ON r.transaction_id=ev.transaction_id
 JOIN public.union_pnl_transaction_frames f ON f.transaction_id=ev.transaction_id AND f.observed_at=ev.observed_at
 WHERE ev.source_name='table_seats' AND ev.operation='UPDATE'
 AND ev.before_row->>'left_at' IS NOT NULL AND (ev.before_row->>'stack')::numeric=0
 AND ev.after_row=public.fn_union_pnl_inventory_project('table_seats',to_jsonb(s))
 AND s.user_id=r.user_id AND s.table_id=r.destination_table_id AND s.stack=2500 AND s.left_at IS NULL)
 THEN RAISE EXCEPTION 'CUSTODY_INVENTORY_VECTOR_CHANGED'; END IF;
 RAISE NOTICE 'CUSTODY_INVENTORY_VECTOR_PROVEN'; END $$;""",label=label+'-inventory-proof',check=False)
 if code or err.count('CUSTODY_INVENTORY_VECTOR_PROVEN')!=1:raise RuntimeError('inventory custody projection differs '+err)

def activation_proof(e,db):
 transaction="BEGIN; SELECT pg_advisory_xact_lock_shared(530090,1); UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2' WHERE singleton AND abi='legacy-capacity-v1'; COMMIT;"
 old=json.loads((ROOT/FIX/'activation-guard.json').read_text())[0]
 activation.refusal(e,db,'original-activation-guard-refuses-custody',old['definition']+';',transaction,
  'MTT_ACTIVATION_AUTHORITY_DRIFT: public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)')
 activation.refusal(e,db,'custody-assignment-pin-refuses-drift',
  "ALTER FUNCTION public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer) SET statement_timeout='1s';",transaction,
  'MTT_ACTIVATION_AUTHORITY_DRIFT: public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)')
 case=e.database(db);before=e.snapshot(case,'custody-activation-before')
 e.sql(case,transaction,label='custody-actual-activation')
 after=e.snapshot(case,'custody-activation-after')
 if {k for k in before if before[k]!=after[k]}!={'public.ca_mtt_admission_contract'}:raise RuntimeError('custody activation changed business rows')
 _,value,_=e.sql(case,"SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton;",label='custody-actual-activation-readback')
 if value.strip()!='unlimited-mtt-v2':raise RuntimeError('custody activation did not execute')
 e.discard(case);e.report['activation']={'original_guard_refuses':True,'successor_all_pins_pass':True,'assignment_drift_refused':True,'only_abi_row_changed':True}

def refusal_cases(e,db):
 cases=[
 ('nil-input',None,"SELECT public.fn_ca_resume_original_paid_tournament_entry(NULL,NULL);",'ORIGINAL_PAID_IDENTITY_REQUIRED'),
 ('changed-expected',None,CALL.replace('SELECT expected FROM','SELECT expected||\'{"grant_chips":2501}\'::jsonb FROM'),'ORIGINAL_PAID_EXPECTED_CHANGED'),
 ('changed-generation',"UPDATE engine_tournament_leases SET lease_generation=gen_random_uuid() WHERE tournament_id="+T,None,'ORIGINAL_PAID_LEASE_CHANGED'),
 ('changed-instance',"UPDATE engine_tournament_leases SET instance_id='another' WHERE tournament_id="+T,None,'ORIGINAL_PAID_LEASE_CHANGED'),
 ('bounty-event',"UPDATE tournaments SET is_bounty=true WHERE id="+T,None,'ORIGINAL_PAID_SCOPE_CHANGED'),
 ('changed-paid-stack',"UPDATE tournament_players SET chips=2501 WHERE user_id="+U,None,'ORIGINAL_PAID_SCOPE_CHANGED'),
 ('terminal-player',"UPDATE tournament_players SET status='eliminated',position=2 WHERE user_id="+U,None,'ORIGINAL_PAID_SCOPE_CHANGED'),
 ('resolved-candidate',"UPDATE tournament_knockout_candidates SET state='rebought',resolved_at=now() WHERE eliminated_user_id="+U,None,'ORIGINAL_PAID_SCOPE_CHANGED'),
 ('unaccepted-hand',"UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE hand_number=9720001",None,'ORIGINAL_PAID_ACCEPTED_HISTORY_CHANGED'),
 ('missing-durable-key',"DELETE FROM settlement_idempotency_keys WHERE hand_id='b7700000-0000-4000-8000-000000000001'",None,'ORIGINAL_PAID_ACCEPTED_HISTORY_CHANGED'),
 ('later-durable-play',"INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,result,completed_at) SELECT table_id,gen_random_uuid(),status,jsonb_set(result,'{hand_number}','9720002'),now() FROM settlement_idempotency_keys WHERE hand_id='b7700000-0000-4000-8000-000000000001'",None,'ORIGINAL_PAID_ACCEPTED_HISTORY_CHANGED'),
 ('wrong-original-wallet',"UPDATE wallet_transactions SET amount=2 WHERE id='b7a00000-0000-4000-8000-000000000001'",None,'ORIGINAL_PAID_FUNDING_CHANGED'),
 ('missing-purchase-key',"DELETE FROM wallet_credit_idempotency WHERE user_id="+U,None,'ORIGINAL_PAID_FUNDING_CHANGED'),
 ('changed-source-club',"UPDATE tournament_refund_entitlements SET refund_wallet_club_id=gen_random_uuid() WHERE user_id="+U,None,'ORIGINAL_PAID_FUNDING_CHANGED'),
 ('nonzero-original-seat',"UPDATE table_seats SET stack=1 WHERE id='b7400000-0000-4000-8000-000000000001'",None,'ORIGINAL_PAID_ACCEPTED_HISTORY_CHANGED'),
 ('live-original-seat',"UPDATE table_seats SET left_at=NULL,status='active',active_game_scope='table:b7300000-0000-4000-8000-000000000001',active_parent_key='tournament:b7200000-0000-4000-8000-000000000001' WHERE id='b7400000-0000-4000-8000-000000000001'",None,'ORIGINAL_PAID_SCOPE_CHANGED'),
 ('changed-survivor',"UPDATE table_seats SET stack=320001 WHERE id='b7400000-0000-4000-8000-000000000002'",None,'ORIGINAL_PAID_SURVIVOR_CHANGED'),
 ('active-snapshot',"INSERT INTO hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json) VALUES('b7300000-0000-4000-8000-000000000001',9720002,'{}','{}',1,'[]')",None,'ORIGINAL_PAID_ACTIVE_CUSTODY_CHANGED'),
 ('reserved-permit',"INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state) VALUES(gen_random_uuid(),"+T+",'b7300000-0000-4000-8000-000000000001',1,9720002,gen_random_uuid(),'b7b00000-0000-4000-8000-000000000001','reserved')",None,'ORIGINAL_PAID_ACTIVE_CUSTODY_CHANGED'),
 ('active-park',"INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,state,revision,created_at) VALUES(gen_random_uuid(),"+T+",'b7300000-0000-4000-8000-000000000001',1,gen_random_uuid(),'b7b00000-0000-4000-8000-000000000001','park_requested',0,now())",None,'ORIGINAL_PAID_ACTIVE_CUSTODY_CHANGED'),
  ('platform-freeze',"INSERT INTO engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,updated_at,enforce_freeze,ownership_token) VALUES(true,'counting_down',now()-interval '2 minutes',now(),now()+interval '5 minutes','native custody freeze','native',now(),true,gen_random_uuid())",None,'ORIGINAL_PAID_PLATFORM_FROZEN'),
  ('changed-acknowledgement',"UPDATE tournament_felt_supply_acknowledgements SET reason='changed proof' WHERE tournament_id="+T,None,'ORIGINAL_PAID_EXPECTED_CHANGED'),
  ('missing-acknowledgement',"DELETE FROM tournament_felt_supply_acknowledgements WHERE tournament_id="+T,None,'ORIGINAL_PAID_EXPECTED_CHANGED'),
  ('changed-acknowledged-supply',"UPDATE tournament_felt_supply_acknowledgements SET chips=2501 WHERE tournament_id="+T,None,'ORIGINAL_PAID_EXPECTED_CHANGED'),
 ]
 before=e.snapshot(db,'refusals-before')
 for name,mutation,call,error in cases:
  # Changed historical inputs are explicit fixture setup; all real guards are
  # restored before invoking the owner. The outer transaction always rolls back.
  setup=('SET LOCAL session_replication_role=replica;'+mutation+';SET LOCAL session_replication_role=origin;') if mutation else ''
  sql="BEGIN;"+setup+"DO $case$ BEGIN BEGIN "+(call or CALL)+" RAISE EXCEPTION 'NATIVE_EXPECTED_REFUSAL_ABSENT'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>"+"'"+error+"' THEN RAISE; END IF; END; RAISE NOTICE 'CUSTODY_REFUSAL_PROVEN'; END $case$; ROLLBACK;"
  code,stdout,err=e.sql(db,sql,label='refusal-'+name,check=False)
  if code or err.count('CUSTODY_REFUSAL_PROVEN')!=1 or 'ERROR:' in err:raise RuntimeError('refusal failed '+name+': '+err)
  if e.snapshot(db,'refusal-'+name+'-rollback')!=before:raise RuntimeError('refusal changed rows '+name)
  e.report.setdefault('refusals',[]).append(name)
 for role in ['anon','authenticated','service_role']:
  code,stdout,err=e.sql(db,'SET ROLE '+role+'; SELECT public.fn_ca_resume_original_paid_tournament_entry(NULL,NULL);',label='permission-'+role,check=False)
  if code!=3 or 'permission denied for function fn_ca_resume_original_paid_tournament_entry' not in err:raise RuntimeError('authority exposed to '+role)
  code,stdout,err=e.sql(db,'SET ROLE '+role+'; INSERT INTO public.tournament_paid_stack_custody_receipts DEFAULT VALUES;',label='capability-'+role,check=False)
  if code!=3 or 'permission denied for table tournament_paid_stack_custody_receipts' not in err:raise RuntimeError('capability exposed to '+role)
 e.report['private_role_refusals']=6

def original_refusal(e,db,rows):
 case=e.database(db)
 row=next(r for r in rows if r['signature'].startswith('fn_ca_assign_tournament_player_seat_locked('))
 e.sql(case,row['definition']+';',label='original-assignment-body')
 before=e.snapshot(case,'original-owner-before')
 code,stdout,err=e.sql(case,CALL,label='original-owner-refusal',check=False)
 if code!=3 or 'ORIGINAL_PAID_ASSIGNMENT_REFUSED:' not in err or 'tournament_chip_conservation' not in err:
  raise RuntimeError('original exact owner failure was not reproduced')
 if e.snapshot(case,'original-owner-after')!=before:raise RuntimeError('original refusal leaked a candidate, receipt or seat')
 e.discard(case);e.report['original_refusal']={'exact_original_body':row['body_md5'],'same_input_rejected':True,'whole_transaction_rollback':True}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);a=p.parse_args()
 out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 built=compose(ROOT);(out/'foundation.sql').write_text(built.pop('sql'));built.pop('entry_sql')
 paths=[MIGRATION,SUCCESSOR,FIX/'felt-guard.json',FIX/'acknowledged-supply-catalog.json',FIX/'current-authorities.json',FIX/'opening.sql',FIX/'cases.sql',FIX/'setup.sql',FIX/'races.spec',FIX/'snapshot-catalog.json',FIX/'snapshot-guard.json',FIX/'activation-guard.json',FIX/'lease-claim.json',FIX/'lease-dependencies.json',FIX/'paid-purchase-authority.json',FIX/'purchase-prevention.sql',FIX/'owner-races.spec',Path('scripts/ci/original_paid_custody_native.py'),Path('supabase/migrations/20260918071546_f06_original_preparation_cancellations_survive_maintenance_r.sql'),Path('scripts/ci/probes/original-paid-custody-authority.sql'),Path('scripts/ci/build-original-paid-custody.py'),Path(__file__).relative_to(ROOT),Path('.github/workflows/ci.yml'),Path('scripts/ci/classify-ci-changes.mjs'),Path('tests/unit/fixtureNativeCi.test.ts'),Path('scripts/qualification/cash-native-hosted.manifest.json'),Path('scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql'),Path('scripts/ci/probes/bounty-rebuy-generation-atomicity.sql'),Path('scripts/ci/test-mtt-unlimited.py'),Path('scripts/ci/mtt_isolation_results.py'),Path('scripts/ci/mtt_format_qualification.py'),Path('scripts/ci/mtt_historical_freebuy_proof.py')]
 built['source_sha256'].update({str(p):sha(ROOT/p) for p in paths})
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','custody_execution');e=native.Execution(ROOT,out,a.pg_bin.resolve(),out,600)
 e.report.update(source_sha256=built['source_sha256'],fixture_identity='real-financial-catalog-original-paid-custody')
 for s in native.CANCELLATION_SIGNALS:signal.signal(s,native.interrupted)
 try:
  activation.source_inputs(e)
  catalog=native.preparation_inputs(e)
  db=activation.compose_template(e,catalog)
  e.sql(db,file=ROOT/activation.GUARD,label='existing-activation-guard')
  activation.install_funding(e,db)
  e.sql(db,file=ROOT/activation.SUCCESSOR,label='existing-funding-guard')
  e.sql(db,file=ROOT/activation.PRODUCERS,label='existing-satellite-producers')
  e.sql(db,file=ROOT/activation.SATELLITE_SUCCESSOR,label='existing-satellite-guard')
  rows=json.loads((ROOT/FIX/'current-authorities.json').read_text())
  capture='BEGIN;\n'
  for r in rows:
   sig=r['signature'] if '.' in r['signature'].split('(')[0] else 'public.'+r['signature']
   capture+=r['definition']+';\nREVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;\n'
  e.sql(db,capture+'COMMIT;',label='captured-current-seat-authority')
  snapshot=json.loads((ROOT/FIX/'snapshot-catalog.json').read_text())
  guard=json.loads((ROOT/FIX/'snapshot-guard.json').read_text())
  preparation=(ROOT/'supabase/migrations/20260918071546_f06_original_preparation_cancellations_survive_maintenance_r.sql').read_text()
  shape=preparation[preparation.index('CREATE TABLE smarter_private.f06_prepared_hand_cancellations'):preparation.index('CREATE FUNCTION public.fn_f06_cancel_prepared_hand')]
  capture='BEGIN;\n'+shape+table_sql(snapshot)+'\n'+guard['definition']+';\n'
  capture+='REVOKE ALL ON FUNCTION smarter_private.f06_prepared_cancellation_immutable(),smarter_private.f06_cancelled_preparation_writer_guard() FROM PUBLIC,anon,authenticated,service_role;\n'
  for c in snapshot['constraints']:
   if c['type']=='f':capture+='ALTER TABLE public.hand_state_snapshots ADD CONSTRAINT '+c['name']+' '+c['definition']+';\n'
  for t in snapshot['triggers']:capture+=t['definition']+';\n'
  e.sql(db,capture+exact_table_sql(snapshot)+'COMMIT;',label='actual-snapshot-catalog-and-guard')
  lease_foundation(e,db,FIX)
  installer_refusals(e,db,MIGRATION,activation.refusal)
  _,registry_before,_=e.sql(db,"SELECT jsonb_agg(to_jsonb(r) ORDER BY proname) FROM public.ca_money_rpc_registry r WHERE proname<>'fn_ca_resume_original_paid_tournament_entry';",label='original-registry-before')
  before=e.snapshot(db,'before-migration');e.sql(db,file=ROOT/MIGRATION,label='guarded-install')
  after=e.snapshot(db,'after-migration')
  _,registry_after,_=e.sql(db,"SELECT jsonb_agg(to_jsonb(r) ORDER BY proname) FROM public.ca_money_rpc_registry r WHERE proname<>'fn_ca_resume_original_paid_tournament_entry';",label='original-registry-after')
  if registry_before!=registry_after:raise RuntimeError('installation changed an existing financial declaration')
  before.pop('public.ca_money_rpc_registry');after.pop('public.ca_money_rpc_registry')
  after.pop('public.tournament_paid_stack_custody_receipts',None)
  if after!=before:raise RuntimeError('migration changed business rows')
  postimage(e,db,FIX,(ROOT/'scripts/ci/probes/original-paid-custody-authority.sql').read_text())
  activation_proof(e,db)
  e.sql(db,file=ROOT/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='structural-opening')
  seed=(ROOT/'scripts/ci/probes/bounty-rebuy-generation-atomicity.sql').read_text().split('SET LOCAL session_replication_role=origin;')[0]
  seed+=(ROOT/FIX/'opening.sql').read_text();e.sql(db,seed,label='exact-scoring-shape')
  e.sql(db,file=ROOT/FIX/'setup.sql',label='independent-original-expectation')
  acknowledged_install(e,db,FIX,SUCCESSOR,activation.refusal)
  builder=module(ROOT/'scripts/ci/build-original-paid-custody.py','custody_builder')
  _,corrected=builder.build_acknowledged()
  complete_source=(ROOT/'scripts/ci/probes/original-paid-custody-authority.sql').read_text()
  original=re.search(r'CREATE FUNCTION public\.fn_ca_resume_original_paid_tournament_entry\(.*?\$function\$;',complete_source,re.S)[0]
  postimage(e,db,FIX,complete_source.replace(original,corrected.replace('CREATE OR REPLACE FUNCTION','CREATE FUNCTION',1)))
  private_before=private_rows(e,db,'all-cases-private-before')
  paid_purchase_prevention(e,db,FIX)
  original_refusal(e,db,rows)
  refusal_cases(e,db)
  races(e,db,native)
  owner_races(e,db,FIX,native,CHANGED,assert_inventory)
  before=e.snapshot(db,'transfer-before')
  code,stdout,err=e.sql(db,(ROOT/FIX/'cases.sql').read_text().replace('-- @OUTCOME@','COMMIT;'),label='actual-custody-cases',check=False)
  if code or err.count('CUSTODY PASS:')!=7 or 'ERROR:' in err:raise RuntimeError('actual transfer cases failed: '+err)
  after=e.snapshot(db,'transfer-after')
  changed={name for name in before if before[name]!=after[name]}
  if changed!=CHANGED:raise RuntimeError('unexpected final business delta: '+str(changed))
  assert_inventory(e,db,'final')
  e.report['successful_transfer']={'assertions':7,'only_custody_rows_changed':sorted(changed)}
  for path,digest in built['source_sha256'].items():
   if sha(ROOT/path)!=digest:raise RuntimeError('input changed '+path)
  if private_rows(e,db,'all-cases-private-after')!=private_before:raise RuntimeError('cases changed private custody')
  e.report['private_custody_unchanged']=True
  validate_complete(e.report)
  keys=['original_refusal','refusals','private_role_refusals','races','owner_races','activation','installer_refusals','postimage','successful_transfer','private_custody_unchanged','paid_purchase_prevention','acknowledged_supply']
  for key in keys:
   bad=copy.deepcopy(e.report);bad.pop(key)
   try:validate_complete(bad)
   except RuntimeError:pass
   else:raise RuntimeError('missing qualification evidence accepted: '+key)
  e.report['missing_result_controls']=len(keys)
  e.report['status']='passed'
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  for s in native.CANCELLATION_SIGNALS:signal.signal(s,signal.SIG_IGN)
  try:e.close()
  except BaseException as exc:e.report.update(cleanup_failure=repr(exc),status='failed')
  (out/'source-manifest.json').write_text(json.dumps({'source_sha256':e.report['source_sha256']},indent=2)+'\n')
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure','cleanup']}),flush=True)
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':sys.exit(main())
