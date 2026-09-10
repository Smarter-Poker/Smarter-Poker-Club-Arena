#!/usr/bin/env python3
"""Exercise the real twelve-argument Diamond accepted-hand and projection doors."""
import concurrent.futures
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
DB = 'poker_diamond_phase6_accepted_test'
CMD = ['/opt/homebrew/opt/postgresql@17/bin/psql', '-X', '-q', '-At',
       '-h', '/tmp/codex-diamond-phase2-pg', '-p', '55472', '-d', DB,
       '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off']
def run(sql):
    with tempfile.NamedTemporaryFile(mode='w',suffix='.sql',dir=ROOT/'tests/sql') as fixture:
        fixture.write(sql)
        fixture.flush()
        r = subprocess.run(CMD+['-f',fixture.name],text=True,capture_output=True,cwd=ROOT/'tests/sql',timeout=60)
    if r.returncode: raise RuntimeError(r.stderr + r.stdout)
    for line in r.stderr.splitlines():
        if 'PASS:' in line: print(line.split('PASS:',1)[1].strip(),flush=True)
    return r.stdout.strip()
# Guarded bootstrap may only rebuild this named socket-local database.
base=(ROOT/'tests/sql/poker-diamond-custody.sql').read_text()
base=base.replace('poker_diamond_phase3_test',DB).replace('DROP SCHEMA IF EXISTS public CASCADE;',"SET client_min_messages='warning'; DROP SCHEMA IF EXISTS public CASCADE; SET client_min_messages='notice';")
run(base+'\n\\ir poker-diamond-cash-custody-setup.sql\n'
    '\\ir poker-diamond-accepted-hand-schema.sql\n'
    '\\ir poker-diamond-accepted-hand-prerequisites.sql\n'
    '\\ir ../../supabase/migrations/20260910030442_diamond_accepted_hands_retain_history_without_chip_obligatio.sql\n'
    '\\ir poker-diamond-accepted-hand-setup.sql\n')
run('\\ir poker-diamond-accepted-hand-lanes.sql')
run('\\ir poker-diamond-accepted-hand-refusals.sql')
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results=list(pool.map(lambda _:json.loads(run("SELECT fixture_accept();")),range(2)))
assert all(r.get('success') is True and r.get('atomic_hand_commit') is True for r in results),results
assert sum(r.get('replay') is True for r in results)==1,results
print('PASS: concurrent full accepted-hand delivery commits once and returns replay')
run('\\ir poker-diamond-accepted-hand-acceptance.sql')
print('Diamond accepted-hand integration passed; public gameplay remains gated.')
