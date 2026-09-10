#!/usr/bin/env python3
"""Isolated PostgreSQL custody contract; never connects to production."""
import concurrent.futures
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PSQL = '/opt/homebrew/opt/postgresql@17/bin/psql'
CMD = [PSQL, '-X', '-h', '/tmp/codex-diamond-phase2-pg', '-p', '55472',
       '-d', 'poker_diamond_phase6_test', '-v', 'ON_ERROR_STOP=1', '-At']
SQL_DIR = ROOT / 'tests/sql'
def run(sql):
    with tempfile.NamedTemporaryFile(mode='w+', suffix='.sql', dir=SQL_DIR) as script:
        script.write(sql)
        script.flush()
        r = subprocess.run(CMD + ['-P', 'pager=off', '-f', script.name],
                           text=True, cwd=SQL_DIR, capture_output=True, timeout=60)
    if r.returncode:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise RuntimeError('Isolated Diamond custody SQL failed')
    for line in r.stderr.splitlines():
        if 'PASS:' in line:
            print(line.split('PASS:', 1)[1].strip())
    return r.stdout.strip()

fixture = (SQL_DIR / 'poker-diamond-custody.sql').read_text()
fixture = fixture.replace('poker_diamond_phase3_test', 'poker_diamond_phase6_test')
print(run(fixture + '\n\\ir poker-diamond-cash-custody-setup.sql\n'))
hand = """SELECT fn_ca_settle_hand_stacks_absolute(
 '30000000-0000-0000-0000-000000000001',1000001,stacks,0,0,null,0)
 FROM fixture_diamond_hand_input;"""
# Simultaneous delivery exercises the table lock and immutable hand receipt.
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(lambda _: json.loads(run(hand)), range(2)))
assert all(r['success'] is True for r in results)
assert sum(r.get('replay', False) is True for r in results) == 1
print('PASS: concurrent duplicate delivery commits exactly once')
print(run('\\ir poker-diamond-cash-custody-acceptance.sql\n'))
print('Diamond custody contract passed; this is not full gameplay certification.')
