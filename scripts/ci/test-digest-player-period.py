"""Qualify the exact player-period owner in isolated PostgreSQL17.

The existing daily report is a deterministic fixture here. This verifies the
new snapshot/period owner, not production money or the existing daily query.
"""
from pathlib import Path
import os
import shutil
import socket
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
work = os.environ.get('DIGEST_NATIVE_WORK')
if not work:
    raise SystemExit('DIGEST_NATIVE_WORK must name an owned scratch directory')
scratch = Path(tempfile.mkdtemp(prefix='digest-player-period-', dir=work))
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = str(listener.getsockname()[1])

def run(tool, args, sql=None):
    p = subprocess.run([str(pg / tool), *args], input=sql, text=True, capture_output=True)
    if p.returncode:
        raise RuntimeError(p.stdout + p.stderr)
    return p.stdout

def sql(text):
    return run('psql', ['-X', '-h', '127.0.0.1', '-p', port, '-d', 'postgres',
                        '-v', 'ON_ERROR_STOP=1'], text)

started = False
try:
    run('initdb', ['-D', str(scratch / 'data'), '-A', 'trust', '--no-locale'])
    run('pg_ctl', ['-D', str(scratch / 'data'), '-l', str(scratch / 'log'),
                   '-o', f"-h 127.0.0.1 -k '' -p {port}", '-w', 'start'])
    started = True
    fixture = repo / 'scripts/ci/fixtures/digest-player-period'
    sql((fixture / 'setup.sql').read_text())
    migration = next((repo / 'supabase/migrations').glob('20261026140704_*.sql')).read_text()
    tables = migration[migration.index('CREATE TABLE'):migration.index(
        'CREATE OR REPLACE FUNCTION public.fn_sp_digest_player_totals')]
    owner = migration[migration.index('-- Keep one day:'):]
    sql('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;\n'
        + 'BEGIN;\n' + tables + owner)
    sql((fixture / 'assert.sql').read_text())
    print('PASS exact period owner: one daily compute, explicit missing history, finite fill, '
          'day/week/month, distinct players, end wallet, inherited grants removed')
finally:
    if started:
        run('pg_ctl', ['-D', str(scratch / 'data'), '-m', 'immediate', '-w', 'stop'])
    shutil.rmtree(scratch)
