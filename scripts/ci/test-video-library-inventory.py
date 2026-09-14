"""Run the published inventory function against PostgreSQL 17, with real roles."""
import argparse, json, os, pathlib, re, shutil, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT/'artifacts/video-library-inventory')
args = parser.parse_args(); out=args.output.resolve(); out.mkdir(parents=True,exist_ok=False)
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C'
cluster=pathlib.Path(tempfile.mkdtemp(prefix='codex-video-inventory-'));sock=cluster/'socket';sock.mkdir(mode=0o700)
cmd=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55746','-U','postgres','-d','postgres']
results={'checks':[],'production_mutations':False};writer=None
def command(argv,sql=None):
 r=subprocess.run(list(map(str,argv)),input=sql,text=True,capture_output=True,env=env,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def run(sql):return command(cmd,sql)
def check(name,value):
 results['checks'].append({'name':name,'passed':bool(value)})
 if not value:raise AssertionError(name)
def inventory(prefix='SET ROLE service_role;'):
 return json.loads(run(prefix+' SELECT public.fn_video_library_scrape_inventory()'))
try:
 if shutil.disk_usage('/tmp').free<1024**3:raise RuntimeError('one GiB disk reserve required')
 check('PostgreSQL17',bool(re.search(r'PostgreSQL\) 17\.',command([pg/'postgres','--version']))))
 command([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 command([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',f"-k {sock} -p 55746 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",'-w','start'])
 run('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE TABLE public.video_library_videos(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,source_id text);GRANT SELECT ON public.video_library_videos TO service_role;')
 migration=(ROOT/'supabase/migrations/20260914050300_video_library_inventory_counts.sql').read_text();run(migration)
 check('empty-inventory-is-explicit',inventory()=={'total_videos':0,'unassigned_videos':0,'creators':0,'by_source':{}})
 run("INSERT INTO public.video_library_videos(source_id) SELECT CASE WHEN g<=1500 THEN 'HCL' ELSE 'Poker & Café' END FROM generate_series(1,2505) g;INSERT INTO public.video_library_videos(source_id) VALUES(NULL),(''),('__proto__'),('constructor');")
 expected={'total_videos':2509,'unassigned_videos':2,'creators':4,'by_source':{'HCL':1500,'Poker & Café':1005,'__proto__':1,'constructor':1}}
 check('all-2509-rows-counted-beyond-rest-cap',inventory()==expected)
 check('empty-and-null-sources-remain-visible',inventory()['unassigned_videos']==2)
 check('unusual-source-keys-are-data',inventory()['by_source']['__proto__']==1)
 check('independent-table-total-reconciles',int(run('SELECT count(*) FROM public.video_library_videos'))==sum(expected['by_source'].values())+expected['unassigned_videos'])
 for role in ['anon','authenticated']:
  denied=subprocess.run(cmd,input=f'SET ROLE {role};SELECT public.fn_video_library_scrape_inventory()',text=True,capture_output=True,env=env,timeout=10)
  check(role+'-execution-refused',denied.returncode!=0 and 'permission denied for function' in denied.stderr)
 run('REVOKE SELECT ON public.video_library_videos FROM service_role')
 denied=subprocess.run(cmd,input='SET ROLE service_role;SELECT public.fn_video_library_scrape_inventory()',text=True,capture_output=True,env=env,timeout=10)
 check('invoker-cannot-bypass-table-permissions',denied.returncode!=0 and 'permission denied for table' in denied.stderr)
 run('GRANT SELECT ON public.video_library_videos TO service_role')
 # Keep a real concurrent write open; this reader must see only committed rows.
 writer=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 writer.stdin.write("BEGIN;INSERT INTO public.video_library_videos(source_id) VALUES('pending');SELECT 'writer-ready';\n");writer.stdin.flush()
 check('concurrent-writer-is-open',writer.stdout.readline().strip()=='writer-ready')
 check('uncommitted-row-is-not-counted',inventory()==expected)
 writer.stdin.write('COMMIT;\n');writer.stdin.close();writer.stdin=None
 stdout,stderr=writer.communicate(timeout=10);check('concurrent-writer-committed',writer.returncode==0)
 after=inventory();check('next-read-includes-committed-row',after['total_videos']==2510 and after['by_source']['pending']==1 and after['creators']==5)
 run(migration);check('migration-replay-preserves-results',inventory()==after)
 check('repeated-reads-do-not-change-rows',int(run('SELECT count(*) FROM public.video_library_videos'))==2510)
 results['passed']=True
finally:
 if writer is not None and writer.poll() is None:writer.terminate();writer.wait(timeout=5)
 if (cluster/'data/postmaster.pid').exists():command([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
 shutil.rmtree(cluster);results['owned_cluster_removed']=not cluster.exists()
 (out/'RESULTS.json').write_text(json.dumps(results,indent=2)+'\n')
 print(json.dumps({'passed':results.get('passed',False),'checks':len(results['checks']),'evidence':str(out)}))
