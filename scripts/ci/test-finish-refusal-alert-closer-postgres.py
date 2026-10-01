#!/usr/bin/env python3
"""Exercise the actual finish-refusal closer migration in an isolated,
socket-only PostgreSQL. No provider connection, real alert, player or
credential is used.

--baseline installs only the production preimage embedded in the migration
and must FAIL: a retried finish whose terminal receipt settled stays open.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261001151637_a_retried_finish_refusal_closes_when_its_terminal_receipt_se.sql'
FIXTURES = ROOT / 'scripts/ci/fixtures/finish-refusal-alert-closer'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
parser.add_argument('--baseline', action='store_true')
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-finish-closer-', dir=args.scratch))
data = cluster / 'data'
socket = cluster / 's'
socket.mkdir(mode=0o700)
start_attempted = False


def run(argv, sql=None):
    result = subprocess.run([str(v) for v in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()


def query(sql):
    return run([pg/'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket,
                '-U', 'postgres', '-d', 'postgres', '-p', '5432'], sql)


def preimage(text):
    found = re.findall(r"v_pre constant text := \$pre\$(.*?)\$pre\$;", text, re.S)
    if len(found) != 1:
        raise RuntimeError('the migration must embed exactly one preimage')
    return found[0]


try:
    version = run([pg/'postgres', '--version'])
    if not re.search(r' 1[67]\.', version):
        raise RuntimeError('PostgreSQL 16 or 17 is required, found ' + version)
    run([pg/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust',
         '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as conf:
        conf.write("\nlisten_addresses = ''\nunix_socket_directories = '" + str(socket) + "'\nautovacuum = off\n")
    start_attempted = True
    run([pg/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    endpoint = json.loads(query("select json_build_object('address',inet_server_addr(),'listen',current_setting('listen_addresses'));"))
    assert endpoint == {'address': None, 'listen': ''}, endpoint
    text = MIGRATION.read_text()
    query((FIXTURES/'setup.sql').read_text())
    # The exact production body, with its production grants.
    query(preimage(text) + ";\nREVOKE ALL ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean,integer) FROM PUBLIC;\n"
          "GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean,integer) TO service_role;")
    if not args.baseline:
        query(text)
        # Installing twice is a no-op, never an error.
        query(text)
    result = query((FIXTURES/'cases.sql').read_text())
    if 'finish-refusal-alert-closer-acceptance-passed' not in result:
        raise RuntimeError('Acceptance marker missing')
    print(result)
finally:
    if start_attempted and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
