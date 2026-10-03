#!/usr/bin/env python3
"""Qualify the first-party client error sink in an isolated PostgreSQL 17 cluster.

Installs supabase/migrations/20261003080431_players_errors_reach_a_first_party_sink.sql unchanged over a
fixture that reproduces what it depends on (the anon/authenticated/service_role roles, auth.uid() read
from request.jwt.claim.sub as PostgREST sets it, and a pg_cron stand-in), then exercises the rules the
design names: auth.uid() is the only identity, browsers can neither read nor write the table directly,
signed-out callers cannot reach it, the per-user / global / per-call caps hold (also under concurrency), every text field is
scrubbed and size-capped, malformed input stores nothing and never raises, and the prune keeps 14 days.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261003080431_players_errors_reach_a_first_party_sink.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/client-error-sink')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='client-error-sink-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55741'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'client error sink: identity, grants, rate limits, scrubbing, size caps, retention; '
                    'isolated fixture, not whole-schema qualification', 'cases': [], 'passed': False}
U1 = '00000000-0000-4000-8000-0000000000e1'
U2 = '00000000-0000-4000-8000-0000000000e2'

FIXTURE = """
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase's default privileges: new tables and functions are granted to the browser roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(n text, s text, c text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (n, s, c)
  ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule, command = excluded.command
  RETURNING jobid::bigint $$;
