#!/usr/bin/env python3
"""Run only in a new, private, socket-only PG17 cluster. No production connection."""
import os, pathlib, subprocess, tempfile, json, hashlib, sys
root=pathlib.Path(__file__).resolve().parent
pg=pathlib.Path('/opt/homebrew/opt/postgresql@17/bin')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
env.update(LC_ALL='C',LANG='C',NODE_PATH='/Users/smarter.poker/Documents/club-arena/node_modules')
results=[]
modes=['duplicate','first-install-partial','first-install-all']
for mode in modes:
 work=pathlib.Path(tempfile.mkdtemp(prefix='ca-rakeback-payer.',dir='/tmp'))
 data=work/'data'; log=work/'server.log'
 subprocess.run([str(pg/'initdb'),'-D',str(data),'-U','postgres','-A','trust','--no-locale','--encoding=UTF8'],env=env,check=True,stdout=subprocess.DEVNULL)
 subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-l',str(log),'-o',"-k "+str(work)+" -p 55473 -c listen_addresses=''",'start','-w'],env=env,check=True,stdout=subprocess.DEVNULL)
 args=[str(pg/'psql'),'-X','-v','ON_ERROR_STOP=1','-h',str(work),'-p','55473','-U','postgres']
 try:
  actual=subprocess.check_output(args+['-At','-d','postgres','-c',"SELECT current_setting('data_directory')||'|'||current_setting('listen_addresses')"],env=env,text=True).strip()
  assert actual==str(data)+'|',actual
  subprocess.run(args+['-d','postgres','-c','CREATE DATABASE payer_test'],env=env,check=True,stdout=subprocess.DEVNULL)
  files=['fixture.sql','basis-fixture.sql','money-guards.sql']+(['00-apply-legacy-repair.sql'] if mode=='duplicate' else [])
  with (root/(mode+'-setup.log')).open('w') as out:
   for name in files:subprocess.run(args+['-d','payer_test','-f',str(root/name)],env=env,check=True,stdout=out,stderr=subprocess.STDOUT)
  with (root/(mode+'-native.log')).open('w') as out:
   subprocess.run(['/opt/homebrew/bin/node',str(root/('probe-duplicate.mjs' if mode=='duplicate' else 'probe-first-install.mjs')),mode],env=dict(env,PGHOST=str(work)),check=True,stdout=out,stderr=subprocess.STDOUT,timeout=90)
  results.append({'mode':mode,'socket':str(work),'data_directory':str(data),'tcp_listeners':'','pass':True})
 finally:subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'stop','-m','fast','-w'],env=env,check=True,stdout=subprocess.DEVNULL)
(root/'duplicate-runner-evidence.json').write_text(json.dumps({'runs':results,'source_hashes':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in root.iterdir() if f.suffix in ['.sql','.mjs','.py']}},indent=2)+'\n')
print(json.dumps(results))
