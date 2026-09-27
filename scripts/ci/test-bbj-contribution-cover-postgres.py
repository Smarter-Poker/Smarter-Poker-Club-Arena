#!/usr/bin/env python3
"""Exact installed RPCs and online covering index on isolated native PG17."""
import hashlib,json,os,shutil,subprocess,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
FIX=ROOT/'scripts/ci/fixtures/bbj-contribution-cover'
MIG=ROOT/'supabase/migrations/20260927050525_bbj_facts_use_a_covering_contribution_index.sql'
ONLINE=ROOT/'scripts/ops/build-bbj-contribution-cover-concurrently.sql'
cluster=Path(tempfile.mkdtemp(prefix='bbj-cover-',dir=os.environ.get('TMPDIR')))
sock=Path(tempfile.mkdtemp(prefix='bbj-cover-sock-',dir='/tmp'))
data=cluster/'data';started=False;children=[]
env={'PATH':str(PG)+':/usr/bin:/bin','LANG':'C','LC_ALL':'C'}
def run(args,sql=None,error=None):
 r=subprocess.run([str(a) for a in args],input=sql,text=True,capture_output=True,env=env,timeout=120)
 if error:
  assert r.returncode and error in r.stderr,r.stdout+r.stderr
  print('PASS refused: '+error,flush=True)
 elif r.returncode: raise RuntimeError(r.stdout+r.stderr)
 return r.stdout.strip()
def argv():return [PG/'psql','-X','-At','-v','ON_ERROR_STOP=1','-h',sock,'-U','postgres','-d','postgres']
def q(sql,error=None):return run(argv(),sql,error)
def nodes(n):
 yield n
 for child in n.get('Plans',[]):yield from nodes(child)
def fp():
 return q("SELECT jsonb_build_object('functions',(SELECT jsonb_agg(row_to_json(x)) FROM (SELECT oid,proowner,proacl,proconfig,prosecdef,pg_get_functiondef(oid) definition FROM pg_proc WHERE proname IN ('fn_bbj_pool_facts','fn_bbj_promo_facts') ORDER BY oid)x),'table',(SELECT jsonb_build_object('oid',oid,'owner',relowner,'acl',relacl,'rls',relrowsecurity,'force',relforcerowsecurity,'options',reloptions) FROM pg_class WHERE oid='bbj_contributions'::regclass),'rows',(SELECT md5(string_agg(row_to_json(x)::text,'' ORDER BY id)) FROM bbj_contributions x))")
def result():
 return q("SELECT jsonb_agg(jsonb_build_object('pool',n,'facts',(SELECT row_to_json(f) FROM fn_bbj_pool_facts(u(n))f),'promo',(SELECT row_to_json(f) FROM fn_bbj_promo_facts(u(n))f)) ORDER BY n) FROM generate_series(10,13)n")
def plan(body):return json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+body))[0]
def until(sql):
 end=time.monotonic()+10
 while time.monotonic()<end:
  if q(sql)=='t':return
  time.sleep(.025)
 raise AssertionError(sql)
