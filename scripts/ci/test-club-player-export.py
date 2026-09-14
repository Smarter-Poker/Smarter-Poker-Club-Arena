"""Qualify the exact player export against its live page and real authorization helpers."""
import argparse,datetime,json,os,pathlib,re,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
BASE=ROOT/'scripts/ci/probes/club-player-export'
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path,default=ROOT/'artifacts/club-player-export');p.add_argument('--migration',type=pathlib.Path,default=ROOT/'supabase/migrations/20260914014000_standalone_player_export_rake.sql')
a=p.parse_args();out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C'
cluster=pathlib.Path(tempfile.mkdtemp(prefix='codex-club-export-',dir='/tmp'));sock=cluster/'socket';sock.mkdir(mode=0o700)
cmd=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',str(sock),'-p','55745','-U','postgres','-d','postgres']
result={'scope':'Exact live export, player page and export page with actual finance and horse visibility helpers; isolated synthetic relations, no production export created','checks':[],'production_mutations':False}
def command(argv,sql=None):
 r=subprocess.run(list(map(str,argv)),input=sql,text=True,capture_output=True,env=env,timeout=20)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def run(sql):return command(cmd,sql)
def check(name,actual,expected):
 result['checks'].append({'name':name,'actual':actual,'expected':expected,'passed':actual==expected})
 if actual!=expected:raise RuntimeError(name+': '+str(actual)+' expected '+str(expected))
def refused(name,sql,code):
 r=subprocess.run(cmd,input=sql,text=True,capture_output=True,env=env,timeout=20)
 (out/(name+'.log')).write_text(r.stdout+r.stderr)
 check(name,r.returncode!=0 and code in r.stderr,True)
def uid(n):return '00000000-0000-4000-8000-'+str(n).zfill(12)
owner,supervisor,outsider,horse,human,rake_only=map(uid,range(1,7))
standalone,united,sibling=map(uid,range(11,14));union=uid(21)
def auth(user,role='authenticated'):
 return "SET SESSION AUTHORIZATION "+role+";SET request.jwt.claim.role='"+role+"';SET request.jwt.claim.sub='"+user+"';"
def export(user,club,sort='rake',request=None):
 request=request or uid(100+len(result['checks']))
 return json.loads(run(auth(user)+f"SELECT ca_club_player_export_start('{club}',current_date-7,current_date,'{sort}','{request}')"))
def exported(user,export_id):
 return json.loads(run(auth(user)+f"SELECT ca_club_data_export_page('{export_id}',0,2000)"))['rows']
def page(user,club,sort='rake'):
 return json.loads(run(auth(user)+f"SELECT ca_club_player_page('{club}',current_date-7,current_date,'{sort}')"))['rows']
