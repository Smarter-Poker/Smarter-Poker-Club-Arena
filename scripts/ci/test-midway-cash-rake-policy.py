#!/usr/bin/env python3
"""Qualify the exact Midway policy migration on isolated native PostgreSQL.
No production connection. BBJ is deliberately outside the migration's changes.
"""
import json, os, pathlib, shutil, subprocess, tempfile, sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
FIXTURE=ROOT/'scripts/ci/fixtures/midway-cash-rake'
MIGRATION=ROOT/'supabase/migrations/20261021174448_midway_cash_rake_policy_two_point_five_bb.sql'
PG=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
OWNER=['runuser','-u','postgres','--'] if os.geteuid()==0 else []
OUT=ROOT/'artifacts/midway-cash-rake-policy'
OUT.mkdir(parents=True,exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL']='C'
cluster=pathlib.Path(tempfile.mkdtemp(prefix='midway-cash-rake-'))
if sys.platform=='darwin':
 if not str(cluster).startswith('/Volumes/SmarterWork/agent-work/'):
  raise RuntimeError('Mac qualifier requires SSD TMPDIR')
 sock=pathlib.Path(tempfile.mkdtemp(prefix='ms-',dir=cluster.parent.parent))
else:
 sock=cluster/'socket';sock.mkdir()
if OWNER:
 shutil.chown(cluster,'postgres');shutil.chown(sock,'postgres')
psql=[str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55831','-U','postgres','-d','postgres']
receipt={'passed':False,'production_mutations':False}
started=False

def run(command,check=True):
 r=subprocess.run([str(x) for x in command],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
 if check and r.returncode: raise RuntimeError(r.stderr or r.stdout)
 return r

def sql(path): return run(psql+['-f',path])
try:
 run(OWNER+[PG/'initdb','-D',cluster/'data','-A','trust','--no-locale','--username=postgres'])
 run(OWNER+[PG/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-k {sock} -p 55831 -c listen_addresses=''",'-w','start'])
 started=True
 sql(FIXTURE/'schema.sql')
 for name in ['fn_unscheduled_cap_bb','fn_rake_tier_price','fn_rake_stake_price','fn_rake_cap_for_dealt','fn_effective_rake','fn_complete_club_opening_setup','fn_rake_law_violations','fn_effective_rake_config']:
  sql(FIXTURE/(name+'.before.sql'))
 run(psql+['-c',"REVOKE ALL ON FUNCTION fn_effective_rake_config(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION fn_effective_rake_config(uuid) TO authenticated,service_role;"])
 before=run(psql+['-c',"SELECT rake FROM fn_effective_rake(.2,100,4,true,.1)"])
 if float(before.stdout.strip())!=3: raise RuntimeError('before-case not reproduced: '+before.stdout)
 sql(MIGRATION)
 result=sql(FIXTURE/'regression.sql')
 if 'midway-cash-rake-postgres-passed' not in result.stdout: raise RuntimeError('regression did not finish')
 # The exact migration must refuse replay, without partially applying anything.
 replay=run(psql+['-f',str(MIGRATION)],check=False)
 if replay.returncode==0: raise RuntimeError('installed migration unexpectedly replayed')
 receipt.update(passed=True,before_cap='3.00',after_cap='0.50',checks='scope,defaults,standalone-custom,table-precedence,future-creation,union-join,discounts,no-flop,snapshot-history,ACL,replay-refusal')
except Exception as e:
 receipt['failure']=str(e)
 if (cluster/'log').exists(): (OUT/'postgres.log').write_text((cluster/'log').read_text())
 raise
finally:
 if started:
  stopped=run(OWNER+[PG/'pg_ctl','-D',cluster/'data','-m','immediate','-w','stop'],check=False)
  receipt['cleanup_stopped']=stopped.returncode==0
  if stopped.returncode: receipt['passed']=False
 shutil.rmtree(sock)
 shutil.rmtree(cluster)
 (OUT/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt))
 if not receipt['passed']: raise SystemExit(1)
