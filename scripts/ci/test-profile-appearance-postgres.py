#!/usr/bin/env python3
"""Exercise the actual appearance migration in an isolated, socket-only PG17.
No provider connection, real profile, credential or network request is used.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20260926150415_profile_appearance_changes_have_a_private_bounded_signal.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
parser.add_argument('--baseline', action='store_true')
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-appearance-', dir=args.scratch))
data = cluster / 'data'
socket = cluster / 's'
socket.mkdir(mode=0o700)
start_attempted = False

def run(argv, sql=None):
    result = subprocess.run([str(v) for v in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()

def query(sql):
    return run([pg/'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket,
                '-U', 'postgres', '-d', 'postgres', '-p', '5432'], sql)

try:
    if ' 17.' not in run([pg/'postgres', '--version']):
        raise RuntimeError('PostgreSQL 17 is required')
    run([pg/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as conf:
        conf.write("\nlisten_addresses = ''\nunix_socket_directories = '" + str(socket) + "'\nautovacuum = off\n")
    start_attempted = True
    run([pg/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    endpoint = json.loads(query("select json_build_object('address',inet_server_addr(),'data',current_setting('data_directory'),'listen',current_setting('listen_addresses'));"))
    assert endpoint == {'address': None, 'data': str(data), 'listen': ''}, endpoint
    query((ROOT/'scripts/ci/fixtures/profile-appearance/setup.sql').read_text())
    if not args.baseline:
        query(MIGRATION.read_text())
    result = query((ROOT/'scripts/ci/fixtures/profile-appearance/cases.sql').read_text())
    if 'profile-appearance-acceptance-passed' not in result:
        raise RuntimeError('Acceptance marker missing')
    print(result)
finally:
    # pg_ctl may time out after starting our private server. Never delete a
    # running cluster just because the start acknowledgment was interrupted.
    # A failed stop preserves the directory for diagnosis instead of erasing it.
    if start_attempted and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
