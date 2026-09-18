"""Direct read/assert custody qualification on the actual installed financial foundation."""
from pathlib import Path
import argparse, ast, datetime, json, re, signal, sys
from collections import Counter
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module,sha,function_sql
PROBE='scripts/ci/probes/f06-drained-custody.sql'
SPEC='scripts/ci/probes/f06-drained-custody.spec'
FORMAT='supabase/migrations/20260917060000_mtt_persisted_format_preparation.sql'
FINISH='supabase/migrations/20260912100322_tournament_break_original_custody_and_hand_authority.sql'
RELEASE='supabase/migrations/20260908042900_tournament_leases_have_fencing_generations.sql'
MIXED='scripts/ci/fixtures/f06-drained-custody/installed-mixed-authority.json'
PAID='scripts/ci/fixtures/f06-drained-custody/installed-paid-dependency.sql'
MIXED_FIXTURE='scripts/ci/probes/f06-shared-hand-lane/mixed-fixture.sql'
PREPARED_FIXTURE='scripts/ci/probes/f06-shared-hand-lane/prepared_cancellation_qualification.py'
def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[2]);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);a=p.parse_args()
 root,out=a.root.resolve(),a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 f=module(root/'scripts/ci/test-f06-accepted-elimination.py','drained_fixture');m=module(root/'scripts/ci/test-f06-movement-admission.py','drained_movement');b=module(root/'scripts/ci/build-f06-drained-custody.py','drained_builder')
 manifest=f.prepare(root,out)
 paths=['scripts/ci/mtt_break_authoring_native.py',PROBE,SPEC,FORMAT,FINISH,RELEASE,PREPARED_FIXTURE,MIXED,PAID,MIXED_FIXTURE,b.MIGRATION,b.AUTHORITY,b.PREPARED,'scripts/ci/build-f06-drained-custody.py','scripts/ci/test-f06-drained-custody.py','scripts/ci/test-f06-movement-admission.py']
 paths +=[m.MIGRATION,m.OPENING,m.RECEIPT,m.AUTHORITIES,m.PUBLIC_F06,m.DEPENDENCY_FUNCTIONS,m.DEPENDENCY_CATALOG,m.FINAL_RELATIONS,m.PRIVATE,m.CONTROL,m.CONTINUATION]
 manifest['source_sha256'].update({p:sha(root/p) for p in paths})
 if b.render(root)!=(root/b.MIGRATION).read_text():raise ValueError('installer binding differs')
 (out/'movement-catalog.sql').write_text(m.movement_catalog(root));(out/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 n=module(root/'scripts/ci/test-mtt-unlimited.py','drained_execution');e=n.Execution(root,out,a.pg_bin.resolve(),out,600);e.report.update(source_sha256=manifest['source_sha256'])
 for sig in n.CANCELLATION_SIGNALS:signal.signal(sig,n.interrupted)
 try:
  e.start();db=e.database()
  e.sql(db,file=out/'foundation.sql',label='real-foundation',seconds=180)
  e.sql(db,file=out/'current-authorities.sql',label='current-authorities')
  e.sql(db,file=out/'movement-catalog.sql',label='actual-movement-catalog')
  e.sql(db,file=root/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='structural-opening')
  e.sql(db,file=out/'opening.sql',label='canonical-opening')
  e.sql(db,file=root/m.OPENING,label='movement-opening')
  e.sql(db,file=root/f.MIGRATION,label='installed-elimination')
  e.sql(db,file=root/m.MIGRATION,label='installed-movement')
  shape=[x.args[1].value for x in ast.walk(ast.parse((root/PREPARED_FIXTURE).read_text())) if isinstance(x,ast.Call) and len(x.args)>1 and isinstance(x.args[0],ast.Constant) and x.args[0].value=='prepared-private-card-shape']
  if len(shape)!=1:raise ValueError('maintained prepared card shape missing')
  e.sql(db,shape[0],label='maintained-private-card-shape')
  # Compose the exact receipt/canceller from the installed migration, without
  # downgrading the newer captured writer guard that also fences continuations.
  prepared=(root/b.PREPARED).read_text()
  receipt=prepared[prepared.index('CREATE TABLE smarter_private.f06_prepared_hand_cancellations'):prepared.index('-- Covers raw snapshot/private/hand writers')]
  receipt+="REVOKE ALL ON FUNCTION smarter_private.f06_prepared_cancellation_immutable() FROM PUBLIC,anon,authenticated,service_role;"
  e.sql(db,receipt,label='installed-preparation-receipt-and-caller')
  e.sql(db,"DO $$ DECLARE rel text; BEGIN FOREACH rel IN ARRAY ARRAY['hand_atomic_commits','hand_history','table_hole_cards'] LOOP EXECUTE format('CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()',rel); END LOOP; END $$;",label='same-current-preparation-writer-bindings')
  e.sql(db,file=root/PAID,label='installed-paid-relation')
  format_sql=(root/FORMAT).read_text();format_sql=format_sql[format_sql.index('ALTER TABLE public.tournaments ADD COLUMN format_contract'):format_sql.index('-- Metadata qualification')]
  e.sql(db,format_sql,label='actual-recorded-format-schema')
  e.sql(db,"BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.tournaments SET format_contract='mtt-v2' WHERE id::text LIKE 'b7200000-%'; COMMIT;",label='synthetic-recorded-format')
  for path,name,delimiter in [(FINISH,'fn_f06_finish_hand','$$'),(RELEASE,'release_tournament_leases_v2','$function$')]:
   source=(root/path).read_text();definition=re.search(r'CREATE (?:OR REPLACE )?FUNCTION public\.'+name+r'\(.*?'+re.escape(delimiter)+r'.*?'+re.escape(delimiter)+r';',source,re.S)[0]
   e.sql(db,definition,label='original-'+name)
  mixed=json.loads((root/MIXED).read_text())
  import hashlib
  if hashlib.md5(mixed['definition'].encode()).hexdigest()!=mixed['definition_md5'] or mixed['definition_md5']!='483b508311d233d3da73e55db17499ce':raise ValueError('current mixed authority differs')
  e.sql(db,mixed['definition']+'; REVOKE ALL ON FUNCTION public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) TO service_role;',label='exact-installed-mixed-caller')
  expected=(root/MIXED_FIXTURE).read_text();expected=expected[expected.index('CREATE FUNCTION fixture_expected_mixed'):expected.index('CREATE FUNCTION fixture_seed_mixed')]
  e.sql(db,expected,label='maintained-mixed-input-builder')
  guard=json.loads((root/'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json').read_text())
  for r in guard['functions']:e.sql(db,function_sql(r),label='real-money-ddl-guard')
  e.sql(db,"CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();",label='actual-ddl-binding')
  code,_,err=e.sql(db,"SELECT public.fn_f06_assert_drained_manager_custody(NULL,NULL,NULL,'[]',NULL);",label='before-no-handoff-authority',check=False)
  if not code or 'does not exist' not in err:raise RuntimeError('expected original missing-authority refusal absent')
  e.report['before_missing_authority']=True
  # Drift controls run the whole real installer and preserve its atomic refusal.
  for label,mutation,reason in [
   ('helper-body',"CREATE OR REPLACE FUNCTION smarter_private.f06_movement_permits(p_tournament uuid,p_table uuid,p_boundary bigint) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS 'SELECT ''[]''::jsonb';",'F06_DRAINED_DEPENDENCY_DRIFT'),
   ('helper-acl',"GRANT EXECUTE ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) TO authenticated;",'F06_DRAINED_DEPENDENCY_DRIFT'),
   ('receipt-binding',"DROP TRIGGER f06_prepared_cancellation_immutable ON smarter_private.f06_prepared_hand_cancellations;",'F06_DRAINED_PREPARATION_BINDING'),
   ('receipt-identity',"ALTER TABLE smarter_private.f06_prepared_hand_cancellations DROP CONSTRAINT f06_prepared_hand_cancellations_table_id_hand_number_key;",'F06_DRAINED_PREPARATION_RELATION')]:
   case=e.database(db);e.sql(case,mutation,label='drift-'+label)
   state=e.catalog_snapshot(case,'before-install-'+label)
   rc,_,errors=e.sql(case,file=root/b.MIGRATION,label='installer-refuses-'+label,check=False)
   if rc!=3 or reason not in errors or e.catalog_snapshot(case,'after-install-'+label)!=state:raise RuntimeError('installer drift refusal failed: '+label)
   e.discard(case);e.report.setdefault('installer_refusals',[]).append(label)
  e.sql(db,file=root/b.MIGRATION,label='candidate-install')
  before=e.snapshot(db,'before-data');private=f.private_snapshot(e,db,'before-private');catalog=e.catalog_snapshot(db,'before-catalog')
  code,stdout,stderr=e.sql(db,file=root/PROBE,label='drained-direct-cases',check=False,seconds=60)
  e.report.update(case_output=stdout,case_errors=stderr)
  if code or stderr.count('DRAINED_COMPLETE')!=1 or stderr.count('DRAINED PASS:')!=28 or 'ERROR:' in stderr:raise RuntimeError('direct custody cases failed')
  if e.snapshot(db,'after-data')!=before or f.private_snapshot(e,db,'after-private')!=private or e.catalog_snapshot(db,'after-catalog')!=catalog:raise RuntimeError('qualification failed full rollback')
  e.report.update(assertions=stderr.count('DRAINED PASS:'),data_rollback=True,catalog_rollback=True)
  # The same real movement admission waits behind this read/assert prefix; its
  # own immutable custody and financial guards remain active after release.
  text=(root/SPEC).read_text();binary=n.stock_isolationtester(e.pg)
  e.report['isolationtester']={'path':str(binary),'sha256':sha(binary)}
  permutations=re.findall(r'^permutation .+$',text,re.M);body=re.sub(r'^permutation .+$','',text,flags=re.M)
  if len(permutations)!=2:raise ValueError('exact two lock permutations required')
  for mode,permutation in zip(['commit','rollback'],permutations):
   case=e.database(db);unused='rollback' if mode=='commit' else 'commit';rendered=re.sub(r'^step "a_'+unused+r'".*\n','',body,flags=re.M)
   rc,ro,re_=e.run('drained-race-'+mode,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered+'\n'+permutation+'\n',seconds=40,check=False)
   if rc or re_.strip() or re.search(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):',ro,re.M) or ro.count('<waiting ...>')!=1 or ro.count('<... completed>')!=1 or Counter(re.findall(r'^step ([a-z_]+):',ro,re.M))!=Counter({'a_begin':1,'a_claim':1,'b_claim':2,'observed_wait':1,'a_'+mode:1,'final_state':1}) or re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*((?:DRAINED|MOVEMENT)_[A-Z_]+)\s*$',ro,re.M)!=['DRAINED_RACE_ASSERT_PROVEN','DRAINED_RACE_WAIT_PROVEN','MOVEMENT_RACE_CLAIM_PROVEN','DRAINED_RACE_FINAL_PROVEN']:raise RuntimeError('real custody/movement overlap failed: '+mode)
   e.report['races'].append({'case':mode,'actual_wait':True,'effects_proven':True});e.discard(case)
  for p,d in manifest['source_sha256'].items():
   if sha(root/p)!=d:raise RuntimeError('input changed: '+p)
  e.report.update(status='passed',failure=None);e.discard(db)
 except BaseException as ex:e.report['failure']=repr(ex)
 finally:
  for sig in n.CANCELLATION_SIGNALS:signal.signal(sig,signal.SIG_IGN)
  try:e.close()
  except BaseException as ex:e.report.update(status='failed',cleanup_failure=repr(ex))
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'RESULTS.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure','assertions','races','cleanup']}),flush=True)
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':sys.exit(main())
