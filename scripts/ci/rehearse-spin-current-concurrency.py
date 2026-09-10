#!/usr/bin/env python3
# Local native proof with three retained synthetic events; restore journal is saved before DDL.
from pathlib import Path
import subprocess,json,hashlib,re,time,os,argparse
parser=argparse.ArgumentParser(description='Observe current native Spin lock races and restore the exact prior local schema.')
parser.add_argument('--spin-source',type=Path,required=True)
parser.add_argument('--socket',type=Path,required=True)
parser.add_argument('--port',type=int,required=True)
parser.add_argument('--database',required=True)
parser.add_argument('--psql',default='psql')
parser.add_argument('--output-prefix',type=Path,required=True)
args=parser.parse_args()
if args.database!='full_stage1' or not args.socket.is_absolute() or not args.socket.is_dir():
 parser.error('only the owned full_stage1 database over an existing absolute Unix socket is allowed')
cmd=[args.psql,'-X','-q','-h',str(args.socket),'-p',str(args.port),'-U','postgres','-d',args.database,'-v','ON_ERROR_STOP=1','-At']
root=args.output_prefix
repo=Path(__file__).resolve().parents[2]
sha=lambda s:hashlib.sha256(s.encode()).hexdigest()
def run(sql,check=True):return subprocess.run(cmd,input=sql,text=True,capture_output=True,check=check)
def read(sql):return run(sql).stdout.strip()
sig='public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'
source=args.spin_source.read_text()
assert sha(source)=='0634d1da3856c1db483ea99fb9713838a5c7c5158e1d2f3ee6daf58f335dcf7f'
active=source.split('-- PART 3')[0]
without_body=re.sub(r'AS \$function\$.*?\$function\$;', 'AS BODY;',active,flags=re.S)
without_comments=re.sub(r'--[^\n]*','',without_body)
assert len(re.findall(r'CREATE OR REPLACE FUNCTION',without_comments))==1
assert not re.search(r'\b(ALTER|DROP|CREATE TABLE|CREATE TRIGGER)\b',without_comments)
assert without_comments.count('REVOKE ALL ON FUNCTION')==1 and without_comments.count('GRANT EXECUTE ON FUNCTION')==1
catalog_sql="""SELECT jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('sig',oid::regprocedure::text,'def',md5(pg_get_functiondef(oid)),'owner',proowner,'acl',proacl) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'),'defaults',(SELECT jsonb_agg(jsonb_build_object('table',adrelid::regclass::text,'column',adnum,'expression',pg_get_expr(adbin,adrelid)) ORDER BY adrelid::regclass::text,adnum) FROM pg_attrdef WHERE adrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)),'triggers',(SELECT jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,'enabled',tgenabled,'def',pg_get_triggerdef(oid)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE NOT tgisinternal));"""
connection=json.loads(read("SELECT jsonb_build_object('database',current_database(),'user',current_user,'local',inet_server_addr() IS NULL,'other_sessions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));"))
assert connection=={'database':'full_stage1','user':'postgres','local':True,'other_sessions':0},'owned idle local PostgreSQL connection required'
catalog_before=read(catalog_sql)
preimage=json.loads(read("SELECT jsonb_build_object('definition',pg_get_functiondef(oid),'body_md5',md5(prosrc),'definition_md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl,'config',proconfig,'security_definer',prosecdef) FROM pg_proc WHERE oid='"+sig+"'::regprocedure;"))
assert preimage['definition_md5']=='1c911e3ada50ffe0493b9b375e3fa9ae'
assert preimage['owner']=='postgres' and preimage['acl']==['postgres=X/postgres','service_role=X/postgres']
assert read("SELECT count(*) FROM tournaments WHERE id::text LIKE '9601%';")=='0'
restore="BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';\nDO $guard$ BEGIN IF md5(pg_get_functiondef('"+sig+"'::regprocedure)) IS DISTINCT FROM '6d2328689637d1d28c9ce9256a0d6252' THEN RAISE EXCEPTION 'current Spin wrapper changed; refusing restoration'; END IF; END $guard$;\n"+preimage['definition'].rstrip()+';'+"\nREVOKE ALL ON FUNCTION "+sig+" FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION "+sig+" TO service_role; COMMIT;"
root.with_suffix('.restore.sql').write_text(restore)
root.with_suffix('.preimage.json').write_text(json.dumps(preimage,indent=2)+'\n')
root.with_suffix('.catalog-before.json').write_text(catalog_before+'\n')
journal={'stage':'prepared','source_sha256':sha(source),'affected_schema':['fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb) definition and ACL only'],'restore_sql':str(root.with_suffix('.restore.sql')),'restore_sha256':sha(restore),'catalog_before_sha256':sha(catalog_before),'new_owned_events':['96010000-0000-0000-0000-00000000000'+str(i) for i in range(1,4)]}
def checkpoint(stage):journal['stage']=stage;root.with_suffix('.journal.json').write_text(json.dumps(journal,indent=2)+'\n')
checkpoint('prepared_before_any_write')
installed=False
try:
 run(source);installed=True;checkpoint('current_wrapper_installed')
 assert read("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure));")=='6d2328689637d1d28c9ce9256a0d6252'
 setup=(repo/'scripts/ci/probes/spin-current-concurrency-fixture.sql').read_text()
 assert sha(setup)=='b2c4e0a7af08e874f9919e9868824c147c5a74fb7bc96f0ce61daab6eef895bd'
 root.with_suffix('.setup.sql').write_text(setup)
 setup_result=run(setup);root.with_suffix('.setup.log').write_text(setup_result.stdout+setup_result.stderr);checkpoint('three_fixtures_funded')
 assert read("SELECT balance FROM spin_bonus_pools WHERE club_id='96000000-0000-0000-0000-000000000001';")=='3.28'
 print('INSTALLED_AND_FUNDED',flush=True)
