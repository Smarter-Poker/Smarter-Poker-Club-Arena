#!/usr/bin/env python3
"""PG17 physical membership selector: actual table/trigger/access contract and original query bags.
Private fixtures only. Source65/GEN and maintenance gates are explicit controlled
adapters; no production capacity, whole-report, money or original65 execution claim.
"""
import argparse,hashlib,json,os,re,socket,subprocess,tempfile,time,uuid
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/tournament-membership-union-key';INDEX='union_pnl_inventory_touches_tournament_union';VERSION='20261029032041';GEN='original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'
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
 migration=next((R/'supabase/migrations').glob(VERSION+'_*'));sql=migration.read_text();authority=json.loads((F/'meaningful-table-contract.json').read_text());actual=json.loads((F/'actual-table-authority.json').read_text())['actual'];owners=json.loads((F/'actual-connected-owners.json').read_text())
 try:
  assert ' 17.'in run([a.pg_bin/'postgres','--version']);run([a.pg_bin/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([a.pg_bin/'pg_ctl','-D',data,'-l',w/'server.log','-w','start','-o',f"-k '' -h 127.0.0.1 -p {port} -c shared_buffers=32MB -c maintenance_work_mem=32MB"]);started=True
  q('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text, name text, statements text[]);')
  cols=[c['name']+' '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['notnull']else'')for c in authority['columns']];q('CREATE TABLE public.union_pnl_inventory_touches('+','.join(cols)+');')
  for c in authority['constraints']:q('ALTER TABLE public.union_pnl_inventory_touches ADD CONSTRAINT '+c['name']+' '+c['definition']+';')
  for i in authority['indexes']:
   name=i['definition'].split('INDEX ')[1].split(' ON ')[0]
   if q('SELECT to_regclass('+lit(name)+')IS NULL;')=='t':q(i['definition']+';')
  q("CREATE TABLE union_pnl_inventory_events(source_name text,row_id uuid,event_id bigint,transaction_id xid8,after_row jsonb,before_row jsonb,observed_at timestamptz);CREATE INDEX event_identity ON union_pnl_inventory_events(source_name,row_id,event_id);CREATE TABLE union_pnl_transaction_frames(transaction_id xid8 PRIMARY KEY,observed_at timestamptz);INSERT INTO union_pnl_transaction_frames VALUES('1','2026-10-20');CREATE TABLE tournament_participant_funding_receipts(registration_id uuid,tournament_id uuid,user_id uuid,operation text,asset text,amount numeric,funding_club_id uuid,ledger_id uuid,entitlement_id uuid,registration_snapshot jsonb);CREATE INDEX receipt_registration ON tournament_participant_funding_receipts(registration_id);CREATE TABLE tournament_satellite_awards(tournament_id uuid,user_id uuid,delivery_kind text,registration_id uuid,ticket_id uuid);CREATE TABLE tournament_satellite_settlements(tournament_id uuid,target_id uuid);CREATE TABLE tournament_tickets(id uuid,holder_id uuid,source_satellite_id uuid,source_tournament_id uuid,status text,redemption_mode text,redeemed_at timestamptz);CREATE TABLE chip_ledger(id uuid,status text,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,tournament_id uuid,amount numeric,club_id uuid,category text,row_hash text);")
  for o in owners:
   q('SET check_function_bodies=false;'+o['definition']+';')
   acl=o['metadata']['proacl']
   if acl is not None:
    q('REVOKE ALL ON FUNCTION '+o['signature']+' FROM PUBLIC,postgres,anon,authenticated,service_role;')
    for g in acl:
     role=g.split('=')[0]or'PUBLIC';assert role in('PUBLIC','postgres','anon','authenticated','service_role');q('GRANT EXECUTE ON FUNCTION '+o['signature']+' TO '+role+';')
  # Explicit fixture boundary: maintenance admission and original inventory
  # authorities are controlled; their definitions/metadata remain unchanged.
  q("CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.window',true)='on'THEN'window'END$$;CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('native.frozen',true)='on',false)$$;CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.boundary',true)='on'THEN clock_timestamp()END$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('native.source65',true)<>'off',true)$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.gen',true)='off'THEN NULL ELSE '"+GEN+"'END$$;")
  U='fade0000-0000-0000-0000-000000000001';OTHER=uid(888);CLUB=uid(889);START='2026-10-19 07:00Z';END='2026-10-26 07:00Z'
  q("INSERT INTO union_pnl_inventory_touches SELECT n*1000+j,'tournaments',('00000000-0000-0000-0000-'||lpad(to_hex(1000+n),12,'0'))::uuid,'2026-10-20','1'::xid8,'2026-10-20','UPDATE',NULL,CASE WHEN n%2=0 AND j=0 THEN "+lit(U)+"WHEN n%4=1 THEN NULL ELSE "+lit(OTHER)+"END FROM generate_series(0,199)n CROSS JOIN generate_series(0,999)j;")
  # Observed actual sample shapes, not a population model: target first in6/8/234 histories and72 NULL-union misses.
  for n,size in [(5000,6),(5001,8),(5002,234),(5003,72)]:
   q('INSERT INTO union_pnl_inventory_touches SELECT '+str(1000000+n*1000)+'+j,\'tournaments\','+lit(uid(n))+",'2026-10-20','1'::xid8,'2026-10-20','UPDATE',NULL,"+('NULL'if n==5003 else'CASE WHEN j=0 THEN '+lit(U)+'ELSE '+lit(OTHER)+'END')+' FROM generate_series(0,'+str(size-1)+')j;')
  event=10000000
  def player(t,n):
   nonlocal event
   reg=uid(200000+t);base_event=event;event+=n
   q('INSERT INTO union_pnl_inventory_touches SELECT '+str(base_event)+'+g,\'tournament_players\','+lit(reg)+",'2026-10-20','1'::xid8,'2026-10-20','INSERT',"+lit(uid(1000+t))+',NULL FROM generate_series(1,'+str(n)+')g;');return reg
  regs={t:player(t,n)for t,n in[(0,3),(1,3),(2,4),(4,2),(6,3),(8,5),(10,6),(12,7)]}
  for t,asset,amount,snapshot in[(0,'chips',10,{}),(4,'chips',10,{}),(4,'ticket',1,{}),(6,'chips',0,{'club_id':CLUB,'is_satellite_qualifier':False}),(8,'chips',0,{'club_id':CLUB,'is_satellite_qualifier':True}),(10,None,None,{})]:
   q('INSERT INTO tournament_participant_funding_receipts VALUES('+lit(regs[t])+',NULL,NULL,\'entry\','+lit(asset)+','+str(amount if amount is not None else'NULL')+','+lit(CLUB)+',NULL,NULL,'+lit(json.dumps(snapshot))+'::jsonb);')
  # Widths accepted by the retained original index define the admission boundary.
  width_values=[None,'not-a-uuid','',('malformed union\u2713'*2000)]+[''.join(hashlib.sha256(str(i).encode()).hexdigest()for i in range((n+63)//64))[:n]for n in(2048,2400,2500,2600,2700,3000)]
  admitted=[];rejected=[]
  for n,v in enumerate(width_values):
   insert="INSERT INTO union_pnl_inventory_touches VALUES("+str(20000000+n)+",'tournaments',"+lit(uid(400000+n))+",'2026-10-20','1'::xid8,'2026-10-20','UPDATE',NULL,"+lit(v)+');'
   try:q(insert);admitted.append((n,v))
   except AssertionError as e:assert'index row size'in str(e)or'index row requires'in str(e),e;rejected.append(n)
  assert len(admitted)>=6 and rejected,'exercise actual retained-index width boundary'
  q("INSERT INTO union_pnl_inventory_events SELECT source_name,row_id,event_id,transaction_id,jsonb_build_object('union_id',union_id,'tournament_id',tournament_id),NULL,observed_at FROM union_pnl_inventory_touches;")
  q((F/'original-immutable.sql').read_text()+';'+authority['triggers'][0]['definition']+';ALTER TABLE union_pnl_inventory_touches ENABLE ROW LEVEL SECURITY;REVOKE ALL ON union_pnl_inventory_touches FROM PUBLIC,anon,authenticated,service_role;GRANT SELECT ON union_pnl_inventory_touches TO service_role;VACUUM ANALYZE union_pnl_inventory_touches;ANALYZE;')
  proj=(F/'table-contract-projection.sql').read_text().replace(' INTO actual','');assert js(proj)==authority,'actual full9/2/3/1 production contract must match native'
  rec('actual9columns2constraints3retained_indexes1raw_trigger_and_original_access')
  rawtr="SELECT jsonb_agg(jsonb_build_object('catalog',to_jsonb(t),'definition',pg_get_triggerdef(t.oid))ORDER BY t.oid)FROM pg_trigger t WHERE tgrelid='union_pnl_inventory_touches'::regclass";raw_before=q(rawtr)
  fn_snapshot="SELECT jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'metadata',to_jsonb(p))ORDER BY oid)FROM pg_proc p WHERE pronamespace IN('public'::regnamespace,'smarter_private'::regnamespace)";fn_before=q(fn_snapshot)
  row_snapshot="SELECT md5(string_agg(md5(to_jsonb(t)::text),''ORDER BY event_id))FROM union_pnl_inventory_touches t WHERE event_id<30000000";rows_before=q(row_snapshot)
  query=(F/'original-touched-query.sql').read_text().replace(' INTO v_bad','').strip();predicate=(F/'membership-predicate.sql').read_text().strip().removesuffix(';')
  def full(projected,opened):
   z=query
   for old,new in [('p_union_id',lit(U)+'::uuid'),('p_start',lit(START)+'::timestamptz'),('p_end',lit(END)+'::timestamptz'),('v_inv',projected),('v_open_resolved',opened)]:z=re.sub(r'\b'+old+r'\b',new,z)
   return int(q(z))
  before_bags={}
  for projected in('true','false','NULL'):
   for arr,expected in[('ARRAY[]::uuid[]',24),('ARRAY['+lit(regs[12])+']::uuid[]',17),('NULL::uuid[]',13)]:
    k=projected+'|'+arr;before_bags[k]=full(projected,arr);assert before_bags[k]==expected,(k,before_bags[k],expected)
  rec('independent_original_full_touched_counts_duplicates_NULL_opening_and_projection_branches')
  def explain(mode,ident,union):
   prefix='SET plan_cache_mode='+mode+';PREPARE member(text,uuid)AS '+predicate+';';args='('+lit(ident)+','+lit(union)+')';out=q(prefix+'EXECUTE member'+args+';EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)EXECUTE member'+args+';');truth,pl=out.split('\n',1);return truth,json.loads(pl)
  inputs=[(uid(1000),U,True),(uid(1001),U,False),(uid(1000),OTHER,True),(uid(1000).upper(),U,False),('BAD-ID',U,False),(None,U,False),(uid(1000),None,False),(uid(5003),U,False)]
  for mode in('force_custom_plan','force_generic_plan'):
   for n,(ident,u,want)in enumerate(inputs):truth,pl=explain(mode,ident,u);assert(truth=='t')is want;plans['before_'+mode+'_'+str(n)]=pl
  split="import{splitConcurrentPreamble}from"+json.dumps((R/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));";parts=json.loads(run(['node','--input-type=module','-e',split,migration]));assert parts['ok']and len(parts['indexes'])==1;statement=parts['indexes'][0]['statement'];body=parts['body']
  # Genuine interrupted CCI and concurrent append-writer boundaries run only
  # in this owned loopback fixture. No live cancel/drop/recovery route exists here.
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
    x=js("SELECT(SELECT to_jsonb(p)FROM pg_stat_progress_create_index p WHERE p.relid='union_pnl_inventory_touches'::regclass AND p.index_relid=to_regclass("+lit(INDEX)+"))::jsonb;")if q("SELECT EXISTS(SELECT FROM pg_stat_progress_create_index WHERE relid='union_pnl_inventory_touches'::regclass AND index_relid=to_regclass("+lit(INDEX)+"));")=='t'else None
    if x and x['phase'].startswith(prefix):return x
    time.sleep(.02)
   raise AssertionError('native CCI phase not observed:'+prefix)
  snapshot=held('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SELECT count(*)FROM union_pnl_inventory_touches','SNAPSHOT_READY');builder=None
  try:
   builder,src,bo,be=build_actor();progress=await_phase('waiting for old snapshots');assert q('SELECT pg_cancel_backend('+str(progress['pid'])+');')=='t';builder.wait(timeout=15);be.seek(0);error=be.read();assert builder.returncode and'canceling statement due to user request'in error,error
   assert q('SELECT NOT indisvalid FROM pg_index WHERE indexrelid='+lit(INDEX)+'::regclass;')=='t';invalid_oid=q('SELECT '+lit(INDEX)+'::regclass::oid;')
  finally:
   release(snapshot)
   if builder is not None and builder.poll()is None:builder.kill();builder.wait()
  q(body,'tournament_membership_union_key_exact_catalog_required');assert q('SELECT '+lit(INDEX)+'::regclass::oid;')==invalid_oid
  rec('genuine_interrupted_CCI_durable_invalid_prefix_refuses_without_rebuild_or_history')
  # Explicit negative-fixture cleanup only, after exact invalid owned OID proof.
  q('DROP INDEX '+INDEX+';')
  append="INSERT INTO union_pnl_inventory_touches VALUES(40000000,'tournaments',"+lit(uid(600000))+",'2026-10-20','1'::xid8,'2026-10-20','INSERT',NULL,"+lit(OTHER)+")"
  writer=held('BEGIN;'+append,'WRITER_READY');builder=None
  try:
   builder,src,bo,be=build_actor();await_phase('waiting for writers before build')
   q("SET statement_timeout='2s';"+append.replace('40000000','40000001').replace(uid(600000),uid(600001))+';');rec('concurrent_original_append_writer_commits_while_CCI_waits_for_existing_writer')
   writer.stdin.write('COMMIT;\n\\q\n');writer.stdin.flush();writer.communicate(timeout=10);builder.wait(timeout=60);be.seek(0);assert builder.returncode==0,be.read()
  finally:
   release(writer)
   if builder is not None and builder.poll()is None:builder.kill();builder.wait()
  assert q('SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='+lit(INDEX)+'::regclass')=='t';rec('exact_maintained_CCI_new_index_valid_no_old_index_retirement')
  index_oid=q('SELECT '+lit(INDEX)+'::regclass::oid;')
  for n,v in admitted:q("INSERT INTO union_pnl_inventory_touches VALUES("+str(30000000+n)+",'tournaments',"+lit(uid(500000+n))+",'2026-10-20','1'::xid8,'2026-10-20','UPDATE',NULL,"+lit(v)+');')
  rec('all_original_admitted_large_compressible_malformed_NULL_and_near_boundary_union_TEXT_remains_admitted')
  q(body.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'native_history_tail_fault';END$$;COMMIT;"),'native_history_tail_fault');assert q('SELECT '+lit(INDEX)+'::regclass::oid;')==index_oid;rec('valid_CCI_prefix_survives_qualification_history_tail_failure')
  q(body);assert q('SELECT '+lit(INDEX)+'::regclass::oid;')==index_oid;rec('same_exact_body_resumes_without_index_rebuild')
  for k,want in before_bags.items():projected,arr=k.split('|',1);assert full(projected,arr)==want
  rec('original_full_touched_counts_preserved_after_physical_only_transition')
  for mode in('force_custom_plan','force_generic_plan'):
   for n,(ident,u,want)in enumerate(inputs):
    truth,pl=explain(mode,ident,u);assert(truth=='t')is want;plans['after_'+mode+'_'+str(n)]=pl
    if n in(1,7):
     scans=[x for x in nodes(pl)if x.get('Relation Name')=='union_pnl_inventory_touches'];assert any(x.get('Index Name')==INDEX and'union_id'in x.get('Index Cond','')for x in scans),scans;assert sum(x.get('Rows Removed by Filter',0)for x in scans)==0
  rec('natural_custom_and_generic_original_predicate_uses_union_key_and_keeps_canonical_text_roundtrip')
  def refuse(name,setup,cleanup,error):
   if setup:q(setup)
   q(body,error)
   if cleanup:q(cleanup)
   assert js(proj)==authority and q(rawtr)==raw_before;rec(name)
  for flag,error in [('source65','source65_required'),('gen','original_generation_required')]:q("SELECT set_config('native."+flag+"','off',false);"+body,'tournament_membership_union_key_'+error);rec(flag+'_refuses')
  for flag in('window','frozen','boundary'):q("SELECT set_config('native."+flag+"','on',false);"+body,'tournament_membership_union_key_window_refused');rec(flag+'_refuses')
  for prefix in["SET request.jwt.claims='{}';","SET request.jwt.claim.role='service_role';","SET ROLE anon;","SET ca.break_window_migration_override='native';"]:q(prefix+body,'tournament_membership_union_key_operator_refused');rec('operator_'+prefix)
  refuse('history_replay',"INSERT INTO supabase_migrations.schema_migrations VALUES('"+VERSION+"','native',ARRAY['fixture']);",'DELETE FROM supabase_migrations.schema_migrations;','tournament_membership_union_key_history_replay')
  refuse('table_ACL_drift','GRANT SELECT ON union_pnl_inventory_touches TO anon;','REVOKE SELECT ON union_pnl_inventory_touches FROM anon;','tournament_membership_union_key_actual_table_required')
  refuse('table_force_RLS_drift','ALTER TABLE union_pnl_inventory_touches FORCE ROW LEVEL SECURITY;','ALTER TABLE union_pnl_inventory_touches NO FORCE ROW LEVEL SECURITY;','tournament_membership_union_key_actual_table_required')
  refuse('old_identity_index_cannot_disappear','ALTER INDEX union_pnl_inventory_touches_identity RENAME TO native_old_identity;','ALTER INDEX native_old_identity RENAME TO union_pnl_inventory_touches_identity;','tournament_membership_union_key_actual_table_required')
  refuse('original_trigger_disable_refuses','ALTER TABLE union_pnl_inventory_touches DISABLE TRIGGER original_pnl_immutable;','ALTER TABLE union_pnl_inventory_touches ENABLE TRIGGER original_pnl_immutable;','tournament_membership_union_key_actual_table_required')
  refuse('critical_helper_ACL_drift','GRANT EXECUTE ON FUNCTION fn_union_pnl_touched_registrations(timestamptz,timestamptz,boolean)TO anon;','REVOKE EXECUTE ON FUNCTION fn_union_pnl_touched_registrations(timestamptz,timestamptz,boolean)FROM anon;','tournament_membership_union_key_query_authority_changed')
  q('UPDATE union_pnl_inventory_touches SET union_id=NULL WHERE false;','original_pnl_inventory_is_immutable');rec('exact_original_immutable_producer_remains_enforced')
  assert q(row_snapshot)==rows_before and q(rawtr)==raw_before and q(fn_snapshot)==fn_before and js(proj)==authority
  rec('all_original_rows_functions_metadata_raw_trigger_and_three_indexes_unchanged')
  report={'status':'passed','migration_sha256':hashlib.sha256(sql.encode()).hexdigest(),'cases':cases,'admitted_width_cases':[{'case':n,'utf8_bytes':None if v is None else len(v.encode())}for n,v in admitted],'original_rejected_width_cases':rejected,'actual_contract_sha256':hashlib.sha256((F/'meaningful-table-contract.json').read_bytes()).hexdigest(),'source65_generation_and_maintenance_are_controlled_fixture_boundaries':True,'original_helpers_and_trigger_are_real_captured_bodies':True,'production_capacity_claimed':False,'old_indexes_retained':3};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2)+'\n');a.output.with_name(a.output.stem+'-plans.json').write_text(json.dumps(plans,indent=2)+'\n');print(json.dumps(report))
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
if __name__=='__main__':main()
