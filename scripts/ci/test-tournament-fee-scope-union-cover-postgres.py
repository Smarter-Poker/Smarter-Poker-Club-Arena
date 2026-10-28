#!/usr/bin/env python3
"""OWN localPG17 physical fee_scope candidate; never a production connection."""
from pathlib import Path
import argparse,hashlib,json,os,subprocess,tempfile,uuid
R=Path(__file__).resolve().parents[2]
FIXTURE_PATH=R/'scripts/ci/fixtures/tournament-fee-scope-union-cover'
AUTH=FIXTURE_PATH/'source-table.json'
SOURCE=FIXTURE_PATH/'original-fee-scope.sql'
INDEX='accounting_tournament_fee_scope_union_cover'
C='10000000-0000-0000-0000-000000000010';F='10000000-0000-0000-0000-000000000020';U1='10000000-0000-0000-0000-000000000001';U2='10000000-0000-0000-0000-000000000002'
def uid(s):return str(uuid.UUID(hashlib.md5(s.encode()).hexdigest()))
def lit(s):return "'"+str(s).replace("'","''")+"'"
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def walk(n):
 yield n
 for c in n.get('Plans',[]):yield from walk(c)
def main():
 p=argparse.ArgumentParser();p.add_argument('--scratch',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);a=p.parse_args();assert a.scratch.is_dir()and not a.out.exists()
 receipt=json.loads((FIXTURE_PATH/'source-receipt.json').read_text());aggregate=SOURCE.read_text().strip();assert hashlib.sha256(aggregate.encode()).hexdigest()==receipt['exact_original_aggregate_sha256']
 cases=[];pg=a.pg_bin;authority=json.loads(AUTH.read_text());assert(len(authority['columns']),len(authority['constraints']),len(authority['indexes']))==(15,5,12)
 migration=R/receipt['migration_file'];candidate=migration.read_text()
 with tempfile.TemporaryDirectory(prefix='fu-',dir=a.scratch)as temporary:
  tmp=Path(temporary);data=tmp/'d';env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(PGHOST=str(tmp),PGUSER='postgres',PGDATABASE='postgres',PGSSLMODE='disable',TMPDIR=str(tmp));ps=[pg/'psql','-XAtq','-v','ON_ERROR_STOP=1']
  def run(cmd,s=None,error=None):
   x=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,env=env,timeout=120);assert(x.returncode and error in x.stderr)if error else x.returncode==0,(x.stdout,x.stderr,error);return x.stdout.strip()
  def q(s,error=None):return run(ps,s,error)
  def js(s):return json.loads(q(s))
  run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
  with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(tmp)+"'\nshared_buffers='16MB'\nmaintenance_work_mem='16MB'\ntemp_file_limit='128MB'\n")
  run([pg/'pg_ctl','-D',data,'-l',tmp/'log','-w','start'])
  try:
   q('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE TABLE accounting_tournament_fee_batches(rake_record_id uuid PRIMARY KEY);CREATE TABLE fixture_candidates(tournament_id uuid PRIMARY KEY);')
   columns=[]
   for c in authority['columns']:
    columns.append('"'+c['name']+'" '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['not_null']else''))
   q('CREATE TABLE accounting_tournament_fee_sources('+','.join(columns)+');')
   for c in authority['constraints']:q('ALTER TABLE accounting_tournament_fee_sources ADD CONSTRAINT "'+c['name']+'" '+c['definition']+';')
   for i in authority['indexes']:
    name=i.split('INDEX ')[1].split(' ON ')[0]
    if q('SELECT to_regclass('+lit(name)+')IS NULL')=='t':q(i+';')
   assert q("SELECT count(*)FROM pg_index WHERE indrelid='accounting_tournament_fee_sources'::regclass")=='12'
   q('ALTER TABLE accounting_tournament_fee_sources ENABLE ROW LEVEL SECURITY;REVOKE ALL ON accounting_tournament_fee_sources FROM PUBLIC,anon,authenticated,service_role;GRANT SELECT ON accounting_tournament_fee_sources TO service_role;')
   q("CREATE SCHEMA smarter_private;CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(NULLIF(current_setting('fixture.frozen',true),'')::boolean,false)$$;CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('fixture.break',true),'')$$;CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('fixture.boundary',true),'')::uuid$$;CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(NULLIF(current_setting('fixture.source65',true),'')::boolean,true)$$;CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN COALESCE(NULLIF(current_setting('fixture.gen_null',true),''),'false')::boolean THEN NULL ELSE 'controlled-unchanged-generation' END$$;")
   q("INSERT INTO accounting_tournament_fee_batches SELECT md5('b'||g)::uuid FROM generate_series(1,20008)g;INSERT INTO fixture_candidates SELECT md5('t'||g)::uuid FROM generate_series(1,10005)g;")
   q("INSERT INTO accounting_tournament_fee_sources SELECT md5('s'||g)::uuid,md5('b'||((g-1)/3+1))::uuid,md5('t'||((g-1)/6+1))::uuid,md5('p'||g)::uuid,CASE WHEN g%17=0 THEN '"+F+"'::uuid ELSE '"+C+"'::uuid END,CASE WHEN g%7=0 THEN '"+U2+"'::uuid WHEN g%3=0 THEN '"+U1+"'::uuid END,CASE WHEN g%5=0 THEN '"+U2+"'::uuid END,'holdem',md5('reg'||g)::uuid,md5('charge'||g)::uuid,md5('entitlement'||g)::uuid,'2026-10-19 07:00Z'::timestamptz+(g%12-2)*interval '1day',(g%100)::numeric/100,jsonb_build_object('original_contract',repeat(md5('contract'||g),32)),'2026-10-27'::timestamptz FROM generate_series(1,60000)g;")
   q("INSERT INTO accounting_tournament_fee_sources SELECT md5('s'||g)::uuid,md5('b'||((g-1)/3+1))::uuid,md5('t'||((g-1)/6+1))::uuid,md5('p'||g)::uuid,'"+F+"'::uuid,CASE WHEN g<=60006 THEN NULL WHEN g<=60012 THEN '"+U1+"'::uuid WHEN g<=60018 THEN '"+U2+"'::uuid WHEN g%2=0 THEN '"+U1+"'::uuid ELSE '"+U2+"'::uuid END,NULL,'holdem',md5('reg'||g)::uuid,md5('charge'||g)::uuid,md5('entitlement'||g)::uuid,'2026-10-01'::timestamptz,0,jsonb_build_object('original_contract','foreignzero'), '2026-10-27'::timestamptz FROM generate_series(60001,60024)g;")
   q('VACUUM ANALYZE accounting_tournament_fee_sources;')
   def query(array=None):
    selected=aggregate if array is None else aggregate.replace('(SELECT array_agg(c.tournament_id) FROM candidates c)::uuid[]',array)
    return ('WITH candidates AS(SELECT tournament_id FROM fixture_candidates) 'if array is None else'')+'SELECT COALESCE(jsonb_agg(to_jsonb(x)ORDER BY tournament_id),\'[]\'::jsonb)FROM('+selected+')x'
   whole=query();before=q(whole);actual=json.loads(before);expected=[]
   for event in range(1,10001):
    gs=range((event-1)*6+1,event*6+1);unions=[U2 if g%7==0 else U1 if g%3==0 else None for g in gs];expected.append({'tournament_id':uid('t'+str(event)),'fee_source_count':6,'scope_count':len(set(u or'private'for u in unions)),'one_union':min((u for u in unions if u is not None),default=None)})
   for event,count,one in [(10001,1,None),(10002,1,U1),(10003,1,U2),(10004,2,U1)]:expected.append({'tournament_id':uid('t'+str(event)),'fee_source_count':6,'scope_count':count,'one_union':one})
   assert actual==sorted(expected,key=lambda x:x['tournament_id']);cases+=['FULL10004group_original4field_fee_scope_independent_oracle','NULL_private_allNULL_singleUnion_mixedUnion_foreignClub_time_coordinator_rows_preserved']
   empty_before=q(query('ARRAY[]::uuid[]'));null_before=q(query('NULL::uuid[]'));duplicate_array='ARRAY['+lit(uid('t1'))+'::uuid,'+lit(uid('t1'))+'::uuid]::uuid[]';duplicate_before=q(query(duplicate_array));assert empty_before==null_before=='[]'and json.loads(duplicate_before)==[next(x for x in expected if x['tournament_id']==uid('t1'))];cases.append('original_empty_NULL_duplicate_candidate_array_membership_semantics')
   point=query('ARRAY['+lit(uid('t1'))+'::uuid]::uuid[]');oldplan=js('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+point);assert any(n.get('Relation Name')=='accounting_tournament_fee_sources'and n.get('Node Type')in['Index Scan','Bitmap Heap Scan']for n in walk(oldplan[0]['Plan']));cases.append('original_point_natural_heap_access')
   rows_sql="SELECT md5(string_agg(md5(to_jsonb(s)::text),''ORDER BY id))FROM accounting_tournament_fee_sources s";rows=q(rows_sql)
   metadata_sql="SELECT jsonb_build_object('owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'columns',(SELECT jsonb_agg(jsonb_build_object('catalog',to_jsonb(a),'default',pg_get_expr(d.adbin,d.adrelid))ORDER BY a.attnum)FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid),'constraints',(SELECT jsonb_agg(to_jsonb(k)ORDER BY k.oid)FROM pg_constraint k WHERE k.conrelid=c.oid),'triggers',(SELECT jsonb_agg(to_jsonb(t)ORDER BY t.oid)FROM pg_trigger t WHERE t.tgrelid=c.oid))FROM pg_class c WHERE c.oid='accounting_tournament_fee_sources'::regclass";metadata=q(metadata_sql)
   indexes_sql="SELECT jsonb_agg(jsonb_build_object('catalog',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid))ORDER BY i.indexrelid)FROM pg_index i WHERE i.indrelid='accounting_tournament_fee_sources'::regclass AND i.indexrelid<>COALESCE(to_regclass('"+INDEX+"'),0::oid)";indexes=q(indexes_sql)
   split="import{splitConcurrentPreamble}from"+json.dumps((R/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));"
   parts=json.loads(run(['node','--input-type=module','-e',split,migration]));assert parts['ok']and len(parts['indexes'])==1
   statement=parts['indexes'][0]['statement'];body=parts['body']
   auth_sql="SELECT jsonb_agg(to_jsonb(p)ORDER BY p.oid)FROM pg_proc p WHERE p.oid IN('smarter_private.original_inventory_proof_sources_match()'::regprocedure,'smarter_private.original_inventory_basis_generation()'::regprocedure)";auth_before=q(auth_sql)
   q(statement);q(body);assert q(auth_sql)==auth_before;cases.append('maintained_CCI_parser_and_guarded_body_preserve_controlled_authority_metadata')
   assert q(whole)==before and q(rows_sql)==rows and q(metadata_sql)==metadata and q(indexes_sql)==indexes and q(query('ARRAY[]::uuid[]'))==empty_before and q(query('NULL::uuid[]'))==null_before and q(query(duplicate_array))==duplicate_before;cases+=['FULLoriginal_fee_scope_ordered_bag_byte_equal_before_after','all60024rawrows_contracts_defaults_constraints_RLS_ACL12indexes_unchanged']
   plan=js('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+point);cover=[n for n in walk(plan[0]['Plan'])if n.get('Index Name')==INDEX];assert cover and all(n['Node Type']=='Index Only Scan'and n['Heap Fetches']==0 for n in cover);cases.append('natural_original_point_IndexOnly_zero_heap_without_forcing')
   ix=js("SELECT jsonb_build_object('definition',pg_get_indexdef(indexrelid),'keys',indnkeyatts,'attrs',indnatts,'valid',indisvalid,'ready',indisready,'live',indislive,'partial',indpred IS NOT NULL,'expression',indexprs IS NOT NULL,'unique',indisunique)FROM pg_index WHERE indexrelid='"+INDEX+"'::regclass");assert ix['keys']==1 and ix['attrs']==2 and ix['valid']and ix['ready']and ix['live']and not ix['partial']and not ix['expression']and not ix['unique'];cases.append('exact_global_tournament_key_and_union_scalar_only_catalog')
   for sql,error in [("UPDATE accounting_tournament_fee_sources SET rake_credit='NaN'WHERE id=md5('s1')::uuid",'violates check constraint'),("UPDATE accounting_tournament_fee_sources SET rake_credit='Infinity'WHERE id=md5('s1')::uuid",'violates check constraint'),("UPDATE accounting_tournament_fee_sources SET rake_credit=-0.01 WHERE id=md5('s1')::uuid",'violates check constraint'),("UPDATE accounting_tournament_fee_sources SET rake_credit=0.001 WHERE id=md5('s1')::uuid",'violates check constraint'),("UPDATE accounting_tournament_fee_sources SET registration_id=NULL WHERE id=md5('s1')::uuid",'not-null constraint'),('INSERT INTO accounting_tournament_fee_sources SELECT*FROM accounting_tournament_fee_sources LIMIT 1','duplicate key'),("UPDATE accounting_tournament_fee_sources SET rake_record_id=md5('unknown-batch')::uuid WHERE id=md5('s1')::uuid",'violates foreign key constraint'),("SELECT 'invalid UUID'::uuid",'invalid input syntax')]:q(sql,error)
   assert q(rows_sql)==rows;cases.append('actual_numeric_NULL_duplicate_FK_UUID_constraint_refusals_atomic')
   q('SET ROLE anon;SELECT*FROM accounting_tournament_fee_sources','permission denied');cases.append('original_anon_access_refused')
   q(statement);q(body);assert q(rows_sql)==rows and q(auth_sql)==auth_before;cases.append('maintained_CCI_replay_exact_catalog_preserves_original_rows')
   for label,setup,error in [
    ('operator',"SET LOCAL request.jwt.claims='{}';",'fee_scope_union_cover_operator_refused'),
    ('override',"SET LOCAL ca.break_window_migration_override='not-authorized';",'fee_scope_union_cover_operator_refused'),
    ('source65',"SET LOCAL fixture.source65='false';",'fee_scope_union_cover_source65_required'),
    ('generation',"SET LOCAL fixture.gen_null='true';",'fee_scope_union_cover_generation_required'),
    ('freeze',"SET LOCAL fixture.frozen='true';",'fee_scope_union_cover_window_refused'),
    ('break',"SET LOCAL fixture.break='break';",'fee_scope_union_cover_window_refused'),
    ('boundary',"SET LOCAL fixture.boundary='"+U2+"';",'fee_scope_union_cover_window_refused'),
    ('table_ACL',"GRANT INSERT ON accounting_tournament_fee_sources TO service_role;",'fee_scope_union_cover_source_access_refused'),
    ('table_policy',"CREATE POLICY fixture_permissive ON accounting_tournament_fee_sources FOR SELECT TO service_role USING(true);",'fee_scope_union_cover_source_access_refused'),
    ('force_RLS',"ALTER TABLE accounting_tournament_fee_sources FORCE ROW LEVEL SECURITY;",'fee_scope_union_cover_source_access_refused'),
    ('default',"ALTER TABLE accounting_tournament_fee_sources ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();",'fee_scope_union_cover_columns_refused'),
    ('constraint',"ALTER TABLE accounting_tournament_fee_sources DROP CONSTRAINT accounting_tournament_fee_sources_rake_credit_check;",'fee_scope_union_cover_constraints_refused'),
    ('existing_index',"UPDATE pg_index SET indisvalid=false WHERE indexrelid='accounting_tournament_fee_sources_event'::regclass;",'fee_scope_union_cover_existing_indexes_refused'),
    ('candidate',"UPDATE pg_index SET indisvalid=false WHERE indexrelid='"+INDEX+"'::regclass;",'fee_scope_union_cover_exact_catalog_required')]:
    q('BEGIN;'+setup+body,error);assert q(rows_sql)==rows and q(metadata_sql)==metadata and q(indexes_sql)==indexes and q(auth_sql)==auth_before
    cases.append('actual_installer_'+label+'_refusal_atomic')
   reader=subprocess.Popen(list(map(str,ps)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);reader.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'+point+";\nSELECT 'READY';\n");reader.stdin.flush();one=reader.stdout.readline().strip();assert reader.stdout.readline().strip()=='READY'
   q("INSERT INTO accounting_tournament_fee_sources SELECT md5('concurrent')::uuid,rake_record_id,tournament_id,md5('concurrent-player')::uuid,club_id,'"+U2+"'::uuid,coordinator_union_id,game_type,md5('concurrent-registration')::uuid,md5('concurrent-charge')::uuid,md5('concurrent-entitlement')::uuid,charged_at,rake_credit,contract,recorded_at FROM accounting_tournament_fee_sources WHERE id=md5('s1')::uuid")
   reader.stdin.write(point+';\nROLLBACK;\n');reader.stdin.close();two=reader.stdout.readline().strip();reader.wait(timeout=10);assert reader.returncode==0 and one==two;fresh=js(point);assert fresh[0]['fee_source_count']==7 and fresh[0]['scope_count']==3 and fresh[0]['one_union']==U1;cases.append('real_two_backend_repeatable_read_INSERT_mixed_scope_snapshot')
   result={'qualification':'passed','case_count':len(cases),'cases':cases,'candidate_sha256':sha(migration),'runner_sha256':sha(__file__),'schema_fixture_sha256':sha(AUTH),'exact_original_aggregate_sha256':hashlib.sha256(aggregate.encode()).hexdigest(),'whole_original_group_count':len(actual),'whole_original_bag_sha256':hashlib.sha256(before.encode()).hexdigest(),'raw_row_fingerprint':rows,'before_plan':oldplan,'after_plan':plan,'index_catalog':ix,'limits':'SOURCE ONLY local PG17 physical qualification; actual15column types/defaults/NOTNULL/5constraints/12indexes/RLS/ACL reproduced. FK batch endpoints ID-only. Original4fieldaggregate uses controlled candidateIDs, not upstream candidate discovery. Actual8producer/immutability/diamond/daily/parentFK triggers retained in actualcatalog evidence, not reproduced; UPDATE faultcases test typed constraints only, not actual immutable producer path. Actual quality owner/source65/GEN/maintenance are not reproduced; external source65/GEN/window collaborators controlled for exact installer branch/refusal tests. No whole FOR/production timing/closed book qualification.'}
   a.out.parent.mkdir(parents=True,exist_ok=True)
   with a.out.open('x')as f:json.dump(result,f,indent=2);f.write('\n')
   print(json.dumps({'qualification':'passed','case_count':len(cases),'cases':cases,'out':str(a.out)}))
  finally:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
if __name__=='__main__':main()
