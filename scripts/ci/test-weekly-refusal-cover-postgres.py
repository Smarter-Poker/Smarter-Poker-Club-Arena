#!/usr/bin/env python3
"""Exact refusal function parity and index-only scope probe on disposable PG17."""
import argparse,json,os,shutil,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True)
a=ap.parse_args();root=Path(__file__).resolve().parents[2]
a.scratch.mkdir(parents=True,exist_ok=True);base=Path(tempfile.mkdtemp(prefix='refusal-',dir=a.scratch));data=base/'d';started=False
sig='public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)'
def run(args,s=None,error=None):
 r=subprocess.run(list(map(str,args)),input=s,text=True,capture_output=True,timeout=120,env={**os.environ,'TMPDIR':str(base)})
 if error:assert r.returncode and error in r.stderr,(error,r.stdout+r.stderr)
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def sql(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',base,'-U','postgres','-d','postgres'],s,error)
try:
 assert ' 17.' in run([a.pg_bin/'postgres','--version'])
 run([a.pg_bin/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',data,'-l',base/'log','-o',f"-h '' -k {base}",'-w','start']);started=True
 sql("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE control(frozen boolean);INSERT INTO control VALUES(false);
 CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT frozen FROM control$$;
 CREATE TABLE accounting_cash_source_receipts(id uuid PRIMARY KEY,rake_record_id uuid,earned_at timestamptz,scope jsonb,reason text,status text,padding text);
 CREATE TABLE accounting_cash_source_work(rake_record_id uuid PRIMARY KEY,receipt_id uuid,status text);
 CREATE INDEX work_blocked ON accounting_cash_source_work(rake_record_id) WHERE status='blocked';
 INSERT INTO accounting_cash_source_receipts SELECT md5('receipt-'||g)::uuid,md5('record-'||g)::uuid,
  CASE g%9 WHEN 0 THEN '-infinity'::timestamptz WHEN 1 THEN 'infinity'::timestamptz WHEN 2 THEN NULL WHEN 3 THEN '2026-10-19 07:00Z'::timestamptz WHEN 4 THEN '2026-10-26 07:00Z'::timestamptz ELSE '2026-10-21'::timestamptz END,
  CASE g%6 WHEN 0 THEN jsonb_build_object('kind','unknown') WHEN 1 THEN jsonb_build_object('kind','union','id',md5('union')::uuid) WHEN 2 THEN jsonb_build_object('kind','club','id',md5('club')::uuid) WHEN 3 THEN jsonb_build_object('kind','union','id',md5('other')::uuid) WHEN 4 THEN jsonb_build_object('kind','club') ELSE NULL END,
  CASE WHEN g%3=0 THEN NULL ELSE 'reason-'||g END,CASE WHEN g%3=0 THEN 'accrued' ELSE 'blocked' END,repeat(md5('padding-'||g),64)
 FROM generate_series(1,6000)g;
 INSERT INTO accounting_cash_source_work SELECT rake_record_id,id,CASE WHEN get_byte(uuid_send(id),0)%2=0 THEN 'blocked' ELSE 'accrued' END FROM accounting_cash_source_receipts;
 -- Duplicate receipt pointers and disagreement between receipt/work status
 -- stay in the original result: the optimization must not invent invariants.
 INSERT INTO accounting_cash_source_work SELECT md5('duplicate-'||id)::uuid,id,'blocked' FROM accounting_cash_source_receipts LIMIT 5;
 ANALYZE;""")
 original=(root/'scripts/ci/fixtures/weekly-refusal-cover/original.sql').read_text();sql(original)
 assert sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='ac7d777693e79eca6a13084b51cd1305'
 sql('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;')
 meta="SELECT jsonb_build_array(proowner,proacl,prosecdef,provolatile,proconfig,proparallel,proisstrict) FROM pg_proc WHERE oid='"+sig+"'::regprocedure"
 before=sql(meta)
 calls=["SELECT fn_cash_source_refusals_for_period(md5('union')::uuid,NULL,'2026-10-19 07:00Z','2026-10-26 07:00Z')", "SELECT fn_cash_source_refusals_for_period(NULL,md5('club')::uuid,'2026-10-19 07:00Z','2026-10-26 07:00Z')", "SELECT fn_cash_source_refusals_for_period(NULL,md5('absent')::uuid,'2026-10-19 07:00Z','2026-10-26 07:00Z')"]
 def answers():return [json.loads(sql('SET plan_cache_mode='+mode+';'+c)) for mode in ['force_generic_plan','force_custom_plan'] for c in calls]
 baseline=answers();assert all(x['count']==len(x['sources']) for x in baseline)
 sql("SELECT fn_cash_source_refusals_for_period(NULL,NULL,now()-interval '1 day',now())",'invalid_cash_refusal_scope')
 migration=(root/'supabase/migrations/20261026143349_weekly_close_refusal_checks_read_only_their_scope.sql').read_text()
 preamble,body=migration.split('BEGIN;',1);sql(preamble);body='BEGIN;'+body
 sql('VACUUM ANALYZE accounting_cash_source_receipts;')
 sql(body.replace('BEGIN;','BEGIN;UPDATE control SET frozen=true;',1),'weekly_refusal_install_frozen')
 sql(body.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'forced_rollback';END$$;COMMIT;"),'forced_rollback')
 assert sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='ac7d777693e79eca6a13084b51cd1305'
 sql(body);assert answers()==baseline;assert sql(meta)==before
 definition=sql("SELECT pg_get_functiondef('"+sig+"'::regprocedure)")
 query=definition[definition.index(' WITH scoped_refusals'):definition.index(' RETURN jsonb_build_object')].replace(' INTO problems','')
 for k,v in [('p_union_id',"md5('union')::uuid"),('p_club_id','NULL::uuid'),('p_from',"'2026-10-19 07:00Z'::timestamptz"),('p_to',"'2026-10-26 07:00Z'::timestamptz")]:query=query.replace(k,v)
 plan=json.loads(sql('EXPLAIN(ANALYZE,FORMAT JSON,TIMING FALSE) '+query))[0]
 nodes=[]
 def visit(n):
  nodes.append(n)
  for c in n.get('Plans',[]):visit(c)
 visit(plan['Plan'])
 cover=[n for n in nodes if n.get('Index Name')=='accounting_cash_receipts_refusal_cover']
 assert cover and all(n['Node Type']=='Index Only Scan' and n['Heap Fetches']==0 for n in cover),plan
 sql(body,'weekly_refusal_preimage_changed')
 print(json.dumps({'qualification':'passed','scope_answers':6,'receipt_cases':6000,'duplicate_pointers_preserved':True,'null_and_infinite_dates':True,'mismatched_status_preserved':True,'rollback_verified':True,'grants_owner_and_function_metadata_preserved':True,'cover_heap_fetches':0,'scope_probe_index_only':True,'native_execution_ms':plan['Execution Time']}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(base)
