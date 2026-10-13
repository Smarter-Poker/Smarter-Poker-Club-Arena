#!/usr/bin/env python3
"""Actual current late proof, captured31, call gating and exact40 installation."""
import argparse,json,os,pathlib,shutil,subprocess,sys,tempfile,hashlib
p=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--output',type=pathlib.Path,required=True);o=parser.parse_args().output.resolve();o.mkdir(parents=True,exist_ok=True)
root=p.parents[2]
for name,pin in json.loads((p/'source-binding.json').read_text())['files'].items():
 raw=(root/name).read_bytes()
 if len(raw)!=pin['bytes'] or hashlib.sha256(raw).hexdigest()!=pin['sha256']:raise RuntimeError('qualification source input differs: '+name)
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote database connection inputs are forbidden')
pg=pathlib.Path(os.environ.get('PG_BIN',str(pathlib.Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
if ' 17.' not in subprocess.check_output([str(pg/'postgres'),'--version'],text=True):raise RuntimeError('PostgreSQL17 required')
base=pathlib.Path('/Volumes/SmarterWork/agent-work') if sys.platform=='darwin' else o.parent
if sys.platform=='darwin' and (not pathlib.Path('/Volumes/SmarterWork').is_mount() or not str(o).startswith('/Volumes/SmarterArchives/agent-evidence/') and not str(o).startswith('/Volumes/SmarterWork/agent-work/')):raise RuntimeError('mounted SSD output required')
c=pathlib.Path(tempfile.mkdtemp(prefix='elig-',dir=base));sock=c/'s';sock.mkdir(mode=0o700);started=False
v=dict(os.environ,PG_BIN=str(pg),ELIG_NATIVE_SOCKET=str(sock),ELIG_NATIVE_PORT='56614',TZ='UTC',LC_ALL='C')
def run(name,cmd):
 r=subprocess.run([str(x) for x in cmd],text=True,capture_output=True,env=v,timeout=90);(o/(name+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise RuntimeError(name+': '+(r.stdout+r.stderr)[-2500:])
 return r
try:
 run('initdb',[pg/'initdb','-D',c/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
 run('start',[pg/'pg_ctl','-D',c/'d','-l',c/'server.log','-o',f"-k {sock} -p 56614 -h ''",'-w','start']);started=True
 v['ELIG_NATIVE_OUTPUT']=str(o/'component');run('actual-components',[sys.executable,p/'component-native.py'])
 run('create-metadata-db',[pg/'createdb','-h',sock,'-p','56614','-U','postgres','installer'])
 v['ELIG_NATIVE_DB']='installer';v['ELIG_NATIVE_OUTPUT']=str(o/'installer');run('exact-installer',[sys.executable,p/'installer-native.py'])
 print('PASS actual31/equations/financial+retained negatives/39gatecontrols/20039→32 authentichelpercalls/current40 metadata/installationrefusals/rollback/replay')
finally:
 if started:run('stop',[pg/'pg_ctl','-D',c/'d','-m','immediate','-w','stop'])
 if (c/'server.log').exists():shutil.copyfile(c/'server.log',o/'server.log')
 shutil.rmtree(c)
 (o/'cleanup.json').write_text(json.dumps({'own_cluster_stopped':True,'own_data_removed':True,'no_production_calls':True}))
