#!/usr/bin/env python3
"""Local PG17 only: exact original cg LATERAL + current12 indexes/typed constraints.
No production connection, payer, official migration, planner forcing or source rewrite.
"""
import argparse,hashlib,json,os,subprocess,tempfile,uuid
from pathlib import Path
from decimal import Decimal
R=Path(__file__).resolve().parents[2]
F=R/'scripts/ci/fixtures/private-cash-record-cover'
FIXTURE=F/'source-table.json'
ORIGINAL=F/'original-cg.sql'
INDEX='accounting_cash_private_record_facts_cover'
C='10000000-0000-0000-0000-000000000001';FOREIGN='10000000-0000-0000-0000-000000000002';U='10000000-0000-0000-0000-000000000003'
T='2026-10-19 07:00:00+00';END='2026-10-26 07:00:00+00'
def lit(s):return "'"+str(s).replace("'","''")+"'"
def uid(s):return str(uuid.UUID(hashlib.md5(s.encode()).hexdigest()))
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def nodes(n):
 yield n
 for c in n.get('Plans',[]):yield from nodes(c)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--scratch',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--pg-bin',type=Path,default=Path('/opt/homebrew/opt/postgresql@17/bin'));a=parser.parse_args()
 assert a.scratch.is_dir() and not a.output.exists()
 receipt=json.loads((F/'source-receipt.json').read_text());cg=ORIGINAL.read_text().strip()
 assert hashlib.sha256(cg.encode()).hexdigest()==receipt['exact_original_cg_sha256']
 assert cg.endswith('OFFSET 0') and 'FROM public.accounting_cash_rake_sources s' in cg
 migration=R/receipt['migration_file'];candidate=migration.read_text()
 cases=[]
 with tempfile.TemporaryDirectory(prefix='cash-record-',dir=a.scratch)as temporary:
  tmp=Path(temporary);data=tmp/'data';pg=a.pg_bin
  env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(PGHOST=str(tmp),PGUSER='postgres',PGDATABASE='postgres',PGSSLMODE='disable',TMPDIR=str(tmp))
  def run(cmd,sql=None,error=None):
   r=subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,env=env,timeout=120)
   assert (r.returncode and error in r.stderr)if error else r.returncode==0,(r.stdout,r.stderr,error)
   return r.stdout.strip()
  ps=[pg/'psql','-XAtq','-v','ON_ERROR_STOP=1']
  def q(sql,error=None):return run(ps,sql,error)
  def js(sql):return json.loads(q(sql),parse_float=Decimal)
  run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
  with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(tmp)+"'\nshared_buffers='16MB'\nmaintenance_work_mem='16MB'\ntemp_file_limit='128MB'\n")
  run([pg/'pg_ctl','-D',data,'-l',tmp/'postgres.log','-w','start'])
  try:
   catalog=json.loads(FIXTURE.read_text())
   assert len(catalog['indexes'])==12
   q('CREATE SCHEMA auth;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE TABLE clubs(id uuid PRIMARY KEY);CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE accounting_cash_accrual_batches(rake_record_id uuid PRIMARY KEY);')
   cols=[]
   for column in catalog['columns']:
    cols.append('"'+column['name']+'" '+column['type']+(' DEFAULT '+column['default'] if column.get('default') else '')+(' NOT NULL'if column['not_null']else''))
   q('CREATE TABLE accounting_cash_rake_sources('+','.join(cols)+');')
   for constraint in catalog['constraints']:q('ALTER TABLE accounting_cash_rake_sources ADD CONSTRAINT "'+constraint['name']+'" '+constraint['definition']+';')
   for index in catalog['indexes']:
    name=index.split('INDEX ')[1].split(' ON ')[0]
    if q('SELECT to_regclass('+lit(name)+')IS NULL')=='t':q(index+';')
   assert q("SELECT count(*)FROM pg_index WHERE indrelid='accounting_cash_rake_sources'::regclass")=='12'
   q('ALTER TABLE accounting_cash_rake_sources ENABLE ROW LEVEL SECURITY;REVOKE ALL ON accounting_cash_rake_sources FROM PUBLIC,anon,authenticated,service_role;GRANT SELECT ON accounting_cash_rake_sources TO service_role;')
   q("CREATE SCHEMA smarter_private;CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(NULLIF(current_setting('fixture.frozen',true),'')::boolean,false)$$;CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('fixture.break',true),'')$$;CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('fixture.boundary',true),'')::uuid$$;CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(NULLIF(current_setting('fixture.source65',true),'')::boolean,true)$$;CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN COALESCE(NULLIF(current_setting('fixture.gen_null',true),''),'false')::boolean THEN NULL ELSE 'controlled-unchanged-generation' END$$;")
   q("INSERT INTO clubs VALUES('"+C+"'),('"+FOREIGN+"');INSERT INTO auth.users SELECT md5('p'||g)::uuid FROM generate_series(1,60013)g;INSERT INTO accounting_cash_accrual_batches SELECT md5('r'||g)::uuid FROM generate_series(1,10002)g;")
   q("INSERT INTO accounting_cash_rake_sources SELECT md5('s'||g)::uuid,md5('r'||((g-1)/6+1))::uuid,md5('p'||g)::uuid,CASE WHEN g%17=0 THEN '"+FOREIGN+"'::uuid ELSE '"+C+"'::uuid END,CASE WHEN g%19=0 THEN '"+U+"'::uuid END,CASE WHEN g%23=0 THEN '"+U+"'::uuid END,'"+T+"'::timestamptz+CASE WHEN g%29=0 THEN interval '1second' ELSE interval '0' END,(g%100)::numeric/100,jsonb_build_object('original_contract',repeat(md5('c'||g),32)), '2026-10-27'::timestamptz FROM generate_series(1,60000)g;")
   q("INSERT INTO accounting_cash_rake_sources SELECT md5('s'||g)::uuid,md5('r'||CASE WHEN g<=60006 THEN 10001 ELSE 10002 END)::uuid,md5('p'||g)::uuid,CASE WHEN g<=60006 THEN '"+C+"'::uuid ELSE '"+FOREIGN+"'::uuid END,NULL,NULL,'"+T+"'::timestamptz,CASE WHEN g<=60006 THEN 0 ELSE 0.50 END,jsonb_build_object('original_contract','zero-or-foreign'), '2026-10-27'::timestamptz FROM generate_series(60001,60012)g;")
   q('VACUUM ANALYZE accounting_cash_rake_sources;')
   def query(record,coord=None,source='cash_rake_accrual',time=T):
    return 'WITH period AS(SELECT '+lit(C)+'::uuid club_id,'+('NULL::uuid'if coord is None else lit(coord)+'::uuid')+' union_id),b AS(SELECT '+lit(source)+'::text source_type,'+lit(record)+'::uuid source_group,'+lit(time)+'::timestamptz banked_at) SELECT row_to_json(cg) FROM period,b CROSS JOIN LATERAL('+cg+')cg'
   point=query(uid('r1'))
   before_plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+point))
   assert any(n.get('Node Type')in('Index Scan','Bitmap Heap Scan')and n.get('Relation Name')=='accounting_cash_rake_sources'for n in nodes(before_plan[0]['Plan'])),'baseline must actually access heap naturally; no planner forcing'
   cases.append('original_exact_cg_before_natural_heap_access')
   queries=[query(uid('r'+str(i)),coord)for coord in [None,U]for i in [1,3,4,5,7,8,11,12,10000]]+[query(uid('missing')),query(uid('r1'),source='tournament_fee_accrual'),query(uid('r1'),time=END),query(uid('r10001')),query(uid('r10002'))]
   before=[js(sql)for sql in queries]
   expected=[]
   for coord in [None,U]:
    for record in [1,3,4,5,7,8,11,12,10000]:
     group=list(range((record-1)*6+1,record*6+1))
     expected.append({'n':6,'total':sum((Decimal(g%100)/100 for g in group),Decimal(0)),'bad':sum(g%17==0 or g%19==0 or (U if g%23==0 else None)!=coord or g%29==0 for g in group),'mine':any(g%17!=0 and (U if g%23==0 else None)==coord for g in group)})
   expected += [{'n':0,'total':None,'bad':0,'mine':None}]*2+[{'n':6,'total':sum((Decimal(g%100)/100 for g in range(1,7)),Decimal(0)),'bad':6,'mine':True},{'n':6,'total':Decimal(0),'bad':0,'mine':True},{'n':6,'total':Decimal('3.00'),'bad':6,'mine':False}]
   assert before==expected,(before,expected)
   cases += ['independent_original_cg_exact_count_sum_bad_mine','foreign_club_union_mixed_coordinator_NULL_nonNULL_time_bad_preserved','n0_and_non_cash_group_NULL_aggregates_preserved','zero_source_amount_and_all_foreign_skip_inputs_preserved']
   full_query='WITH period AS(SELECT '+lit(C)+'::uuid club_id,NULL::uuid union_id),b AS(SELECT \'cash_rake_accrual\'::text source_type,rake_record_id source_group,'+lit(T)+'::timestamptz banked_at FROM accounting_cash_accrual_batches) SELECT jsonb_agg(to_jsonb(g)ORDER BY source_group) FROM(SELECT b.source_group,cg.* FROM period,b CROSS JOIN LATERAL('+cg+')cg)g'
   full_before_raw=q(full_query);full_before=json.loads(full_before_raw,parse_float=Decimal)
   full_expected=[]
   for record in range(1,10001):
    group=list(range((record-1)*6+1,record*6+1))
    full_expected.append({'source_group':uid('r'+str(record)),'n':6,'total':sum((Decimal(g%100)/100 for g in group),Decimal(0)),'bad':sum(g%17==0 or g%19==0 or g%23==0 or g%29==0 for g in group),'mine':any(g%17!=0 and g%23!=0 for g in group)})
   full_expected.extend([{'source_group':uid('r10001'),'n':6,'total':Decimal(0),'bad':0,'mine':True},{'source_group':uid('r10002'),'n':6,'total':Decimal(3),'bad':6,'mine':False}])
   assert full_before==sorted(full_expected,key=lambda x:x['source_group']),'whole original10002record cg bag differs independent source oracle'
   cases.append('FULL10002record_original_cg_bag_independent_oracle_all_count_sum_bad_mine')
   whole="SELECT md5(string_agg(md5(to_jsonb(s)::text),''ORDER BY id))FROM accounting_cash_rake_sources s"
   keybag="SELECT jsonb_build_object('count',count(*),'md5',md5(string_agg(rake_record_id::text||player_id::text,''ORDER BY rake_record_id,player_id)))FROM accounting_cash_rake_sources"
   metadata="SELECT jsonb_build_object('class',to_jsonb(c)-'relpages'-'reltuples'-'relallvisible','columns',(SELECT jsonb_agg(to_jsonb(a)ORDER BY attnum)FROM pg_attribute a WHERE a.attrelid=c.oid),'constraints',(SELECT jsonb_agg(to_jsonb(n)ORDER BY n.oid)FROM pg_constraint n WHERE n.conrelid=c.oid))FROM pg_class c WHERE c.oid='accounting_cash_rake_sources'::regclass"
   indexes="SELECT jsonb_agg(jsonb_build_object('catalog',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid))ORDER BY i.indexrelid)FROM pg_index i WHERE i.indrelid='accounting_cash_rake_sources'::regclass AND i.indexrelid<>COALESCE(to_regclass('"+INDEX+"'),0::oid)"
   fingerprint=q(whole);keys=q(keybag);meta=q(metadata);old_indexes=q(indexes)
   split="import{splitConcurrentPreamble}from"+json.dumps((R/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));"
   parts=json.loads(run(['node','--input-type=module','-e',split,migration]));assert parts['ok']and len(parts['indexes'])==1
   statement=parts['indexes'][0]['statement'];body=parts['body']
   authority_sql="SELECT jsonb_agg(to_jsonb(p)ORDER BY p.oid)FROM pg_proc p WHERE p.oid IN('smarter_private.original_inventory_proof_sources_match()'::regprocedure,'smarter_private.original_inventory_basis_generation()'::regprocedure)"
   authority_before=q(authority_sql)
   q(statement);q(body)
   assert q(authority_sql)==authority_before;cases.append('maintained_CCI_parser_and_guarded_installer_preserve_controlled_authority_metadata')
   after=[js(sql)for sql in queries]
   assert q(full_query)==full_before_raw,'whole original10002record cg bag changed after index'
   cases.append('FULL10002record_original_cg_bag_byte_equal_before_after')
   assert after==before and q(whole)==fingerprint and q(keybag)==keys and q(metadata)==meta and q(indexes)==old_indexes
   cases+=['all_original_raw_contract_rows_and_record_player_keys_byte_fingerprint_unchanged','full_table_columns_constraints_owner_RLS_ACL_and_all12_index_catalogs_unchanged']
   after_plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+point))
   cover=[n for n in nodes(after_plan[0]['Plan'])if n.get('Index Name')==INDEX]
   assert cover and all(n['Node Type']=='Index Only Scan'and n['Heap Fetches']==0 for n in cover),'natural point plan must use new scalar cover with zero heap fetches'
   cases.append('original_exact_cg_after_natural_IndexOnly_zeroheap_no_forcing')
   index_catalog=js("SELECT jsonb_build_object('keys',indnkeyatts,'attrs',indnatts,'valid',indisvalid,'ready',indisready,'live',indislive,'unique',indisunique,'partial',indpred IS NOT NULL,'expressions',indexprs IS NOT NULL,'definition',pg_get_indexdef(indexrelid))FROM pg_index WHERE indexrelid='"+INDEX+"'::regclass")
   assert index_catalog['keys']==1 and index_catalog['attrs']==6 and index_catalog['valid']and index_catalog['ready']and index_catalog['live']and not index_catalog['partial']and not index_catalog['expressions']and not index_catalog['unique']
   cases.append('exact_nonpartial_one_key_five_scalar_include_catalog')
   for sql,error in [("UPDATE accounting_cash_rake_sources SET rake_credit='NaN'WHERE id=md5('s1')::uuid",'violates check constraint'),("UPDATE accounting_cash_rake_sources SET rake_credit='Infinity'WHERE id=md5('s1')::uuid",'violates check constraint'),("UPDATE accounting_cash_rake_sources SET rake_credit=-0.01 WHERE id=md5('s1')::uuid",'violates check constraint'),("UPDATE accounting_cash_rake_sources SET rake_credit=0.001 WHERE id=md5('s1')::uuid",'violates check constraint'),("UPDATE accounting_cash_rake_sources SET earned_at=NULL WHERE id=md5('s1')::uuid",'not-null constraint'),('INSERT INTO accounting_cash_rake_sources SELECT*FROM accounting_cash_rake_sources LIMIT 1','duplicate key')]:q(sql,error)
   assert q(whole)==fingerprint;cases.append('original_nonfinite_negative_subcent_NULL_duplicate_refusals_atomic')
   q('SET ROLE anon;SELECT*FROM accounting_cash_rake_sources','permission denied');cases.append('original_anon_permission_refusal')
   q(statement);q(body);assert q(whole)==fingerprint and q(authority_sql)==authority_before;cases.append('maintained_CCI_replay_exact_catalog_no_source_changes')
   for label,setup,error in [
    ('operator',"SET LOCAL request.jwt.claims='{}';",'private_record_cover_operator_refused'),
    ('override',"SET LOCAL ca.break_window_migration_override='not-authorized';",'private_record_cover_operator_refused'),
    ('source65',"SET LOCAL fixture.source65='false';",'private_record_cover_source65_required'),
    ('generation',"SET LOCAL fixture.gen_null='true';",'private_record_cover_generation_required'),
    ('freeze',"SET LOCAL fixture.frozen='true';",'private_record_cover_window_refused'),
    ('break',"SET LOCAL fixture.break='break';",'private_record_cover_window_refused'),
    ('boundary',"SET LOCAL fixture.boundary='"+U+"';",'private_record_cover_window_refused'),
    ('table_ACL',"GRANT INSERT ON accounting_cash_rake_sources TO service_role;",'private_record_cover_source_access_refused'),
    ('default',"ALTER TABLE accounting_cash_rake_sources ALTER COLUMN recorded_at SET DEFAULT now();",'private_record_cover_columns_refused'),
    ('constraint',"ALTER TABLE accounting_cash_rake_sources DROP CONSTRAINT accounting_cash_rake_sources_rake_credit_check;",'private_record_cover_constraints_refused'),
    ('existing_index',"UPDATE pg_index SET indisvalid=false WHERE indexrelid='accounting_cash_private_deposit_keys_cover'::regclass;",'private_record_cover_existing_indexes_refused'),
    ('candidate',"UPDATE pg_index SET indisvalid=false WHERE indexrelid='"+INDEX+"'::regclass;",'private_record_cover_exact_catalog_required')]:
    q('BEGIN;'+setup+body,error)
    assert q(whole)==fingerprint and q(metadata)==meta and q(indexes)==old_indexes and q(authority_sql)==authority_before
    cases.append('actual_installer_'+label+'_refusal_atomic')
   # Existing physical cover does not alter repeatable-read MVCC visibility.
   reader=subprocess.Popen(list(map(str,ps)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
   reader.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'+point+";\nSELECT 'SNAPSHOT_READY';\n");reader.stdin.flush()
   first=reader.stdout.readline().strip();assert reader.stdout.readline().strip()=='SNAPSHOT_READY'
   q("INSERT INTO accounting_cash_rake_sources SELECT md5('new-concurrent-source')::uuid,rake_record_id,md5('p60013')::uuid,club_id,union_id,coordinator_union_id,earned_at,0.50,contract,recorded_at FROM accounting_cash_rake_sources WHERE id=md5('s1')::uuid;")
   reader.stdin.write(point+";\nROLLBACK;\n");reader.stdin.close();second=reader.stdout.readline().strip();reader.wait(timeout=10)
   assert reader.returncode==0 and first==second and js(point)['n']==before[0]['n']+1 and js(point)['total']==before[0]['total']+Decimal('0.50')
   cases.append('real_two_connection_repeatable_read_source_insert_snapshot_consistency')
   result={'qualification':'passed','case_count':len(cases),'cases':cases,'candidate_sha256':digest(migration),'runner_sha256':digest(__file__),'schema_fixture_sha256':digest(FIXTURE),'original_full_query_sha256':receipt['original_whole_private_query_sha256'],'exact_cg_sha256':hashlib.sha256(cg.encode()).hexdigest(),'before_plan':before_plan,'after_plan':after_plan,'index_catalog':index_catalog,'whole_original_cg_bag_count':len(full_before),'whole_original_cg_bag_sha256':hashlib.sha256(full_before_raw.encode()).hexdigest(),'original_key_bag':json.loads(keys),'raw_contract_row_fingerprint':fingerprint,'original_count_sum_bad_mine':before,'limits':'SOURCE ONLY. Current actual typed columns/defaults/NOTNULL/CHECK/PK/unique/FK and all12 indexes including14525; referenced FK tables are ID-only endpoints. Actual source producer/immutability/diamond triggers are catalog-preserved as evidence but not installed in this read-access fixture; INSERT/UPDATE refusal and MVCC cases qualify constraints/read semantics only, not producer acceptance. Exact original cash cg scalar aggregate extracted without rewrite. No tournament branch, ledger/verdict, whole summary, actual source65/GEN functions or external maintenance guards (controlled here), production timing or book closure qualification. Candidate changes no public function or permission; native controlled external authority metadata before/after is preserved, not actual full65/GEN execution. IndexOnly0heap demonstrated on vacuumed fixture; concurrent/dirty production pages can require visibility heap checks.'}
   a.output.parent.mkdir(parents=True,exist_ok=True)
   with a.output.open('x')as f:json.dump(result,f,indent=2,default=str);f.write('\n')
   print(json.dumps({'qualification':result['qualification'],'case_count':len(cases),'cases':cases,'output':str(a.output)}))
  finally:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
if __name__=='__main__':main()
