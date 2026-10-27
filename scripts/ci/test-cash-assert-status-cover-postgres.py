#!/usr/bin/env python3
"""Exact original raw completeness owner and compact batch-status index qualification.

Only auth/ghost/launch/platform fixtures are controlled. Original assertion,
null/missing batch semantics, full candidate sets and original metadata stay real.
No production access; native row counts/timings do not certify production speed.
"""
import argparse,hashlib,json,os,shutil,socket,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);args=ap.parse_args()
root=Path(__file__).resolve().parents[2];args.scratch.mkdir(parents=True,exist_ok=True)
w=Path(tempfile.mkdtemp(prefix='cash-assert-',dir=args.scratch));data=w/'d';pg=args.pg_bin;started=False
with socket.socket() as sk:sk.bind(('127.0.0.1',0));port=sk.getsockname()[1]
psql=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(port),'-U','postgres','-d','postgres']
env={**os.environ,'TMPDIR':str(w)}
def run(cmd,s=None,check=True):
 r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,timeout=90,env=env)
 if check:assert r.returncode==0,r.stdout+r.stderr
 return r
def q(s,check=True):return run(psql,s,check)
def val(s):return q(s).stdout.strip()
def refuses(s,message):
 r=q(s,False);assert r.returncode and message in r.stderr,(message,r.stdout,r.stderr)
def nodes(n):
 yield n
 for c in n.get('Plans',[]):yield from nodes(c)
