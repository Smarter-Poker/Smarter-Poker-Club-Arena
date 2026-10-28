#!/usr/bin/env python3
"""PG17 physical five-scalar cover, exact original/C2 key selectors. No production connection."""
import argparse,hashlib,json,os,subprocess,tempfile,uuid
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/private-deposit-source-cover'
p=argparse.ArgumentParser();p.add_argument('--scratch',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
I='accounting_cash_private_deposit_keys_cover';C='10000000-0000-0000-0000-000000000001';U='10000000-0000-0000-0000-000000000002'
def lit(s):return "'"+s.replace("'","''")+"'"
def nodes(n):
 yield n
 for c in n.get('Plans',[]):yield from nodes(c)
with tempfile.TemporaryDirectory(prefix='pk-',dir=a.scratch)as tmp:
 t=Path(tmp);d=t/'d';pg=a.pg_bin;env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(PGHOST=str(t),PGUSER='postgres',PGDATABASE='postgres',PGSSLMODE='disable',TMPDIR=str(t))
 def run(cmd,sql=None,error=None):
  x=subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,env=env,timeout=120)
  assert(x.returncode and error in x.stderr)if error else x.returncode==0,(x.stdout,x.stderr,error)
  return x.stdout.strip()
 ps=[pg/'psql','-XAtq','-v','ON_ERROR_STOP=1']
 def q(s,error=None):return run(ps,s,error)
 def js(s):return json.loads(q(s))
 run([pg/'initdb','-D',d,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with(d/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(t)+"'\nshared_buffers='16MB'\nwork_mem='8MB'\nmaintenance_work_mem='16MB'\ntemp_file_limit='128MB'\n")
 run([pg/'pg_ctl','-D',d,'-l',t/'log','-w','start']);cases=[]
 try:
  x=json.loads((F/'actual-cash-source-catalog.json').read_text());q('CREATE SCHEMA auth;CREATE SCHEMA smarter_private;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE TABLE clubs(id uuid PRIMARY KEY);CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE accounting_cash_accrual_batches(rake_record_id uuid PRIMARY KEY);')
  cols=[]
  for c in x['columns']:
   v=c['catalog'];cols.append('"'+v['attname']+'" '+c['type']+(' NOT NULL'if v['attnotnull']else''))
  q('CREATE TABLE accounting_cash_rake_sources('+','.join(cols)+');')
  for c in x['constraints']:q('ALTER TABLE accounting_cash_rake_sources ADD CONSTRAINT "'+c['catalog']['conname']+'" '+c['definition']+';')
  for i in x['indexes']:
   name=i['definition'].split('INDEX ')[1].split(' ON ')[0]
   if q('SELECT to_regclass('+lit(name)+')IS NULL')=='t':q(i['definition']+';')
  q("ALTER TABLE accounting_cash_rake_sources ENABLE ROW LEVEL SECURITY;REVOKE ALL ON accounting_cash_rake_sources FROM PUBLIC,anon,authenticated,service_role;GRANT SELECT ON accounting_cash_rake_sources TO service_role;CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(NULLIF(current_setting('fixture.frozen',true),'')::boolean,false)$$;CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('fixture.break',true),'')$$;CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('fixture.boundary',true),'')::uuid$$;CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(NULLIF(current_setting('fixture.source65',true),'')::boolean,true)$$;CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT 'controlled-unchanged-generation'$$;")
  q("INSERT INTO clubs VALUES('"+C+"'),('"+U+"');INSERT INTO auth.users SELECT md5('p'||g)::uuid FROM generate_series(1,60000)g;INSERT INTO accounting_cash_accrual_batches SELECT md5('r'||g)::uuid FROM generate_series(1,60000)g;")
  q("INSERT INTO accounting_cash_rake_sources SELECT md5('s'||g)::uuid,md5('r'||g)::uuid,md5('p'||g)::uuid,CASE WHEN g%97=0 THEN '"+C+"'::uuid ELSE '"+U+"'::uuid END,CASE WHEN g%7=0 THEN '"+U+"'::uuid END,CASE WHEN g%3=0 THEN '"+U+"'::uuid END,'2026-10-19 07:00Z'::timestamptz+(g%12-2)*interval '1day',1,jsonb_build_object('original_contract',repeat(md5('c'||g),32)),'2026-10-27'::timestamptz FROM generate_series(1,60000)g;")
  q('VACUUM ANALYZE accounting_cash_rake_sources;')
  def selector(coord='NULL',original=False):
   pred='s.coordinator_union_id IS NOT DISTINCT FROM '+coord if original else('s.coordinator_union_id IS NULL'if coord=='NULL'else's.coordinator_union_id='+coord)
   return "SELECT DISTINCT s.rake_record_id FROM accounting_cash_rake_sources s WHERE s.club_id='"+C+"'AND s.union_id IS NULL AND "+pred+" AND s.earned_at>='2026-10-19 07:00Z'AND s.earned_at<'2026-10-26 07:00Z'"
  def bag(sql):return q("SELECT jsonb_build_object('count',count(*),'md5',md5(COALESCE(string_agg(rake_record_id::text,''ORDER BY rake_record_id),'')))FROM("+sql+")x")
  queries=[selector(),selector(original=True),selector(lit(U)+'::uuid'),selector(lit(U)+'::uuid',True)]
  before=[bag(v)for v in queries];assert before[0]==before[1]and before[2]==before[3];cases+=['original_and_explicit_NULL_nonNULL_selectors_identical']
  expected=[]
  for nullable in [True,False]:
   keys=sorted(str(uuid.UUID(hashlib.md5(('r'+str(g)).encode()).hexdigest()))for g in range(1,60001)if g%97==0 and g%7!=0 and ((g%3!=0)if nullable else(g%3==0))and 0<=g%12-2<7)
   expected.append({'count':len(keys),'md5':hashlib.md5(''.join(keys).encode()).hexdigest()})
  assert list(map(json.loads,before))==[expected[0],expected[0],expected[1],expected[1]],'independent foreignclub/foreignunion/coordNULL/nonNULL/start-inclusive/end-exclusive keys differ';cases.append('independent_scope_and_both_week_boundaries_exact_keys')
  whole="SELECT md5(string_agg(md5(to_jsonb(s)::text),''ORDER BY id))FROM accounting_cash_rake_sources s";fp=q(whole)
  metadata="SELECT jsonb_build_object('owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'columns',(SELECT jsonb_agg(to_jsonb(a)ORDER BY attnum)FROM pg_attribute a WHERE a.attrelid=c.oid),'constraints',(SELECT jsonb_agg(to_jsonb(n)ORDER BY n.oid)FROM pg_constraint n WHERE n.conrelid=c.oid))FROM pg_class c WHERE c.oid='accounting_cash_rake_sources'::regclass";table=q(metadata)
  owners="SELECT jsonb_agg(to_jsonb(p)ORDER BY p.oid)FROM pg_proc p WHERE p.oid IN('smarter_private.original_inventory_proof_sources_match()'::regprocedure,'smarter_private.original_inventory_basis_generation()'::regprocedure)";om=q(owners)
  oldplan=js('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+queries[0]);old_nullable_plan=js('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+queries[1]);assert any(v.get('Node Type')=='Index Scan'and v.get('Relation Name')=='accounting_cash_rake_sources'for v in nodes(oldplan[0]['Plan'])),'native baseline must exercise heap index scan'
  migration=R/json.loads((F/'source-receipt.json').read_text())['migration_file'];source=migration.read_text();split="import{splitConcurrentPreamble}from"+json.dumps((R/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));";parts=json.loads(run(['node','--input-type=module','-e',split,migration]));assert parts['ok']and len(parts['indexes'])==1
  statement=parts['indexes'][0]['statement'];body=parts['body'];q(statement);q(body)
  assert [bag(v)for v in queries]==before and q(whole)==fp and q(metadata)==table and q(owners)==om;cases+=['full_key_bags_source_contract_rows_table_metadata_ACL_source65_GEN_unchanged']
  newplan=js('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+queries[0]);new_nullable_plan=js('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+queries[1]);ix=[v for v in nodes(newplan[0]['Plan'])if v.get('Index Name')==I];assert ix and all(v['Node Type']=='Index Only Scan'and v['Heap Fetches']==0 for v in ix),'natural covering path not demonstrated';cases+=['natural_exact_selector_IndexOnly_zeroheap_no_forcing']
  q(statement);q(body);assert q(whole)==fp;cases+=['maintained_CCI_preamble_and_catalog_replay_preserves_all_sources']
  for label,sql,error in [('source65',"SET LOCAL fixture.source65='false';",'private_keys_cover_source65_required'),('operator',"SET LOCAL request.jwt.claims='{}';",'private_keys_cover_operator_refused'),('freeze',"SET LOCAL fixture.frozen='true';",'private_keys_cover_window_refused'),('break',"SET LOCAL fixture.break='break';",'private_keys_cover_window_refused'),('boundary',"SET LOCAL fixture.boundary='"+U+"';",'private_keys_cover_window_refused'),('invalid',"UPDATE pg_index SET indisvalid=false WHERE indexrelid='"+I+"'::regclass;",'private_keys_cover_exact_catalog_required')]:q('BEGIN;'+sql+body,error);cases.append('actual_'+label+'_refused')
  q("SET ROLE anon;SELECT*FROM accounting_cash_rake_sources;",'permission denied');cases.append('original_anon_access_refused')
  q("UPDATE accounting_cash_rake_sources SET rake_credit='NaN'WHERE id=md5('s1')::uuid;",'violates check constraint');q('UPDATE accounting_cash_rake_sources SET earned_at=NULL;', 'not-null constraint');q("INSERT INTO accounting_cash_rake_sources SELECT*FROM accounting_cash_rake_sources LIMIT 1;",'duplicate key');cases.append('original_nonfinite_NULL_duplicate_constraints_preserved')
  result={'qualification':'passed','case_count':len(cases),'cases':cases,'index_name':I,'candidate_sha256':hashlib.sha256(source.encode()).hexdigest(),'key_bags':list(map(json.loads,before)),'old_plan':oldplan,'new_plan':newplan,'original_nullable_old_plan':old_nullable_plan,'original_nullable_new_plan':new_nullable_plan,'limits':'Current full cash-source column types/NOTNULL/check/PK/unique/FK constraints and existing indexes; referenced tables are ID-only endpoints; source65/GEN collaborators controlled. Native60000 rows prove physical path and exact bags, not production30/285 timing or whole book closure.'};a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items()if not k.endswith('_plan')}))
 finally:run([pg/'pg_ctl','-D',d,'-m','immediate','-w','stop'])
