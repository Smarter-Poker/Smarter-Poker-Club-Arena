#!/usr/bin/env python3
"""Run a disposable PG17 clock-boundary protocol proof. Never accepts a database URL.
This is a concurrency design proof, not the complete production clock or financial schema."""
from pathlib import Path
import json,os,shutil,subprocess,tempfile,sys
repo=Path(__file__).resolve().parents[2]
pg=Path('/opt/homebrew/opt/postgresql@17/bin')
root=Path(tempfile.mkdtemp(prefix='ca-clock-boundary-pg17-'))
cluster,sock=root/'cluster',root/'socket'
sock.mkdir()
port=str(35000+os.getpid()%10000)
logpath=Path('/tmp/codex-k01-clock-boundary-pg17.log')
with logpath.open('w') as log:
 try:
  assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
  subprocess.run([str(pg/'initdb'),'-D',str(cluster),'--auth=trust','--no-locale'],check=True,stdout=log,stderr=log)
  subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-o',f'-k {sock} -p {port} -c listen_addresses=','-w','start'],check=True,stdout=log,stderr=log)
  psql=[str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-h',str(sock),'-p',port,'-d','postgres']
  subprocess.run(psql+['-f',str(repo/'scripts/dev/fixtures/clock-boundary-protocol.sql')],check=True,stdout=log,stderr=log)
  capture=json.loads((repo/'docs/audits/2026-09-10-k01-clock-membership-catalog.json').read_text())
  definitions='\n'.join(x['definition']+';' for x in capture['functions'])
  names={'aa_tournament_table_launch_proof_lock','cancelled_tournament_evidence_is_immutable','tournament_table_terminal_close_is_irreversible'}
  definitions+='\n'+'\n'.join(x['definition']+';' for x in capture['table_before_triggers'] if x['tgname'] in names)
  subprocess.run(psql,input=definitions,text=True,check=True,stdout=log,stderr=log)
  pause_epochs='--pause-epochs' in sys.argv[1:]
  if set(sys.argv[1:])-{'--pause-epochs'}:raise ValueError('Only --pause-epochs is supported')
  if pause_epochs:
   subprocess.run(psql+['-f',str(repo/'scripts/dev/fixtures/clock-pause-epoch-protocol.sql')],check=True,stdout=log,stderr=log)
   maintenance=json.loads((repo/'docs/audits/2026-09-10-k01-maintenance-credit-catalog.json').read_text())
   definitions='\n'.join(x['definition']+';' for x in maintenance['functions'] if not x['signature'].startswith('fn_thaw_platform('))
   subprocess.run(psql,input=definitions,text=True,check=True,stdout=log,stderr=log)
  env=dict(os.environ,POKER_CLOCK_PROBE_SOCKET=str(sock),POKER_CLOCK_PROBE_PORT=port)
  subprocess.run(['node',str(repo/('scripts/dev/clock-pause-epoch-runtime.mjs' if pause_epochs else 'scripts/dev/clock-boundary-runtime.mjs'))],env=env,check=True)
 finally:
  if cluster.exists():subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-m','immediate','stop'],stdout=log,stderr=log)
  shutil.rmtree(root)
