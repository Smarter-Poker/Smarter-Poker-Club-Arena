#!/usr/bin/env python3
"""PG17 replay/refusal regression; no native funding or journal qualification."""
from pathlib import Path
import argparse, hashlib, json, os, re, shutil, signal, subprocess, tempfile

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,default=ROOT/'artifacts/bbj-bank-replay')
args=parser.parse_args()
W=args.output.resolve()
W.mkdir(parents=True,exist_ok=False) # Preserve earlier evidence rather than overwrite it.

def require(condition,message):
 if not condition: raise RuntimeError(message)

def digest(data): return hashlib.sha256(data).hexdigest()

def find_pg():
 if os.environ.get('PG_BIN'): return Path(os.environ['PG_BIN']).resolve()
 executable=shutil.which('postgres')
 if executable: return Path(executable).resolve().parent
 config=shutil.which('pg_config')
 require(config,'Set PG_BIN to an existing PostgreSQL17 bin directory')
 return Path(subprocess.check_output([config,'--bindir'],text=True).strip())

PG=find_pg()
for binary in ['postgres','initdb','pg_ctl','psql']:
 require((PG/binary).is_file() and os.access(PG/binary,os.X_OK),'Missing PostgreSQL binary: '+binary)
require(not hasattr(os,'geteuid') or os.geteuid()!=0,'Run as a non-root user; initdb refuses root')
# Ignore externally configured DB targets/options; all connections use our explicit private socket.
child_env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
child_env['LC_ALL']='C'
short_temp='/tmp' if Path('/tmp').is_dir() else tempfile.gettempdir()
fixture_path=ROOT/'scripts/ci/probes/bbj-bank-replay/fixture.sql'
cases_path=fixture_path.with_name('cases.sql')
installer_path=ROOT/'supabase/migrations/20260912054700_bbj_bank_move_replay_matches_payload.sql'
expected_hashes={
 'installer':'92556d69907be409b43f0ceb5c82597576263207fe1389de5d287092f3d7ff8c',
 'fixture':'03e7e5412d98a82b54e2cae7a9185d3268235e37583dffa5ed3908b281f0ffc4',
 'cases':'f69bb0f2af55c74290efed61d92479a5c99b292bd0d7efc33096d3107b77831a',
 'before':'cc76e59820fde27688cb96e61d7617599f354afdf47873b86224805ef1528546',
 'candidate':'124fea653182792f0c5e4c097b373e419d0ad8c45023343d24d7782d6ec6d949',
}
texts={}
for name,path in [('installer',installer_path),('fixture',fixture_path),('cases',cases_path)]:
 raw=path.read_bytes();require(digest(raw)==expected_hashes[name],name+' hash drift');texts[name]=raw.decode()
install=texts['installer'];fixture=texts['fixture'];harness=texts['cases']
def definition(label):
 matches=re.findall(r'v_'+label+r' constant text := \$'+label+r'\$(.*?)\$'+label+r'\$;',install,re.S)
 require(len(matches)==1,'Expected exactly one installer definition: '+label)
 require(digest(matches[0].encode())==expected_hashes[label],label+' definition hash drift')
 return matches[0]
original=definition('before');proposed=definition('candidate')
expected_red={'mismatch_'+name for name in ['pool','from','to','reverse','amount','rounding_boundary','null_from','null_to']}
def interrupted(signum,frame): raise SystemExit('Interrupted by signal '+str(signum))
signal.signal(signal.SIGTERM,interrupted)
receipt={'scope':'isolated PG17 branch and installation proof only','steps':[],'cases':19,'passed':False}
receipt['inputHashes']=expected_hashes
owned=None;started=False

def run(args,name,data=None,expected=0):
 r=subprocess.run([str(x) for x in args],input=data,text=True,capture_output=True,timeout=45,env=child_env)
 (W/(name+'.log')).write_text(r.stdout+r.stderr)
 receipt['steps'].append({'name':name,'argv':[str(x) for x in args],'exit':r.returncode,'expected':expected})
 print(name,r.returncode,flush=True)
 if r.returncode!=expected:raise RuntimeError(name+': '+r.stderr[-1200:])
 return r.stdout
