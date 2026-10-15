"""Isolated PostgreSQL regression for the Open Claw silence and no-op readers.

Migration 20261015035957 fixes three defects behind OpenClawFleetLongSilence,
OpenClawJobsHaveGoneSilent and CronJobsReportingSuccessWhileDoingNothing:

  * v_openclaw_job_staleness only judged jobs with >= 5 successes in 30 days,
    so a job that keeps failing decays out of judgement (pokernews-videos:
    3 successes, silent 15 days, not stale), and its universe was "had a
    success in 30 days", so a job with none vanished while still being fired
    (video-library-scraper: 21 runs, 0 successes);
  * fn_monitoring_health_snapshot's no-op count read each job's latest
    SUCCESS, so a job failing ever since stayed counted on its last skipped
    success, and it had no notion of a deliberate owner hold;
  * two names that are not live jobs were never registered.

The test loads the exact production view and snapshot captured 2026-10-15,
proves the blind spots on a seeded log, applies the migration as production
would, and proves each case flips (and nothing healthy starts paging), the
derived snapshot postimage md5, unchanged columns and grants, and a refused
second run. An empty throwaway cluster on a Unix socket; no network, no
production connection.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'a-silent-job-cannot-hide'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/a-silent-job-cannot-hide')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='silent-job-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

LIVE_VIEW_MD5 = '085765e6587d63b90b2ae18f1ae65316'
LIVE_SNAPSHOT_MD5 = '35b5a40a7aee5d616dff26d695fe8497'
POST_SNAPSHOT_MD5 = '353ff5fc64d427d2ffd46582699c6300'


def command(argv, sql=None):
    r = subprocess.run(list(map(str, argv)), input=sql, text=True, capture_output=True, env=env, timeout=120)
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


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA cron;
CREATE TABLE cron.job_run_details(runid bigserial, status text, start_time timestamptz);
CREATE TABLE public.cron_execution_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_name text, status text,
  started_at timestamptz, completed_at timestamptz, duration_ms integer, error text, result jsonb);
CREATE INDEX idx_cron_execution_log_job_started ON public.cron_execution_log (job_name, started_at DESC);
CREATE TABLE public.ca_retired_cron_jobs(job_name text PRIMARY KEY, retired_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL, replaced_by text);
CREATE TABLE public.financial_alerts(id bigserial, resolved boolean, severity text, created_at timestamptz, source text);
CREATE FUNCTION public.fn_settlement_health(p_window integer)
RETURNS TABLE(window_minutes integer, settled bigint, failed bigint, stuck bigint, failure_rate numeric)
LANGUAGE sql AS $$ SELECT p_window, 0::bigint, 0::bigint, 0::bigint, 0::numeric $$;
CREATE FUNCTION public.fn_undeclared_money_triggers() RETURNS TABLE(name text) LANGUAGE sql AS $$ SELECT NULL::text WHERE false $$;
INSERT INTO public.ca_retired_cron_jobs(job_name, reason) VALUES ('/cron/retired-long-ago', 'fixture');
"""

GRANTS = """
REVOKE ALL ON FUNCTION public.fn_monitoring_health_snapshot(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_monitoring_health_snapshot(integer) TO service_role;
GRANT ALL ON public.v_openclaw_job_staleness TO service_role;
GRANT SELECT, REFERENCES, TRIGGER ON public.v_openclaw_job_staleness TO anon, authenticated;
"""

# Each job's log, relative to now(): (job, status, minutes_ago, result json or None)
LOG = []


def every(job, status, start_min, stop_min, step_min, result=None):
    m = start_min
    while m >= stop_min:
        LOG.append((job, status, m, result))
        m -= step_min


# A: hourly, healthy.
every('/cron/hourly-healthy', 'success', 30 * 1440 - 60, 30, 60, {'success': True})
# B: hourly, stopped three days ago (the cadence rule already sees it).
every('/cron/hourly-stopped', 'success', 30 * 1440 - 60, 3 * 1440, 60, {'success': True})
# C: pokernews shape: 3 successes, then 3-hourly 500s for 15 days.
for d in (17, 16, 15):
    LOG.append(('/cron/sparse-failing', 'success', d * 1440, {'success': True}))
