#!/usr/bin/env python3
"""Bind the candidate cashier browser test to the existing isolated native image."""
import hashlib,json,os,re,shutil,subprocess,sys,tempfile,uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from bootstrap import schema,records
SCOPE='cashier-realtime-native-lifecycle'
def execute(repo,image,output):
 assert re.fullmatch(r'sha256:[a-f0-9]{64}',image)
 here=repo/'tests/fixtures/cashier-realtime-lifecycle';name='ca-cashier-realtime-'+uuid.uuid4().hex
 receipt={'scope':SCOPE,'status':'failed','product_certificate':False,'container_absent':False}
 env={k:os.environ[k] for k in ('PATH','HOME') if k in os.environ};created=False
 def run(args,timeout=60,environment=env):return subprocess.run(args,cwd=repo,env=environment,capture_output=True,text=True,check=True,timeout=timeout).stdout
 try:
  sha=run(['git','rev-parse','HEAD']).strip();receipt['source_revision']=sha
  assert run(['docker','image','inspect','--format','{{index .Config.Labels "com.smarter-poker.source-revision"}}',image]).strip()==sha
  paths=run(['git','ls-files','tests/fixtures/cashier-realtime-lifecycle']).splitlines()
  run(['git','diff','--exit-code','HEAD','--',*paths]);assert len(paths)>=8
  receipt['source_sha256']={p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in paths}
  binding=json.loads((repo/'dist-cashier-fixture/build-info.json').read_text());assert binding['ca_sha']==sha;assert binding['built_by']=='cashier-native-fixture'
  output.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(prefix='cashier-native-',dir=output.parent) as temp:
   source=Path(temp);source.chmod(0o755)
   for f in ['native.mjs','functions.jsonl','helpers.jsonl','seed.sql']:shutil.copyfile(here/f,source/f)
   chunks=[['captured-current-cashier',schema()]]
   registry=json.loads((here/'registry.json').read_text());sql=[]
   for label,table in [('stores','ca_chip_store_coverage'),('global_mode','ca_ledger_invariant_mode'),('store_modes','ca_ledger_invariant_store_mode')]:
    sql.append("INSERT INTO public."+table+" SELECT * FROM jsonb_populate_recordset(NULL::public."+table+",'"+json.dumps(registry[label]).replace("'","''")+"'::jsonb);")
   chunks.append(['captured-ledger-registry','\n'.join(sql)])
   (source/'chunks.json').write_text(json.dumps(chunks))
   shutil.copytree(repo/'dist-cashier-fixture',source/'web')
   (source/'expected-client.json').write_text(json.dumps(binding))
   args=['docker','run','--name',name,'--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','1024','--memory','4g','--cpus','2','--sysctl','net.ipv4.ip_unprivileged_port_start=0','--tmpfs','/tmp:rw,nosuid,nodev,mode=1777','--tmpfs','/run:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700','--tmpfs','/var/lib/postgresql:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700']
   for host in ['smarter.poker','ca-static.smarter.poker','engine.smarter.poker','kuklfnapbkmacvwxktbh.supabase.co','fixture']:args+=['--add-host',host+':127.0.0.1']
   args+=['--mount',f'type=bind,src={source},dst=/cashier,readonly','--entrypoint','node',image,'/cashier/native.mjs']
   created=True;result=subprocess.run(args,cwd=repo,env=env,capture_output=True,text=True,timeout=480)
   final=[]
   for line in (result.stdout+'\n'+result.stderr).splitlines():
    try:r=json.loads(line)
    except ValueError:continue
    if isinstance(r,dict) and r.get('scope')==SCOPE:
     if r.get('kind')=='stage' and re.fullmatch(r'[a-zA-Z0-9_.-]{1,100}',str(r.get('stage',''))):receipt['last_stage']=r['stage']
     elif r.get('status') in ('passed','failed'):final.append(r)
   assert len(final)==1;receipt['observation']=final[0]
   assert result.returncode==0 and final[0]['status']=='passed'
   receipt['status']='passed'
 except Exception as error:
  receipt['runner_error']=type(error).__name__ if type(error).__name__ in ('AssertionError','CalledProcessError','TimeoutExpired','OSError') else 'RUNNER_FAILURE'
 finally:
  try:
   if created:run(['docker','container','rm','--force',name])
   assert not run(['docker','container','ls','-aq','--filter','name=^/'+name+'$']).strip();receipt['container_absent']=True
  except Exception:receipt['status']='failed'
  output.mkdir(parents=True,exist_ok=True);(output/'cashier-realtime-lifecycle.json').write_text(json.dumps(receipt,indent=2)+'\n')
 return receipt['status']=='passed'
if __name__=='__main__':sys.exit(0 if execute(Path(sys.argv[1]).resolve(),sys.argv[2],Path(sys.argv[3]).resolve()) else 1)