try:
 assert ' 17.' in run([PG/'postgres','--version'])
 run([PG/'initdb','-D',data,'-U','bbj_fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nautovacuum=off\n")
 started=True;run([PG/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start'])
 run([PG/'psql','-X','-At','-v','ON_ERROR_STOP=1','-h',sock,'-U','bbj_fixture_admin','-d','postgres'], 'CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEROLE; GRANT CREATE ON DATABASE postgres TO postgres; GRANT ALL ON SCHEMA public TO postgres;')
 assert json.loads(run([PG/'psql','-X','-At','-h',sock,'-U','bbj_fixture_admin','-d','postgres'],"SELECT json_build_object('host',inet_server_addr(),'dir',current_setting('data_directory'))"))=={'host':None,'dir':str(data)}
 q((FIX/'bootstrap.sql').read_text())
 for name,digest in [('fn_bbj_pool_facts','cbaccc1e155abb94d44e956185f7c296'),('fn_bbj_promo_facts','91d4875621299c2af678081bfa3c84e7')]:
  definition=(FIX/(name+'.sql')).read_text();assert hashlib.md5(definition.encode()).hexdigest()==digest
  q(definition+'; REVOKE ALL ON FUNCTION '+name+'(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION '+name+'(uuid) TO authenticated,service_role;')
 assert q("SELECT NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname=current_user")=='t'
 original=fp();baseline={}
 for who in ['','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000099']:
  baseline[who]=q("SET request.jwt.claim.sub='"+who+"'; SELECT jsonb_agg(row_to_json(f)) FROM fn_bbj_promo_facts(u(10))f")
 full=result()
 body="SELECT count(*)::bigint,round(coalesce(sum(amount),0),2),min(created_at) FROM bbj_contributions WHERE pool_id=u(10)"
 before=plan(body)
 q(MIG.read_text(),'BBJ_CONTRIBUTION_INDEX_NOT_QUALIFIED')
 q('CREATE INDEX idx_bbj_contrib_pool_facts ON bbj_contributions(pool_id,created_at) INCLUDE(backup_portion);')
 q(MIG.read_text(),'BBJ_CONTRIBUTION_INDEX_NOT_QUALIFIED');q('DROP INDEX idx_bbj_contrib_pool_facts')
 writer=subprocess.Popen([str(a) for a in argv()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(writer)
 writer.stdin.write("SET application_name='bbj_cover_fixture_writer'; BEGIN; LOCK TABLE bbj_contributions IN ROW EXCLUSIVE MODE;\n");writer.stdin.flush()
 until("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='bbj_cover_fixture_writer' AND state='idle in transaction')")
 # A real interrupted concurrent build must never satisfy verification.
 q("SET lock_timeout='300ms'; CREATE INDEX CONCURRENTLY idx_bbj_contrib_pool_facts ON bbj_contributions(pool_id,created_at) INCLUDE(amount,backup_portion,promo_portion);",'lock timeout')
 assert q("SELECT NOT indisvalid AND NOT indisready FROM pg_index WHERE indexrelid='idx_bbj_contrib_pool_facts'::regclass")=='t'
 q(MIG.read_text(),'BBJ_CONTRIBUTION_INDEX_NOT_QUALIFIED')
 writer.stdin.write('ROLLBACK;\n');writer.stdin.close();assert writer.wait(timeout=10)==0
 q('DROP INDEX idx_bbj_contrib_pool_facts;')
 writer=subprocess.Popen([str(a) for a in argv()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(writer)
 writer.stdin.write("SET application_name='bbj_cover_fixture_writer'; BEGIN; LOCK TABLE bbj_contributions IN ROW EXCLUSIVE MODE;\n");writer.stdin.flush()
 until("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='bbj_cover_fixture_writer' AND state='idle in transaction')")
 build=subprocess.Popen([str(a) for a in argv()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(build)
 build.stdin.write("SET statement_timeout='60s'; SET lock_timeout='30s';\n"+ONLINE.read_text());build.stdin.close()
 until("SELECT EXISTS(SELECT FROM pg_stat_progress_create_index WHERE relid='bbj_contributions'::regclass)")
 q("SET statement_timeout='2s'; INSERT INTO bbj_contributions(id,pool_id,amount,stakes_tier) SELECT u(999999),null,2,string_agg(md5(n::text),'') FROM generate_series(1,300)n;")
 writer.stdin.write('ROLLBACK;\n');writer.stdin.close();assert writer.wait(timeout=10)==0
 assert build.wait(timeout=60)==0,build.stderr.read()
 q('DELETE FROM bbj_contributions WHERE id=u(999999); VACUUM ANALYZE bbj_contributions;')
 q(MIG.read_text());assert fp()==original and result()==full
 assert q("SET ROLE authenticated; SELECT hands_contributed FROM public.fn_bbj_pool_facts(u(10));")=="SET\n135000"
 q("SET ROLE authenticated; SELECT * FROM public.bbj_contributions LIMIT 1;",'permission denied')
 for cache in ['force_generic_plan','force_custom_plan']:
  generic=json.loads(q("SET plan_cache_mode='"+cache+"'; PREPARE poolfacts(uuid) AS SELECT count(*),sum(amount),min(created_at) FROM bbj_contributions WHERE pool_id=$1; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE poolfacts(u(10));").split('PREPARE\n',1)[1])[0]
  assert any(n.get('Index Name')=='idx_bbj_contrib_pool_facts' and n['Node Type']=='Index Only Scan' for n in nodes(generic['Plan'])),generic

 for who,expected in baseline.items():
  assert q("SET request.jwt.claim.sub='"+who+"'; SELECT jsonb_agg(row_to_json(f)) FROM fn_bbj_promo_facts(u(10))f")==expected
 after=plan(body)
 beforeblocks=sum(n.get('Shared Hit Blocks',0)+n.get('Shared Read Blocks',0) for n in nodes(before['Plan']) if n.get('Relation Name')=='bbj_contributions')
 scans=[n for n in nodes(after['Plan']) if n.get('Relation Name')=='bbj_contributions']
 assert scans and all(n['Node Type']=='Index Only Scan' and n.get('Index Name')=='idx_bbj_contrib_pool_facts' for n in scans),scans
 afterblocks=sum(n.get('Shared Hit Blocks',0)+n.get('Shared Read Blocks',0) for n in scans)
 assert afterblocks<beforeblocks,(beforeblocks,afterblocks)
 # Both original backup window and each facts aggregate retain indexed input.
 for expression,where in [('sum(backup_portion)',"AND created_at>'2026-09-01'"),('sum(promo_portion)',''),('sum(promo_portion)/nullif(sum(amount),0)','AND promo_portion IS NOT NULL')]:
  measured=plan('SELECT '+expression+' FROM bbj_contributions WHERE pool_id=u(10) '+where)
  assert any(n.get('Index Name')=='idx_bbj_contrib_pool_facts' for n in nodes(measured['Plan'])),measured
 q("BEGIN; CREATE OR REPLACE FUNCTION fn_bbj_pool_facts(p_pool_id uuid) RETURNS TABLE(hands_contributed bigint,total_contributed numeric,first_contribution_at timestamptz) LANGUAGE sql AS $$SELECT 0::bigint,0::numeric,null::timestamptz$$;"+MIG.read_text().replace('BEGIN;','').replace('COMMIT;',''),'BBJ_FACTS_SOURCE_CHANGED')
 assert fp()==original
 q("BEGIN; ALTER TABLE bbj_contributions ALTER COLUMN amount TYPE numeric;"+MIG.read_text().replace('BEGIN;','').replace('COMMIT;',''),'BBJ_CONTRIBUTION_COLUMN_CONTRACT_CHANGED')
 assert fp()==original
 print(json.dumps({'beforeBlocks':beforeblocks,'afterBlocks':afterblocks,'beforeMs':before['Execution Time'],'afterMs':after['Execution Time']}),flush=True)
 print('PASS: exact unchanged RPCs, rows/catalog/RLS, concurrent writer, oversized unrelated text, missing/wrong/source-drift refusal and covering plans',flush=True)
finally:
 for child in children:
  if child.poll() is None:child.kill();child.wait()
 if started:run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(cluster,ignore_errors=True);shutil.rmtree(sock,ignore_errors=True)
