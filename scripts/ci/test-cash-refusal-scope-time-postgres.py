#!/usr/bin/env python3
"""Private PG17 exact migration/authority qualification; never calls business owners.
Physical partition bags and source-query errors reuse the unchanged recorded proofs.
Native catalog OIDs, history and inert external guard collaborators are explicit
fixtures, not production install or full-week capacity evidence.
"""
import argparse,copy,hashlib,json,os,re,shutil,subprocess,tempfile
from cash_native_guard import bootstrap
from pathlib import Path
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
 old=json.loads((F/'owners41-before.json').read_text());new=json.loads((F/'owners41-after.json').read_text());physical=json.loads((F/'physical-installed.json').read_text());candidate=(F/'candidate.sql').read_text();original=(F/'original.sql').read_text();source=next((R/'supabase/migrations').glob('*_tournament_quality_reads_bounded_rake_evidence.sql')).read_text()
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
  baseadapt=adapt_sql
  def adapt_sql(sql):return cash['adapt'](baseadapt(sql))
  CF=R/'scripts/ci/fixtures/cash-refusal-scope-time'
  ixfile,stfile,fnfile=cash['files'](R);ixsource=ixfile.read_text();stsource=stfile.read_text();fnsource=fnfile.read_text();ixbody=adapt_sql(ixsource[ixsource.index('BEGIN;'):]);stbody=adapt_sql(stsource);fnbody=adapt_sql(fnsource)
  def history(file):return "INSERT INTO supabase_migrations.schema_migrations(version,name,statements)VALUES("+lit(file.name[:14])+','+lit(file.name[15:-4])+',ARRAY['+lit(file.read_text())+']);'
  def state():return {'owners':owners(),'cash':cash['owner'](),'authority':cash['capture']()}
  def observer(stage):
   text=adapt_sql((CF/('reader-'+stage+'.sql')).read_text());path=a.output.parent/('reader-'+stage+'-native.sql');path.write_text(text);log=a.output.parent/('reader-'+stage+'-native.log')
   # Drop q only: exact psql command tags prove literal terminal ROLLBACK.
   cmd=[str(x).replace('-XqAt','-XAt')for x in ps]+['-f',str(path)]
   with log.open('w')as f:proc=subprocess.run(cmd,stdout=f,stderr=f,text=True,env=env,timeout=90)
   out=log.read_text();assert proc.returncode==0 and 'CASH_ACCESS_POSTGUARDS_PASS'in out and re.search(r'(^|\n)ROLLBACK\s*(?:\n|$)',out),out[-2000:]
   return log
  cash['seed_fixture']()
  beforelog=observer('before')
  baseline=state();ok('actual_cash12_and6_columns_7and5_constraints_6oldindexes_10rawtriggers_native_fullmetadata')
  q(ixsource[:ixsource.index('BEGIN;')]);q(ixbody.rsplit('COMMIT;',1)[0]+history(ixfile)+'COMMIT;');assert state()==baseline;ok('exact_CCI_and_full_postguard_history_commit_preserve_all42owners_schema')
  indexlog=observer('index')
  q(fnbody,'cash_refusal_exact_expression_statistics_history_required');assert state()==baseline;ok('missing_statistics_history_refuses_function_without_change')
  q(fnbody.replace('BEGIN;','BEGIN;'+history(stfile),1),'cash_refusal_real_expression_statistics_required');assert state()==baseline;ok('missing_real_collected_stats_with_history_refuses_function')
  assert q("SELECT count(*)FROM pg_statistic WHERE starelid='accounting_cash_receipts_scope_time_keys'::regclass;")=='0'
  q(stbody.replace('COMMIT;','ROLLBACK;'));assert q("SELECT count(*)FROM pg_statistic_ext WHERE stxname='accounting_cash_receipts_scope_distribution';")=='0';ok('exact_new_stats_migration_rollback_removes_object_and_data')
  q(stbody.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'native_stats_post_failure';END$$;COMMIT;"),'native_stats_post_failure');assert q("SELECT count(*)FROM pg_statistic_ext WHERE stxname='accounting_cash_receipts_scope_distribution';")=='0';ok('stats_postfailure_atomic_no_orphan')
  q(stbody.rsplit('COMMIT;',1)[0]+history(stfile)+'COMMIT;');assert state()==baseline;statisticslog=observer('statistics');ok('exact_singleCASE_stats_and_narrow3column_ANALYZE_collect_real_data')
  q(stbody,'cash_expression_statistics_already_recorded');ok('statistics_history_replay_refuses')
  q(fnbody.rsplit('COMMIT;',1)[0]+history(fnfile)+'COMMIT;');assert cash['owner']()==cash['after'] and cash['capture']()==baseline['authority'] and owners()==baseline['owners'];ok('exact_function_migration_atomic_commit_preserves_ABI_ACL_and_all_other_sources')
  functionlog=observer('function');ok('exact_four_catalog_readers_execute_all_guards_and_real_ROLLBACK_tags')
  # Offline strict verifier uses only explicitly adapted native catalog OIDs/payloads.
  vf=a.output.parent/(a.output.stem+'-native-verifier-worktree');vff=vf/'scripts/ci/fixtures/cash-refusal-scope-time';vff.mkdir(parents=True,exist_ok=True);(vf/'supabase/migrations').mkdir(parents=True,exist_ok=True)
  for name,val in [('authority.json',cash['authority']),('function-before.json',cash['before']),('function-after.json',cash['after'])]:(vff/name).write_text(json.dumps(val))
  (vff/'index-canonical.sql').write_text((CF/'index-canonical.sql').read_text());(vff/'statistics-canonical.json').write_text((CF/'statistics-canonical.json').read_text())
  for f in [ixfile,stfile,fnfile]:(vf/'supabase/migrations'/f.name).write_text(f.read_text())
  verifier=(R/'scripts/ci/verify-cash-access-install.py').read_text();role=q("SELECT 'postgres'::regrole::oid;");assert verifier.count("=='16384'")==1;verifier=verifier.replace("=='16384'","=="+repr(role));vp=a.output.parent/'verify-cash-access-native-catalog.py';vp.write_text(verifier)
  for stage,b,z in [('index',beforelog,indexlog),('statistics',indexlog,statisticslog),('function',statisticslog,functionlog)]:run(['python3',vp,'--before',b,'--after',z,'--stage',stage,'--worktree',vf]);
  ok('strict_index_and_function_offline_verifiers_pass_native_catalog_adapter')
  q(fnbody,'cash_refusal_owner_changed');assert cash['owner']()==cash['after'];ok('actual_installed_replay_refuses_original_preimage_without_second_effect')
  # Restore private fixture to original owner; no business rows exist or execute.
  q("DELETE FROM supabase_migrations.schema_migrations WHERE version='"+fnfile.name[:14]+"';SET check_function_bodies=off;"+(CF/'original.sql').read_text()+';');assert state()==baseline
  for prefix in ['SET ROLE service_role;',"SET request.jwt.claims='{}';"]:q(prefix+fnbody,'tq_operator_refused');assert state()==baseline
  ok('nonowner_role_and_JWT_refusals_preserve_all_catalogs')
  for setup,error in [('ALTER TABLE accounting_cash_source_receipts ADD COLUMN native_drift int;','cash_refusal_schema_authority_changed'),('ALTER INDEX accounting_cash_receipts_refusal_cover RENAME TO native_old_cover;','cash_refusal_schema_authority_changed'),("DELETE FROM supabase_migrations.schema_migrations WHERE version='20261029211338';",'cash_refusal_exact_selector_history_required')]:
   q(fnbody.replace('BEGIN;','BEGIN;'+setup,1),error);assert state()==baseline
  ok('new_schema_oldindex_and_exacthistory_drift_refuse_atomically')
  # New post-owner guard must fail after replacement and roll back original prosrc/metadata.
  cand=(CF/'candidate.sql').read_text();assert cand in fnbody
  q(fnbody.replace(cand,cand+';ALTER FUNCTION fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)COST 101;',1),'cash_refusal_owner_changed');assert state()==baseline
  ok('postguard_cost_fault_rolls_back_replacement_and_all42metadata')
  # Current finite-scope owner regression is additive; historical migration evidence stays exact.
  finite_output=a.output.with_name(a.output.stem+'-finite-presence.json');assert not finite_output.exists()
  run(['python3',R/'scripts/ci/fixtures/cash-refusal-finite-presence/native-parity.py','--repo',R,'--pg-bin',a.pg_bin,'--scratch',a.scratch,'--output',finite_output])
  finite=json.loads(finite_output.read_text());assert finite['sixteen_native_scope_mode_bags_equal']and finite['four_invalid_scope_errors_preserved']and finite['portable_installer_controls']['passed']and len(finite['portable_installer_controls']['cases'])==6
  result={'status':'passed','cases':cases,'index_sha256':hashlib.sha256(ixsource.encode()).hexdigest(),'statistics_sha256':hashlib.sha256(stsource.encode()).hexdigest(),'function_sha256':hashlib.sha256(fnsource.encode()).hexdigest(),'limits':'Native OIDs/rawcatalog expected payload explicitly adapted using exactguardqueries; external source65/window collaborators controlled; zero business calls/bags rerun; no production installation/capacity claim.'};a.output.write_text(json.dumps(result,indent=2)+'\n')
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',d,'-m','immediate','-w','stop'])
  shutil.rmtree(w)
if __name__=='__main__':main()
