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
parser.add_argument('--pulse-baseline', action='store_true')
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
    # A bootstrap superuser cannot be demoted. Keep it distinct so the final
    # owner invocation can match Supabase's NOSUPERUSER BYPASSRLS postgres.
    run([pg/'initdb', '-D', data, '-U', 'pulse_fixture_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as conf:
        conf.write("\nlisten_addresses = ''\nunix_socket_directories = '"+str(socket)+"'\nautovacuum = off\n")
    start_attempted = True
    run([pg/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    run([pg/'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket,
         '-U', 'pulse_fixture_admin', '-d', 'postgres', '-p', '5432'],
        'CREATE ROLE postgres LOGIN SUPERUSER;')
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
    # Connected aggregate boundary uses the actual cron grants and RLS.
    captured = json.loads((FIXTURE/'pulse-baseline.json').read_text())
    query("""CREATE ROLE supabase_admin BYPASSRLS;
      ALTER SCHEMA cron OWNER TO supabase_admin;
      REVOKE ALL ON SCHEMA cron FROM PUBLIC,anon,authenticated,service_role;
      GRANT USAGE ON SCHEMA cron TO postgres;
      ALTER TABLE cron.job ADD COLUMN username text DEFAULT 'postgres';
      ALTER TABLE cron.job OWNER TO supabase_admin;
      ALTER TABLE cron.job ENABLE ROW LEVEL SECURITY;
      CREATE POLICY cron_job_policy ON cron.job USING(username=CURRENT_USER);
      GRANT SELECT ON cron.job TO PUBLIC;
      CREATE TABLE cron.job_run_details(jobid bigint,username text,start_time timestamptz,end_time timestamptz,status text,return_message text);
      ALTER TABLE cron.job_run_details OWNER TO supabase_admin;
      ALTER TABLE cron.job_run_details ENABLE ROW LEVEL SECURITY;
      CREATE POLICY cron_job_run_details_policy ON cron.job_run_details USING(username=CURRENT_USER);
      GRANT SELECT,DELETE ON cron.job_run_details TO PUBLIC;
      DROP TABLE public.v_system_health_cron;
      INSERT INTO cron.job VALUES(700,'home-disabled','* * * * *','PRIVATE SQL',false,'postgres'),
        (701,'unrelated-active','* * * * *','PRIVATE SQL',true,'postgres'),
        (702,'another-owner','* * * * *','PRIVATE SQL',true,'another_owner');
      INSERT INTO cron.job_run_details VALUES
        (17,'postgres',now(),now(),'failed','PRIVATE ERROR'),
        (20,'postgres',now(),now(),'succeeded','PRIVATE ERROR'),
        (700,'postgres',now(),now(),'failed','PRIVATE ERROR'),
        (701,'postgres',now(),now(),'failed','PRIVATE ERROR'),
        (702,'another_owner',now(),now(),'failed','PRIVATE ERROR'),
        (999,'postgres',now(),now(),'failed','PRIVATE ERROR'),
        (17,'postgres',now()-interval '25 hours',now(),'failed','PRIVATE ERROR');
    """)
    query('CREATE VIEW public.v_system_health_cron WITH(security_invoker=true) AS '+captured['view']['def']+'; GRANT SELECT ON public.v_system_health_cron TO anon,authenticated,service_role;')
    # Capture the caller-visible non-cron payload; the temporary grant is local
    # only and removed before reproducing the real denied schema boundary.
    query("GRANT USAGE ON SCHEMA cron TO authenticated;")
    def payload(role, uid):
        return query("SET ROLE "+role+"; SET request.jwt.claim.sub='"+uid+"'; SELECT get_smarter_poker_pulse()-'generated_at' #- '{system_health,cron_jobs_active}' #- '{system_health,cron_failures_24h}';")
    users=['20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000099']
    query("UPDATE commander_home_groups SET is_private=true WHERE id='10000000-0000-0000-0000-000000000002';")
    expected=[payload('authenticated',uid) for uid in users]
    assert expected[0] != expected[2], 'Fixture must distinguish owner and stranger RLS'
    query("REVOKE USAGE ON SCHEMA cron FROM authenticated;")
    if args.pulse_baseline:
        query('SET ROLE authenticated; SELECT public.get_smarter_poker_pulse();')
        raise AssertionError('Expected the recorded cron schema permission failure')
    query('SET ROLE authenticated; SELECT public.get_smarter_poker_pulse();','permission denied for schema cron')
    catalog_sql="SELECT md5(jsonb_build_object('schema',(SELECT nspacl FROM pg_namespace WHERE nspname='cron'),'relations',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'acl',c.relacl,'rls',c.relrowsecurity) ORDER BY c.oid) FROM pg_class c WHERE c.relnamespace='cron'::regnamespace),'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY policyname) FROM pg_policies p WHERE schemaname='cron'))::text);"
    cron_catalog_before=query(catalog_sql)
    migration=(ROOT/'supabase/migrations/20260927041025_pulse_cron_aggregates_preserve_caller_product_privacy.sql').read_text()
    query(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'fixture rollback';END$$;COMMIT;"),'fixture rollback')
    assert query("SELECT to_regprocedure('public.fn_smarter_poker_pulse_cron_counts()') IS NULL;")=='t'
    query(migration)
    query(migration,'PULSE_CRON_BOUNDARY_PREIMAGE_CHANGED')
    assert query("SELECT md5(pg_get_functiondef('public.get_smarter_poker_pulse()'::regprocedure));")==captured['pulse']['candidate_md5']
    assert [payload('authenticated',uid) for uid in users]==expected
    assert query(catalog_sql)==cron_catalog_before
    assert query("SELECT prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=\"\"','statement_timeout=8s'] FROM pg_proc WHERE oid='public.fn_smarter_poker_pulse_cron_counts()'::regprocedure;")== 't'
    for role in ['anon','authenticated']:
        query('SET ROLE '+role+'; SELECT command FROM cron.job;','permission denied for schema cron')
        # The existing bound view needs no underlying schema lookup; its RLS
        # still hides jobs owned by other database roles. No view grants change.
        assert query('SET ROLE '+role+'; SELECT count(*) FROM public.v_system_health_cron;')=='SET\n0'
    query('SET ROLE anon; SELECT * FROM public.fn_smarter_poker_pulse_cron_counts();','permission denied')
    query('SET ROLE anon; SELECT public.get_smarter_poker_pulse();','permission denied')
    for role in ['authenticated','service_role']:
        assert query('SET ROLE '+role+'; SELECT * FROM public.fn_smarter_poker_pulse_cron_counts();')=='SET\n2|4'
    # Empty data produces explicit zero; errors are not hidden as empty success.
    query('DELETE FROM cron.job_run_details; DELETE FROM cron.job;')
    assert query('SET ROLE authenticated; SELECT * FROM public.fn_smarter_poker_pulse_cron_counts();')=='SET\n0|0'
    assert query("SELECT (NOT prosecdef) AND proacl=ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[] FROM pg_proc WHERE oid='public.get_smarter_poker_pulse()'::regprocedure;")=='t'
    # Supabase's actual postgres owner is NOSUPERUSER BYPASSRLS. A separate
    # isolated setup role remains superuser only to drive the test connection.
    query("""INSERT INTO cron.job VALUES
      (17,'home-native-owner','* * * * *','PRIVATE SQL',true,'postgres'),
      (20,'pnm-native-other','* * * * *','PRIVATE SQL',true,'another_owner');
      INSERT INTO cron.job_run_details VALUES
      (17,'postgres',now(),now(),'failed','PRIVATE ERROR'),
      (20,'another_owner',now(),now(),'failed','PRIVATE ERROR');
      ALTER ROLE postgres NOSUPERUSER BYPASSRLS;""")
    native_owner_result = run([pg/'psql','-X','-v','ON_ERROR_STOP=1','-At','-h',socket,
      '-U','pulse_fixture_admin','-d','postgres','-p','5432'],
      "SELECT NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname='postgres';"
      " SET ROLE authenticated; SELECT * FROM public.fn_smarter_poker_pulse_cron_counts();"
      " SELECT jsonb_typeof(public.get_smarter_poker_pulse());")
    assert native_owner_result == 't\nSET\n2|2\nobject', native_owner_result
    print('pulse-cron-boundary-nosuperuser-owner-passed')
    print('pulse-cron-boundary-native-acceptance-passed')
finally:
    if start_attempted and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
