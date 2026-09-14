#!/usr/bin/env python3
"""Certify fn_poker_diamond_top_up against the isolated Phase 6 fixture.

Never connects to production. The door is loaded from the same migration file
that was applied to kuklfnapbkmacvwxktbh, and that file's own preflight pins the
md5 of the four Phase 6 functions it depends on, so a fixture that has drifted
from production fails the load rather than certifying something else.
"""
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
CMD = ['/opt/homebrew/opt/postgresql@17/bin/psql', '-X', '-q', '-At',
       '-h', '/tmp/codex-diamond-phase2-pg', '-p', '55472',
       '-d', 'poker_diamond_phase6_test', '-v', 'ON_ERROR_STOP=1']
T = '30000000-0000-0000-0000-000000000001'
C = '20000000-0000-0000-0000-000000000001'
A = '10000000-0000-0000-0000-000000000001'
B = '10000000-0000-0000-0000-000000000002'


def run(sql):
    with tempfile.NamedTemporaryFile(mode='w+', suffix='.sql', dir=ROOT / 'tests/sql') as script:
        script.write(sql)
        script.flush()
        r = subprocess.run(CMD + ['-P', 'pager=off', '-f', script.name],
                           text=True, capture_output=True, cwd=ROOT / 'tests/sql', timeout=120)
    if r.returncode:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise RuntimeError('Isolated Diamond top-up SQL failed')
    for line in r.stderr.splitlines():
        if 'PASS:' in line:
            print(line.split('PASS:', 1)[1].strip())
    return r.stdout.strip()


def actor(uid):
    return f"""SET ROLE authenticated;
 SET request.jwt.claim.role='authenticated';
 SET request.jwt.claim.sub='{uid}';
 SET request.jwt.claims='{{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000001"}}';"""


# Rebuild the guarded Phase 6 database, then seat two players through the real
# public purchase door before anything is topped up.
subprocess.run([sys.executable, str(ROOT / 'tests/sql/run-diamond-cash-custody.py')], check=True)
run('\\ir poker-diamond-cash-admission-setup.sql')
run('\\ir poker-diamond-top-up-setup.sql')
run(actor(A) + f"SELECT atomic_table_buyin('{A}','{T}',1,100,false,'{C}',"
               "'40000000-0000-0000-0000-000000000021');")
run(actor(B) + f"SELECT atomic_table_buyin('{B}','{T}',2,100,false,'{C}',"
               "'40000000-0000-0000-0000-000000000022');")
print(run('\\ir poker-diamond-top-up-acceptance.sql'))
print('Diamond top-up door certified in the isolated fixture; this is not public release.')
