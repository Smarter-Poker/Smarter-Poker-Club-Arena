#!/usr/bin/env python3
"""Apply the exact migration to private socket-only PG17 and test real privileges.
The recorded production definitions have no data. PostGIS operators are modeled
only to compile unchanged spatial expressions; spatial math is not under test.
"""
import argparse
import collections
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/discovery-privacy'
MIGRATION = ROOT / 'supabase/migrations/20260926220706_public_discovery_reads_current_privacy_before_cached_locatio.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
parser.add_argument('--baseline', action='store_true')
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-discovery-', dir=args.scratch))
data = cluster / 'data'
# macOS UNIX socket paths are short even when the private SSD worktree is not.
socket = Path(tempfile.mkdtemp(prefix='ca-dp-', dir=tempfile.gettempdir()))
start_attempted = False

def run(argv, sql=None, expected_error=None):
    result = subprocess.run([str(v) for v in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=60)
    if expected_error is not None:
        assert result.returncode and expected_error in result.stderr, result.stderr + result.stdout
    elif result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()

def query(sql, expected_error=None):
    return run([pg/'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket,
                '-U', 'postgres', '-d', 'postgres', '-p', '5432'], sql, expected_error)

def baseline():
    captured = json.loads((FIXTURE/'baseline.json').read_text())
    query((FIXTURE/'setup.sql').read_text())
    tables = collections.defaultdict(list)
    for col in captured['columns']:
        typ = col['type'].replace('geography(Point,4326)', 'geography')
        tables[col['relname']].append('"'+col['attname']+'" '+typ)
    for table, columns in tables.items():
        query('CREATE TABLE public.'+table+' ('+','.join(columns)+');')
    query((FIXTURE/'rows.sql').read_text())
    for view in captured['views']:
        query('CREATE MATERIALIZED VIEW public.'+view['matviewname']+' AS '+view['definition'])
        # Exact unchanged baseline definitions, not hand-copied substitutes.
        actual = query("SELECT md5(pg_get_viewdef('public."+view['matviewname']+"'::regclass, true));")
        if actual != hashlib.md5(view['definition'].encode()).hexdigest():
            parsed = query("SELECT pg_get_viewdef('public."+view['matviewname']+"'::regclass, true);")
            raise AssertionError('\n'.join(difflib.unified_diff(view['definition'].strip().splitlines(), parsed.splitlines())))
    query('''CREATE UNIQUE INDEX mv_active_poker_locations_pk ON public.mv_active_poker_locations(source,entity_id);
             CREATE UNIQUE INDEX idx_mv_home_groups_trending_group_id ON public.mv_home_groups_trending(group_id);
             GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON public.mv_active_poker_locations,public.mv_home_groups_trending TO anon,authenticated;
             GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;''')
    for function in captured['functions']:
        query(function['definition'])
        privilege = next(p for p in captured['privileges'] if p['proname'] == function['proname'])
        signature = function['proname']+'('+','.join(arg.strip().split(' ', 1)[1] for arg in function['args'].split(','))+')' if function['args'] else function['proname']+'()'
        query('REVOKE ALL ON FUNCTION public.'+signature+' FROM PUBLIC,anon,authenticated,service_role;')
        for role, key in [('anon','anon_execute'),('authenticated','authenticated_execute'),('service_role','service_execute')]:
            if privilege[key]: query('GRANT EXECUTE ON FUNCTION public.'+signature+' TO '+role+';')
    query('''CREATE TABLE fixture_function_catalog AS SELECT oid, proname, md5(pg_get_functiondef(oid)) AS hash, proacl, prosecdef, proconfig
             FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'get_%';
             CREATE TABLE fixture_columns AS SELECT c.relname,a.attname,a.atttypid,a.atttypmod,a.attnum
             FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relname IN ('mv_active_poker_locations','mv_home_groups_trending') AND a.attnum>0 AND NOT a.attisdropped;
             CREATE TABLE fixture_indexes AS SELECT indexrelid,indrelid FROM pg_index WHERE indrelid IN ('mv_active_poker_locations'::regclass,'mv_home_groups_trending'::regclass);''')

try:
    if ' 17.' not in run([pg/'postgres', '--version']): raise RuntimeError('PostgreSQL 17 is required')
    run([pg/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as conf:
        conf.write("\nlisten_addresses = ''\nunix_socket_directories = '"+str(socket)+"'\nautovacuum = off\n")
    start_attempted = True
    run([pg/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    endpoint = json.loads(query("select json_build_object('address',inet_server_addr(),'data',current_setting('data_directory'),'listen',current_setting('listen_addresses'));"))
    assert endpoint == {'address': None, 'data': str(data), 'listen': ''}, endpoint
    baseline()
    migration = MIGRATION.read_text()
    if not args.baseline:
        # Unexpected source is refused before the migration mutates anything.
        query("ALTER FUNCTION public.fn_refresh_trending_home_groups() SET search_path=public,pg_temp;")
        query(migration, 'discovery privacy source drift: fn_refresh_trending_home_groups')
        original = next(f['definition'] for f in json.loads((FIXTURE/'baseline.json').read_text())['functions'] if f['proname']=='fn_refresh_trending_home_groups')
        query(original)
        # Real rollback of every DDL/ACL change before its commit.
        query(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"), 'fixture rollback')
        assert query("SELECT to_regnamespace('discovery_private') IS NULL AND (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='m')=2;") == 't'
        # Prime all four existing RPC plans in the same backend before schema move.
        query("SET ROLE anon; SELECT count(*) FROM get_poker_locations_by_state('IL'); SELECT count(*) FROM get_trending_home_groups(); SELECT get_public_smarter_poker_metrics(); RESET ROLE; SET ROLE authenticated; SELECT get_smarter_poker_pulse(); RESET ROLE;\n" + migration + "\nSET ROLE anon; SELECT count(*) FROM get_poker_locations_by_state('IL'); SELECT count(*) FROM get_trending_home_groups(); SELECT get_public_smarter_poker_metrics(); RESET ROLE; SET ROLE authenticated; SELECT get_smarter_poker_pulse(); RESET ROLE;")
        query(migration, 'target schema already exists')
    result = query((FIXTURE/'cases.sql').read_text())
    if 'discovery-privacy-acceptance-passed' not in result: raise RuntimeError('Acceptance marker missing')
    # Verify the exact MVCC boundary with two actual database connections.
    # An existing REPEATABLE READ snapshot stays consistent; the next statement
    # snapshot after commit hides the group immediately without cache refresh.
    connection = subprocess.Popen([str(pg/'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-At',
        '-h', str(socket), '-U', 'postgres', '-d', 'postgres', '-p', '5432'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1, env=env)
    try:
        def exchange(sql, expected):
            connection.stdin.write(sql + '\n')
            connection.stdin.flush()
            for wanted in expected:
                actual = connection.stdout.readline().strip()
                assert actual == wanted, (actual, wanted)
        exchange("BEGIN ISOLATION LEVEL REPEATABLE READ; SET ROLE anon; SELECT count(*) FROM get_poker_locations_by_state('IL');", ['BEGIN','SET','2'])
        query("UPDATE commander_home_groups SET is_private=true WHERE id='10000000-0000-0000-0000-000000000001';")
        exchange("SELECT count(*) FROM get_poker_locations_by_state('IL'); COMMIT; SELECT count(*) FROM get_poker_locations_by_state('IL');", ['2','COMMIT','1'])
        connection.stdin.close()
        assert connection.wait(timeout=5) == 0, connection.stderr.read()
    finally:
        if connection.poll() is None:
            connection.terminate()
            connection.wait(timeout=5)
    print(result)
    print('discovery-privacy-two-session-snapshot-passed')
finally:
    if start_attempted and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
