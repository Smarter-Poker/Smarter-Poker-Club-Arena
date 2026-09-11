#!/usr/bin/env python3
"""Focused admission proof in a fresh PG17 cluster; no inherited DB connection."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

here = Path(__file__).resolve().parent
original = Path(os.environ['ROUND1_FIXTURE']).resolve()
pgbin = Path('/opt/homebrew/opt/postgresql@17/bin')
python = Path('/opt/homebrew/bin/python3')
assert (pgbin / 'initdb').is_file() and python.is_file()
work = Path(tempfile.mkdtemp(prefix='ca-source-admission-', dir='/tmp'))
runner = work / 'runner'
shutil.copytree(original, runner)
shutil.copy2(original.parent / 'source-payer-proposal.sql', work / 'source-payer-proposal.sql')
for name in ['function-catalog-reader-dependencies.json', 'trigger-catalog-legacy.json',
             'table-catalog-legacy.json', 'function-catalog-commission-batch.json',
             'function-catalog-legacy.json']:
    shutil.copy2(here / name, runner / 'vendor/source-authority/owner-composition' / name)
inputs = work / 'input'
shutil.copytree(runner / 'vendor', inputs)
fixture = inputs / 'source-authority/owner-composition'
for name in ['function-catalog-round1.json', 'table-catalog-round1.json',
             'table-catalog-capacity-extra.json', 'function-catalog-capacity-extra.json',
             'trigger-catalog-capacity-extra.json']:
    if (runner / name).exists():
        shutil.copy2(runner / name, fixture / name)
(work / 'socket').mkdir()
env = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}

def run(args, capture=False):
    return subprocess.run([str(a) for a in args], env=env, cwd=work, check=True,
                          text=True, capture_output=capture)

share = Path(run([pgbin / 'pg_config', '--sharedir'], True).stdout.strip())
if not (share / 'postgres.bki').exists():
    share = pgbin.parent / 'share/postgresql'
run([pgbin / 'initdb', '-L', share, '-D', work / 'data', '-U', 'postgres',
     '-A', 'trust', '--no-locale', '-E', 'UTF8'], True)
started = False
try:
    run([pgbin / 'pg_ctl', '-D', work / 'data', '-l', work / 'postgres.log',
         '-o', "-h '' -k '" + str(work / 'socket') + "' -p 55487", '-w', 'start'], True)
    started = True
    env.update(PGHOST=str(work / 'socket'), PGPORT='55487', PGUSER='postgres',
               PGDATABASE='postgres', COMMISSION_PSQL=str(pgbin / 'psql'),
               ROUND1_INPUT=str(inputs), ROUND1_HERE=str(runner),
               PYTHONPATH=str(runner), SOURCE_ADMISSION_HERE=str(here),
               SOURCE_ADMISSION_WORK=str(work))
    # Read-only identity proof happens before the first fixture SQL statement.
    identity = json.loads(run([pgbin / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
        "SELECT jsonb_build_object('database',current_database(),'user',session_user,"
        "'data',current_setting('data_directory'),'listen',current_setting('listen_addresses'),"
        "'socket',current_setting('unix_socket_directories'),'port',current_setting('port'));"], True).stdout)
    assert identity == {'database': 'postgres', 'user': 'postgres', 'data': str(work / 'data'),
                        'listen': '', 'socket': str(work / 'socket'), 'port': '55487'}, identity
    (work / 'cluster-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    print('Verified fresh private PG17 identity with no TCP listener', flush=True)
    run([python, fixture / 'build-fixture.py'])
    def sql_file(path):
        run([pgbin / 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', path])
    for stage in ['schema-tables', 'schema-functions', 'schema-defaults',
                  'schema-constraints', 'schema-foreign-keys', 'seed']:
        sql_file(fixture / (stage + '.sql'))
    sql_file(runner / 'fixture-seed.sql')
    sql_file(fixture / 'schema-triggers.sql')
    sql_file(fixture / 'exercise.sql')
    for stage in ['01-schema', '02-online-index', '03-cutover']:
        sql_file(inputs / (stage + '.sql'))
    for stage in ['01-source-schema', '02-capture']:
        sql_file(inputs / 'source-authority' / (stage + '.sql'))
    sql_file(inputs / 'source-authority/bank-owner/00-bank-legacy-index.sql')
    run([python, runner / 'activate-fixture.py'])
    run([python, here / 'source-admission-probe.py'])
finally:
    if started:
        subprocess.run([str(pgbin / 'pg_ctl'), '-D', str(work / 'data'), '-m', 'immediate',
                        '-w', 'stop'], env=env, cwd=work, capture_output=True, text=True, check=True)
    print('Retained isolated proof directory: ' + str(work), flush=True)
