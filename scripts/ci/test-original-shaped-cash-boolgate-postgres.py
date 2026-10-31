#!/usr/bin/env python3
"""PG17 physical Boolean selector: actual table/trigger/access contract and original shaped-hand bags.
Private fixtures only. Source65/GEN and maintenance gates are explicit controlled
adapters; no production capacity, whole-report, money or original65 execution claim.
"""
import argparse,hashlib,json,os,re,socket,subprocess,tempfile,time,uuid
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/original-shaped-cash-boolgate';INDEX='union_pnl_cash_outcomes_shape_gate_window';VERSION='20261029071236';GEN='original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'
def lit(x):return 'NULL'if x is None else "'"+str(x).replace("'","''")+"'"
def uid(n):return str(uuid.UUID(int=n))
def nodes(n):
 if isinstance(n,dict):
  yield n
  for v in n.values():yield from nodes(v)
 elif isinstance(n,list):
  for v in n:yield from nodes(v)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')));p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();assert __debug__ and a.scratch.is_dir()and not a.output.exists();w=Path(tempfile.mkdtemp(prefix='membership-',dir=a.scratch.resolve()));data=w/'d';started=False;cases=[];plans={};E={k:v for k,v in os.environ.items()if not k.startswith('PG')};E.update(TMPDIR=str(w),TMP=str(w),TEMP=str(w),LC_ALL='C',PGTZ='UTC')
 with socket.socket()as sk:sk.bind(('127.0.0.1',0));port=str(sk.getsockname()[1])
 ps=[a.pg_bin/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres']
 def run(args,sql=None,error=None,timeout=90):
  with tempfile.TemporaryFile(mode='w+',dir=w)as f:
   if sql is not None:f.write(sql);f.seek(0)
   z=subprocess.run(list(map(str,args)),stdin=f if sql is not None else None,text=True,capture_output=True,env=E,timeout=timeout)
  assert (z.returncode!=0 and error in z.stderr)if error else z.returncode==0,(z.stdout[-1000:],z.stderr[-5000:]);return z.stdout.strip()
 def q(s,error=None):return run(ps,s,error)
 def js(s):return json.loads(q(s))
 def rec(n):cases.append(n);print('PASS',n,flush=True)
 migration=next((R/'supabase/migrations').glob(VERSION+'_*'));sql=migration.read_text();authority=json.loads((F/'meaningful-table-contract.json').read_text());actual=json.loads((F/'actual-table-authority.json').read_text());owners=json.loads((F/'actual-connected-owners.json').read_text())
 try:
  assert ' 17.'in run([a.pg_bin/'postgres','--version']);run([a.pg_bin/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([a.pg_bin/'pg_ctl','-D',data,'-l',w/'server.log','-w','start','-o',f"-k '' -h 127.0.0.1 -p {port} -c shared_buffers=32MB -c maintenance_work_mem=32MB"]);started=True
  q('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text,name text,statements text[]);CREATE TABLE public.union_pnl_transaction_frames(transaction_id xid8 PRIMARY KEY);INSERT INTO public.union_pnl_transaction_frames VALUES(\'1\');')
  cols=[c['name']+' '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['notnull']else'')for c in authority['columns']];q('CREATE TABLE public.union_pnl_cash_outcomes('+','.join(cols)+');')
  for c in authority['constraints']:q('ALTER TABLE public.union_pnl_cash_outcomes ADD CONSTRAINT '+c['name']+' '+c['definition']+';')
  for i in authority['indexes']:
   name=i['definition'].split('INDEX ')[1].split(' ON ')[0]
   if q('SELECT to_regclass('+lit(name)+')IS NULL;')=='t':q(i['definition']+';')
  q('CREATE TABLE public.union_pnl_cash_outcome_touches(table_id uuid NOT NULL,hand_number bigint NOT NULL,recognized_at timestamptz,game_union_id text,shaped boolean NOT NULL,accepted_rake text,participants jsonb,PRIMARY KEY(table_id,hand_number));CREATE INDEX touch_week ON public.union_pnl_cash_outcome_touches(game_union_id,recognized_at);')
  for o in owners:
   q('SET check_function_bodies=false;'+o['definition']+';')
   if o['metadata']['proacl'] is not None:
    q('REVOKE ALL ON FUNCTION '+o['signature']+' FROM PUBLIC,postgres,anon,authenticated,service_role;')
    for g in o['metadata']['proacl']:q('GRANT EXECUTE ON FUNCTION '+o['signature']+' TO '+(g.split('=')[0]or'PUBLIC')+';')
  q((F/'original-touch-producers.sql').read_text())
  q("CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.window',true)='on'THEN'window'END$$;CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('native.frozen',true)='on',false)$$;CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.boundary',true)='on'THEN clock_timestamp()END$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('native.source65',true)<>'off',true)$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.gen',true)='off'THEN NULL ELSE '"+GEN+"'END$$;")
  U='fade0000-0000-0000-0000-000000000001';START='2026-10-19 07:00Z';END='2026-10-26 07:00Z'
  shape=(F/'original-shaped-hands.sql').read_text();query=shape.split('RETURN QUERY ',1)[1].split(';\n ELSE',1)[0]
  for old,new in [('p_union_id','$1'),('p_start','$2'),('p_end','$3')]:query=query.replace(old,new)
  proj=(F/'table-contract-projection.sql').read_text();rawtr="SELECT jsonb_agg(jsonb_build_object('catalog',to_jsonb(t),'definition',pg_get_triggerdef(t.oid))ORDER BY t.oid)FROM pg_trigger t WHERE tgrelid='union_pnl_cash_outcomes'::regclass";fns="SELECT jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'metadata',to_jsonb(p))ORDER BY oid)FROM pg_proc p WHERE pronamespace IN('public'::regnamespace,'smarter_private'::regnamespace)"
  split="import{splitConcurrentPreamble}from"+json.dumps((R/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));";parts=json.loads(run(['node','--input-type=module','-e',split,migration]));assert parts['ok']and len(parts['indexes'])==1;statement=parts['indexes'][0]['statement'];body=parts['body']
  def fill(density,week,correlated):
   q('DROP TRIGGER IF EXISTS original_pnl_immutable ON union_pnl_cash_outcomes;DROP TRIGGER IF EXISTS union_pnl_cash_outcome_touch ON union_pnl_cash_outcomes;TRUNCATE union_pnl_cash_outcomes,union_pnl_cash_outcome_touches;')
   union="CASE WHEN n%100<"+str(density)+" THEN '"+U+"' ELSE 'other' END";gate='n%101=0'
   if correlated:union="CASE WHEN n%10000<2660 THEN NULL WHEN n%10000<9660 THEN '"+U+"' ELSE 'other' END";gate='n%10000<2700'
   q("INSERT INTO union_pnl_cash_outcomes SELECT 'fade0000-0000-0000-0000-000000000010',n,('fade0000-0000-0000-0001-'||lpad(n::text,12,'0'))::uuid,'1'::xid8,CASE WHEN(n*7919)%10000<"+str(week*100)+" THEN '2026-10-20'::timestamptz ELSE '2026-09-01'::timestamptz END,repeat('x',1200),jsonb_build_object('game_union_id',"+union+"),CASE WHEN "+gate+" THEN '{}'::jsonb ELSE jsonb_build_object('status','ready','basis_certified',true,'all_players_included',true,'game_scope',jsonb_build_object('game_union_id',"+union+"))END FROM generate_series(1,20000)n;")
   q('INSERT INTO union_pnl_cash_outcome_touches SELECT t.* FROM union_pnl_cash_outcomes o CROSS JOIN LATERAL fn_union_pnl_cash_outcome_touch_row(o.table_id,o.hand_number,o.recognized_at,o.game_scope,o.evidence)t;')
   for t in authority['triggers']:
    if not t['catalog']['tgisinternal']:q(t['definition']+';')
   q('ALTER TABLE union_pnl_cash_outcomes ENABLE ROW LEVEL SECURITY;REVOKE ALL ON union_pnl_cash_outcomes FROM PUBLIC,anon,authenticated,service_role;ANALYZE union_pnl_cash_outcomes;ANALYZE union_pnl_cash_outcome_touches;')
  def bag():return js("SELECT jsonb_build_object('count',count(*),'bag',md5(COALESCE(string_agg(md5(to_jsonb(x)::text),''ORDER BY table_id,hand_number),'')))FROM fn_union_pnl_week_shaped_hands("+lit(U)+','+lit(START)+','+lit(END)+',true)x;')
  fill(95,1,False);assert js(proj)==authority;rec('actual8columns3constraints7indexes4triggers_RLS_ACL_portable_contract')
  wide=[{'padding':'unicode-\u2713'*150000},{'status':'ready','basis_certified':True,'all_players_included':True,'padding':'z'*1000000}]
  def wide_append(offset):
   for n,evidence in enumerate(wide):q("INSERT INTO union_pnl_cash_outcomes VALUES('fade0000-0000-0000-0000-000000000010',"+str(offset+n)+','+lit(uid(offset+n))+",'1','2026-10-20','native',jsonb_build_object('game_union_id','other'),"+lit(json.dumps(evidence))+"::jsonb);")
  wide_append(800000000);rec('original_seven_indexes_admit_large_JSON_payload_boundaries')
  raw_before=q(rawtr);fn_before=q(fns);before=bag();q(statement);q(body);assert before==bag()and q(rawtr)==raw_before and q(fns)==fn_before;rec('exact_CCI_and_qualification_preserve_original_function_bag_metadata_and_raw_triggers')
  wide_append(800000010);rec('new_fixed_BOOL_timestamp_UUID_bigint_keys_add_no_wide_JSON_rejection')
  index_oid=q('SELECT '+lit(INDEX)+'::regclass::oid;');q(body.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'native_history_tail_fault';END$$;COMMIT;"),'native_history_tail_fault');q(body);assert index_oid==q('SELECT '+lit(INDEX)+'::regclass::oid;');rec('valid_prefix_survives_history_tail_failure_and_resumes_without_rebuild')
  q('DROP INDEX '+INDEX+';')
  def held(source,marker):
   proc=subprocess.Popen(list(map(str,ps)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=E)
   proc.stdin.write(source+";SELECT '"+marker+"';\n");proc.stdin.flush()
   while True:
    line=proc.stdout.readline()
    if line.strip()==marker:return proc
    if not line and proc.poll()is not None:raise AssertionError(proc.stderr.read())
  def release(proc):
   if proc.poll()is None:
    proc.stdin.write('ROLLBACK;\n\\q\n');proc.stdin.flush();proc.communicate(timeout=10)
  def build_actor():
   source=tempfile.TemporaryFile(mode='w+',dir=w);out=tempfile.TemporaryFile(mode='w+',dir=w);err=tempfile.TemporaryFile(mode='w+',dir=w);source.write(statement);source.seek(0)
   proc=subprocess.Popen(list(map(str,ps)),stdin=source,stdout=out,stderr=err,text=True,env=E);return proc,source,out,err
  def await_phase(prefix):
   for _ in range(250):
    x=js("SELECT(SELECT to_jsonb(p)FROM pg_stat_progress_create_index p WHERE p.relid='union_pnl_cash_outcomes'::regclass AND p.index_relid=to_regclass("+lit(INDEX)+"))::jsonb;")if q("SELECT EXISTS(SELECT FROM pg_stat_progress_create_index WHERE relid='union_pnl_cash_outcomes'::regclass AND index_relid=to_regclass("+lit(INDEX)+"));")=='t'else None
    if x and x['phase'].startswith(prefix):return x
    time.sleep(.02)
   raise AssertionError('native CCI phase not observed:'+prefix)
  snapshot=held('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SELECT count(*)FROM union_pnl_cash_outcomes','SNAPSHOT_READY');builder=None
  try:
   builder,src,bo,be=build_actor();progress=await_phase('waiting for old snapshots');assert q('SELECT pg_cancel_backend('+str(progress['pid'])+');')=='t';builder.wait(timeout=15);be.seek(0);error=be.read();assert builder.returncode and'canceling statement due to user request'in error,error
   assert q('SELECT NOT indisvalid FROM pg_index WHERE indexrelid='+lit(INDEX)+'::regclass;')=='t';invalid_oid=q('SELECT '+lit(INDEX)+'::regclass::oid;')
  finally:
   release(snapshot)
   if builder is not None and builder.poll()is None:builder.kill();builder.wait()
  q(body,'original_shaped_cash_boolgate_exact_catalog_required');assert q('SELECT '+lit(INDEX)+'::regclass::oid;')==invalid_oid
  rec('genuine_interrupted_CCI_durable_invalid_prefix_refuses_without_rebuild_or_history')
  # Explicit negative-fixture cleanup only, after exact invalid owned OID proof.
  q('DROP INDEX '+INDEX+';')
  append="INSERT INTO union_pnl_cash_outcomes VALUES('fade0000-0000-0000-0000-000000000010',900000000,'"+uid(900000000)+"','1','2026-10-20','native',jsonb_build_object('game_union_id',"+lit(U)+"),'{}')"

  writer=held('BEGIN;'+append,'WRITER_READY');builder=None
  try:
   builder,src,bo,be=build_actor();await_phase('waiting for writers before build')
   q("SET statement_timeout='2s';"+append.replace('900000000','900000001').replace(uid(900000000),uid(900000001))+';');rec('concurrent_original_append_writer_commits_while_CCI_waits_for_existing_writer')
   writer.stdin.write('COMMIT;\n\\q\n');writer.stdin.flush();writer.communicate(timeout=10);builder.wait(timeout=60);be.seek(0);assert builder.returncode==0,be.read()
  finally:
   release(writer)
   if builder is not None and builder.poll()is None:builder.kill();builder.wait()
  assert q('SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='+lit(INDEX)+'::regclass')=='t';rec('exact_maintained_CCI_new_index_valid_no_old_index_retirement')
  for name,density,week,corr in [('dense95week1',95,1,False),('dense95week20',95,20,False),('dense100week1',100,1,False),('dense100week20',100,20,False),('actual_correlation70_27_985',70,20,True)]:
   fill(density,week,corr);raw_before=q(rawtr);fn_before=q(fns);before=bag();q(body);assert before==bag()and q(rawtr)==raw_before and q(fns)==fn_before and js(proj)==authority
   for mode in('auto','force_custom_plan','force_generic_plan'):
    out=q('SET plan_cache_mode='+mode+';PREPARE shaped(uuid,timestamptz,timestamptz)AS '+query+';EXPLAIN(ANALYZE,BUFFERS,VERBOSE,FORMAT JSON)EXECUTE shaped('+lit(U)+','+lit(START)+','+lit(END)+');');pl=json.loads(out);plans[name+'_'+mode]=pl;scans=[x for x in nodes(pl)if x.get('Relation Name')=='union_pnl_cash_outcomes' or x.get('Index Name')==INDEX];assert any(x.get('Index Name')in(INDEX,'union_pnl_cash_outcomes_unaccepted')for x in scans),scans
   rec(name+'_actual_original_bag_and_natural_auto_custom_generic_plans')
  for flag,err in [('source65','source65_required'),('gen','original_generation_required')]:q("SELECT set_config('native."+flag+"','off',false);"+body,'original_shaped_cash_boolgate_'+err);rec(flag+'_refuses')
  for flag in('window','frozen','boundary'):q("SELECT set_config('native."+flag+"','on',false);"+body,'original_shaped_cash_boolgate_window_refused');rec(flag+'_refuses')
  for prefix in["SET request.jwt.claims='{}';","SET request.jwt.claim.role='service_role';","SET ROLE anon;","SET ca.break_window_migration_override='native';"]:q(prefix+body,'original_shaped_cash_boolgate_operator_refused');rec('operator_'+prefix)
  q("INSERT INTO supabase_migrations.schema_migrations VALUES('"+VERSION+"','native',ARRAY['fixture']);");q(body,'original_shaped_cash_boolgate_history_replay');q('DELETE FROM supabase_migrations.schema_migrations;');rec('history_replay_refuses')
  q('GRANT SELECT ON union_pnl_cash_outcomes TO anon;');q(body,'original_shaped_cash_boolgate_actual_table_required');q('REVOKE SELECT ON union_pnl_cash_outcomes FROM anon;');rec('ACL_drift_refuses')
  q('ALTER TABLE union_pnl_cash_outcomes FORCE ROW LEVEL SECURITY;');q(body,'original_shaped_cash_boolgate_actual_table_required');q('ALTER TABLE union_pnl_cash_outcomes NO FORCE ROW LEVEL SECURITY;');rec('force_RLS_drift_refuses')
  q('ALTER INDEX union_pnl_cash_outcomes_unaccepted RENAME TO native_old;');q(body,'original_shaped_cash_boolgate_actual_table_required');q('ALTER INDEX native_old RENAME TO union_pnl_cash_outcomes_unaccepted;');rec('old_partial_index_drift_refuses')
  q('ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;');q(body,'original_shaped_cash_boolgate_actual_table_required');q('ALTER TABLE union_pnl_cash_outcomes ENABLE TRIGGER original_pnl_immutable;');rec('original_trigger_drift_refuses')
  q('GRANT EXECUTE ON FUNCTION fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)TO anon;');q(body,'original_shaped_cash_boolgate_query_authority_changed');q('REVOKE EXECUTE ON FUNCTION fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)FROM anon;');rec('shaped_helper_ACL_drift_refuses')
  q('UPDATE union_pnl_cash_outcomes SET evidence=NULL WHERE false;','original_pnl_inventory_is_immutable');rec('original_immutable_guard_preserved')
  assert js(proj)==authority and q(fns)==fn_before and q(rawtr)==raw_before
  report={'status':'passed','cases':cases,'migration_sha256':hashlib.sha256(sql.encode()).hexdigest(),'old_indexes_retained':7,'correlated_bitmap_predicate_recheck_allowed_and_recorded':True,'source65_generation_maintenance_controlled_fixture_boundaries':True,'production_capacity_claimed':False};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2)+'\n');a.output.with_name(a.output.stem+'-plans.json').write_text(json.dumps(plans,indent=2)+'\n');print(json.dumps(report))
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
if __name__=='__main__':main()
