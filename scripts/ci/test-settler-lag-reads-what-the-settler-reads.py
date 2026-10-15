"""Isolated PostgreSQL regression for fn_settler_lag_check().

The rakeback settler (server/src/services/RakebackSettlerService.ts) pages
rake_records WHERE rake_amount > 0 by the keyset (created_at, id) and leaves
its cursor and daemon_state.updated_at untouched on an idle run. Its lag probe
must therefore judge the rows the settler reads, by the age of the oldest one:

  * an idle settler (no row waiting) is healthy however old its cursor is;
  * a fresh backlog that arrived after a quiet spell is not a stall;
  * a rake reversal (rake_amount <= 0), which the settler never reads, is not
    backlog;
  * a positive row that has waited past the grace IS a stall, a positive row
    older than six hours is unhealthy, and a closed week with unaccrued cash
    rake still blocks.

The test loads the exact production definition captured on 2026-10-15 (its
pg_get_functiondef md5 equals production's), proves it misreads the first
three cases, then applies the candidate migration (a pinned-text
substitution) and proves every case, the derived postimage md5, the grants and
that a second run is refused. An empty throwaway cluster on a Unix socket; no
network, no production connection.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'settler-lag-reads-what-the-settler-reads'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/settler-lag-reads-what-the-settler-reads')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='settler-lag-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 read on production 2026-10-15, before and after the
# candidate (the postimage derived read-only on production with replace()).
LIVE_DEF_MD5 = '5cdd53e06cc8dbbc843b99fdbc2ff7db'
POST_DEF_MD5 = '84bf7dc6f8cb3fedcf0146ac2927075f'
# Production's grants (proacl {postgres=X/postgres,service_role=X/postgres}).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_settler_lag_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_settler_lag_check() TO service_role;
'''

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE daemon_state(daemon text PRIMARY KEY, high_water_mark timestamptz,
  high_water_mark_id uuid, updated_at timestamptz);
CREATE TABLE rake_records(id uuid PRIMARY KEY, created_at timestamptz NOT NULL,
  rake_amount numeric NOT NULL, is_tournament boolean, tournament_id uuid);
CREATE INDEX ON rake_records(created_at, id);
-- The union week boundary, set per case (production: Monday 07:00 UTC).
CREATE TABLE fixture_week(week_start timestamptz);
CREATE FUNCTION public.fn_union_week_start(p_at timestamptz DEFAULT now()) RETURNS timestamptz
  LANGUAGE sql STABLE AS $$ SELECT week_start FROM fixture_week $$;
"""


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


# Each case: cursor age, last save age, rows above the cursor as
# (count, minutes old, rake amount, cash?), minutes since the week boundary.
# A boundary only 10 minutes old is inside the 30-minute week grace, so the
# week is not asked about; 120 minutes old asks it.
CASES = {
    # 2026-10-13 19:17 to 2026-10-14 23:04: no rake row at all. lag_hours 27.57.
    'idle-floor': dict(cursor_h=27.57, save_h=27.43, rows=[], week_m=10),
    # 2026-10-14 23:15: 1,545 rows, the oldest eleven minutes old.
    'fresh-after-quiet': dict(cursor_h=27.96, save_h=27.82, rows=[(1545, 11, 2.5, True)], week_m=10),
    # 2026-10-13 17:01: 853 reversals (sum -1,351.85), none positive.
    'reversals-only': dict(cursor_h=3.74, save_h=3.6, rows=[(853, 50, -1.585, True)], week_m=10),
    # A cycle really skipped: positive rows waiting 90 minutes.
    'true-stall': dict(cursor_h=1.6, save_h=1.6, rows=[(40, 90, 1.0, True)], week_m=10),
    # Seven hours behind.
    'hours-behind': dict(cursor_h=7.5, save_h=7.4, rows=[(5, 420, 1.0, False)], week_m=10),
    # Healthy and busy: the oldest waiting row is 20 minutes old.
    'mid-cycle': dict(cursor_h=0.4, save_h=0.3, rows=[(300, 20, 1.0, True)], week_m=10),
    # The closed week still holds unaccrued cash rake (boundary 2 h ago,
    # rows 3 h old, cursor 4 h behind).
    'week-blocked': dict(cursor_h=4.0, save_h=0.1, rows=[(3, 180, 1.0, True)], week_m=120),
}


def seed(case):
    c = CASES[case]
    sql = ['TRUNCATE daemon_state, rake_records, fixture_week;',
           f"INSERT INTO fixture_week VALUES (now() - interval '{c['week_m']} minutes');",
           "INSERT INTO daemon_state VALUES ('rakeback_settler', "
           f"now() - interval '{c['cursor_h']} hours', '{uuid.UUID(int=1)}', now() - interval '{c['save_h']} hours');"]
    n = 0
    for count, minutes, amount, cash in c['rows']:
        for k in range(count):
            n += 1
            sql.append("INSERT INTO rake_records VALUES ("
                       f"'{uuid.UUID(int=(1 << 64) + n)}', now() - interval '{minutes} minutes' + interval '{k} milliseconds', "
                       f"{amount}, {'false' if cash else 'true'}, {'NULL' if cash else repr(str(uuid.UUID(int=7)))});")
    # One transaction, so every now() above is the same instant.
    run('BEGIN;\n' + '\n'.join(sql) + '\nCOMMIT;')


