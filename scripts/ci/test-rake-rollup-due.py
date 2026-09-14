"""Native read-only rollup-monitor proof; only the clock is substituted for boundary cases."""
import argparse,datetime,json,os,pathlib,re,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=pathlib.Path,default=ROOT/'artifacts/rake-rollup-due')
args=parser.parse_args()
out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
fixture=(ROOT/'scripts/ci/probes/rake-rollup-due/fixture.sql').read_text()
installer=(ROOT/'supabase/migrations/20260914011000_rake_rollup_daily_deadline.sql').read_text()
old=re.search(r'CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;',fixture).group()
candidate=re.search(r'CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;',installer).group()
assert candidate.count('now()')==1, 'Boundary adapter must replace exactly one clock source'
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C'
cluster=pathlib.Path(tempfile.mkdtemp(prefix='codex-rake-due-',dir='/tmp'))
sock=cluster/'socket';sock.mkdir(mode=0o700)
cmd=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',str(sock),'-p','55744','-U','postgres','-d','postgres']
results={'scope':'exact baseline/candidate SQL with only now/current_date substituted in fixed-clock cases; untouched candidate separately installed','checks':[],'production_mutations':False}
def command(argv,sql=None):
 r=subprocess.run(list(map(str,argv)),input=sql,text=True,capture_output=True,env=env,timeout=15)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def run(sql):return command(cmd,sql)
def refused(name,sql,code):
 r=subprocess.run(cmd,input=sql,text=True,capture_output=True,env=env,timeout=15)
 (out/(name+'.log')).write_text(r.stdout+r.stderr)
 check(name,str(r.returncode!=0 and code in r.stderr),'True')
def check(name,actual,expected):
 results['checks'].append({'name':name,'actual':actual,'expected':expected,'passed':actual==expected})
 if actual!=expected:raise RuntimeError(name+': '+actual+' expected '+expected)
def at(definition,stamp,zone='UTC',arg=26):
 literal="TIMESTAMPTZ '"+stamp+"'"
 # Keep the full function body, table access and arithmetic. Substitute only
 # transaction clock primitives, so wall time cannot make boundary tests flaky.
 body=definition.replace('now()',literal).replace('current_date',f"({literal} AT TIME ZONE current_setting('TimeZone'))::date")
 return run("BEGIN;SET LOCAL TIME ZONE '"+zone+"';"+body+";SELECT coalesce(jsonb_agg(jsonb_build_object('missing',missing_complete_days,'completed',newest_complete_day)),'[]'::jsonb) FROM fn_ca_rake_rollup_writer_silent("+str(arg)+");ROLLBACK;")
