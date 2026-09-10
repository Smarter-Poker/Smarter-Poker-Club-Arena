#!/usr/bin/env python3
"""Exercise real shared purchase/cash-out doors in the prepared isolated fixture."""
import concurrent.futures
import json
import pathlib
import subprocess
import sys

ROOT=pathlib.Path(__file__).resolve().parents[2]
CMD=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-q','-At',
 '-h','/tmp/codex-diamond-phase2-pg','-p','55472','-d','poker_diamond_phase6_test',
 '-v','ON_ERROR_STOP=1']
T='30000000-0000-0000-0000-000000000001'
C='20000000-0000-0000-0000-000000000001'
A='10000000-0000-0000-0000-000000000001'
B='10000000-0000-0000-0000-000000000002'
KEY='40000000-0000-0000-0000-000000000006'
def run(sql):
 r=subprocess.run(CMD,input=sql,text=True,capture_output=True,cwd=ROOT/'tests/sql')
 if r.returncode: raise RuntimeError(r.stderr)
 for line in r.stderr.splitlines():
  if 'PASS:' in line: print(line.split('PASS:',1)[1].strip())
 return r.stdout.strip()
def actor(uid):
 return f"""SET ROLE authenticated;
 SET request.jwt.claim.role='authenticated';
 SET request.jwt.claim.sub='{uid}';
 SET request.jwt.claims='{{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000001"}}';"""
# Rebuild only the guarded Phase 6 database, then run the actual public doors.
subprocess.run([sys.executable,str(ROOT/'tests/sql/run-diamond-cash-custody.py')],check=True)
run('\\ir poker-diamond-cash-admission-setup.sql')
buy=f"""SELECT atomic_table_buyin('{A}','{T}',1,100,false,'{C}','{KEY}');
SELECT fn_ca_cash_buyin_receipt('{KEY}','{T}');"""
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 results=list(pool.map(lambda _: json.loads(run(actor(A)+buy)),range(2)))
assert results[0]==results[1] and results[0]['status']=='confirmed'
print('PASS: concurrent authenticated purchase replays the same verified receipt')
print(run(actor(B)+f"""SELECT atomic_table_buyin('{B}','{T}',2,100,false,'{C}',
 '40000000-0000-0000-0000-000000000007');"""))
print(run('\\ir poker-diamond-cash-admission-acceptance.sql'))
