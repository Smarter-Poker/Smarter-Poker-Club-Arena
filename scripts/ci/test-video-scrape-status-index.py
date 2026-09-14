"""Prove the exact online index with real PG17 readers, writers and query plans."""
import argparse, json, os, pathlib, re, shutil, subprocess, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT/'artifacts/video-scrape-status-index')
args = parser.parse_args()
out = args.output.resolve(); out.mkdir(parents=True, exist_ok=False)
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
paths = list((ROOT/'supabase/migrations').glob('*_video_scrape_history_lookup.sql'))
assert len(paths) == 1, 'exactly one source migration required'
installer = paths[0].read_text()
online = (ROOT/'scripts/ops/build-video-scrape-status-index-concurrently.sql').read_text()
env = {k:v for k,v in os.environ.items() if not k.startswith('PG')}; env['LC_ALL'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='codex-video-status-', dir='/tmp'))
sock = cluster/'socket'; sock.mkdir(mode=0o700)
cmd = [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', '55745', '-U', 'postgres', '-d', 'postgres']
results = {'scope':'exact index; representative audit table, real PG17 concurrency and query plans', 'checks':[], 'production_mutations':False}
children = []
def command(argv, sql=None, timeout=30):
 r = subprocess.run(list(map(str,argv)), input=sql, text=True, capture_output=True, env=env, timeout=timeout)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip()
def run(sql): return command(cmd, sql)
def check(name, value):
 results['checks'].append({'name':name,'passed':bool(value)})
 if not value: raise RuntimeError(name)
def start(sql):
 p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
 p.stdin.write(sql); p.stdin.close(); p.stdin=None; children.append(p); return p
query = "SELECT scrape_proof, created_at FROM data_audit_log WHERE table_name='video_library_videos' AND action='scrape' ORDER BY created_at DESC LIMIT 1"
try:
 if shutil.disk_usage('/tmp').free < 1024**3: raise RuntimeError('one GiB disk reserve required')
 check('PostgreSQL17', bool(re.search(r'PostgreSQL\) 17\.', command([pg/'postgres','--version']))))
 command([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 command([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',f"-k {sock} -p 55745 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",'-w','start'])
 run("CREATE TABLE data_audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_name text NOT NULL,record_id text NOT NULL DEFAULT 'fixture',action text NOT NULL,scrape_proof jsonb,created_at timestamptz DEFAULT now());CREATE INDEX idx_data_audit_log_created_at ON data_audit_log(created_at DESC);INSERT INTO data_audit_log(table_name,action,scrape_proof,created_at) SELECT 'unrelated','update',jsonb_build_object('body',repeat('x',500)),TIMESTAMPTZ '2026-09-14T00:00Z'+g*interval '1 second' FROM generate_series(1,100000) g;INSERT INTO data_audit_log(table_name,action,scrape_proof,created_at) VALUES('video_library_videos','scrape','{\"total_found\":1398}','2026-09-13T06:03Z'),('video_library_videos','scrape_trigger','{}','2026-09-15T06:00Z');ANALYZE data_audit_log;")
 absent = subprocess.run(cmd,input=installer,text=True,capture_output=True,env=env,timeout=15)
 check('migration-refuses-missing-online-index',absent.returncode!=0 and 'absent, invalid or differs' in absent.stderr)
 before = run(query)
 plan_before = run('EXPLAIN(FORMAT JSON) '+query)
 (out/'plan-before.json').write_text(plan_before+'\n')
 check('baseline-is-broad-scan', 'Seq Scan' in plan_before)
 blocker = start("BEGIN;INSERT INTO data_audit_log(table_name,action) VALUES('unrelated','update');SELECT pg_sleep(2);COMMIT;")
 deadline = time.monotonic()+3
 while run("SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event='PgSleep'") != '1':
  if time.monotonic()>deadline: raise RuntimeError('writer did not reach open transaction')
  time.sleep(.02)
 builder = start(online)
 deadline = time.monotonic()+2
 while run("SELECT count(*) FROM pg_stat_progress_create_index WHERE command='CREATE INDEX CONCURRENTLY'") != '1':
  if time.monotonic()>deadline: raise RuntimeError('online build was not observed')
  time.sleep(.02)
 check('online-build-allows-new-writer',run("SET statement_timeout='500ms';INSERT INTO data_audit_log(table_name,action) VALUES('unrelated','update');SELECT true")=='t')
 for name,p in [('held-writer',blocker),('index-builder',builder)]:
  stdout,stderr=p.communicate(timeout=15);(out/(name+'.log')).write_text(stdout+stderr);check(name+'-completed',p.returncode==0)
 run(installer)
 check('original-result-unchanged',run(query)==before)
 plan_after = run('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query)
 (out/'plan-after.json').write_text(plan_after+'\n')
 check('matching-partial-index-used','idx_data_audit_video_scrape_latest' in plan_after and 'Seq Scan' not in plan_after)
 check('only-scrape-row-indexed',run("SELECT count(*) FROM data_audit_log WHERE table_name='video_library_videos' AND action='scrape'")=='1')
 run(installer)
 check('replay-keeps-one-valid-index',run("SELECT count(*) FROM pg_index WHERE indexrelid='idx_data_audit_video_scrape_latest'::regclass AND indisvalid AND indisready")=='1')
 check('all-audit-rows-and-concurrent-writes-preserved',run('SELECT count(*) FROM data_audit_log')=='100004')
 run("DROP INDEX CONCURRENTLY idx_data_audit_video_scrape_latest;CREATE INDEX idx_data_audit_video_scrape_latest ON data_audit_log(action)")
 refused = subprocess.run(cmd,input=installer,text=True,capture_output=True,env=env,timeout=15)
 (out/'wrong-definition-refused.log').write_text(refused.stdout+refused.stderr)
 check('existing-wrong-definition-refused',refused.returncode!=0 and 'differs from the reviewed definition' in refused.stderr)
 results['passed']=True
finally:
 for p in children:
  if p.poll() is None: p.terminate(); p.wait(timeout=5)
 if (cluster/'data/postmaster.pid').exists(): command([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
 shutil.rmtree(cluster)
 results['owned_cluster_removed']=not cluster.exists()
 (out/'RESULTS.json').write_text(json.dumps(results,indent=2)+'\n')
 print(json.dumps({'passed':results.get('passed',False),'cases':len(results['checks']),'evidence':str(out)}))