every('/cron/sparse-failing', 'error', 15 * 1440 - 180, 30, 180, {'success': False})
# D: video-library-scraper shape: success 46 days ago, failing daily for 30.
LOG.append(('/cron/never-succeeds-in-window', 'success', 46 * 1440, {'exit_code': 0}))
every('/cron/never-succeeds-in-window', 'error', 29 * 1440, 60, 1440, {'exit_code': 1})
# E: weekly, healthy.
every('/cron/weekly-healthy', 'success', 24 * 1440, 3 * 1440, 7 * 1440, {'success': True})
# F: fired once, eleven days ago, never again (a flag-gated schedule left off).
LOG.append(('/cron/fired-once', 'error', 11 * 1440, {'error': 'x'}))
# G: the dispatcher's auth probe: a 404 every minute, by design.
every('/cron/__auth_probe_no_such_route__', 'error', 20 * 1440, 1, 120, None)
# H: retired job still in the log.
every('/cron/retired-long-ago', 'error', 20 * 1440, 1, 360, None)
# I: a new job failing for two days.
every('/cron/new-and-failing', 'error', 2 * 1440, 60, 360, {'success': False})
# J: last success was a skip, failing ever since.
LOG.append(('/cron/skip-then-failing', 'success', 15 * 1440, {'skipped': 'engine_disabled', 'success': True}))
every('/cron/skip-then-failing', 'error', 15 * 1440 - 180, 30, 180, {'success': False})
# K: digest shape: the latest run is a success with a string skip.
LOG.append(('/cron/weekly-unconfigured', 'success', 3 * 1440, {'ok': True, 'skipped': 'recipient_unset'}))
# L: an owner hold reported as held (with a legacy skipped beside it).
every('/cron/owner-held', 'success', 3 * 1440, 5, 60, {'ok': True, 'held': 'mode_disabled', 'skipped': 'mode_disabled'})
# M: a kill switch left off: the class the no-op alert exists for.
every('/cron/kill-switch-off', 'success', 3 * 1440, 5, 60, {'success': True, 'skipped': 'engine_disabled'})
# N: a numeric skip is a count, not a reason.
every('/cron/numeric-skip', 'success', 3 * 1440, 5, 60, {'success': True, 'skipped': 4})
# O: a running row never counts as a finished run.
LOG.append(('/cron/hourly-healthy', 'running', 1, None))


def seed():
    rows = []
    for job, status, minutes, result in LOG:
        res = 'NULL' if result is None else "'" + json.dumps(result).replace("'", "''") + "'::jsonb"
        rows.append(f"('{job}', '{status}', now() - interval '{minutes} minutes', {res})")
    run('TRUNCATE public.cron_execution_log; INSERT INTO public.cron_execution_log(job_name, status, started_at, result) VALUES '
        + ',\n'.join(rows) + ';')


def staleness():
    return {r.split('|')[0]: {'n': int(r.split('|')[1]), 'silent': float(r.split('|')[2]), 'stale': r.split('|')[3] in ('t', 'true')}
            for r in run('SELECT job_name || \'|\' || successes_30d || \'|\' || silent_minutes || \'|\' || is_stale '
                         'FROM public.v_openclaw_job_staleness').splitlines() if r}


def snapshot():
    row = run('SELECT cron_openclaw_stale || \'|\' || cron_openclaw_worst_silence_minutes || \'|\' || cron_jobs_skipping_all_work '
              'FROM public.fn_monitoring_health_snapshot(5)').split('|')
    return {'stale': int(row[0]), 'worst': float(row[1]), 'noop': int(row[2])}


NOOP_SQL = None  # filled from the live snapshot: the noop CTE chain alone, by job