try:
 assert ' 17.' in run([pg/'postgres','--version']).stdout
 run([pg/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([pg/'pg_ctl','-D',data,'-l',w/'log','-o',f'-h 127.0.0.1 -p {port} -k ""','-w','start']);started=True
 q("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
 CREATE TABLE fixture_controls(engine boolean,uid uuid,overseer boolean,frozen boolean);INSERT INTO fixture_controls VALUES(true,NULL,false,false);
 CREATE FUNCTION fn_caller_is_engine()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT engine FROM fixture_controls$$;
 CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT uid FROM fixture_controls$$;
 CREATE FUNCTION fn_is_union_overseer(uuid,uuid)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT overseer FROM fixture_controls$$;
 CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT frozen FROM fixture_controls$$;
 CREATE FUNCTION fn_rake_record_is_ghost_twin(uuid,uuid,jsonb)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT ($3->>'ghost')::boolean$$;
 CREATE FUNCTION fn_ca_launch_accounting_accepts(uuid,timestamptz)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT CASE WHEN $1=md5('late-club')::uuid THEN $2>='2026-10-22'::timestamptz ELSE true END$$;
 CREATE TABLE rake_records(id uuid PRIMARY KEY,club_id uuid,created_at timestamptz,rake_amount numeric,is_tournament boolean,tournament_id uuid,hand_id uuid,table_id uuid,metadata jsonb);
 CREATE TABLE accounting_cash_accrual_batches(rake_record_id uuid PRIMARY KEY,hand_id uuid UNIQUE,earned_at timestamptz,status text,plan text);
 ALTER TABLE accounting_cash_accrual_batches ALTER COLUMN plan SET STORAGE PLAIN;
 CREATE INDEX rake_records_cash_positive_created ON rake_records(created_at,id) WHERE rake_amount>0 AND is_tournament IS NOT TRUE AND tournament_id IS NULL;
 CREATE TABLE union_clubs(union_id uuid,club_id uuid);CREATE TABLE rake_attributions(rake_record_id uuid,club_id uuid);
 CREATE INDEX rake_attributions_club_record ON rake_attributions(club_id,rake_record_id);
 INSERT INTO union_clubs VALUES(md5('union')::uuid,md5('club')::uuid),(md5('union')::uuid,md5('late-club')::uuid),(md5('foreign-union')::uuid,md5('foreign-club')::uuid);
 INSERT INTO rake_records SELECT md5('raw-'||g)::uuid,
  CASE g%6 WHEN 0 THEN md5('union')::uuid WHEN 1 THEN md5('club')::uuid WHEN 2 THEN md5('late-club')::uuid WHEN 3 THEN md5('foreign-club')::uuid WHEN 4 THEN md5('other')::uuid ELSE NULL END,
  CASE g%7 WHEN 0 THEN '2026-10-19 07:00Z'::timestamptz WHEN 1 THEN '2026-10-26 07:00Z'::timestamptz WHEN 2 THEN '2026-10-18'::timestamptz WHEN 3 THEN '2026-10-27'::timestamptz ELSE '2026-10-21'::timestamptz END,
  CASE g%13 WHEN 0 THEN NULL WHEN 1 THEN -1 WHEN 2 THEN 0 ELSE 100 END,
  CASE g%5 WHEN 0 THEN true WHEN 1 THEN NULL ELSE false END,
  CASE WHEN g%9=0 THEN md5('tour')::uuid END,
  CASE WHEN g%3<>0 THEN md5('hand-'||g)::uuid END,md5('table')::uuid,
  CASE g%4 WHEN 0 THEN '{"ghost":true}'::jsonb WHEN 1 THEN '{"ghost":false}'::jsonb WHEN 2 THEN '{}'::jsonb ELSE NULL END
 FROM generate_series(1,5000)g;
 INSERT INTO accounting_cash_accrual_batches SELECT id,md5(id::text)::uuid,created_at,
  CASE get_byte(uuid_send(id),0)%5 WHEN 0 THEN 'blocked' WHEN 1 THEN 'pending' WHEN 2 THEN NULL ELSE 'accrued' END,repeat(md5(id::text),42)
 FROM rake_records WHERE get_byte(uuid_send(id),1)%7<>0;
 INSERT INTO rake_attributions SELECT id,md5('club')::uuid FROM rake_records WHERE get_byte(uuid_send(id),0)%7=0;
 INSERT INTO rake_attributions SELECT * FROM rake_attributions LIMIT 5;
 ANALYZE;""")
 original=(root/'scripts/ci/fixtures/cash-assert-status-cover/original.sql').read_text();q(original)
 sig='public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'
 q('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;')
 assert val("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='0df1c3e9fe3e1a0e53a043baf57127d7'
 meta="SELECT to_jsonb(p) FROM pg_proc p WHERE oid='"+sig+"'::regprocedure";before_meta=val(meta)
 fingerprint="SELECT md5(jsonb_build_object('r',(SELECT md5(string_agg(to_jsonb(r)::text,'' ORDER BY id))FROM rake_records r),'b',(SELECT md5(string_agg(to_jsonb(b)::text,'' ORDER BY rake_record_id))FROM accounting_cash_accrual_batches b),'a',(SELECT jsonb_agg(to_jsonb(a)ORDER BY rake_record_id,club_id)FROM rake_attributions a),'c',(SELECT jsonb_agg(to_jsonb(c)ORDER BY union_id,club_id)FROM union_clubs c))::text)";before_data=val(fingerprint)
 a=original.index('  WITH unaccrued AS MATERIALIZED');z=original.index('\n THEN RAISE',a);kernel=original[a:z].rstrip()[:-1]
 def subst(s,params):
  for k,v in zip(['p_union_id','p_club_id','p_from','p_to'],params):s=s.replace(k,v)
  return s
 scopes=[("md5('union')::uuid",'NULL::uuid'),('NULL::uuid',"md5('club')::uuid"),('NULL::uuid',"md5('foreign-club')::uuid"),('NULL::uuid',"md5('absent')::uuid")]
 periods=[("'2026-10-19 07:00Z'::timestamptz","'2026-10-26 07:00Z'::timestamptz"),("'2026-10-26 07:00Z'::timestamptz","'2026-10-27 07:00Z'::timestamptz"),("'-infinity'::timestamptz","'infinity'::timestamptz")]
 def answers():
  out=[]
  for mode in ['force_custom_plan','force_generic_plan']:
   for scope in scopes:
    for period in periods:
     params=scope+period;ks=subst(kernel,params).replace('SELECT 1 FROM unaccrued u','SELECT r.id FROM unaccrued u',1)
     ids=json.loads(val('SET plan_cache_mode='+mode+";SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]')FROM("+ks+')s'))
     call='SELECT '+sig.split('(')[0]+'('+','.join(params)+');';r=q('SET plan_cache_mode='+mode+';'+call,False)
     assert (r.returncode!=0)==bool(ids),(mode,scope,period,ids,r.stderr)
     if ids:assert 'cash_commission_earning_evidence_requires_reconciliation' in r.stderr
     out.append(ids)
  return out
 def guards():
  valid="md5('union')::uuid,NULL,'2026-10-19 07:00Z','2026-10-26 07:00Z'"
  for bad in ["NULL,NULL,'2026-10-19','2026-10-26'", "md5('union')::uuid,md5('club')::uuid,'2026-10-19','2026-10-26'", "md5('union')::uuid,NULL,NULL,'2026-10-26'", "md5('union')::uuid,NULL,'2026-10-26','2026-10-26'", "md5('union')::uuid,NULL,'2026-10-27','2026-10-26'"]:
   refuses('SELECT fn_assert_cash_commission_period('+bad+');','invalid_cash_commission_scope')
  refuses('SET ROLE anon;SELECT fn_assert_cash_commission_period('+valid+');','permission denied')
  q('UPDATE fixture_controls SET engine=false,uid=NULL,overseer=false;');refuses('SELECT fn_assert_cash_commission_period('+valid+');','service_role_required')
  q("UPDATE fixture_controls SET uid=md5('user')::uuid;");refuses('SELECT fn_assert_cash_commission_period('+valid+');','service_role_required')
  q('UPDATE fixture_controls SET overseer=true;');q("SELECT fn_assert_cash_commission_period(md5('absent-union')::uuid,NULL,'2026-10-19','2026-10-26');")
  q('UPDATE fixture_controls SET engine=true,uid=NULL,overseer=false;')
 guards();baseline=answers()
 migration=(root/'supabase/migrations/20261027180331_cash_evidence_reads_the_accrual_status_cover.sql').read_text();preamble,body=migration.split('BEGIN;',1);body='BEGIN;'+body
 q(preamble);refuses(body.replace('BEGIN;','BEGIN;UPDATE fixture_controls SET frozen=true;',1),'cash_status_cover_install_frozen')
 refuses(body.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'forced_cover_rollback';END$$;COMMIT;"),'forced_cover_rollback')
 q(body);guards();assert answers()==baseline;assert val(meta)==before_meta;assert val(fingerprint)==before_data
 q(migration);assert val("SELECT count(*)FROM pg_class WHERE relname='accounting_cash_batches_status_cover'")=='1'
 fault_count=0
 for ddl in ["CREATE INDEX accounting_cash_batches_status_cover ON accounting_cash_accrual_batches(rake_record_id)","CREATE INDEX accounting_cash_batches_status_cover ON accounting_cash_accrual_batches(status)INCLUDE(rake_record_id)","CREATE INDEX accounting_cash_batches_status_cover ON accounting_cash_accrual_batches(rake_record_id)INCLUDE(status)WHERE status='accrued'","CREATE UNIQUE INDEX accounting_cash_batches_status_cover ON accounting_cash_accrual_batches(rake_record_id)INCLUDE(status)","CREATE INDEX accounting_cash_batches_status_cover ON accounting_cash_accrual_batches(rake_record_id DESC)INCLUDE(status)"]:
  q('DROP INDEX accounting_cash_batches_status_cover;'+ddl+';');refuses(body,'cash_status_cover_');fault_count+=1
 q('DROP INDEX accounting_cash_batches_status_cover;')
 invalid=q('CREATE UNIQUE INDEX CONCURRENTLY accounting_cash_batches_status_cover ON accounting_cash_accrual_batches(status);',False);assert invalid.returncode
 assert val("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='accounting_cash_batches_status_cover'::regclass")=='t';refuses(body,'cash_status_cover_shape_changed');fault_count+=1
 q('DROP INDEX accounting_cash_batches_status_cover;');q(preamble);q(body)
 q('GRANT EXECUTE ON FUNCTION '+sig+' TO anon;');refuses(body,'cash_status_cover_original_owner_changed');q('REVOKE EXECUTE ON FUNCTION '+sig+' FROM anon;');fault_count+=1
 # A clean candidate cohort has no early witness: the entire original hash join runs.
 q("INSERT INTO accounting_cash_accrual_batches SELECT id,md5(id::text)::uuid,created_at,'accrued',repeat(md5(id::text),42)FROM rake_records ON CONFLICT(rake_record_id)DO UPDATE SET status='accrued';VACUUM ANALYZE accounting_cash_accrual_batches;VACUUM ANALYZE rake_records;")
 params=scopes[0]+periods[0];query='SELECT EXISTS('+subst(kernel,params)+')'
 q('DROP INDEX accounting_cash_batches_status_cover;');old_plan=json.loads(val('EXPLAIN(ANALYZE,FORMAT JSON,TIMING FALSE) '+query))[0]
 assert any(n.get('Relation Name')=='accounting_cash_accrual_batches' and n['Node Type']=='Seq Scan' for n in nodes(old_plan['Plan']))
 q(preamble);q(body);new_plan=json.loads(val('EXPLAIN(ANALYZE,FORMAT JSON,TIMING FALSE) '+query))[0]
 covered=[n for n in nodes(new_plan['Plan'])if n.get('Index Name')=='accounting_cash_batches_status_cover'];assert covered and all(n['Node Type']=='Index Only Scan' and n['Heap Fetches']==0 for n in covered),new_plan
 assert val(query)=='f'
 # An uncommitted real status update clears visibility; the unchanged assertion
 # must recheck the heap and retain the old committed accrued version.
 rawid=val("SELECT id FROM rake_records WHERE club_id=md5('club')::uuid AND created_at='2026-10-21' AND rake_amount=100 AND is_tournament IS NOT TRUE AND tournament_id IS NULL AND hand_id IS NOT NULL LIMIT 1")
 other=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 other.stdin.write("BEGIN;UPDATE accounting_cash_accrual_batches SET status='blocked'WHERE rake_record_id='"+rawid+"';SELECT 'updated';\n");other.stdin.flush();assert other.stdout.readline().strip()=='updated'
 try:
  mvcc=json.loads(val('EXPLAIN(ANALYZE,FORMAT JSON,TIMING FALSE) '+query))[0];assert val(query)=='f'
  assert any(n.get('Index Name')=='accounting_cash_batches_status_cover' and n.get('Heap Fetches',0)>0 for n in nodes(mvcc['Plan']))
 finally:other.stdin.write('ROLLBACK;\n');other.stdin.close();other.wait(timeout=10)
 q("UPDATE accounting_cash_accrual_batches SET status='blocked'WHERE rake_record_id='"+rawid+"';");assert val(query)=='t'
 assert val(meta)==before_meta
 plans={'before':old_plan,'after':new_plan,'mvcc':mvcc};(args.scratch/'cash-assert-status-cover-plans.json').write_text(json.dumps(plans,indent=2)+'\n')
 result={'status':'passed','whole_original_cases':len(baseline),'authorization_and_invalid_input_cases':9,'full_qualifying_id_sets_equal':True,'fixture_records':5000,'original_owner_md5':'0df1c3e9fe3e1a0e53a043baf57127d7','all_metadata_unchanged':True,'raw_source_fingerprints_unchanged_by_index':True,'installer_frozen_rollback_replay':True,'catalog_fault_cases':fault_count,'actual_invalid_concurrent_index_refused':True,'natural_original_plan':'SeqScan batch heap -> IndexOnlyScan existing exact query','cover_heap_fetches':0,'real_uncommitted_status_mvcc_heap_fallback':True,'after_committed_nonaccrued_detected':True,'native_before_ms':old_plan['Execution Time'],'native_after_ms':new_plan['Execution Time'],'production_speed':'requires root original-query readback after one maintained installation','controlled_helpers':['auth','ghost','launch','platform']}
 (args.scratch/'cash-assert-status-cover-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'],check=False)
 shutil.rmtree(w,ignore_errors=True)
