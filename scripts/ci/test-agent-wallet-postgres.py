#!/usr/bin/env python3
"""Exercise the actual agent-wallet migration in an isolated, socket-only PG17.
No provider connection, real player, credential or network request is used.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261010215645_agent_wallet_changes_emit_private_roster_signals.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
parser.add_argument('--baseline', action='store_true')
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-agent-wallet-', dir=args.scratch))
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
    query((ROOT/'scripts/ci/fixtures/agent-wallet/setup.sql').read_text())
    if not args.baseline:
        query(MIGRATION.read_text())
    result = query((ROOT/'scripts/ci/fixtures/agent-wallet/cases.sql').read_text())
    if 'agent-wallet-acceptance-passed' not in result:
        raise RuntimeError('Acceptance marker missing')
    print(result)
finally:
    # pg_ctl may time out after starting our private server. Never delete a
    # running cluster just because the start acknowledgment was interrupted.
    # A failed stop preserves the directory for diagnosis instead of erasing it.
    if start_attempted and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)

# The same maintained wallet qualification entry point also exercises explicit
# recipient destinations and the bank-to-agent lock order.
if not args.baseline:
    import sys
    choice_env = dict(os.environ, PG_BIN=str(pg))
    subprocess.run([sys.executable, str(ROOT/'scripts/ci/test-chip-wallet-choice-postgres.py')],
                   env=choice_env, check=True, timeout=60)

# Owner October 21: own-player funding, server-held recovery, full newest roster
# pagination and minimum tournament clocks run with the existing native gate.
if not args.baseline:
    subprocess.run([sys.executable, str(ROOT/'scripts/ci/test-hand-wallet-requests-postgres.py')],
                   env=choice_env, check=True, timeout=60)

# Selected reclaim destinations and promo confinement use the same native gate.
if not args.baseline:
    subprocess.run([sys.executable, str(ROOT/'scripts/ci/test-cashier-reclaim-destinations-postgres.py')],
                   env=choice_env, check=True, timeout=60)