except Exception:
 if installed:
  run(restore);assert read(catalog_sql)==catalog_before;checkpoint('restored_after_setup_failure')
 raise

# Every money request below runs under origin with actual service request claims.
rules={'version':1,'buy_in':1,'seats':3,'rake_rate':0.08,'starting_chips':1000,'tiers':[]}
for multiplier,freq in [(2,181),(10,19)]:
 blinds=[{'level':i,'smallBlind':i*10,'bigBlind':i*20,'ante':0,'duration':180} for i in range(1,13)]
 blinds[-1]['spinContinuation']={'version':1,'anchorLevel':12,'anchorBigBlind':240,'growth':1.4,'roundBigTo':10}
 rules['tiers'].append({'multiplier':multiplier,'freq':freq,'reserveThresholdX':0,'blind_structure':blinds,'payout_structure':[{'place':1,'percentage':100}]})
def call(n,manifest=None):
 value=json.dumps(manifest if manifest is not None else rules,separators=(',',':'))
 return "SELECT public.fn_spin_draw_and_settle_atomic('96010000-0000-0000-0000-00000000000"+str(n)+"','96040000-0000-4000-8000-00000000000"+str(n)+"','96050000-0000-4000-8000-00000000000"+str(n)+"','"+value+"'::jsonb);"
claims="SET LOCAL session_replication_role=origin; SET LOCAL request.jwt.claim.role='service_role'; SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}'; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='15s';"
class Owner:
 def __init__(self):
  self.p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
  self.pid=int(self.query('SELECT pg_backend_pid();')[0])
 def query(self,sql):
  self.p.stdin.write(sql+'\n\\echo NATIVE_DONE\n');self.p.stdin.flush();out=[]
  while True:
   line=self.p.stdout.readline()
   if not line:raise RuntimeError('owner stopped: '+self.p.stderr.read())
   if line.strip()=='NATIVE_DONE':return out
   if line.strip():out.append(line.strip())
 def close(self):
  if self.p.poll() is None:self.p.stdin.write('\\q\n');self.p.stdin.flush()
  self.p.communicate(timeout=10)
