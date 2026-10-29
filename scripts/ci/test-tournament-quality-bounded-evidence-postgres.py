#!/usr/bin/env python3
"""Private PG17 exact migration/authority qualification; never calls business owners.
Physical partition bags and source-query errors reuse the unchanged recorded proofs.
Native catalog OIDs, history and inert external guard collaborators are explicit
fixtures, not production install or full-week capacity evidence.
"""
import argparse,copy,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
from cash_native_guard import bootstrap
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/tournament-quality-bounded-evidence'
def lit(x):return "'"+str(x).replace("'","''")+"'"
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')));ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args();assert __debug__ and a.scratch.is_dir()and not a.output.exists()
 w=Path(tempfile.mkdtemp(prefix='tqc-',dir=a.scratch.resolve()));assert len(str(w).encode())<90;d=w/'d';started=False;cases=[]
 env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(TMPDIR=str(w),TMP=str(w),TEMP=str(w),LC_ALL='C');ps=[a.pg_bin/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',w,'-U','postgres','-d','postgres']
 def run(args,sql=None,error=None):
  p=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=90);assert (p.returncode!=0 and error in p.stderr)if error else p.returncode==0,(p.stdout[-2000:],p.stderr[-6000:]);return p.stdout.strip()
 def q(s,error=None):
  path=w/'statement.sql';path.write_text(s)
  return run([*ps,'-f',path],None,error)
 def js(s):return json.loads(q(s))
 def ok(s):cases.append(s);print('PASS',s,flush=True)
 old=json.loads((F/'owners41-before.json').read_text());new=json.loads((F/'owners41-after.json').read_text());physical=json.loads((F/'physical-installed.json').read_text());candidate=(F/'candidate.sql').read_text();original=(F/'original.sql').read_text();source=(R/'supabase/migrations/20261029230441_tournament_quality_reads_bounded_rake_evidence.sql').read_text()
 assert hashlib.md5(original.encode()).hexdigest()=='28a130f35342357a4dfa61043f1ce2a2'and hashlib.md5(candidate.encode()).hexdigest()=='ba40f5f1f0aedf382134f246e8297e26'
 assert sum(x!=y for x,y in zip(old,new))==1 and len(old)==41
 try:
  assert ' 17.'in run([a.pg_bin/'postgres','--version']);run([a.pg_bin/'initdb','-D',d,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
  with(d/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(w)+"'\nshared_buffers='16MB'\n")
  run([a.pg_bin/'pg_ctl','-D',d,'-l',w/'server.log','-w','start']);started=True
  q('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA smarter_private;GRANT USAGE ON SCHEMA smarter_private TO service_role;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);CREATE TABLE ca_guard_defs(proname text);SET check_function_bodies=off;')
  history_prerequisites=json.loads((F/'history-prerequisites.json').read_text());extra_history=set(history_prerequisites[0]['metadata'])-{'version','name'}
  for key in sorted(extra_history):
   assert re.fullmatch('[a-z_]+',key)and all(h['metadata'][key]is None for h in history_prerequisites);q('ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN "'+key+'" jsonb;')
  cols=json.loads((R/'scripts/ci/fixtures/rake-record-bounded-cover/authority.json').read_text())['columns'];q('CREATE TABLE rake_records('+','.join(c['attribute']['attname']+' '+c['type']for c in cols)+');')
  outcome_cols=json.loads((R/'scripts/ci/fixtures/original-shaped-cash-boolgate/meaningful-table-contract.json').read_text())['columns'];q('CREATE TABLE union_pnl_cash_outcomes('+','.join(c['name']+' '+c['type']for c in outcome_cols)+');')
  for owner in old:
   if owner['metadata']['prolang']=='12':continue
   q('SET check_function_bodies=off;'+owner['definition']+';')
   sig=owner['signature'];q('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;')
   # Existing private native dependencies do not execute production financial bodies.
  q("CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('native.source65',true)IS DISTINCT FROM 'off'$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT 'original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'::text$$;CREATE OR REPLACE FUNCTION fn_ca_guard_watchlist()RETURNS text[]LANGUAGE sql STABLE AS $$SELECT ARRAY[]::text[]$$;CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.window_refusal',true),'')$$;CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT null::timestamptz$$;")
  q((R/'scripts/ci/fixtures/rake-record-bounded-cover/helper.sql').read_text());q('REVOKE ALL ON FUNCTION smarter_private.rake_record_jsonb_raw_size(jsonb)FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION smarter_private.rake_record_jsonb_raw_size(jsonb)TO service_role;')
  # Only the new physical guard logic is tested here. The exact real two CCI
  # bodies and actual20/8/19/39 physical schema are qualified by the retained17.
  q('CREATE INDEX rake_records_tournament_small_evidence_cover ON rake_records(tournament_id,id);CREATE INDEX rake_records_tournament_large_evidence_keys ON rake_records(tournament_id,id);')
  for p in sorted((R/'supabase/migrations').glob('202610291804*.sql')):q('INSERT INTO supabase_migrations.schema_migrations(version,name,statements)VALUES('+lit(p.name[:14])+','+lit(p.name[15:-4])+',ARRAY['+lit(p.read_text())+']);')
  cash=bootstrap(q,js,R/'scripts/ci/fixtures/cash-refusal-scope-time')
  cash['install_fixture_prerequisites'](R)
  signatures=[x['signature']for x in old]
  def owners():return js("SELECT jsonb_agg(jsonb_build_object('signature',v.signature,'definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p))ORDER BY v.ordinality)FROM jsonb_array_elements_text("+lit(json.dumps(signatures))+"::jsonb)WITH ORDINALITY v(signature,ordinality)JOIN pg_proc p ON p.oid=to_regprocedure(v.signature)")
  native_old=owners();assert len(native_old)==41
  # q calls use independent sessions, so capture postimage in one transaction.
  native_new=js('BEGIN;SET LOCAL check_function_bodies=off;'+candidate+';SELECT jsonb_agg(jsonb_build_object(\'signature\',v.signature,\'definition\',pg_get_functiondef(p.oid),\'metadata\',to_jsonb(p))ORDER BY v.ordinality)FROM jsonb_array_elements_text('+lit(json.dumps(signatures))+'::jsonb)WITH ORDINALITY v(signature,ordinality)JOIN pg_proc p ON p.oid=to_regprocedure(v.signature);ROLLBACK;')
  # Restore original after the explicit private postimage capture.
  q('SET check_function_bodies=off;'+original+';')
  assert sum(x!=y for x,y in zip(native_old,native_new))==1
  observed_old=next(x for x in native_old if x['metadata']['proname']=='fn_accounting_tournament_week_quality');observed_new=next(x for x in native_new if x['metadata']['proname']=='fn_accounting_tournament_week_quality');assert observed_old['definition']==original and observed_new['definition']==candidate and hashlib.md5(observed_new['metadata']['prosrc'].encode()).hexdigest()=='6830362a7dc8bb5354dc6113a2fed4b1'
  for x,y in zip(native_old,native_new):
   if x!=y:assert {k:v for k,v in x['metadata'].items()if k!='prosrc'}=={k:v for k,v in y['metadata'].items()if k!='prosrc'}
  ok('exact_public_TQ_original_and_candidate_compile_ABI_ACL_security_metadata_preserved')
  # Render the exact physical SELECT into a native snapshot using the same SQL.
  guard=(F/'physical-guard.sql').read_text();at=guard.index(' expected:=');end=guard.index(' IF payload IS DISTINCT',at);capture=guard[at:end]
  proc=subprocess.run(list(map(str,ps)),input='DO $$DECLARE expected jsonb:=\'{"authority":{}}\'::jsonb;actual jsonb;payload jsonb;BEGIN '+capture+"RAISE NOTICE 'SNAP:%',payload;END$$;",text=True,capture_output=True,env=env,timeout=30);assert proc.returncode==0,proc.stderr
  native_phys=json.loads(next(l.split('SNAP:',1)[1]for l in proc.stderr.splitlines()if'SNAP:'in l))
  def compact(x):return json.dumps(x,separators=(',',':'))
  def adapt_sql(sql):return sql.replace(compact(old),compact(native_old)).replace(compact(new),compact(native_new)).replace(compact(physical),compact(native_phys))
  base_adapt=adapt_sql
  def adapt_sql(sql):return cash['adapt'](base_adapt(sql))
  adapted=adapt_sql(source);assert adapted!=source
  def read_catalog(state):
   sql=adapt_sql((F/('reader-'+state+'.sql')).read_text());input_file=w/('reader-'+state+'.sql');input_file.write_text(sql);output_file=w/('reader-'+state+'.log')
   with output_file.open('w')as log:z=subprocess.run(list(map(str,ps))+['-f',str(input_file)],stdout=log,stderr=log,text=True,env=env,timeout=90)
   text=output_file.read_text();assert z.returncode==0 and 'TQ_CONSUMER_READ_POSTGUARD_PASS'in text and 'ROLLBACK'in sql,text[-5000:]
   rows=[line.split('TQ_CONSUMER_READ:',1)[1]for line in text.splitlines()if'TQ_CONSUMER_READ:'in line];assert len(rows)==1;return json.loads(rows[0])
  read_before=read_catalog('before');assert read_before['owners']==native_old and read_before['history']is None
  # New body is parsed with real PL/pgSQL and compiled, but not invoked.
  adapted=adapted.replace('BEGIN;','BEGIN;SET LOCAL check_function_bodies=off;',1)
  applier=(R/'scripts/ci/apply-recorded-migration.mjs').read_text();template=re.search(r'const historyStatement = `([\s\S]*?)`;',applier).group(1);tag='$ca_file_history_20261029230441$';history=template.replace('${version}','20261029230441').replace('${slug}','tournament_quality_reads_bounded_rake_evidence').replace('${exactSQLLiteral}',tag+source+tag)
  before=owners();q(adapted.rsplit('COMMIT;',1)[0]+history+'COMMIT;');assert owners()==native_new;ok('whole_exact_migration_atomic_commit_changes_only_one_prosrc_native_catalog')
  read_after=read_catalog('after');assert read_after['owners']==native_new and read_after['history']['statements']==[source]and read_after['source65']is True and read_before['generation']==read_after['generation'];ok('exact_before_after_readers_execute_full_guards_and_capture_applier_exact_history')
  q(adapted,'tq_owner_changed');assert owners()==native_new;ok('installed_owner_replay_refuses_without_second_effect')
  q("DELETE FROM supabase_migrations.schema_migrations WHERE version='20261029230441';SET check_function_bodies=off;"+original+';');assert owners()==before
  for prefix in ['SET ROLE service_role;',"SET request.jwt.claims='{}';"]:
   q(prefix+adapted,'tq_operator_refused');assert owners()==before
  ok('nonowner_role_and_JWT_migration_attempts_refused_before_replacement')
  for setup,error in [("SET LOCAL native.source65='off';",'tq_original_source65_GEN_changed'),("SET LOCAL native.window_refusal='refused';",'tq_window_refused'),('ALTER FUNCTION smarter_private.rake_record_jsonb_raw_size(jsonb)COST 101;','tq_physical_authority_changed'),("DELETE FROM supabase_migrations.schema_migrations WHERE version='20261029180421';",'tq_exact_physical_history_required')]:
   q(adapted.replace('BEGIN;','BEGIN;'+setup,1),error);assert owners()==before
  ok('source_generation_window_helper_fullmetadata_and_protected_history_fail_closed_rollback')
  broken=copy.deepcopy(native_new);target=next(x for x in broken if x['metadata']['proname']=='fn_accounting_tournament_week_quality');target['metadata']['procost']=101
  q(adapted.replace(compact(native_new),compact(broken)),'tq_owner_changed');assert owners()==before;ok('postguard_failure_restores_original_owner_and_all41_metadata')
  for role in ['anon','authenticated','service_role']:q('SET ROLE '+role+';SELECT fn_accounting_tournament_week_quality(NULL,NULL,NULL);','permission denied')
  ok('all_three_nonowner_roles_still_refused_without_business_execution')
  result={'qualification':'passed','cases':cases,'migration_sha256':hashlib.sha256(source.encode()).hexdigest(),'candidate_md5':'ba40f5f1f0aedf382134f246e8297e26','limits':'Native41 catalog OIDs and physical catalog expected payload explicitly adapted; source65/window/watchlist inert collaborators. No business function invocation, paid rows, production installation or whole-week capacity evidence.'};a.output.write_text(json.dumps(result,indent=2)+'\n')
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',d,'-m','immediate','-w','stop'])
  shutil.rmtree(w)
if __name__=='__main__':main()
