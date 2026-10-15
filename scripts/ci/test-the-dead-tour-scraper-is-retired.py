"""Isolated PostgreSQL regression: the dead tour schedule scraper is retired.

Migration 20261015095255 records /cron/tour-schedule-scraper in
ca_retired_cron_jobs. The workers route reads its tours from
tour_schedule_sources and tour_schedule_registry, which have never held a row,
so every run scraped nothing and paged ScraperCritical; the companion World Hub
pull request removes it from the OpenClaw dispatcher. Without the registry row,
the job going quiet would page OpenClawJobsHaveGoneSilent instead: its p90 gap
is three days, so the live view calls it stale after six.

The test loads the exact production view captured 2026-10-15 (md5 equal to
the live one), seeds the scraper's real cadence (every third day, last run
seven days ago), proves the view would page it, applies the migration as
production would, and proves the job leaves the view while a healthy job and a
genuinely stopped job keep their verdicts. It also proves the migration
refuses a second run and refuses to retire a scraper that has a configuration
again. An empty throwaway cluster on a Unix socket; no network, no production
connection.
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
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'the-dead-tour-scraper-is-retired'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/the-dead-tour-scraper-is-retired')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/16/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='dead-tour-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55831'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

LIVE_VIEW_MD5 = '4d54670add83d48e690321edfa3396f9'
JOB = '/cron/tour-schedule-scraper'


def command(argv, sql=None):
    r = subprocess.run(list(map(str, argv)), input=sql, text=True, capture_output=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def attempt(sql):
    return subprocess.run(list(map(str, psql)), input=sql, text=True, capture_output=True, env=env, timeout=60)


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
CREATE TABLE public.cron_execution_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_name text NOT NULL,
  status text, started_at timestamptz, completed_at timestamptz, result jsonb, error text, duration_ms integer);
CREATE TABLE public.ca_retired_cron_jobs(job_name text PRIMARY KEY, retired_at timestamptz NOT NULL,
  reason text NOT NULL, replaced_by text);
CREATE TABLE public.tour_schedule_sources(id bigserial PRIMARY KEY, tour_name text NOT NULL UNIQUE,
  sources_config jsonb NOT NULL DEFAULT '{}', is_active boolean DEFAULT true, pdf_only boolean DEFAULT false,
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.tour_schedule_registry(id bigserial PRIMARY KEY, tour_name text NOT NULL UNIQUE,
  registry_data jsonb NOT NULL DEFAULT '{}', events_count int, last_scraped timestamptz,
  last_modified timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
"""


def seed():
    rows = []
    # The scraper: every third day at 04:00, last run seven days ago (as on
    # production once the dispatcher stops firing it).
    m = 29 * 1440
    while m >= 7 * 1440:
        rows.append(f"('{JOB}', 'success', now() - interval '{m} minutes')")
        m -= 3 * 1440
    # A healthy hourly job and a genuinely stopped hourly job.
    for job, stop in (('/cron/hourly-healthy', 30), ('/cron/hourly-stopped', 3 * 1440)):
        m = 29 * 1440
        while m >= stop:
            rows.append(f"('{job}', 'success', now() - interval '{m} minutes')")
            m -= 60
    run('INSERT INTO public.cron_execution_log(job_name, status, started_at) VALUES ' + ',\n'.join(rows) + ';')


def staleness():
    return {r.split('|')[0]: r.split('|')[1] in ('t', 'true')
            for r in run("SELECT job_name || '|' || is_stale FROM public.v_openclaw_job_staleness").splitlines() if r}


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
    check('baseline-view-is-production',
          run("SELECT md5(pg_get_viewdef('public.v_openclaw_job_staleness'::regclass, true))") == LIVE_VIEW_MD5)
    seed()
    before = staleness()
    results['baseline'] = before
    check('baseline-a-quiet-dead-scraper-would-page', before.get(JOB) is True, before)
    check('baseline-healthy-job-quiet', before.get('/cron/hourly-healthy') is False, before)
    check('baseline-stopped-job-pages', before.get('/cron/hourly-stopped') is True, before)

    migration = one('*_the_dead_tour_schedule_scraper_is_a_retired_cron_job.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-carries-a-live-proof', '-- @live-proof: (' in migration)
    run(migration)
    check('live-proof-holds', run('SELECT ' + re.search(r'-- @live-proof: (.*)', migration).group(1)) == 't')

    after = staleness()
    results['candidate'] = after
    check('retired-scraper-leaves-the-view', JOB not in after, after)
    check('healthy-job-still-quiet', after.get('/cron/hourly-healthy') is False, after)
    check('stopped-job-still-pages', after.get('/cron/hourly-stopped') is True, after)

    replay = attempt(migration)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'already registered' in replay.stderr, replay.stderr[-300:])

    run(f"DELETE FROM public.ca_retired_cron_jobs WHERE job_name = '{JOB}';"
        "INSERT INTO public.tour_schedule_sources(tour_name, sources_config) VALUES ('WSOP', '{}');")
    configured = attempt(migration)
    check('migration-refuses-to-retire-a-configured-scraper',
          configured.returncode != 0 and 'holds rows' in configured.stderr, configured.stderr[-300:])
    check('refused-run-wrote-nothing',
          run(f"SELECT count(*) FROM public.ca_retired_cron_jobs WHERE job_name = '{JOB}'") == '0')
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
