#!/usr/bin/env python3
"""Isolated PG17 FWP01 role matrix; no external database URL or installation.
Real captured helpers; synthetic input schema and claims, not live Auth proof.
"""
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess, tempfile, traceback, uuid

def run():
 if not __debug__: raise RuntimeError('Run without Python optimization; assertions are required')
 repo=Path(__file__).resolve().parents[2]
 fixture=repo/'scripts/dev/fixtures/agent-downline-rake-scope'
 manifest=json.loads((fixture/'source-manifest.json').read_text())
 parser=argparse.ArgumentParser();parser.add_argument('--evidence-dir',type=Path)
 args=parser.parse_args()
 evidence=args.evidence_dir or repo/'artifacts/fwp01-rake-scope'/str(uuid.uuid4())
 evidence.mkdir(parents=True,exist_ok=False)
 runtime=None;started=False;exit_code=1;logs=[];result={};cleanup={}
 env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
 env.update({'LC_ALL':'C','LANG':'C','TZ':'UTC'})
 def call(command,**kwargs):
  value=subprocess.run(command,capture_output=True,text=True,env=env,timeout=40,**kwargs)
  logs.append({'tool':Path(command[0]).name,'exit_code':value.returncode,'stdout':value.stdout,'stderr':value.stderr})
  return value
 try:
  for rel,digest in manifest['inputs'].items():
   target=(repo/rel).resolve();assert target.is_relative_to(repo)
   assert hashlib.sha256(target.read_bytes()).hexdigest()==digest, 'FWP01 source input drift: '+rel
  choices=[Path(os.environ['PGBIN'])] if os.environ.get('PGBIN') else [Path('/opt/homebrew/opt/postgresql@17/bin'),Path('/usr/lib/postgresql/17/bin')]
  pg=next((x for x in choices if (x/'initdb').is_file()),None)
  if pg is None: raise RuntimeError('PostgreSQL17 tools required; set PGBIN. No installation attempted.')
  version=call([str(pg/'postgres'),'--version'])
  assert version.returncode==0 and version.stdout.startswith('postgres (PostgreSQL) 17.'), 'PostgreSQL17 required'
  runtime=Path(tempfile.mkdtemp(prefix='fwp01-',dir='/tmp'));runtime.chmod(0o700)
  cluster=runtime/'data';socket=runtime/'socket';socket.mkdir(mode=0o700)
  port=str(45000+os.getpid()%10000)
  migration=repo/manifest['migration']
  def psql(sql):
   value=call([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-p',port,'-U','postgres','postgres'],input=sql)
   if value.returncode:raise RuntimeError(value.stderr)
   return value.stdout.strip()
  def install_migration():
   # Match the production migration runner: one transaction owns SET LOCAL and DDL.
   return psql('BEGIN;\n'+migration.read_text()+'\nCOMMIT;\n')
  def uid(n):return f'00000000-0000-4000-8000-{n:012d}'
  value=call([str(pg/'initdb'),'-D',str(cluster),'-U','postgres','--auth=trust','--no-locale','-E','UTF8']);assert value.returncode==0
  value=call([str(pg/'pg_ctl'),'-D',str(cluster),'-l',str(runtime/'postgres.log'),'-o',f"-k {socket} -p {port} -c listen_addresses=''",'-w','start']);assert value.returncode==0;started=True
  psql((fixture/'bootstrap.sql').read_text())
  tables=['agents','union_clubs','unions','union_admins','clubs','club_members','club_rake_rollup_complete','club_rake_daily_user','rake_records','rake_attributions','profiles']
  def footprint():return {t:psql("SELECT md5(COALESCE(string_agg(row::text,chr(10) ORDER BY row::text),'')) FROM (SELECT to_jsonb(x) row FROM "+t+" x) z;") for t in tables}
  before_data=footprint()
  roles=[('implicit_self',100,None,None,'same'),('root_self',100,100,None,'same'),('ancestor',210,100,None,'same'),('trusted_service',None,100,None,'same'),('overseer_A_mixed',201,100,None,[1]),('unrelated_A_rootB',201,101,None,'not_authorised'),('overseer_B_mixed',202,100,None,[2]),('unrelated_C_mixed',203,100,None,'not_authorised'),('union_admin_A',227,100,None,[1]),('union_club_owner_A',228,100,None,[1]),('active_union_admin_member',222,100,None,[1]),('approved_union_admin_member',223,100,None,[1]),('suspended_union_member',224,100,None,'not_authorised'),('revoked_union_member',225,100,None,'not_authorised'),('ordinary_player',226,100,None,'not_authorised'),('explicit_admin',220,100,1,'same'),('explicit_suspended_admin',221,100,1,'not_authorised'),('explicit_overseerA',201,100,1,[1]),('explicit_wrong_club',201,100,2,'not_authorised'),('explicit_ancestor',210,100,1,'same'),('inactive_root',201,102,None,'not_an_agent'),('nonagent_role_root',201,103,None,'not_an_agent'),('service_inactive_root',None,102,None,'not_an_agent'),('no_root',None,None,None,'no_agent'),('missing_root',201,999,None,'not_an_agent')]
  result={}
  for version in ['baseline','candidate']:
   if version=='baseline':
    psql((fixture/'baseline.sql').read_text()+"; REVOKE ALL ON FUNCTION fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) TO authenticated,service_role;")
   else:
    install_migration();install_migration()
   definition=psql("SELECT pg_get_functiondef('fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)'::regprocedure);")+'\n'
   (evidence/(version+'-pg-definition.sql')).write_text(definition)
   result[version]={}
   for name,actor,root,club,expected in roles:
    args=[f"'{uid(root)}'" if root else 'NULL',f"'{uid(club)}'" if club else 'NULL',"'2026-09-09 00:00Z'","'2026-09-10 18:00Z'",'NULL','500']
    claims=json.dumps({'role':'authenticated' if actor else 'service_role',**({'sub':uid(actor)} if actor else {})})
    query=f"BEGIN; SELECT set_config('request.jwt.claims','{claims}',true); SET LOCAL ROLE {'authenticated' if actor else 'service_role'}; SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY club_id,player_id),'[]') FROM fn_agent_downline_rake({','.join(args)}) x; ROLLBACK;"
    try:out=psql(query);value={'rows':json.loads(out.splitlines()[-1])}
    except RuntimeError as e:value={'error':str(e).splitlines()[0].split('ERROR:')[-1].strip()}
    result[version][name]=value
   psql('RESET ROLE;')
  checks=[]
  for helper in manifest['helpers']:
   signature=helper['signature']
   value=psql("SELECT pg_get_functiondef('public."+signature+"'::regprocedure);")+'\n'
   checks.append({'case':'current_helper_'+signature,'pass':hashlib.sha256(value.encode()).hexdigest()==helper['sha256']})
  changed={name for name in result['baseline'] if result['baseline'][name]!=result['candidate'][name]}
  checks.append({'case':'baseline_reproduces_exact_nine_scope_failures','pass':changed=={'overseer_A_mixed','unrelated_A_rootB','overseer_B_mixed','unrelated_C_mixed','union_admin_A','union_club_owner_A','active_union_admin_member','approved_union_admin_member','explicit_overseerA'}})
  for name,actor,root,club,expected in roles:
   before=result['baseline'][name];after=result['candidate'][name]
   if expected=='same':passed=before==after and 'rows' in after and len(after['rows'])>0
   elif isinstance(expected,list):passed='rows' in after and bool(after['rows']) and {x['club_id'] for x in after['rows']}=={uid(i) for i in expected} and all(x in before.get('rows',[]) for x in after['rows'])
   else:passed=after.get('error')==expected
   checks.append({'case':name,'pass':passed,'expected':expected})
  # Check exact effective ACL and metadata after idempotent migration replay.
  attrs=psql("SELECT jsonb_build_object('anon',has_function_privilege('anon',oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',oid,'EXECUTE'),'service',has_function_privilege('service_role',oid,'EXECUTE'),'owner',proowner::regrole::text,'stable',provolatile='s','definer',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)'::regprocedure;")
  meta=json.loads(attrs);checks.append({'case':'migration_preserves_expected_authority','pass':meta=={'anon':False,'authenticated':True,'service':True,'owner':'postgres','stable':True,'definer':True,'config':['search_path=public']}})
  # Drift rejection happens before replacement; each transaction is disposable.
  for label,change,error in [('acl','GRANT EXECUTE ON FUNCTION fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) TO anon;','authority metadata drift'),('definition',"COMMENT ON FUNCTION fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) IS 'no effect';",None)]:
   if error:
    psql(change)
    try:install_migration();rejected=False
    except RuntimeError as e:rejected=error in str(e)
    checks.append({'case':'migration_rejects_'+label+'_drift','pass':rejected})
    psql('REVOKE EXECUTE ON FUNCTION fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) FROM anon;')
  drift=(fixture/'candidate.sql').read_text().replace("RAISE EXCEPTION 'no_agent'","RAISE EXCEPTION 'no_agent_drift'")
  psql(drift+';')
  try:install_migration();rejected=False
  except RuntimeError as e:rejected='target definition drift' in str(e)
  checks.append({'case':'migration_rejects_definition_drift','pass':rejected})
  checks.append({'case':'all_fixture_rows_unchanged_by_reads','pass':before_data==footprint()})
  result['fixture_before']=before_data;result['fixture_after']=footprint()
  result['checks']=checks;result['passed']=sum(x['pass'] for x in checks);result['failed']=sum(not x['pass'] for x in checks);result['server_version']=psql('SHOW server_version;')
  (evidence/'NATIVE_RESULTS.json').write_text(json.dumps(result,indent=2));print(json.dumps({'passed':result['passed'],'failed':result['failed'],'failures':[x for x in checks if not x['pass']]}))
  if result['failed']:raise AssertionError('Native role matrix failed')
  exit_code=0
 except BaseException as error:
  (evidence/'FAILURE.txt').write_text(type(error).__name__+': '+str(error)+'\n'+traceback.format_exc())
  print('FWP01 FAILED: '+type(error).__name__+': '+str(error))
 finally:
  try:
   if runtime is not None:
    if started or (runtime/'data/postmaster.pid').exists():
     stopped=call([str(pg/'pg_ctl'),'-D',str(runtime/'data'),'-m','fast','-w','stop'])
     if stopped.returncode!=0 or (runtime/'data/postmaster.pid').exists():
      stopped=call([str(pg/'pg_ctl'),'-D',str(runtime/'data'),'-m','immediate','-w','stop'])
     assert not (runtime/'data/postmaster.pid').exists(), 'Cluster did not stop; retained private runtime'
    if (runtime/'postgres.log').exists():shutil.copyfile(runtime/'postgres.log',evidence/'postgres.log')
    shutil.rmtree(runtime);cleanup={'stopped_removed':True,'socket_only':True}
   else:cleanup={'runtime_not_created':True}
  except BaseException as error:
   exit_code=1;cleanup={'failed':str(error),'runtime':str(runtime)}
  (evidence/'CLEANUP.json').write_text(json.dumps(cleanup,indent=2))
  (evidence/'COMMAND_RESULTS.json').write_text(json.dumps(logs,indent=2))
  (evidence/'RUN_STATUS.json').write_text(json.dumps({'exit_code':exit_code,'qualification':manifest['qualification']},indent=2))
  print('Evidence: '+str(evidence))
 return exit_code

if __name__=='__main__':raise SystemExit(run())