def noop_jobs():
    return set(filter(None, run(NOOP_SQL).splitlines()))


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run((FIXTURES / 'v_openclaw_job_staleness.live-20261015.sql').read_text())
    run((FIXTURES / 'fn_monitoring_health_snapshot.live-20261015.sql').read_text() + ';' + GRANTS)
    check('baseline-view-is-production-preimage',
          run("SELECT md5(pg_get_viewdef('public.v_openclaw_job_staleness'::regclass, true))") == LIVE_VIEW_MD5)
    check('baseline-snapshot-is-production-preimage',
          run("SELECT md5(pg_get_functiondef('public.fn_monitoring_health_snapshot(integer)'::regprocedure))") == LIVE_SNAPSHOT_MD5)

    def noop_query():
        d = run("SELECT pg_get_functiondef('public.fn_monitoring_health_snapshot(integer)'::regprocedure)")
        m = re.search(r'(runs AS MATERIALIZED \(.*?\n  \), noop AS \()', d, re.S)
        chain = 'WITH ' + m.group(1)[:-len(', noop AS (')]
        where = re.search(r'noop AS \(\n    SELECT count\(\*\) AS n\n(.*?)\n  \)\n  SELECT', d, re.S).group(1)
        return chain + '\n SELECT l.job_name\n' + where
    seed()
    NOOP_SQL = noop_query()
    before = staleness()
    before_noop = noop_jobs()
    results['baseline'] = {'stale': sorted(k for k, v in before.items() if v['stale']), 'noop': sorted(before_noop)}
    check('baseline-sparse-failing-job-reads-not-stale', before['/cron/sparse-failing']['stale'] is False, before.get('/cron/sparse-failing'))
    check('baseline-zero-success-job-is-invisible', '/cron/never-succeeds-in-window' not in before)
    check('baseline-counts-a-failing-job-on-its-last-skip', '/cron/skip-then-failing' in before_noop, before_noop)
    check('baseline-counts-an-owner-hold', '/cron/owner-held' in before_noop, before_noop)

    candidate = one('*_a_failing_or_dispatched_job_cannot_hide_from_the_silence_ale.sql')
    migration = candidate.read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-carries-a-live-proof', '-- @live-proof: (' in migration)
    acl_before = run("SELECT relacl::text || '|' || reloptions::text FROM pg_class WHERE oid = 'public.v_openclaw_job_staleness'::regclass")
    run(migration)
    check('candidate-reproduces-production-derived-snapshot-postimage',
          run("SELECT md5(pg_get_functiondef('public.fn_monitoring_health_snapshot(integer)'::regprocedure))") == POST_SNAPSHOT_MD5)
    check('view-keeps-its-grants-and-security-invoker',
          run("SELECT relacl::text || '|' || reloptions::text FROM pg_class WHERE oid = 'public.v_openclaw_job_staleness'::regclass") == acl_before)
    check('live-proof-holds', run('SELECT ' + re.search(r'-- @live-proof: (.*)', migration).group(1)) == 't')

    NOOP_SQL = noop_query()
    after = staleness()
    after_noop = noop_jobs()
    results['candidate'] = {'stale': sorted(k for k, v in after.items() if v['stale']), 'noop': sorted(after_noop),
                            'snapshot': snapshot()}
    check('healthy-hourly-not-stale', after['/cron/hourly-healthy']['stale'] is False, after['/cron/hourly-healthy'])
    check('stopped-hourly-still-stale', after['/cron/hourly-stopped']['stale'] is True, after['/cron/hourly-stopped'])
    check('sparse-failing-job-is-stale', after['/cron/sparse-failing']['stale'] is True, after['/cron/sparse-failing'])
    z = after.get('/cron/never-succeeds-in-window')
    check('zero-success-job-is-visible-and-stale', z is not None and z['stale'] and z['n'] == 0 and z['silent'] > 45 * 1440, z)
    check('healthy-weekly-not-stale', after['/cron/weekly-healthy']['stale'] is False, after['/cron/weekly-healthy'])
    check('fired-once-not-stale', after['/cron/fired-once']['stale'] is False, after['/cron/fired-once'])
    check('new-failing-job-not-yet-stale', after['/cron/new-and-failing']['stale'] is False, after['/cron/new-and-failing'])
    check('auth-probe-is-not-a-job', '/cron/__auth_probe_no_such_route__' not in after)
    check('retired-job-stays-excluded', '/cron/retired-long-ago' not in after)
    check('columns-unchanged',
          run("SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) FROM pg_attribute "
              "WHERE attrelid = 'public.v_openclaw_job_staleness'::regclass AND attnum > 0")
          == 'job_name:text,last_success_at:timestamp with time zone,successes_30d:bigint,silent_minutes:numeric,'
             'p90_gap_minutes:numeric,threshold_minutes:numeric,is_stale:boolean')
    check('noop-no-longer-counts-a-failing-job', '/cron/skip-then-failing' not in after_noop, after_noop)
    check('noop-no-longer-counts-an-owner-hold', '/cron/owner-held' not in after_noop, after_noop)
    check('noop-still-counts-a-kill-switch-left-off', '/cron/kill-switch-off' in after_noop, after_noop)
    check('noop-still-counts-an-unconfigured-success', '/cron/weekly-unconfigured' in after_noop, after_noop)
    check('noop-ignores-a-numeric-skip', '/cron/numeric-skip' not in after_noop, after_noop)
    snap = results['candidate']['snapshot']
    check('snapshot-reports-the-view', snap['stale'] == len(results['candidate']['stale'])
          and snap['noop'] == len(after_noop), snap)

    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned preimage' in replay.stderr, replay.stderr[-300:])
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
