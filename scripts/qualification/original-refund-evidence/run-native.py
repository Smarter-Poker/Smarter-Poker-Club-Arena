#!/usr/bin/env python3
"""Exact original RF classification and guarded source installation; isolated only."""
import argparse,json,os,pathlib,shutil,subprocess,sys,tempfile
p=pathlib.Path(__file__).resolve().parent
arg=argparse.ArgumentParser();arg.add_argument('--output',type=pathlib.Path,required=True);o=arg.parse_args().output.resolve();o.mkdir(parents=True,exist_ok=True)
pg=pathlib.Path(os.environ.get('PG_BIN',str(pathlib.Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
base=pathlib.Path('/Volumes/SmarterWork/agent-work') if sys.platform=='darwin' else o.parent
if sys.platform=='darwin' and not pathlib.Path('/Volumes/SmarterWork').is_mount():raise RuntimeError('mounted SSD required')
c=pathlib.Path(tempfile.mkdtemp(prefix='rf-',dir=base));sock=c/'s';sock.mkdir(mode=0o700);started=False
v=dict(os.environ,PG_BIN=str(pg),RF_NATIVE_SOCKET=str(sock),RF_NATIVE_PORT='56587',RF_NATIVE_OUTPUT=str(o),TZ='UTC',LC_ALL='C')
def run(name,cmd):
 r=subprocess.run([str(x) for x in cmd],text=True,capture_output=True,env=v,timeout=90);(o/(name+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise RuntimeError(name+':'+(r.stdout+r.stderr)[-2500:])
 return r
try:
 run('initdb',[pg/'initdb','-D',c/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
 run('start',[pg/'pg_ctl','-D',c/'d','-l',c/'server.log','-o',f"-k {sock} -p 56587 -h ''",'-w','start']);started=True
 run('classification',[sys.executable,p/'classify-native.py'])
 # Exact source40 installation qualification is an independent metadata stage.
 run('installer',[sys.executable,p/'installer-native.py'])
 print('Original RF classification26, original1024 scans to one, exact source40 installation qualification PASS')
finally:
 if started:run('stop',[pg/'pg_ctl','-D',c/'d','-m','immediate','-w','stop'])
 if (c/'server.log').exists():shutil.copyfile(c/'server.log',o/'server.log')
 shutil.rmtree(c)