"""


def command(argv, sql=None):
    return subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=60)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None, error=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text('-- SQL\n' + sql + '\n-- STDOUT\n' + r.stdout + '-- STDERR\n' + r.stderr)
    passed = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
    got = r.stdout.rstrip('\n')
    if expected is not None:
        passed = passed and got == expected
    results['cases'].append({'name': name, 'passed': passed, 'expected': expected, 'expectedError': error,
                             'observed': got if not error else r.stderr.strip()[-400:]})
    require(passed, name + ': ' + r.stdout[-800:] + r.stderr[-1200:])
    return got


def as_role(role, uid=None, headers=None):
    s = "\\o /dev/null\n"
    s += f"SELECT set_config('request.jwt.claim.sub', '{uid or ''}', false);\n"
    if headers:
        s += f"SELECT set_config('request.headers', '{headers}', false);\n"
    return s + "\\o\n" + f"SET ROLE {role};\n"


def events(n, extra='{}'):
    return (f"(SELECT jsonb_agg(jsonb_build_object('code','TEST_CODE','message','m'||i,"
            f"'at',(extract(epoch FROM now())*1000)::bigint) || '{extra}'::jsonb) FROM generate_series(1,{n}) i)")


def report(n, extra='{}'):
    return f"SELECT public.fn_report_client_errors({events(n, extra)});"


RESET = "TRUNCATE public.client_error_events;"
try:
    require(re.search(r'PostgreSQL\) 17\.', command([pg / 'postgres', '--version']).stdout), 'PostgreSQL 17 required')
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject',
                 '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0700\n"
                "port=" + PORT + "\nshared_buffers='16MB'\nmax_connections=20\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', FIXTURE)
    run('install', MIGRATION.read_text())

    # Grants: the browser roles reach the one door and nothing else.
    run('grants', """SELECT
      NOT has_function_privilege('anon', 'public.fn_report_client_errors(jsonb)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.fn_report_client_errors(jsonb)', 'EXECUTE')
      AND (SELECT prosecdef FROM pg_proc WHERE oid = 'public.fn_report_client_errors(jsonb)'::regprocedure)
      AND NOT has_table_privilege('anon', 'public.client_error_events', 'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('authenticated', 'public.client_error_events', 'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('authenticated', 'public.client_error_rates_10m', 'SELECT')
      AND has_table_privilege('service_role', 'public.client_error_rates_10m', 'SELECT')
      AND NOT has_function_privilege('anon', 'public.fn_client_error_health()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.fn_client_error_health()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.fn_prune_client_error_events(interval,integer)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.fn_client_error_scrub(text,integer)', 'EXECUTE')
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.client_error_events'::regclass);""", 't')
    run('direct-insert-refused', as_role('authenticated', U1) +
        "INSERT INTO public.client_error_events (occurred_at, code) VALUES (now(), 'X');", error='permission denied')
    run('direct-read-refused', as_role('anon') + "SELECT count(*) FROM public.client_error_events;", error='permission denied')

    # Identity is auth.uid(); a client-supplied user_id is ignored.
    run('identity', as_role('authenticated', U1) + report(3, '{"user_id":"' + U2 + '"}') +
        "RESET ROLE; SELECT count(*) || ':' || count(DISTINCT user_id) || ':' || min(user_id::text) FROM public.client_error_events;",
        '3\n3:1:' + U1)
    run('reset-identity', RESET)

    # Per-call cap 20, per-user cap 60 a minute.
    run('per-user-cap', as_role('authenticated', U1) + report(25) + report(25) + report(25) + report(25),
        '20\n20\n20\n0')
    run('second-user-unaffected', as_role('authenticated', U2) + report(5), '5')
    run('reset-per-user', RESET)

    # The cap holds when one player's tabs report concurrently.
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        futs = [pool.submit(command, cmd, as_role('authenticated', U1) + report(20)) for _ in range(5)]
        got = [f.result() for f in futs]
    require(all(g.returncode == 0 for g in got), 'concurrent reports failed: ' + ' | '.join(g.stderr for g in got))
    run('concurrent-per-user-cap', "SELECT count(*) FROM public.client_error_events;", '60')
    run('reset-concurrent', RESET)

    # Signed-out callers cannot reach the door at all (the live definer audit
    # holds anon-executable DEFINER writers at zero), and a call with no user
    # stores nothing even where EXECUTE is held.
    run('anon-refused', as_role('anon') + "SELECT public.fn_report_client_errors(" + events(1) + ");",
        error='permission denied')
    run('no-user-stores-nothing', as_role('service_role') + "SELECT public.fn_report_client_errors(" + events(3) + ");", '0')
    # The table accepts 300 a minute in all.
    run('global-cap', as_role('authenticated') +
        "SELECT sum(r) FROM (SELECT set_config('request.jwt.claim.sub', gen_random_uuid()::text, false), "
        "public.fn_report_client_errors(" + events(20) + ") AS r FROM generate_series(1, 18)) q;", '300')
    run('global-total', "SELECT count(*) || ':' || count(DISTINCT user_id) FROM public.client_error_events;", '300:15')
    run('view-and-health', as_role('service_role') +
        "SELECT code || ':' || reports || ':' || occurrences || ':' || users FROM public.client_error_rates_10m;"
        "SELECT client_errors_10m || ':' || client_error_users_10m || ':' || client_error_top_code_users_10m || ':' || client_error_top_code FROM public.fn_client_error_health();",
        'TEST_CODE:300:300:15\n300:15:15:TEST_CODE')
    run('reset-caps', RESET)

    # Malformed input stores nothing and never raises.
    run('malformed', as_role('authenticated', U1) +
        "SELECT public.fn_report_client_errors(NULL) || ',' || public.fn_report_client_errors('{\"a\":1}') || ',' || "
        "public.fn_report_client_errors('[\"x\", 1, null, []]') || ',' || "
        "public.fn_report_client_errors(jsonb_build_array(jsonb_build_object('message', repeat('z', 70000))));",
        '0,0,0,0')

    # Scrubbing and clamps, applied by the database whatever the browser sent.
    message = ("player bob@example.com jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln Bearer abc.def-123 "
               "refresh_token=v1xyz&ok=1 sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx "
               "table 0b6a0f0e-1c1d-4e5f-8a9b-0c1d2e3f4a5b ")
    run('scrub-and-clamp', as_role('authenticated', U1, '{"user-agent":"RealUA/1.0"}') +
        "SELECT public.fn_report_client_errors(jsonb_build_array(jsonb_build_object("
        "'code', 'SEAT OCCUPANCY;drop', 'name', 'Type Error', 'at', 1e20, 'occurrences', 1e12, 'automated', 'yes',"
        "'route', '/hub/club-arena/table/x?access_token=eyJabc.def.ghi#frag', 'user_agent', 'Spoofed',"
        "'app_version', 'abc123<script>', 'message', '" + message + "' || repeat('x', 1000),"
        "'stack', repeat('at f (a.js:1:1) ', 400), 'source', 'TablePage.action rejected!',"
        "'context', jsonb_build_object('email', 'a@b.co', 'note', 'password=hunter2'), 'dedupe_key', 'abc|def ghi'),"
        "jsonb_build_object('code', 'BIG', 'context', jsonb_build_object('blob', repeat('y', 3000))),"
        "jsonb_build_object('message', 42, 'at', 'soon', 'automated', true)));"
        "RESET ROLE;"
        "SELECT concat_ws('|', code, error_name, occurred_at <= received_at, occurrences, automated, route, app_version,"
        " user_agent, char_length(message), left(message, 170), char_length(stack), source, context::text, dedupe_key)"
        " FROM public.client_error_events ORDER BY id;",  # concat_ws skips NULLs
        '3\n'
        'SEAT_OCCUPANCY_drop|Type_Error|t|10000|f|/hub/club-arena/table/x|abc123script|RealUA/1.0|500|'
        'player [email] jwt [jwt] Bearer [token] refresh_token=[redacted]&ok=1 [token] '
        'table 0b6a0f0e-1c1d-4e5f-8a9b-0c1d2e3f4a5b ' + 'x' * 49 + '|2000|TablePage.action_rejected_|'
        '{"note": "password=[redacted]", "email": "[email]"}|abc|defghi\n'
        'BIG|t|1|f|RealUA/1.0|{"truncated": true}\n'
        'UNKNOWN|t|1|t|RealUA/1.0')
    run('reset-scrub', RESET)

    # Retention: older than 14 days goes, in bounded batches; the schedule is the quiet minute.
    run('prune', "INSERT INTO public.client_error_events (received_at, occurred_at, user_id, code) "
        "SELECT now() - interval '15 days', now() - interval '15 days', '" + U1 + "', 'OLD' FROM generate_series(1, 50);"
        "INSERT INTO public.client_error_events (received_at, occurred_at, user_id, code) "
        "SELECT now() - interval '13 days', now() - interval '13 days', '" + U1 + "', 'KEEP' FROM generate_series(1, 5);"
        "SELECT public.fn_prune_client_error_events(interval '14 days', 20);"
        "SELECT public.fn_prune_client_error_events();"
        "SELECT string_agg(code || ':' || n, ',') FROM (SELECT code, count(*) n FROM public.client_error_events GROUP BY code) s;",
        '20\n30\nKEEP:5')
    run('prune-schedule', "SELECT schedule || '|' || command FROM cron.job WHERE jobname = 'client-error-events-prune';",
        "16 * * * *|SET statement_timeout = '60s'; SELECT public.fn_prune_client_error_events(interval '14 days', 20000);")
    results['passed'] = True
finally:
    if (cluster / 'data/postmaster.pid').exists():
        r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        require(r.returncode == 0, 'Could not stop owned cluster: ' + r.stderr)
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    require(not (cluster / 'data/postmaster.pid').exists(), 'Owned cluster still running')
    shutil.rmtree(cluster)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']), 'evidence': str(out)}))
