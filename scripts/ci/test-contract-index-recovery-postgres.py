#!/usr/bin/env python3
"""Finite isolated PG17 proof of the maintained exact-index recovery module."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tempfile, time
P=pathlib.Path
ap=argparse.ArgumentParser();ap.add_argument('--root',type=P,required=True);ap.add_argument('--scratch-parent',type=P,required=True);ap.add_argument('--output',type=P,required=True);a=ap.parse_args()
root=a.root.resolve(); parent=a.scratch_parent.resolve(); output=a.output.resolve()
# Explicit caller-owned storage; Mac never falls back to the internal disk.
assert parent.is_dir() and str(parent)!='/'
if os.uname().sysname=='Darwin':
 assert str(parent).startswith('/Volumes/SmarterWork/agent-work/')
 assert parent.stat().st_dev != P('/').stat().st_dev
 assert str(output).startswith('/Volumes/SmarterArchives/agent-evidence/')
output.mkdir(parents=True,exist_ok=False)
pg=P(os.environ['PG_BIN']).resolve();assert pg.is_absolute()
for n in ('postgres','initdb','pg_ctl','psql'): assert (pg/n).is_file()
assert os.geteuid()!=0
work=P(tempfile.mkdtemp(prefix='cr-',dir=parent));sock=work/'s';sock.mkdir();data=work/'d';assert len(str(sock).encode())<90
children=[]; child_sql={}; started=False;passed=False;serial=0; observed=None
# No inherited provider credentials, PostgreSQL connection settings or TCP.
env={'PATH':str(pg)+':/usr/bin:/bin','LC_ALL':'C','LANG':'C'}
node=shutil.which('node');assert node
module=root/'scripts/ci/contract-index-recovery.mjs'
historical_path=root/'supabase/migrations/20260902110000_published_game_contracts_are_promises.sql'
migration=root/'supabase/migrations/20261001171339_archived_alert_contract_authority_lookup.sql'
assert hashlib.sha256(migration.read_bytes()).hexdigest()=='6790ef3affa5f220d5613e5edcf50f0e1b0c1cd2260dbd6326336fe860b70c38'
def run(argv,sql=None):
 global serial
 p=subprocess.run([str(x) for x in argv],input=sql,text=True,capture_output=True,env=env,timeout=90);serial+=1
 for suffix,body in [('stdout',p.stdout),('stderr',p.stderr)]: (output/f'{serial:03d}.{suffix}').write_text(body)
 (output/f'{serial:03d}.json').write_text(json.dumps({'argv':[str(x) for x in argv],'sql':sql,'exit_code':p.returncode}))
 assert p.returncode==0,p.stderr
 return p.stdout.strip()
def argv(): return [pg/'psql','-X','-At','-v','ON_ERROR_STOP=1','-h',sock,'-U','postgres','-d','postgres']
def q(sql): return run(argv(),sql)
def child(sql):
 p=subprocess.Popen([str(x) for x in argv()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(p);child_sql[p.pid]=sql;p.stdin.write(sql);p.stdin.flush();return p
def send(p,sql):
 child_sql[p.pid]+=sql;p.stdin.write(sql);p.stdin.flush()
def finish(p,label):
 if not p.stdin.closed:p.stdin.close()
 p.wait(timeout=70);out=p.stdout.read();err=p.stderr.read();(output/(label+'.stdout')).write_text(out);(output/(label+'.stderr')).write_text(err);(output/(label+'.sql')).write_text(child_sql[p.pid]);(output/(label+'.receipt.json')).write_text(json.dumps({'pid':p.pid,'exit_code':p.returncode,'sql_sha256':hashlib.sha256(child_sql[p.pid].encode()).hexdigest(),'stdout_sha256':hashlib.sha256(out.encode()).hexdigest(),'stderr_sha256':hashlib.sha256(err.encode()).hexdigest()}));return p.returncode,err
def wait(sql):
 deadline=time.monotonic()+15
 while time.monotonic()<deadline:
  if q(sql)=='t':return
  time.sleep(.05)
 raise AssertionError('condition not observed: '+sql)
def api(action,**kw):
 # Dynamic import keeps the maintained module authoritative, not a copied validator.
 script="import {pathToFileURL} from 'node:url';const m=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;const x=JSON.parse(s);let y;if(x.action==='queries')y={catalog:m.RECOVERY_CATALOG,snapshots:m.RECOVERY_SNAPSHOTS,transient:m.RECOVERY_TRANSIENT_CATALOG};else {const r=m.recoveryRequest(x.file,x.sql,x.index,x.oid,x.before,x.transientOid);if(x.action==='pair'){try{m.validateRecoveryPair(x.rows,x.transientRows,r);y={accepted:true};}catch(e){y={accepted:false,error:e.message};}}else if(x.action==='cleanup')y=m.cleanupStatement(r);else if(x.action==='catalog'){m.validateRecoveryCatalog(x.rows,r,x.recovered);y=true;}else if(x.action==='snapshots'){try{m.validateRecoverySnapshots(x.rows);y={accepted:true};}catch(e){y={accepted:false,error:e.message};}}else y=m.recoveryStatement(r);}console.log(JSON.stringify(y));"
 payload={'action':action,'before':observed,'file':migration.name,'sql':migration.read_text(),'index':'public.managed_game_contract_versions_game_id_id_idx',**kw}
 return json.loads(run([node,'--input-type=module','-e',script,str(module)],json.dumps(payload)))
def rows(sql):return json.loads(q('SELECT coalesce(json_agg(x),\'[]\'::json) FROM ('+sql+')x'))
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nautovacuum=off\n")
 run([pg/'pg_ctl','-D',data,'-l',work/'server.log','-w','start']);started=True
 assert json.loads(q("SELECT json_build_object('host',inet_server_addr(),'dir',current_setting('data_directory'),'listen',current_setting('listen_addresses'))"))=={'host':None,'dir':str(data),'listen':''}
 historical_path=root/'supabase/migrations/20260902110000_published_game_contracts_are_promises.sql'
 assert hashlib.sha256(historical_path.read_bytes()).hexdigest()=='333ac2a127eb061ae8bb6725b9a15901b37e75e3e5d5b2f396a9b57201600e46'
 historical=(root/'supabase/migrations/20260902110000_published_game_contracts_are_promises.sql').read_text();ddl=historical[historical.index('CREATE TABLE IF NOT EXISTS public.managed_game_contract_versions ('):historical.index('CREATE OR REPLACE FUNCTION public.fn_managed_game_contract_document(')];q(ddl)
 insert="INSERT INTO public.managed_game_contract_versions(game_kind,game_id,club_id,version,contract,contract_hash) SELECT 'tournament',md5(n::text)::uuid,'00000000-0000-0000-0000-000000000001',1,jsonb_build_object('fixture',n),md5(n::text)||md5(n::text) FROM generate_series(1,2000)n;"
 q(insert);baseline=q("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.managed_game_contract_versions t")
 snapshot=child("SET application_name='contract_recovery_old_snapshot'; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT id FROM public.managed_game_contract_versions LIMIT 1;\n")
 wait("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='contract_recovery_old_snapshot' AND state='idle in transaction' AND backend_xmin IS NOT NULL)")
 preamble=migration.read_text().split('\nBEGIN;')[0]
 build=child("SET statement_timeout='30s'; SET lock_timeout='1s';\n"+preamble+'\n');code,error=finish(build,'interrupted-build');assert code!=0 and 'lock timeout' in error
 observed=q("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
 queries=api('queries');catalog=rows(queries['catalog']);oid=catalog[0]['oid'];api('catalog',oid=oid,rows=catalog,recovered=False)
 snapshot_sql=queries['snapshots']
 blocked=api('snapshots',oid=oid,rows=rows(snapshot_sql));assert blocked['accepted'] is False and 'snapshot' in blocked['error']
 send(snapshot,'ROLLBACK;\n');assert finish(snapshot,'snapshot-release')[0]==0
 assert api('snapshots',oid=oid,rows=rows(snapshot_sql))['accepted'] is True
 statement=api('statement',oid=oid);assert statement=='REINDEX INDEX CONCURRENTLY public.managed_game_contract_versions_game_id_id_idx'
 # Already-active transactions newer than historical provenance must now refuse.
 late_snapshot=child("SET application_name='contract_recovery_race_snapshot'; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT id FROM public.managed_game_contract_versions LIMIT 1;\n")
 wait("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='contract_recovery_race_snapshot' AND state='idle in transaction' AND backend_xmin IS NOT NULL)")
 assert api('snapshots',oid=oid,rows=rows(snapshot_sql))['accepted'] is False
 send(late_snapshot,'ROLLBACK;\n');assert finish(late_snapshot,'newer-snapshot-refusal-release')[0]==0
 assert api('snapshots',oid=oid,rows=rows(snapshot_sql))['accepted'] is True
 # A different snapshot arriving after final admission is an unavoidable race.
 # Cause a genuine bounded interrupted REINDEX, never manufacture pg_index flags.
 race=child("SET application_name='contract_after_admission_snapshot'; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT id FROM public.managed_game_contract_versions LIMIT 1;\n")
 wait("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='contract_after_admission_snapshot' AND state='idle in transaction' AND backend_xmin IS NOT NULL)")
 interrupted=child("SET statement_timeout='30s'; SET lock_timeout='2s';\n"+statement+';\n')
 wait("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='public.managed_game_contract_versions'::regclass AND phase='waiting for old snapshots')")
 code,error=finish(interrupted,'interrupted-reindex');assert code!=0 and 'lock timeout' in error
 send(race,'ROLLBACK;\n');assert finish(race,'after-admission-snapshot-release')[0]==0
 original_pair=rows(queries['catalog']);transient=rows(queries['transient']);assert len(transient)==1
 transient_oid=transient[0]['oid'];assert transient_oid!=oid
 assert api('pair',oid=oid,rows=original_pair,transientRows=transient)['accepted'] is False
 assert api('pair',oid=oid,transientOid=str(int(transient_oid)+1),rows=original_pair,transientRows=transient)['accepted'] is False
 wrong=json.loads(json.dumps(transient));wrong[0]['valid']=True
 assert api('pair',oid=oid,transientOid=transient_oid,rows=original_pair,transientRows=wrong)['accepted'] is False
 assert api('pair',oid=oid,transientOid=transient_oid,rows=original_pair,transientRows=transient)['accepted'] is True
 assert api('snapshots',oid=oid,rows=rows(snapshot_sql))['accepted'] is True
 cleanup=api('cleanup',oid=oid,transientOid=transient_oid)
 assert cleanup=='DROP INDEX CONCURRENTLY public.managed_game_contract_versions_game_id_id_idx_ccnew'
 q("SET statement_timeout='30s'; SET lock_timeout='3s';\n"+cleanup+';')
 assert rows(queries['transient'])==[]
 api('catalog',oid=oid,rows=rows(queries['catalog']),recovered=False)
 assert api('snapshots',oid=oid,rows=rows(snapshot_sql))['accepted'] is True
 # Separately prove an after-check bounded wait can complete without killing
 # the arriving snapshot, while another writer commits.
 last=child("SET application_name='contract_final_race'; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT id FROM public.managed_game_contract_versions LIMIT 1;\n")
 wait("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='contract_final_race' AND state='idle in transaction' AND backend_xmin IS NOT NULL)")
 recovery=child("SET statement_timeout='60s'; SET lock_timeout='5s';\n"+statement+';\n')
 wait("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='public.managed_game_contract_versions'::regclass AND phase='waiting for old snapshots')")
 q("SET statement_timeout='3s'; INSERT INTO public.managed_game_contract_versions(game_kind,game_id,club_id,version,contract,contract_hash) VALUES('table','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001',1,'{}',repeat('a',64));")
 assert recovery.poll() is None
 send(last,'ROLLBACK;\n');assert finish(last,'final-race-release')[0]==0
 assert finish(recovery,'recovery')[0]==0
 after=rows(queries['catalog']);api('catalog',oid=oid,rows=after,recovered=True)
 q('BEGIN;'+migration.read_text().split('\nBEGIN;',1)[1])
 assert q("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.managed_game_contract_versions t WHERE id<=2000")==baseline
 assert q('SELECT count(*) FROM public.managed_game_contract_versions')=='2001'
 passed=True
 (output/'RESULT.json').write_text(json.dumps({'passed':True,'old_oid':oid,'replacement_oid':after[0]['oid'],'guard_refused_actual_old_snapshot':True,'newer_snapshot_refused':True,'interrupted_reindex_transient_oid':transient_oid,'exact_transient_removed':True,'cutoff':observed,'original_rows_unchanged':True,'no_transients':after[0]['no_transients'],'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'module_sha256':hashlib.sha256(module.read_bytes()).hexdigest()},indent=2)+'\n')
finally:
 for p in children:
  if p.poll() is None:
   p.terminate()
   try:p.wait(timeout=5)
   except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
 if started:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 assert not (data/'postmaster.pid').exists()
 if (work/'server.log').exists():shutil.copyfile(work/'server.log',output/'server.log')
 shutil.rmtree(work)
 (output/'source-receipt.json').write_text(json.dumps({str(x):hashlib.sha256(x.read_bytes()).hexdigest() for x in [P(__file__),module,migration,historical_path]},indent=2)+'\n')
 (output/'cleanup.json').write_text(json.dumps({'allocation':str(work),'removed':not work.exists(),'passed':passed})+'\n')