state_sql="""SELECT jsonb_build_object('pool',(SELECT to_jsonb(p) FROM spin_bonus_pools p WHERE club_id='96000000-0000-0000-0000-000000000001'),'reserve',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM spin_reserve_ledger t WHERE tournament_id::text LIKE '9601%'),'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM chip_ledger t WHERE tournament_id::text LIKE '9601%'),'escrow',(SELECT jsonb_agg(to_jsonb(t) ORDER BY tournament_id) FROM tournament_escrow t WHERE tournament_id::text LIKE '9601%'),'rake',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM rake_records t WHERE tournament_id::text LIKE '9601%'),'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY tournament_id) FROM spin_draw_receipts t WHERE tournament_id::text LIKE '9601%'),'contracts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tournaments t WHERE id::text LIKE '9601%'));"""
results=[]
owner=None
rival=None
try:
 for phase,rival_event,change in [('shared_reserve',2,False),('changed_rules_replay',1,True),('exact_replay',1,False)]:
  run("UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id::text LIKE '9601%';")
  owner=Owner();owner.query('BEGIN;'+claims)
  receipt=json.loads(owner.query(call(1))[0])
  assert receipt['ok'] is True and receipt['multiplier']==2 and receipt['prize_pool']==2
  if phase=='shared_reserve':assert receipt['replay'] is False
  else:assert receipt['replay'] is True
  owner_state=owner.query(state_sql)[0]
  name='codex_spin_current_'+phase
  manifest=dict(rules,starting_chips=999) if change else rules
  env=dict(os.environ,PGAPPNAME=name)
  rival=subprocess.Popen(cmd+['-c','BEGIN;'+claims+call(rival_event,manifest)+'COMMIT;'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
  blocked=False;deadline=time.monotonic()+5
  while time.monotonic()<deadline:
   blocked=read("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='"+name+"' AND wait_event_type='Lock' AND "+str(owner.pid)+"=ANY(pg_blocking_pids(pid)));")=='t'
   if blocked:break
   if rival.poll() is not None:break
   time.sleep(.05)
  assert blocked,(phase,'rival did not wait behind owner')
  owner.query('COMMIT;');owner.close();owner=None
  out,err=rival.communicate(timeout=15)
  if phase=='shared_reserve':
   assert rival.returncode==1 and 'no_eligible_tiers' in err,(rival.returncode,out,err)
  else:
   assert rival.returncode==0,(out,err)
   replay=json.loads(out.strip());assert replay==dict(receipt,replay=True)
  after_state=read(state_sql);assert after_state==owner_state,(phase,'post-rival financial state changed')
  results.append({'phase':phase,'observed_blocked_by_owner':blocked,'owner_replay':receipt['replay'],'rival_exit':rival.returncode,'state_unchanged_after_rival':True,'state_sha256':sha(after_state),'rival_refusal':'no_eligible_tiers' if phase=='shared_reserve' else None})
  rival=None;checkpoint('verified_'+phase)
 final=json.loads(read(state_sql));assert final['pool']['balance']==1.28 and final['pool']['total_deposited']==8.28 and final['pool']['total_drawn']==7
 assert len(final['receipts'])==1 and len(final['reserve'])==5 and len(final['rake'])==3
 root.with_suffix('.result.json').write_text(json.dumps({'verified_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'passed':results,'final_counts':{'balance':1.28,'deposited':8.28,'drawn':7,'receipts':len(final['receipts']),'reserve_rows':len(final['reserve']),'rake_rows':len(final['rake'])},'production_mutations':False},indent=2)+'\n')
 print('NATIVE_CURRENT_CONCURRENCY_PASS',json.dumps(results),flush=True)
finally:
 if owner is not None:
  try:owner.query('ROLLBACK;');owner.close()
  except Exception as error:print('OWNER_ROLLBACK_ERROR',str(error),flush=True)
 if rival is not None:
  try:rival.communicate(timeout=16)
  except subprocess.TimeoutExpired:rival.terminate();rival.communicate(timeout=5)
 run(restore)
 catalog_after=read(catalog_sql);assert catalog_after==catalog_before,'schema catalog was not exactly restored'
 checkpoint('current_wrapper_restored_and_full_catalog_exact')
 print('FULL_SCHEMA_CATALOG_RESTORED',sha(catalog_after),flush=True)
