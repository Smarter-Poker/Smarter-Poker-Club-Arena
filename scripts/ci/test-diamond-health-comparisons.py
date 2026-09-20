"""PostgreSQL 17 qualification of health verdicts, with controlled comparison output."""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT/'artifacts/diamond-health-comparisons')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='codex-diamond-health-'))
sock = cluster/'socket'
sock.mkdir(mode=0o700)
results = {'checks': [], 'production_mutations': False,
           'scope': 'Actual full health reader and health watcher, controlled trial-balance output. Other health dependencies remain unknown. No financial acceptance.'}
psql = [pg/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', '55748', '-U', 'postgres', '-d', 'postgres']

def command(args, sql=None):
    result = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=40)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()

def run(sql):
    return command(psql, sql)

def check(name, passed):
    results['checks'].append({'name': name, 'passed': bool(passed)})
    if not passed:
        raise AssertionError(name)

def refuses(name, sql, reason):
    result = subprocess.run(list(map(str, psql)), input=sql, text=True, capture_output=True, env=env, timeout=30)
    check(name, result.returncode != 0 and reason in result.stderr)

def definition(path, name):
    source = path.read_text()
    match = re.search(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1;', source, re.S)
    if not match:
        raise ValueError('missing actual definition: ' + name)
    return match.group(0)

def lit(value):
    return "'" + str(value).replace("'", "''") + "'"

required = ['player_diamonds', 'fixture_accounts', 'diamond_house', 'register', 'total']
cases = [
    ('empty', [], 'unknown'),
    ('missing-baseline', [(x, None if x != 'register' else 0) for x in required], 'unknown'),
    ('missing-account', [(x, 0) for x in required[:-1]], 'unknown'),
    ('duplicate-account', [(x, 0) for x in required] + [('register', 0)], 'unknown'),
    ('complete-with-informational-null', [(x, 0) for x in required] + [('arena_wallets', None)], 'ok'),
    ('known-break-with-unknown', [(x, 2 if x == 'register' else None) for x in required], 'critical'),
    ('additional-known-break', [(x, 0) for x in required] + [('new_account', -1)], 'critical'),
]

def seed(rows):
    run('TRUNCATE trial_fixture;' + ('INSERT INTO trial_fixture VALUES ' + ','.join(
        '(' + lit(k) + ',' + ('NULL' if v is None else str(v)) + ')' for k, v in rows) + ';' if rows else ''))

def reading():
    return json.loads(run("SELECT row_to_json(h) FROM fn_ca_diamond_health() h WHERE area='trial balance'"))

try:
    check('postgres-17', command([pg/'postgres', '--version']).startswith('postgres (PostgreSQL) 17.'))
    if shutil.disk_usage('/tmp').free < 1024**3:
        raise RuntimeError('one GiB disk reserve required')
    command([pg/'initdb', '-D', cluster/'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command([pg/'pg_ctl', '-D', cluster/'data', '-l', cluster/'server.log', '-o', f"-k {sock} -p 55748 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10", '-w', 'start'])
    run("""
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
    CREATE TABLE ca_diamond_snapshots(id uuid,taken_at timestamptz,unexplained numeric);
    CREATE TABLE trial_fixture(account text,difference numeric);
    CREATE TABLE incident_fixture(detail jsonb);
    CREATE FUNCTION fn_ca_diamond_incident(text,text,uuid,numeric,text,jsonb) RETURNS void
      LANGUAGE sql SECURITY DEFINER AS $$INSERT INTO incident_fixture VALUES($6)$$;
    """)
    source = ROOT/'supabase/migrations/20260909065458_poker_diamond_custody.sql'
    old = definition(source, 'fn_ca_diamond_health')
    trial = definition(source, 'fn_ca_diamond_trial_balance')
    # Qualify exact production definitions, then supply controlled output through
    # the same timestamp signature. Restore the real contract for migration guards.
    run(trial + old)
    check('exact-live-health-preimage', run("SELECT md5(pg_get_functiondef('fn_ca_diamond_health()'::regprocedure))") == '84752474901fcc22302dae65fe42dbb6')
    check('exact-live-trial-contract', run("SELECT md5(pg_get_functiondef('fn_ca_diamond_trial_balance(timestamptz)'::regprocedure))") == '52bc0ea036ad5dcbc2662376c2dfefff')
    fixture_trial = """CREATE OR REPLACE FUNCTION fn_ca_diamond_trial_balance(p_since timestamptz DEFAULT now())
      RETURNS TABLE(account text,balance_now numeric,balance_delta numeric,journal_net numeric,mint_net numeric,difference numeric,note text)
      LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT account,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,difference,NULL::text FROM trial_fixture$$;"""
    run(fixture_trial)
    for name, rows, expected in cases[:4]:
        seed(rows)
        check('baseline-false-healthy-' + name, reading()['status'] == 'ok')
    # Found by slug, not by stamp: the file was archived on 2026-09-16 and is
    # restored under the version production recorded (20260914063002), not the
    # one it was first written with.
    candidates = sorted((ROOT/'supabase/migrations').glob('*_diamond_health_requires_known_comparisons.sql'))
    if len(candidates) != 1:
        raise RuntimeError('expected exactly one diamond_health_requires_known_comparisons migration, found %d' % len(candidates))
    migration = candidates[-1].read_text()
    run(trial + migration)
    run(fixture_trial)
    for name, rows, expected in cases:
        seed(rows)
        check('candidate-' + name, reading()['status'] == expected)
    candidate = run("SELECT pg_get_functiondef('fn_ca_diamond_health()'::regprocedure)")
    check('candidate-exact-definition', run("SELECT md5(pg_get_functiondef('fn_ca_diamond_health()'::regprocedure))") == '3ed2ac4e441befea2072b3c3e941b37e')
    run(trial + migration)
    run(fixture_trial)
    check('migration-replay', run("SELECT pg_get_functiondef('fn_ca_diamond_health()'::regprocedure)") == candidate)
    for role in ('anon', 'authenticated'):
        refuses(role + '-cannot-call-health', 'SET ROLE ' + role + ';SELECT * FROM fn_ca_diamond_health()', 'permission denied for function')
    check('service-can-read-health', bool(run("SET ROLE service_role;SELECT count(*) FROM fn_ca_diamond_health()")))
    refuses('wrong-request-role-refused', "SELECT set_config('request.jwt.claim.role','authenticated',false);SELECT * FROM fn_ca_diamond_health()", 'service_role required')
    seed([])
    watch = definition(ROOT/'supabase/migrations/20260908162611_the_health_report_gets_a_reader.sql', 'fn_ca_diamond_health_watch')
    run(watch + 'SELECT fn_ca_diamond_health_watch();')
    check('actual-watcher-records-unknown-trial-balance', run("SELECT EXISTS(SELECT 1 FROM incident_fixture WHERE detail->'detail' @> '[{\"area\":\"trial balance\",\"status\":\"unknown\"}]'::jsonb)") == 't')
    run("CREATE OR REPLACE FUNCTION fn_ca_diamond_trial_balance(p_since timestamptz DEFAULT now()) RETURNS TABLE(account text,balance_now numeric,balance_delta numeric,journal_net numeric,mint_net numeric,difference numeric,note text) LANGUAGE plpgsql STABLE AS $$BEGIN RAISE EXCEPTION 'fixture source unavailable';END$$;")
    check('source-exception-remains-unknown', reading()['status'] == 'unknown')
    run("CREATE OR REPLACE FUNCTION fn_ca_diamond_trial_balance(p_since timestamptz DEFAULT now()) RETURNS TABLE(account text,balance_now numeric,balance_delta numeric,journal_net numeric,mint_net numeric,difference numeric,note text) LANGUAGE sql AS $$SELECT NULL::text,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,NULL::text WHERE false$$;")
    refuses('changed-trial-contract-refused', migration, 'trial balance contract changed')
    run(trial)
    run("CREATE OR REPLACE FUNCTION fn_ca_diamond_health() RETURNS TABLE(area text,status text,detail text) LANGUAGE sql AS $$SELECT 'changed','unknown','changed'$$;")
    refuses('changed-health-definition-refused', migration, 'diamond health reader changed')
finally:
    if (cluster/'data/postmaster.pid').exists():
        command([pg/'pg_ctl', '-D', cluster/'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
    results['owned_cluster_removed'] = not cluster.exists()
    (out/'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'passed':len(results['checks']), 'output':str(out/'RESULTS.json'), 'owned_cluster_removed':results['owned_cluster_removed']}))