u='00000000-0000-4000-8000-000000000001'
try:
 if shutil.disk_usage('/tmp').free<512*1024**2:raise RuntimeError('disk reserve unavailable')
 if not re.search(r'PostgreSQL\) 17\.',command([pg/'postgres','--version'])):raise RuntimeError('PostgreSQL 17 required')
 command([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 command([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',f"-k {sock} -p 55744 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",'-w','start'])
 run(fixture)
 check('exact-live-predecessor',run("SELECT md5(pg_get_functiondef('public.fn_ca_rake_rollup_writer_silent(integer)'::regprocedure))"),'e4854fb8c73296006208ec3b97387c63')
 run(f"INSERT INTO union_rake_rollup_days SELECT '{u}',d::date,'2026-09-13T00:55:00.169947Z',39133 FROM generate_series('2026-09-07'::date,'2026-09-12'::date,interval '1 day')d")
 refused('authority-drift-refused','BEGIN;ALTER FUNCTION public.fn_ca_rake_rollup_writer_silent(integer) SECURITY INVOKER;'+installer,'P0001')
 refused('writer-schedule-drift-refused',"BEGIN;UPDATE cron.job SET schedule='15 * * * *' WHERE jobname='union-rake-rollup-catchup';"+installer,'P0001')
 refused('writer-budget-drift-refused',"BEGIN;UPDATE cron.job SET command='SELECT fn_union_rake_rollup_catchup_all(8)' WHERE jobname='union-rake-rollup-catchup';"+installer,'P0001')
 before_install=run('SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY day)::text) FROM union_rake_rollup_days x')
 run(installer)
 run(installer)
 check('migration-replay-preserves-rollups',run('SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY day)::text) FROM union_rake_rollup_days x'),before_install)
 check('exact-installed-candidate',run("SELECT md5(pg_get_functiondef('public.fn_ca_rake_rollup_writer_silent(integer)'::regprocedure))"),'9c5c569556467e0bb71d4a0d6fe33990')
 refused('anon-cannot-read-operator-telemetry','SET ROLE anon;SELECT * FROM fn_ca_rake_rollup_writer_silent();','42501')
 refused('authenticated-cannot-read-operator-telemetry','SET ROLE authenticated;SELECT * FROM fn_ca_rake_rollup_writer_silent();','42501')
 check('service-can-read-operator-telemetry',run('SET ROLE service_role;SELECT count(*)>=0 FROM fn_ca_rake_rollup_writer_silent();'),'t')
 check('authority-preserved',run("SELECT prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig=ARRAY['search_path=public'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_rake_rollup_writer_silent(integer)'::regprocedure"),'t')
 missing='[{"missing": 1, "completed": "2026-09-13"}]'
 check('baseline-natural-0052-false-alert',at(old,'2026-09-14T00:52:00Z'),missing)
 for label,t in [('midnight','00:00:00'),('before-writer','00:52:00'),('writer-start','00:55:00'),('budget-last-second','01:04:59.999999')]:
  check('candidate-'+label,at(candidate,'2026-09-14T'+t+'Z'),'[]')
 check('missing-at-exact-budget-end',at(candidate,'2026-09-14T01:05:00Z'),missing)
 check('missing-during-day',at(candidate,'2026-09-14T14:00:00Z'),missing)
 check('timezone-chicago',at(candidate,'2026-09-14T01:05:00Z','America/Chicago'),missing)
 check('timezone-auckland-before-due',at(candidate,'2026-09-14T00:52:00Z','Pacific/Auckland'),'[]')
 run(f"INSERT INTO union_rake_rollup_days VALUES('{u}','2026-09-13','2026-09-14T00:55:00.21654Z',23484)")
 check('natural-successful-writer-clears-gap',at(candidate,'2026-09-14T01:05:00Z'),'[]')
 run("DELETE FROM union_rake_rollup_days WHERE day='2026-09-10'")
 check('older-gap-not-suppressed-in-grace',at(candidate,'2026-09-14T00:52:00Z'),missing)
 run(f"INSERT INTO union_rake_rollup_days VALUES('{u}','2026-09-10','2026-09-13T00:55:00Z',1)")
 run("UPDATE union_rake_rollup_days SET computed_at='2026-09-12T21:00:00Z' WHERE union_id='"+u+"'")
 check('real-26h-silence-still-alerts-during-grace',at(candidate,'2026-09-14T00:52:00Z'),'[{"missing": 0, "completed": "2026-09-13"}]')
 check('existing-silence-override-preserved',at(candidate,'2026-09-14T00:52:00Z',arg=100),'[]')
 before=run('SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY day)::text) FROM union_rake_rollup_days x')
 run(candidate)
 check('install-does-not-rewrite-rollups',run('SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY day)::text) FROM union_rake_rollup_days x'),before)
 results['candidate_md5']=run("SELECT md5(pg_get_functiondef('public.fn_ca_rake_rollup_writer_silent(integer)'::regprocedure))")
 results['passed']=True
finally:
 if (cluster/'data/postmaster.pid').exists():command([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
 shutil.rmtree(cluster)
 results['owned_cluster_removed']=not cluster.exists()
 (out/'RESULTS.json').write_text(json.dumps(results,indent=2)+'\n')
 print(json.dumps({'passed':results.get('passed',False),'cases':len(results['checks']),'evidence':str(out)}))