try:
 require(re.search(r'PostgreSQL\) 17\.', run([PG/'postgres','--version'],'version')), 'PostgreSQL major 17 required')
 owned=Path(tempfile.mkdtemp(prefix='bbj-replay-',dir=short_temp));owned.chmod(0o700);(owned/'socket').mkdir(mode=0o700)
 receipt['ownedCluster']=str(owned)
 run([PG/'initdb','-D',owned/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],'initdb')
 with (owned/'data/postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(owned/'socket')+"'\nunix_socket_permissions=0700\nport=55681\nshared_buffers='16MB'\nmax_connections=10\n")
 run([PG/'pg_ctl','-D',owned/'data','-l',owned/'server.log','-w','start'],'start');started=True
 cmd=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',owned/'socket','-p','55681','-U','postgres','-d','postgres']
 run(cmd,'fixture',fixture)
 run(cmd,'baseline-install',original+';\nREVOKE ALL ON FUNCTION public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text) TO service_role;')
 snapshot="SELECT jsonb_build_object('pools',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.bbj_pools p),'receipts',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.ca_bbj_bucket_moves m),'sequence',(SELECT jsonb_build_object('last_value',last_value,'is_called',is_called) FROM public.ca_bbj_bucket_moves_id_seq));"
 before=run(cmd,'state-before',snapshot)
 baseline=json.loads(run(cmd,'baseline-cases',harness));receipt['baseline']=baseline
 require(len(baseline)==19 and {c['name'] for c in baseline if not c['passed']} == expected_red, 'Original failure set changed')
 for case in baseline:
  require(case['actual'] == ({'ok':True,'replayed':True,'move_id':1,'amount':10} if case['name'] in expected_red else case['expected']), 'Unexpected original behavior: '+case['name'])
 require(run(cmd,'state-after-baseline',snapshot)==before, 'Verification failed: '+"run(cmd,'state-after-baseline',snapshot)==before")
 metadata="SELECT jsonb_build_object('oid',oid,'definition',pg_get_functiondef(oid),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'settings',proconfig,'security',prosecdef,'anon',has_function_privilege('anon',oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',oid,'EXECUTE'),'service',has_function_privilege('service_role',oid,'EXECUTE')) FROM pg_proc WHERE oid='public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text)'::regprocedure;"
 meta0=json.loads(run(cmd,'metadata-before',metadata));require(meta0['definition']==original, 'Verification failed: '+"meta0['definition']==original")
 # install was hash-verified and parsed before starting the owned cluster
 run(cmd+['-1'],'install-original-to-candidate',install)
 meta1=json.loads(run(cmd,'metadata-candidate',metadata))
 require(meta1['definition']==proposed and meta1['oid']==meta0['oid'], 'Candidate definition or OID mismatch')
 for key in ['owner','acl','settings','security','anon','authenticated','service']:require(meta1[key]==meta0[key], 'Verification failed: '+'meta1[key]==meta0[key]')
 candidate=json.loads(run(cmd,'candidate-cases',harness));receipt['candidate']=candidate;require(all(c['passed'] for c in candidate), 'Verification failed: '+"all(c['passed'] for c in candidate)")
 require(run(cmd,'state-after-candidate',snapshot)==before, 'Verification failed: '+"run(cmd,'state-after-candidate',snapshot)==before")
 run(cmd+['-1'],'install-repeat',install);require(json.loads(run(cmd,'metadata-repeat',metadata))==meta1, 'Verification failed: '+"json.loads(run(cmd,'metadata-repeat',metadata))==meta1")
 for name,drift in [('acl','GRANT EXECUTE ON FUNCTION public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text) TO authenticated;'),('settings',"ALTER FUNCTION public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text) SET search_path TO pg_catalog;"),('body',proposed.replace('DECLARE','DECLARE\n-- deliberate local drift',1)+';')]:
  run(cmd+['-1'],'drift-'+name,drift+'\n'+install,expected=3)
  require(json.loads(run(cmd,'metadata-after-drift-'+name,metadata))==meta1, 'Verification failed: '+"json.loads(run(cmd,'metadata-after-drift-'+name,metadata))==meta1")
 for table in ['bbj_pools','ca_bbj_bucket_moves']:
  for op,sql in [('update',f'UPDATE public.{table} SET id=id;'),('delete',f'DELETE FROM public.{table};'),('truncate',f'TRUNCATE public.{table};'),('insert',f'INSERT INTO public.{table} SELECT * FROM public.{table};')]:
   run(cmd,'tripwire-'+table+'-'+op,sql,expected=3)
   require('REPLAY_WRITE_TRIPWIRE' in (W/('tripwire-'+table+'-'+op+'.log')).read_text(), 'Verification failed: '+"'REPLAY_WRITE_TRIPWIRE' in (W/('tripwire-'+table+'-'+op+'.log')).read_text()")
 require(run(cmd,'state-final',snapshot)==before, 'Verification failed: '+"run(cmd,'state-final',snapshot)==before")
 receipt['passed']=True
except BaseException as error:
 receipt['passed']=False
 receipt['error']=str(error)
 raise
finally:
 cleanup_error=None
 # Startup may have succeeded even if pg_ctl timed out before returning.
 if owned and (owned/'data/postmaster.pid').exists():
  try:
   run([PG/'pg_ctl','-D',owned/'data','-m','fast','-w','stop'],'stop')
  except BaseException as error:
   cleanup_error=str(error)
 stopped=bool(owned and not (owned/'data/postmaster.pid').exists())
 try:
  if owned and (owned/'server.log').exists(): shutil.copyfile(owned/'server.log',W/'server.log')
  # Preserve the directory whenever shutdown is uncertain or reported an error.
  if owned and stopped and not cleanup_error: shutil.rmtree(owned)
 except BaseException as error:
  cleanup_error=cleanup_error or str(error)
 removed=bool(owned and not owned.exists())
 cleanup_failed=bool(cleanup_error or (owned and (not stopped or not removed)))
 receipt['cleanup']={'stopped':stopped,'ownedDirectoryRemoved':removed,'error':cleanup_error}
 if cleanup_failed: receipt['passed']=False
 (W/'RESULTS.json').write_text(json.dumps(receipt,indent=2)+'\n')
 if cleanup_failed:
  raise RuntimeError('Owned cluster cleanup failed: '+(cleanup_error or 'cluster not confirmed stopped and removed'))