def verdict(case):
    seed(case)
    return json.loads(run('SELECT public.fn_settler_lag_check()'))


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Baseline: the exact production definition before this change.
    run((FIXTURES / 'fn_settler_lag_check.live-20261015.sql').read_text() + ';' + GRANTS)
    check('baseline-is-production-preimage',
          run("SELECT md5(pg_get_functiondef('public.fn_settler_lag_check()'::regprocedure))") == LIVE_DEF_MD5)
    base = {case: verdict(case) for case in CASES}
    results['baseline'] = {k: {f: v.get(f) for f in ('healthy', 'stalled', 'lag_hours', 'backlog_rows')} for k, v in base.items()}
    check('baseline-pages-an-idle-settler', base['idle-floor']['healthy'] is False, base['idle-floor'])
    check('baseline-calls-a-fresh-backlog-a-stall', base['fresh-after-quiet']['stalled'] is True, base['fresh-after-quiet'])
    check('baseline-counts-reversals-as-backlog',
          base['reversals-only']['stalled'] is True and base['reversals-only']['backlog_rows'] == 853, base['reversals-only'])

    # Candidate: the migration under test, applied as production would.
    migration = one('*_the_settler_lag_reads_what_the_settler_reads.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-carries-live-proof', '@live-proof:' in migration and POST_DEF_MD5 in migration)
    run(migration)
    check('candidate-reproduces-production-derived-postimage',
          run("SELECT md5(pg_get_functiondef('public.fn_settler_lag_check()'::regprocedure))") == POST_DEF_MD5)
    check('candidate-keeps-stable-definer',
          run("SELECT provolatile::text || prosecdef::text || array_to_string(proconfig, ',') FROM pg_proc "
              "WHERE oid = 'public.fn_settler_lag_check()'::regprocedure") == 'struesearch_path=public')
    got = {case: verdict(case) for case in CASES}
    results['candidate'] = {k: {f: v.get(f) for f in ('healthy', 'stalled', 'lag_hours', 'backlog_rows', 'cursor_age_hours',
                                                      'week_settlement_blocked')} for k, v in got.items()}
    g = got['idle-floor']
    check('idle-settler-is-healthy', g['healthy'] is True and g['stalled'] is False and g['lag_hours'] == 0
          and g['backlog_rows'] == 0 and g['cursor_age_hours'] > 27, g)
    g = got['fresh-after-quiet']
    check('fresh-backlog-after-quiet-is-not-a-stall', g['healthy'] is True and g['stalled'] is False
          and g['backlog_rows'] == 1545 and 0.15 <= g['lag_hours'] <= 0.25, g)
    g = got['reversals-only']
    check('reversals-are-not-backlog', g['healthy'] is True and g['backlog_rows'] == 0 and g['lag_hours'] == 0, g)
    g = got['true-stall']
    check('a-skipped-cycle-is-still-a-stall', g['healthy'] is False and g['stalled'] is True and g['backlog_rows'] == 40, g)
    g = got['hours-behind']
    check('hours-behind-is-unhealthy', g['healthy'] is False and g['lag_hours'] > 6, g)
    g = got['mid-cycle']
    check('mid-cycle-is-healthy', g['healthy'] is True and g['stalled'] is False and g['backlog_rows'] == 300, g)
    g = got['week-blocked']
    check('a-blocked-week-still-blocks', g['healthy'] is False and g['week_settlement_blocked'] is True
          and g['week_unaccrued_rows'] == 3, g)
    # The keyset tie: a row at the cursor instant with a larger id is waiting.
    run("BEGIN; TRUNCATE daemon_state, rake_records, fixture_week;"
        "INSERT INTO fixture_week VALUES (now());"
        f"INSERT INTO daemon_state VALUES ('rakeback_settler', now() - interval '2 hours', '{uuid.UUID(int=5)}', now() - interval '2 hours');"
        f"INSERT INTO rake_records VALUES ('{uuid.UUID(int=4)}', now() - interval '2 hours', 1, false, NULL),"
        f"('{uuid.UUID(int=9)}', now() - interval '2 hours', 1, false, NULL); COMMIT;")
    tie = json.loads(run('SELECT public.fn_settler_lag_check()'))
    check('a-tie-above-the-cursor-id-is-waiting', tie['backlog_rows'] == 1 and tie['stalled'] is True, tie)

    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT public.fn_settler_lag_check();',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-call', r.returncode != 0 and 'permission denied' in r.stderr)
    check('service-role-calls', run('SET ROLE service_role; SELECT public.fn_settler_lag_check() IS NOT NULL') == 't')
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage',
          run("SELECT md5(pg_get_functiondef('public.fn_settler_lag_check()'::regprocedure))") == POST_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
