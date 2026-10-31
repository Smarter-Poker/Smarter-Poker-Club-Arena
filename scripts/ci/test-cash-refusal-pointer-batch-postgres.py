import argparse,ast,json,os,shutil,socket,subprocess,tempfile,hashlib
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);args=ap.parse_args()
base=args.scratch; base.mkdir(parents=True,exist_ok=True)
repo=Path(__file__).resolve().parents[2]
pg=args.pg_bin
fixture=ast.parse((repo/'scripts/ci/test-weekly-refusal-cover-postgres.py').read_text())
setup=next(n.args[0].value for n in ast.walk(fixture) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='sql' and n.args and isinstance(n.args[0],ast.Constant) and isinstance(n.args[0].value,str) and 'CREATE ROLE anon;' in n.args[0].value)
cluster=Path(tempfile.mkdtemp(prefix='native-',dir=base)); started=False
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
def run(args,s=None):
 r=subprocess.run(list(map(str,args)),input=s,text=True,capture_output=True,timeout=90,env={**os.environ,'TMPDIR':str(cluster)})
 assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def sql(s):return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s)
try:
 run([pg/'initdb','-D',cluster/'d','-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([pg/'pg_ctl','-D',cluster/'d','-l',cluster/'log','-o',f'-h 127.0.0.1 -p {port} -k ""','-w','start']);started=True
 sql(setup)
 sql("CREATE INDEX accounting_cash_receipts_refusal_cover ON accounting_cash_source_receipts(id) INCLUDE(earned_at,scope); CREATE INDEX accounting_cash_work_attempt_cover ON accounting_cash_source_work(attempts,next_attempt_at,rake_record_id) INCLUDE(receipt_id) WHERE status='blocked';")
 sql("INSERT INTO accounting_cash_source_work VALUES(md5('missing')::uuid,md5('absent')::uuid,'blocked',1,now()),(md5('nullpointer')::uuid,NULL,'blocked',1,now());")
 original=(repo/'scripts/ci/fixtures/cash-refusal-scope-set/original.sql').read_text();sql(original)
 sig='public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)'
 sql('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;')
 assert sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='294935a386ce126757330f577631dafe'
 meta="SELECT jsonb_build_array(proowner,proacl,prosecdef,provolatile,proconfig,proparallel,proisstrict) FROM pg_proc WHERE oid='"+sig+"'::regprocedure"
 metadata=sql(meta)
 raw="SELECT md5(string_agg(to_jsonb(r)::text,'' ORDER BY id)) FROM accounting_cash_source_receipts r"
 before=sql(raw)
 calls=[]
 for union,club in [("md5('union')::uuid",'NULL'),('NULL',"md5('club')::uuid"),('NULL',"md5('absent')::uuid")]:
  for f,t in [("'2026-10-19 07:00Z'","'2026-10-26 07:00Z'"),("'2026-10-26 07:00Z'","'2026-10-27 07:00Z'")]:calls.append(f"SELECT fn_cash_source_refusals_for_period({union},{club},{f},{t})")
 def answers():return [json.loads(sql('SET plan_cache_mode='+mode+';'+c)) for mode in ['force_generic_plan','force_custom_plan'] for c in calls]
 baseline=answers()
 empty_before=sql('BEGIN;DELETE FROM accounting_cash_source_work;'+calls[0]+';ROLLBACK;')
 work_before=sql("SELECT md5(string_agg(to_jsonb(w)::text,'' ORDER BY rake_record_id)) FROM accounting_cash_source_work w")
 migration=(repo/'supabase/migrations/20261027164000_cash_refusals_read_the_compact_scope_set_once.sql').read_text()
 def refuses(s,expected):
  try:sql(s)
  except AssertionError as e:assert expected in str(e),str(e)
  else:raise AssertionError('expected refusal '+expected)
 refuses(migration.replace('BEGIN;','BEGIN;UPDATE control SET frozen=true;',1),'cash_refusal_scope_set_install_frozen')
 assert sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='294935a386ce126757330f577631dafe'
 refuses(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'forced_rollback';END$$;COMMIT;"),'forced_rollback')
 assert sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='294935a386ce126757330f577631dafe'
 sql('GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;')
 refuses(migration,'cash_refusal_scope_set_preimage_changed')
 sql('REVOKE EXECUTE ON FUNCTION '+sig+' FROM service_role;')
 sql(migration);assert answers()==baseline;assert sql(meta)==metadata;assert sql(raw)==before
 assert sql('BEGIN;DELETE FROM accounting_cash_source_work;'+calls[0]+';ROLLBACK;')==empty_before
 assert sql("SELECT md5(string_agg(to_jsonb(w)::text,'' ORDER BY rake_record_id)) FROM accounting_cash_source_work w")==work_before
 candidate=sql("SELECT pg_get_functiondef('"+sig+"'::regprocedure)")+"\n"
 refuses(migration,'cash_refusal_scope_set_preimage_changed')
 for c in ["SELECT fn_cash_source_refusals_for_period(NULL,NULL,now()-interval '1 day',now())", "SELECT fn_cash_source_refusals_for_period(md5('union')::uuid,NULL,'-infinity',now())", "SELECT fn_cash_source_refusals_for_period(md5('union')::uuid,NULL,now(),now())"]:refuses(c,'invalid_cash_refusal_scope')
 sql('VACUUM ANALYZE accounting_cash_source_receipts;')
 kernel=candidate[candidate.index(' WITH blocked_work'):candidate.index(' RETURN jsonb_build_object')].replace(' INTO problems','')
 for key,val in [('p_union_id',"md5('union')::uuid"),('p_club_id','NULL::uuid'),('p_from',"'2026-10-19 07:00Z'::timestamptz"),('p_to',"'2026-10-26 07:00Z'::timestamptz")]:kernel=kernel.replace(key,val)
 plan=json.loads(sql('EXPLAIN(ANALYZE,FORMAT JSON,TIMING FALSE) '+kernel))
 nodes=[]
 def visit(n):
  nodes.append(n)
  for child in n.get('Plans',[]):visit(child)
 visit(plan[0]['Plan'])
 cover=[n for n in nodes if n.get('Index Name')=='accounting_cash_receipts_refusal_cover' and 'ANY' in n.get('Index Cond','')]
 assert cover and all(n['Node Type']=='Index Only Scan' and n['Heap Fetches']==0 for n in cover),plan
 (base/'pointer-batch-native-plan.json').write_text(json.dumps(plan,indent=2))
 result={'qualified_semantics':True,'actual_original_md5':'294935a386ce126757330f577631dafe','calls':len(baseline),'records':6000,'duplicate_missing_null_pointers':True,'metadata_unchanged':True,'raw_receipts_unchanged':True,'candidate_sha256':hashlib.sha256(candidate.encode()).hexdigest(),'installer_frozen_acl_rollback_replay_refusals':True,'invalid_input_refusals':3,'production_performance':'reported_separately'}
 (base/'pointer-batch-native-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 if started:run([pg/'pg_ctl','-D',cluster/'d','-m','immediate','-w','stop'])
 shutil.rmtree(cluster)
