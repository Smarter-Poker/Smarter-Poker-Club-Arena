#!/usr/bin/env python3
"""Certify the Diamond bomb pot admission change in the isolated fixture.

Never connects to production. The four migrations are loaded from the same files
that were applied to kuklfnapbkmacvwxktbh, and each one's preflight pins the md5
of the door it edits, so a fixture that has drifted fails the load instead of
certifying something the estate does not run. The money proof for the ante and
the multi-board split is server/src/engine/DiamondCashHand.test.ts.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
CMD = [PG_BIN + '/psql', '-X', '-q', '-At',
       '-h', '/tmp/codex-diamond-phase2-pg', '-p', '55472',
       '-d', 'poker_diamond_phase6_test', '-v', 'ON_ERROR_STOP=1']


def run(sql):
    with tempfile.NamedTemporaryFile(mode='w+', suffix='.sql', dir=ROOT / 'tests/sql') as script:
        script.write(sql)
        script.flush()
        r = subprocess.run(CMD + ['-P', 'pager=off', '-f', script.name],
                           text=True, capture_output=True, cwd=ROOT / 'tests/sql', timeout=120)
    if r.returncode:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise RuntimeError('Isolated Diamond bomb pot SQL failed')
    for line in r.stderr.splitlines():
        if 'PASS:' in line:
            print(line.split('PASS:', 1)[1].strip())
    return r.stdout.strip()


subprocess.run([sys.executable, str(ROOT / 'tests/sql/run-diamond-cash-custody.py')], check=True)
run('\\ir poker-diamond-cash-admission-setup.sql')
run('\\ir poker-diamond-bomb-pot-setup.sql')
print(run('\\ir poker-diamond-bomb-pot-acceptance.sql'))
print('Diamond bomb pot admission certified in the isolated fixture; this is not public release.')
