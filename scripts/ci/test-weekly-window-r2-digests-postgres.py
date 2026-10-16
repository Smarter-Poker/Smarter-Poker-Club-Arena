#!/usr/bin/env python3
"""Actual complete R2 combiner with real TOAST, independent fingerprints, PG17 only."""
import argparse,hashlib,json,os,shutil,subprocess,sys,tempfile,uuid
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2]);p.add_argument('--pg-bin',required=True);p.add_argument('--scratch',required=True);a=p.parse_args()
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote database forbidden')
F=a.repo.resolve()/'scripts/ci/fixtures/weekly-window-digests';scratch=Path(a.scratch).resolve()
if sys.platform=='darwin' and not str(scratch).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('external scratch required')
C=Path(tempfile.mkdtemp(prefix='rd-',dir=scratch));D=C/'d';pg=Path(a.pg_bin);started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres']
def run(cmd,text=None):
 r=subprocess.run(list(map(str,cmd)),input=text,text=True,capture_output=True,timeout=90)
 assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s):return run(psql,s)
pins=next(x for x in json.loads((F/'replacement.json').read_text())['functions'] if 'commission_combine' in x['signature']);before=(F/pins['before_file']).read_text();after=(F/pins['after_file']).read_text()
assert hashlib.md5(before.encode()).hexdigest()==pins['before_md5']=='0a4e7a1bc6b05634ebb0d87e6cc05501'
assert before.replace(pins['old'],pins['new'])==after
u="md5('union')::uuid";pa="'2026-10-05 07:00Z'::timestamptz";pb="'2026-10-12 07:00Z'::timestamptz";call=lambda name:f"{name}('union',{u},{pa},{pb})"
def expected(cash,fee):
 parts=[]
 for kind,count in [('cash',cash),('fee',fee)]:
  ids=sorted(range(1,count*84+1),key=lambda k:uuid.UUID(hashlib.md5(f'{kind}-source-{k}'.encode()).hexdigest()).int)
  parts.extend(hashlib.md5(f'{kind}-row-{k}'.encode()).hexdigest() for k in ids)
 return hashlib.md5(''.join(parts).encode()).hexdigest()
def seed(ncash,nfee):
 q(f"""TRUNCATE accounting_close_partials;
 INSERT INTO accounting_close_partials
 SELECT 'round2_union_window',{u},{pa},{pb},w.window_start,w.window_end,clock_timestamp(),
 jsonb_build_object('read_failed',false,'sources',{ncash+nfee},'unclassified',0,'odd',0,'tiers_failed',false,'tier_bad',0,'dup',0,'e1',0,'e2',0,'e3',0,
 'clubs',jsonb_build_array(md5('club')::uuid),'nodes',jsonb_build_array(
 jsonb_build_object('club_id',md5('club')::uuid,'user_id',md5('agent')::uuid,'agent_min',md5('parent')::uuid,'agent_max',md5('parent')::uuid,'role_min','agent','role_max','agent','own',1,'rows',2),
 jsonb_build_object('club_id',md5('club')::uuid,'user_id',md5('sub')::uuid,'agent_min',md5('agent')::uuid,'agent_max',md5('agent')::uuid,'role_min','sub_agent','role_max','sub_agent','own',0.25,'rows',1)),
 'edges',jsonb_build_array(jsonb_build_object('club_id',md5('club')::uuid,'payer_user',NULL,'payee_user',md5('agent')::uuid,'amount',1.25,'role_min','agent'),jsonb_build_object('club_id',md5('club')::uuid,'payer_user',md5('agent')::uuid,'payee_user',md5('sub')::uuid,'amount',0.25,'role_min','sub_agent'))),
 (SELECT array_agg(md5('cash-source-'||((w.n-1)*{ncash}+j))::uuid ORDER BY j DESC)FROM generate_series(1,{ncash})j),
 (SELECT decode(string_agg(md5('cash-row-'||((w.n-1)*{ncash}+j)),'' ORDER BY j DESC),'hex')FROM generate_series(1,{ncash})j),
 (SELECT array_agg(md5('fee-source-'||((w.n-1)*{nfee}+j))::uuid ORDER BY j DESC)FROM generate_series(1,{nfee})j),
 (SELECT decode(string_agg(md5('fee-row-'||((w.n-1)*{nfee}+j)),'' ORDER BY j DESC),'hex')FROM generate_series(1,{nfee})j)
 FROM fn_accounting_close_windows({pa},{pb}) WITH ORDINALITY w(window_start,window_end,n);""")
