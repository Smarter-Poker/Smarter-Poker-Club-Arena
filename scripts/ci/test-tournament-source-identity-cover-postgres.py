#!/usr/bin/env python3
"""PG17 physical identity cover: full source-table contract, exact old/541b FOR bags.
Only private fixture clusters. Financial/helper/maintenance collaborators are
explicit adapters; no production latency, whole Scope or producer qualification.
"""
import argparse,concurrent.futures,hashlib,json,os,re,shutil,subprocess,tempfile,time
from pathlib import Path
R=Path(__file__).resolve().parents[2]
F=R/'scripts/ci/fixtures/tournament-source-identity-cover'
INDEX='accounting_tournament_source_identity_keys_cover'
GEN='original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'
def lit(s):return "'"+str(s).replace("'","''")+"'"
def nodes(p):
 yield p
 for c in p.get('Plans',[]):yield from nodes(c)
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')));ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args()
 assert __debug__ and a.scratch.is_dir()and not a.output.exists()
 w=Path(tempfile.mkdtemp(prefix='fic-',dir=a.scratch.resolve()));assert len(str(w).encode())<90,'short owned socket path required';data=w/'d';started=False;cases=[];plans=[]
 env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(TMPDIR=str(w),TMP=str(w),TEMP=str(w),LC_ALL='C')
 ps=[a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',w,'-U','postgres','-d','postgres']
 def run(args,sql=None,error=None,timeout=60):
  p=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=timeout)
  assert (p.returncode!=0 and error in p.stderr)if error else p.returncode==0,(p.stdout[-2000:],p.stderr[-10000:]);return p.stdout.strip()
 def q(sql,error=None,timeout=60):return run(ps,sql,error,timeout)
 def js(sql):return json.loads(q(sql))
 def rec(n):cases.append(n);print('PASS',n,flush=True)
 migration=next((R/'supabase/migrations').glob('20261029020140_*'));sql=migration.read_text();authority=json.loads((F/'actual-table-authority.json').read_text())['table']
 try:
  assert ' 17.'in run([a.pg_bin/'postgres','--version'])
  run([a.pg_bin/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
  with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(w)+"'\nshared_buffers='16MB'\nwork_mem='32MB'\nmaintenance_work_mem='32MB'\ntemp_file_limit='256MB'\njit=off\n")
  run([a.pg_bin/'pg_ctl','-D',data,'-l',w/'server.log','-w','start']);started=True
  base=R/'scripts/ci/fixtures/weekly-statement-indexed-quality';schema=(base/'schema.sql').read_text()
  schema=re.sub(r'^CREATE TABLE public\.accounting_tournament_fee_sources\([^\n]+\);\n','',schema,flags=re.M)
  schema=re.sub(r'^CREATE INDEX ON public\.accounting_tournament_fee_sources\([^\n]+\);\n','',schema,flags=re.M)
  q(schema);q((base/'installer-authorities.sql').read_text());q((R/'scripts/ci/fixtures/weekly-quality-typed-source-maps/current-boundaries.sql').read_text())
  cols=[c['name']+' '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['notnull']else'')for c in authority['columns']]
  q('CREATE TABLE public.accounting_tournament_fee_sources('+','.join(cols)+');')
  for c in authority['constraints']:q('ALTER TABLE accounting_tournament_fee_sources ADD CONSTRAINT '+c['name']+' '+c['definition']+';')
  # Reproduce all14 actual indexes, not only the three accessed-column prototypes.
  for ix in authority['indexes']:
   name=ix['definition'].split('INDEX ')[1].split(' ON ')[0]
   if q('SELECT to_regclass('+lit(name)+')IS NULL')=='t':q(ix['definition']+';')
  q('ALTER TABLE accounting_tournament_recognized_sources ADD CONSTRAINT accounting_tournament_recognized_sources_source_id_fkey FOREIGN KEY(source_id)REFERENCES accounting_tournament_fee_sources(id);')
  q('ALTER TABLE accounting_tournament_recognized_sources ADD CONSTRAINT accounting_tournament_recognized_sources_tournament_id_fkey FOREIGN KEY(tournament_id)REFERENCES accounting_tournament_fee_recognitions(tournament_id);')
  # Actual eight trigger identities/ABIs/catalog shape. Their financial bodies
  # are explicit inert adapters; this index never modifies a producer body.
  made=set()
  for t in authority['triggers']:
   if t['catalog']['tgisinternal']:continue
   fn=t['definition'].split('EXECUTE FUNCTION ',1)[1]
   if fn not in made:q('CREATE FUNCTION public.'+fn+'RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF TG_LEVEL=\'STATEMENT\'THEN RETURN NULL;END IF;RETURN COALESCE(NEW,OLD);END$$;');made.add(fn)
   q(t['definition']+';')
  q('ALTER TABLE accounting_tournament_fee_sources ENABLE ROW LEVEL SECURITY;REVOKE ALL ON accounting_tournament_fee_sources FROM PUBLIC,anon,authenticated,service_role;GRANT SELECT ON accounting_tournament_fee_sources TO service_role;')
  q("CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.gen_fail',true)='on'THEN NULL ELSE '"+GEN+"'END$$;")
  seed=(R/'scripts/ci/fixtures/weekly-quality-typed-source-maps/cases.sql').read_text()
  seed=seed.replace('INSERT INTO public.accounting_tournament_fee_sources VALUES(', 'INSERT INTO public.accounting_tournament_fee_sources(id,tournament_id,rake_record_id,rake_credit,union_id,coordinator_union_id,club_id,player_id,contract,charged_at,registration_id,source_charge_ledger_id,source_entitlement_id,game_type)VALUES(')
  old="'2026-10-06 11:00Z');";assert seed.count(old)==1
  seed=seed.replace(old,"'2026-10-06 11:00Z',fixture.u(300000+n),fixture.u(400000+n),fixture.u(500000+n),'holdem');")
  seed=seed.replace("'membership',jsonb_build_object('history_id','fixture'))", "'membership',jsonb_build_object('history_id','fixture'),'native_wide_contract',(SELECT string_agg(md5(n::text||':'||g),''ORDER BY g)FROM generate_series(1,24)g))")
  # Recognition FK is real: insert the parent recognition before its child.
  child=" INSERT INTO public.accounting_tournament_recognized_sources VALUES(s,t,'2026-10-06 12:00Z','earned',100);\n";assert seed.count(child)==1;seed=seed.replace(child,'');anchor=" INSERT INTO public.tournament_rake_settlements VALUES";seed=seed.replace(anchor,child+anchor,1)
  q(seed);q('SELECT fixture.event(1000+n)FROM generate_series(1,5000)n;')
  assert q("SELECT count(*)=5000 AND avg(pg_column_size(contract))>1000 FROM accounting_tournament_fee_sources")=='t'
  widths=js("SELECT jsonb_build_object('rows',count(*),'avg_contract_bytes',avg(pg_column_size(contract)))FROM accounting_tournament_fee_sources")
  # One arbitrary-width contract proves no JSON/text datum enters BTree keys.
  q("UPDATE accounting_tournament_fee_sources SET contract=contract||jsonb_build_object('native_unbounded',(SELECT string_agg(md5(g::text),'')FROM generate_series(1,3000)g))WHERE id=fixture.u(201001);")
  q('VACUUM ANALYZE accounting_tournament_fee_sources;ANALYZE;')
  rec('full15columns5constraints14indexes8trigger_contracts_wide_JSON_fixture')
  before_rows=q("SELECT md5(string_agg(md5(to_jsonb(s)::text),''ORDER BY id))FROM accounting_tournament_fee_sources s")
  raw_triggers="SELECT jsonb_agg(jsonb_build_object('catalog',to_jsonb(t),'definition',pg_get_triggerdef(t.oid))ORDER BY t.oid)FROM pg_trigger t WHERE t.tgrelid='accounting_tournament_fee_sources'::regclass"
  triggers=q(raw_triggers);proj=(F/'table-contract-projection.sql').read_text().replace(' INTO actual','');table=q(proj)
  original_functions=q("SELECT jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'metadata',to_jsonb(p))ORDER BY oid)FROM pg_proc p WHERE p.pronamespace IN('public'::regnamespace,'smarter_private'::regnamespace)")
  queries={};full_functions={}
  for label,name,expected in [('current','quality-current.sql','28a130f35342357a4dfa61043f1ce2a2'),('541b','quality-541b.sql','541b13417ffd614be148737ae33242b1')]:
   s=(F/name).read_text();assert hashlib.md5(s.rstrip().rstrip(';').encode()+b'\n').hexdigest()==expected
   start=s.index('  WITH candidates_all AS (');query=s[start:s.index('\n LOOP',start)]
   for old,new in [('p_from','$1'),('p_to','$2'),('p_club_id','$3'),('scope_union','$4')]:query=re.sub(r'\b'+old+r'\b',new,query)
   queries[label]=query;full_functions[label]=s
  split="import{splitConcurrentPreamble}from"+json.dumps((R/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));"
  parts=json.loads(run(['node','--input-type=module','-e',split,migration]));assert parts['ok']and len(parts['indexes'])==1;statement=parts['indexes'][0]['statement'];body=parts['body']
  def explain(label,mode):
   prefix='SET plan_cache_mode='+mode+';PREPARE f(timestamptz,timestamptz,uuid,uuid)AS '+queries[label]+';'
   args="('2026-10-05 07:00Z','2026-10-12 07:00Z',fixture.u(1),fixture.u(10))"
   plan=js(prefix+'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF)EXECUTE f'+args+';')
   bag=q(prefix+"PREPARE b(timestamptz,timestamptz,uuid,uuid)AS SELECT jsonb_build_object('count',count(*),'bag',md5(coalesce(jsonb_agg(to_jsonb(original)ORDER BY tournament_id)::text,'[]')))FROM("+queries[label]+')original;EXECUTE b'+args+';')
   return plan,bag
  expected_bags={}
  boundaries=[('NULL_receipt_fields',"UPDATE accounting_tournament_recognized_sources SET disposition=NULL,rake_credit=NULL WHERE source_id=fixture.u(201001);"),('wrong_event_receipt',"UPDATE accounting_tournament_recognized_sources SET tournament_id=fixture.u(1002)WHERE source_id=fixture.u(201001);"),('foreign_source_scope',"UPDATE accounting_tournament_fee_sources SET club_id=fixture.u(2),coordinator_union_id=fixture.u(20)WHERE id=fixture.u(201001);"),('NULL_source_union',"UPDATE accounting_tournament_fee_sources SET union_id=NULL,coordinator_union_id=NULL WHERE id=fixture.u(201001);")]
  for stage in ['before','after']:
   if stage=='after':
    q(statement);q(body);assert q(proj)==table and q(raw_triggers)==triggers and q("SELECT md5(string_agg(md5(to_jsonb(s)::text),''ORDER BY id))FROM accounting_tournament_fee_sources s")==before_rows
    rec('one_actual_CCI_fixed_three_UUID_catalog_and_full_actual_table_guard')
   for density,n in [('dense',5000),('sparse',50)]:
    q("UPDATE accounting_tournament_fee_recognitions SET recognized_at=CASE WHEN tournament_id<=fixture.u("+str(1000+n)+")THEN '2026-10-06 12:00Z'::timestamptz ELSE '2026-09-01 12:00Z'::timestamptz END;UPDATE tournament_rake_settlements SET settled_at=CASE WHEN tournament_id<=fixture.u("+str(1000+n)+")THEN '2026-10-06 12:00Z'::timestamptz ELSE '2026-09-01 12:00Z'::timestamptz END;ANALYZE accounting_tournament_fee_recognitions;ANALYZE tournament_rake_settlements;")
    for label in queries:
     for mode in ['auto','force_custom_plan','force_generic_plan']:
      plan,bag=explain(label,mode);key=(density,label,mode)
      assert json.loads(bag)['count']==n,(key,bag)
      if stage=='before':expected_bags[key]=bag
      else:assert bag==expected_bags[key],(key,'full FOR bag changed')
      source_nodes=[v for v in nodes(plan[0]['Plan'])if v.get('Relation Name')=='accounting_tournament_fee_sources']
      if stage=='after':
       orphan_roots=[v for v in nodes(plan[0]['Plan'])if v.get('Subplan Name')=='CTE orphan_source_identities']
       assert len(orphan_roots)==1,(key,'missing orphan identity CTE')
       orphan=[v for v in nodes(orphan_roots[0])if v.get('Relation Name')=='accounting_tournament_fee_sources']
       assert orphan and all(v.get('Index Name')==INDEX and v['Node Type']=='Index Only Scan'and v['Heap Fetches']==0 for v in orphan),(key,orphan)
       if label=='541b'and density=='dense'and mode!='force_generic_plan':
        selected_roots=[v for v in nodes(plan[0]['Plan'])if v.get('Subplan Name')=='CTE selected_event_sources']
        assert len(selected_roots)==1,(key,'missing selected keys CTE')
        selected=[v for v in nodes(selected_roots[0])if v.get('Relation Name')=='accounting_tournament_fee_sources']
        assert selected and all(v.get('Index Name')==INDEX and v['Node Type']=='Index Only Scan'and v['Heap Fetches']==0 for v in selected),(key,selected)
      plans.append({'stage':stage,'density':density,'query':label,'mode':mode,'bag':json.loads(bag),'plan':plan})
    rec(stage+'_'+density+'_old28a_and_541b_all3_modes_exact_full_FOR_bags')
  # Compare each fault bag with and without the physical cover in private
  # rolled-back transactions after the visibility-sensitive plan experiment.
  for boundary,setup in boundaries:
   for label in queries:
    for mode in ['auto','force_custom_plan','force_generic_plan']:
     values=[]
     for physical in [False,True]:
      prefix='BEGIN;'+(''if physical else'DROP INDEX '+INDEX+';')+setup+'SET LOCAL plan_cache_mode='+mode+';PREPARE boundary(timestamptz,timestamptz,uuid,uuid)AS SELECT coalesce(jsonb_agg(to_jsonb(original)ORDER BY tournament_id)::text,\'[]\')FROM('+queries[label]+')original;'
      values.append(q(prefix+"EXECUTE boundary('2026-10-05 07:00Z','2026-10-12 07:00Z',fixture.u(1),fixture.u(10));ROLLBACK;"))
     assert values[0]==values[1],('full original boundary bag changed',boundary,label,mode)
   rec('after_full_FOR_'+boundary+'_bags_all3_modes')
  assert q(proj)==table and q(raw_triggers)==triggers
  rec('all_original_source_rows_contracts_14_indexes_ACL_RLS_constraints_triggers_unchanged')
  # Actual full functions also retain NULL/duplicate/wrong-event behavior after
  # a physical-only change; no query or helper is replaced by the migration.
  for label,s in full_functions.items():q(s.replace('FUNCTION public.fn_accounting_tournament_week_quality(', 'FUNCTION fixture.quality_'+label+'(',1))
  for label in full_functions:assert js("SELECT fixture.verdict('fixture.quality_"+label+"')")=={'status':'ready','checked':50}
  rec('actual_complete_old28a_and_541b_quality_functions_run_with_narrow_index')
  # Extract the owning applier's exact history template, not a second writer.
  version=migration.name[:14];slug=migration.name[15:-4]
  history_js="import fs from'node:fs';const source=fs.readFileSync("+json.dumps(str(R/'scripts/ci/apply-recorded-migration.mjs'))+",'utf8'),sql=fs.readFileSync("+json.dumps(str(migration))+",'utf8'),version="+json.dumps(version)+",slug="+json.dumps(slug)+",tag='$ca_file_history_'+version+'$',exactSQLLiteral=tag+sql+tag;const template=source.match(/const historyStatement = `([\\s\\S]*?)`;/)[1];const statement=template.replaceAll('${version}',version).replaceAll('${slug}',slug).replaceAll('${exactSQLLiteral}',()=>exactSQLLiteral);if(['${version}','${slug}','${exactSQLLiteral}'].some(x=>statement.includes(x)))throw Error('unexpanded history');console.log(JSON.stringify({statement,exactSQLLiteral}));"
  history=json.loads(run(['node','--input-type=module','-e',history_js]));bad=body.rsplit('COMMIT;',1)[0]+history['statement'].replace('ARRAY['+history['exactSQLLiteral']+'::text]',"ARRAY['wrong-source']",1)+'COMMIT;'
  oid=q("SELECT '"+INDEX+"'::regclass::oid");q(bad,'atomic migration history does not match the exact source file');assert q('SELECT count(*)FROM supabase_migrations.schema_migrations')=='0'and q("SELECT '"+INDEX+"'::regclass::oid")==oid
  rec('actual_atomic_history_template_failure_retains_VALID_prefix_without_history')
  q(statement);q(body);assert q("SELECT '"+INDEX+"'::regclass::oid")==oid
  rec('VALID_prefix_IF_NOT_EXISTS_resume_never_rebuilds_or_drops_index')
  for name,setup,error in [('role','SET LOCAL ROLE service_role;','operator_refused'),('jwt',"SET LOCAL request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';",'operator_refused'),('boundary',"SET LOCAL native.boundary='2026-10-29 04:00Z';",'window_refused'),('force_RLS','ALTER TABLE accounting_tournament_fee_sources FORCE ROW LEVEL SECURITY;','actual_table_required'),('constraint','ALTER TABLE accounting_tournament_fee_sources DROP CONSTRAINT accounting_tournament_fee_sources_rake_credit_check;','actual_table_required'),('old_index','DROP INDEX accounting_tournament_fee_sources_event;','actual_table_required'),('source65',"SET LOCAL native.sources_match='off';",'source65_required'),('generation',"SET LOCAL native.gen_fail='on';",'original_generation_required'),('freeze',"SET LOCAL native.frozen='on';",'window_refused'),('window',"SET LOCAL native.window_refusal='refused';",'window_refused'),('override',"SET LOCAL ca.break_window_migration_override='not-authorized';",'operator_refused'),('ACL','GRANT INSERT ON accounting_tournament_fee_sources TO service_role;','actual_table_required'),('column','ALTER TABLE accounting_tournament_fee_sources ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();','actual_table_required'),('trigger','ALTER TABLE accounting_tournament_fee_sources DISABLE TRIGGER aa_poker_arena_no_chip_money;','actual_table_required'),('invalid_prefix',"UPDATE pg_index SET indisvalid=false WHERE indexrelid='"+INDEX+"'::regclass;",'exact_catalog_required')]:
   q('BEGIN;'+setup+body,error);assert q(proj)==table and q(raw_triggers)==triggers and q('SELECT count(*)FROM supabase_migrations.schema_migrations')=='0';rec('installer_'+name+'_refuses_atomically')
  # IF NOT EXISTS cannot repair an INVALID same-name prefix. The owning
  # generic applier rejects this catalog before considering atomic history.
  q("UPDATE pg_index SET indisvalid=false WHERE indexrelid='"+INDEX+"'::regclass;")
  q(statement)
  assert q("SELECT NOT indisvalid AND indisready FROM pg_index WHERE indexrelid='"+INDEX+"'::regclass")=='t'
  q(body,'exact_catalog_required');assert q('SELECT count(*)FROM supabase_migrations.schema_migrations')=='0'
  q("UPDATE pg_index SET indisvalid=true WHERE indexrelid='"+INDEX+"'::regclass;")
  rec('INVALID_prefix_is_not_repaired_by_IF_NOT_EXISTS_and_cannot_record_history')
  # Rebuild only this PRIVATE fixture index to witness real CCI waiting for an
  # old RR snapshot, while a separate writer commits through actual FKs.
  q('DROP INDEX '+INDEX+';')
  hold=subprocess.Popen(list(map(str,ps)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
  try:
   hold.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SELECT count(*)FROM accounting_tournament_fee_sources;\n");hold.stdin.flush()
   assert hold.stdout.readline().strip()=='5000'
   with concurrent.futures.ThreadPoolExecutor(max_workers=1)as pool:
    build=pool.submit(q,statement,None,60)
    deadline=time.monotonic()+15
    while True:
     phase=q("SELECT phase FROM pg_stat_progress_create_index WHERE relid='accounting_tournament_fee_sources'::regclass")
     if phase=='waiting for old snapshots':break
     assert not build.done()and time.monotonic()<deadline,('CCI did not expose old-snapshot phase',phase)
     time.sleep(.02)
    q('SELECT fixture.event(7000);')
    hold.stdin.write("SELECT count(*)FROM accounting_tournament_fee_sources;COMMIT;\n");hold.stdin.flush()
    assert hold.stdout.readline().strip()=='5000'
    assert q('SELECT count(*)FROM accounting_tournament_fee_sources')=='5001'
    build.result(timeout=30)
   hold.stdin.close();assert hold.wait(timeout=10)==0,hold.stderr.read()
  finally:
   if hold.poll()is None:hold.kill();hold.wait()
  q(body);assert q(proj)==table and q(raw_triggers)==triggers
  rec('real_CCI_old_RR_snapshot_and_concurrent_FK_writer_complete_without_source_mutation')
  assert q("SELECT jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'metadata',to_jsonb(p))ORDER BY oid)FROM pg_proc p WHERE p.pronamespace IN('public'::regnamespace,'smarter_private'::regnamespace)")==original_functions
  rec('all_original_public_private_function_definitions_and_metadata_unchanged')
  atomic=body.rsplit('COMMIT;',1)[0]+history['statement']+'COMMIT;';q(atomic)
  assert js("SELECT jsonb_build_object('version',version,'name',name,'exact',statements=ARRAY["+history['exactSQLLiteral']+"::text])FROM supabase_migrations.schema_migrations")=={'version':version,'name':slug,'exact':True}
  q(body,'history_replay');rec('exact_file_history_commit_and_replay_refusal_preserve_valid_physical_prefix')
  result={'qualification':'passed','case_count':len(cases),'cases':cases,'migration_sha256':hashlib.sha256(sql.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'fixture_contract_width':widths,'plans':plans,'limits':'Private PG17 source-only physical index. Exact full15column/default/5constraint/14index/access and eight trigger ABI/catalog contracts; trigger bodies and source65/GEN/maintenance/net-plan helpers are controlled external boundaries. Exact old28a and uninstalled541b query snapshots, density/mode full FOR bags. Does not qualify production build latency, whole Scope capacity, all source paths as zero heap, or original financial producers.'}
  a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'qualification':'passed','case_count':len(cases),'output':str(a.output)}))
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
  shutil.rmtree(w)
if __name__=='__main__':main()