try:
 if shutil.disk_usage('/tmp').free<512*1024**2:raise RuntimeError('disk reserve unavailable')
 if not re.search(r'PostgreSQL\) 17\.',command([pg/'postgres','--version'])):raise RuntimeError('PostgreSQL 17 required')
 command([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 command([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',f"-k {sock} -p 55745 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",'-w','start'])
 run((BASE/'club-export-fixture.sql').read_text())
 check('exact-live-export-preimage',run("SELECT md5(pg_get_functiondef('ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure))"),'b95e25b503dfec870986fb5f4cc8037f')
 check('exact-live-page-preimage',run("SELECT md5(pg_get_functiondef('ca_club_player_page(uuid,date,date,text,text,jsonb,integer)'::regprocedure))"),'980556d672f194b1b190e379d75321bb')
 run(f"""
 INSERT INTO profiles(id,role,is_admin,is_horse,alias,username) VALUES
 ('{owner}','member',false,false,'Owner','owner'),('{supervisor}','member',false,false,'Supervisor','supervisor'),
 ('{outsider}','member',false,false,'Outsider','outsider'),('{horse}','member',false,true,'Alias','horse'),
 ('{human}','member',false,false,'Human','human'),('{rake_only}','member',false,false,'RakeOnly','rakeonly');
 INSERT INTO clubs VALUES('{standalone}','{owner}'),('{united}','{owner}'),('{sibling}','{owner}');
 INSERT INTO union_clubs VALUES('{union}','{united}'),('{union}','{sibling}');
 INSERT INTO club_members SELECT c.id,u.id,CASE u.id WHEN '{owner}' THEN 'owner' WHEN '{supervisor}' THEN 'super_agent' ELSE 'member' END,'active',
   CASE c.id WHEN '{sibling}' THEN now() ELSE now()-interval '1 day' END FROM clubs c CROSS JOIN profiles u
   WHERE u.id<>'{outsider}' AND (u.id<>'{rake_only}' OR c.id='{standalone}');
 INSERT INTO ca_club_player_daily VALUES('{standalone}','{horse}',current_date-1,20,-3),('{standalone}','{human}',current_date-1,-2,0),
 ('{united}','{horse}',current_date-1,3,2),('{sibling}','{horse}',current_date-1,99999,0);
 INSERT INTO club_member_daily_stats VALUES('{standalone}','{horse}',current_date-1,10),('{standalone}','{human}',current_date-1,2),
 ('{united}','{horse}',current_date-1,4);
 INSERT INTO club_rake_daily_user(club_id,user_id,day,rake_amount) VALUES
 ('{standalone}','{horse}',current_date-1,12.50),('{standalone}','{human}',current_date-1,3.75),('{standalone}','{rake_only}',current_date-1,2.25),
 ('{standalone}','{horse}',current_date-8,99000),('{standalone}','{horse}',current_date+1,88000),('{united}','{horse}',current_date-1,77000);
 INSERT INTO union_rake_paid_daily_user VALUES('{union}','{horse}',current_date-1,5),('{union}','{human}',current_date-1,4),
 ('{union}','{horse}',current_date-8,66000),('{union}','{horse}',current_date+1,55000);
 """)
 old=export(owner,standalone,request=uid(90));old_rows=exported(owner,old['export_id'])
 expected=page(owner,standalone)
 check('baseline-export-drops-rake-only-player',len(old_rows),2)
 check('baseline-export-zeroes-standalone-rake',sum(x['rake'] for x in old_rows),0)
 check('page-contains-all-standalone-players',len(expected),3)
 check('page-contains-real-standalone-rake',sum(x['rake'] for x in expected),18.5)
 before=run("SELECT md5((SELECT jsonb_agg(to_jsonb(r) ORDER BY club_id,day,user_id)::text FROM club_rake_daily_user r)||(SELECT jsonb_agg(to_jsonb(u) ORDER BY union_id,day,user_id)::text FROM union_rake_paid_daily_user u))")
 candidate=a.migration.read_text()
 if a.migration:
  refused('authority-drift-refused','BEGIN;ALTER FUNCTION ca_club_player_export_start(uuid,date,date,text,uuid) SECURITY INVOKER;'+candidate,'P0001')
  baseline=re.search(r'CREATE OR REPLACE FUNCTION public.ca_club_player_export_start[\s\S]*?\$function\$;', (BASE/'club-export-fixture.sql').read_text()).group()
  refused('body-drift-refused','BEGIN;'+baseline.replace('DECLARE\n','DECLARE\n  v_drift integer;\n')+candidate,'P0001')
 run(candidate);run(candidate)
 result['candidate_md5']=run("SELECT md5(pg_get_functiondef('ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure))")
 for user,label in [(owner,'owner'),(supervisor,'super-agent')]:
  for club,kind in [(standalone,'standalone'),(united,'union')]:
   for sort in ('winners','losers','rake','hands'):
    started=export(user,club,sort)
    actual=exported(user,started['export_id'])
    check(label+'-'+kind+'-'+sort+'-exact-page-parity',actual,page(user,club,sort))
    check(label+'-'+kind+'-'+sort+'-receipt-count',started['total_rows'],len(actual))
 check('super-agent-horse-masked',all(not x['is_horse'] for x in page(supervisor,standalone)),True)
 check('owner-horse-visible',next(x for x in page(owner,standalone) if x['user_id']==horse)['is_horse'],True)
 check('union-rake-does-not-double-count-club-rake',sum(x['rake'] for x in page(owner,united)),9)
 request=uid(990);one=export(owner,standalone,request=request);two=export(owner,standalone,request=request)
 check('same-request-replays-same-immutable-export',one,two)
 refused('outsider-cannot-prepare',auth(outsider)+f"SELECT ca_club_player_export_start('{standalone}');",'42501')
 refused('anonymous-cannot-prepare',auth('','anon')+f"SELECT ca_club_player_export_start('{standalone}');",'42501')
 refused('another-authorized-user-cannot-read-job',auth(supervisor)+f"SELECT ca_club_data_export_page('{one['export_id']}');",'42501')
 refused('authenticated-cannot-read-materialized-rows',auth(owner)+'SELECT * FROM ca_club_data_export_rows','42501')
 run(f"UPDATE club_members SET role='super_agent' WHERE club_id='{standalone}' AND user_id='{owner}'")
 refused('downgraded-user-cannot-download-horse-identities',auth(owner)+f"SELECT ca_club_data_export_page('{one['export_id']}');",'55000')
 run(f"UPDATE club_members SET role='owner' WHERE club_id='{standalone}' AND user_id='{owner}';UPDATE ca_club_data_exports SET expires_at=now()-interval '1 second' WHERE id='{one['export_id']}'")
 refused('expired-job-not-readable',auth(owner)+f"SELECT ca_club_data_export_page('{one['export_id']}');",'42501')
 check('financial-reporting-sources-unchanged',run("SELECT md5((SELECT jsonb_agg(to_jsonb(r) ORDER BY club_id,day,user_id)::text FROM club_rake_daily_user r)||(SELECT jsonb_agg(to_jsonb(u) ORDER BY union_id,day,user_id)::text FROM union_rake_paid_daily_user u))"),before)
 check('authority-and-config-preserved',run("SELECT prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig=ARRAY['search_path=public','statement_timeout=120s'] AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure"),'t')
 result['passed']=True
finally:
 if (cluster/'data/postmaster.pid').exists():command([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
 shutil.rmtree(cluster)
 result['owned_cluster_removed']=not cluster.exists()
 (out/'RESULTS.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({'passed':result.get('passed',False),'cases':len(result['checks']),'candidate_md5':result.get('candidate_md5'),'evidence':str(out)}))