def outcome(name,change='',settings=True):
 setup="SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='fixture';" if settings else ''
 lines=q('BEGIN;'+setup+change+';SELECT '+call(name)+";SELECT jsonb_build_object('nodes',(SELECT jsonb_agg(to_jsonb(n) ORDER BY club_id,user_id) FROM pg_temp._routed_nodes n),'edges',(SELECT jsonb_agg(to_jsonb(e) ORDER BY club_id,payer_user NULLS FIRST,payee_user) FROM pg_temp._routed_edges e),'clubs',(SELECT jsonb_agg(to_jsonb(c) ORDER BY club_id) FROM pg_temp._routed_clubs c));ROLLBACK;").splitlines()
 return [json.loads(v) for v in lines if v]
def read_result(name,change='',settings=True):
 setup="SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='fixture';" if settings else ''
 text=q('BEGIN;'+setup+change+';SELECT coalesce('+call(name)+",'null'::jsonb);ROLLBACK;")
 return json.loads(text)
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (D/'postgresql.conf').open('a') as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\ntemp_file_limit='256MB'\n")
 run([pg/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q("""CREATE ROLE service_role;
 CREATE FUNCTION fn_accounting_close_proof_lifetime()RETURNS interval LANGUAGE sql IMMUTABLE AS $$SELECT interval '72 hours'$$;
 CREATE FUNCTION fn_accounting_close_windows(timestamptz,timestamptz)RETURNS TABLE(window_start timestamptz,window_end timestamptz) LANGUAGE sql IMMUTABLE AS $$SELECT x,least(x+interval '2 hours',$2)FROM generate_series($1,$2-interval '1 microsecond',interval '2 hours')x$$;
 CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,computed_at timestamptz,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea);
 """+before+";REVOKE ALL ON FUNCTION fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz) FROM PUBLIC;GRANT EXECUTE ON FUNCTION fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz) TO service_role;"+before.replace('public.fn_settle_accounting_commission_combine','public.fixture_before',1))
 authority=q("SELECT jsonb_build_array(proowner,prosecdef,provolatile,proacl,proconfig) FROM pg_proc WHERE oid='fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz)'::regprocedure;")
 q(after)
 assert q("SELECT md5(pg_get_functiondef('fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz)'::regprocedure));")==pins['after_md5']
 assert authority==q("SELECT jsonb_build_array(proowner,prosecdef,provolatile,proacl,proconfig) FROM pg_proc WHERE oid='fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz)'::regprocedure;")
 for nc,nf in [(3,2),(0,4),(4,0),(0,0)]:
  seed(nc,nf);old=outcome('fixture_before');new=outcome('fn_settle_accounting_commission_combine');assert old==new
  assert new[0]['fingerprint']==expected(nc,nf),(new[0],expected(nc,nf))
  assert new[0]['sources']==(nc+nf)*84 and len(new[1]['nodes'])==2 and len(new[1]['edges'])==2 and len(new[1]['clubs'])==1
  assert sorted(float(n['own_amount'])for n in new[1]['nodes'])==[21.0,84.0]
 seed(3,2)
 for change in ["DELETE FROM accounting_close_partials WHERE window_start=(SELECT min(window_start)FROM accounting_close_partials)","UPDATE accounting_close_partials SET computed_at='2026-10-11' WHERE window_start=(SELECT min(window_start)FROM accounting_close_partials)","UPDATE accounting_close_partials SET computed_at=clock_timestamp()-interval '73 hours' WHERE window_start=(SELECT min(window_start)FROM accounting_close_partials)","UPDATE accounting_close_partials SET kind='round2_club_window'","UPDATE accounting_close_partials SET union_id=md5('other')::uuid"]:
  assert read_result('fixture_before',change)==read_result('fn_settle_accounting_commission_combine',change)==None
 assert read_result('fixture_before',settings=False)==read_result('fn_settle_accounting_commission_combine',settings=False)==None
 flags=[('read_failed','true','read_failed'),('unclassified','1','unclassified'),('odd','1','full_path'),('tiers_failed','true','full_path'),('tier_bad','1','hierarchy_bad'),('e1','1','entitlement_bad')]
 for field,value,resultkey in flags:
  change=f"UPDATE accounting_close_partials SET value=jsonb_set(value,'{{{field}}}','{value}'::jsonb) WHERE window_start=(SELECT min(window_start)FROM accounting_close_partials)"
  old=read_result('fixture_before',change);new=read_result('fn_settle_accounting_commission_combine',change);assert old==new and bool(new[resultkey])
 # Differing hierarchy boundaries, zero/negative summed edges, duplicate global UUIDs with same digest.
 for change in ["UPDATE accounting_close_partials SET value=jsonb_set(value,'{nodes,0,agent_max}',to_jsonb(md5('different')::uuid)) WHERE window_start=(SELECT min(window_start)FROM accounting_close_partials)","UPDATE accounting_close_partials SET value=jsonb_set(value,'{edges,1,amount}','0'::jsonb)","UPDATE accounting_close_partials SET cash_ids=ARRAY[md5('same')::uuid],cash_md5=decode(md5('identical'),'hex')"]:
  assert outcome('fixture_before',change)==outcome('fn_settle_accounting_commission_combine',change)
 seed(1500,300);q('VACUUM ANALYZE accounting_close_partials;')
 toast_rows=int(q("SELECT c.reltuples::bigint FROM pg_class p JOIN pg_class c ON c.oid=p.reltoastrelid WHERE p.oid='accounting_close_partials'::regclass;"))
 # reltuples of the TOAST relation can be stale; verify its actual physical pages.
 toast_bytes=int(q("SELECT pg_relation_size(reltoastrelid)FROM pg_class WHERE oid='accounting_close_partials'::regclass;"));assert toast_bytes>1000000
 old=outcome('fixture_before');new=outcome('fn_settle_accounting_commission_combine');assert old==new and new[0]['fingerprint']==expected(1500,300)
 plans=[]
 for name in ['fixture_before','fn_settle_accounting_commission_combine']:
  text=q("BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='fixture';EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT "+call(name)+";ROLLBACK;");plans.append(json.loads(text)[0])
 def blocks(plan):return sum(plan['Plan'].get(k,0) for k in ['Shared Hit Blocks','Shared Read Blocks','Local Hit Blocks','Local Read Blocks'])
 assert blocks(plans[0])>blocks(plans[1])*2,(blocks(plans[0]),blocks(plans[1]))
 (scratch/'weekly-window-r2-native-plans.json').write_text(json.dumps(plans,indent=2)+'\n')
 result={'qualification':'passed','actual_whole_before_after_function':True,'before_md5':pins['before_md5'],'after_md5':pins['after_md5'],'fresh_windows':84,'independent_fingerprint_cases':4,'guard_and_flag_cases':15,'scaled_cash_sources':126000,'scaled_fee_sources':25200,'physical_toast_bytes':toast_bytes,'old_blocks':blocks(plans[0]),'new_blocks':blocks(plans[1]),'old_ms':plans[0]['Execution Time'],'new_ms':plans[1]['Execution Time'],'metadata_unchanged':True,'production_settlement_qualified':False}
 (scratch/'weekly-window-r2-native-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:
 if started:run([pg/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
