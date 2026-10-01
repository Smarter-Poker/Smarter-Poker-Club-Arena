#!/usr/bin/env python3
"""fn_ca_cron_failure_watch sees a failing hourly job, on native PostgreSQL.

Installs the production body (md5-pinned), shows that it raises nothing for an
hourly job that failed 23 of 24 runs (the 2026-09-27 conservation-sweep
outage), then applies the migration and proves the new rule raises exactly the
jobs that are failing and none of the healthy or briefly-failing ones.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/conservation-sweep-read-indexes/cron-failure-watch-installed.sql'
MIGRATION = ROOT / 'supabase/migrations/20261001152926_a_failing_hourly_cron_reaches_the_board.sql'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
cluster = Path(tempfile.mkdtemp(prefix='cron-watch-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='cron-watch-s-', dir=os.environ.get('SOCKET_TMPDIR', '/tmp')))
data = cluster / 'data'
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False

BOOT = r"""
SET client_min_messages = warning;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean NOT NULL DEFAULT true);
CREATE TABLE cron.job_run_details (runid bigserial PRIMARY KEY, jobid bigint, status text, return_message text,
  start_time timestamptz, end_time timestamptz);
CREATE TABLE public.ca_guard_inventory (kind text, object_a text, active boolean);
CREATE TABLE public.raised (source text, severity text, dedup_key text, detail text, context jsonb);
CREATE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_kind text, p_severity text, p_key text,
  a5 numeric, a6 numeric, a7 numeric, a8 text, a9 text, a10 text, a11 text, a12 text, a13 text, a14 text,
  a15 text, a16 text, a17 text, a18 text, p_detail text, a20 jsonb, p_context jsonb)
RETURNS void LANGUAGE sql AS
$$ INSERT INTO public.raised VALUES (p_source, p_severity, p_key, p_detail, p_context) $$;

INSERT INTO cron.job VALUES
  (233, 'ca-conservation-sweep-hourly', '52 * * * *', 'SELECT public.fn_ca_conservation_sweep();', true),
  (300, 'healthy-hourly', '10 * * * *', 'select 1', true),
  (301, 'flapping-30m', '15,45 * * * *', 'select 1', true),
  (302, 'minute-blip', '* * * * *', 'select 1', true),
  (303, 'minute-dead', '* * * * *', 'select 1', true),
  (304, 'inactive-hourly', '5 * * * *', 'select 1', false),
  (305, 'guard-hourly', '25 * * * *', 'select 1', true);
INSERT INTO public.ca_guard_inventory VALUES ('cron', 'guard-hourly', true);

-- the sweep: 23 of 24 hourly runs cancelled, one success 5 hours ago
INSERT INTO cron.job_run_details (jobid, status, return_message, start_time)
SELECT 233, CASE WHEN h = 5 THEN 'succeeded' ELSE 'failed' END,
       CASE WHEN h = 5 THEN '1 row' ELSE 'ERROR:  canceling statement due to statement timeout' END,
       now() - h * interval '1 hour' - interval '8 minutes'
  FROM generate_series(0, 23) h;
-- healthy hourly job with one failure
INSERT INTO cron.job_run_details (jobid, status, start_time)
SELECT 300, CASE WHEN h = 7 THEN 'failed' ELSE 'succeeded' END, now() - h * interval '1 hour' - interval '5 minutes'
  FROM generate_series(0, 23) h;
-- 30-minute job failing 26 of 48 runs, the latest succeeded
INSERT INTO cron.job_run_details (jobid, status, start_time)
SELECT 301, CASE WHEN h % 2 = 0 OR h > 44 THEN 'failed' ELSE 'succeeded' END, now() - h * interval '30 minutes' - interval '1 minute'
  FROM generate_series(1, 48) h;
-- per-minute job: three straight failures just now, succeeded 4 minutes ago
INSERT INTO cron.job_run_details (jobid, status, start_time)
SELECT 302, CASE WHEN m <= 3 THEN 'failed' ELSE 'succeeded' END, now() - m * interval '1 minute'
  FROM generate_series(1, 600) m;
-- per-minute job: failing for three hours straight (the old rule's case)
INSERT INTO cron.job_run_details (jobid, status, start_time)
SELECT 303, CASE WHEN m <= 180 THEN 'failed' ELSE 'succeeded' END, now() - m * interval '1 minute'
  FROM generate_series(1, 600) m;
-- inactive job failing: never reported
INSERT INTO cron.job_run_details (jobid, status, start_time)
SELECT 304, 'failed', now() - h * interval '1 hour' FROM generate_series(1, 24) h;
-- an inventoried guard whose last three hourly runs failed
INSERT INTO cron.job_run_details (jobid, status, start_time)
SELECT 305, CASE WHEN h <= 3 THEN 'failed' ELSE 'succeeded' END, now() - h * interval '1 hour'
  FROM generate_series(1, 24) h;
"""


# The watch's own driving query, read from the migration, for EXPLAIN.
_m = MIGRATION.read_text()
WATCH_QUERY = _m[_m.index('    WITH runs AS ('):_m.index('     ORDER BY day.fails DESC, day.jobname')]


def run(args, sql=None, error=None):
    p = subprocess.run([str(a) for a in args], input=sql, text=True, capture_output=True, env=env, timeout=120)
    if error:
        assert p.returncode and error in p.stderr, (p.stdout, p.stderr)
        print('PASS: refused ' + error, flush=True)
        return ''
    if p.returncode:
        raise RuntimeError(p.stdout + p.stderr)
    return p.stdout.strip()


def q(sql, error=None):
    return run([PG/'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', 'postgres', '-d', 'postgres'], sql, error)


def raised():
    return q("TRUNCATE public.raised; SELECT public.fn_ca_cron_failure_watch(); "
             "SELECT string_agg(context->>'jobname' || '=' || severity, ',' ORDER BY context->>'jobname') FROM public.raised").split('\n')[-2:]


try:
    run([PG/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nautovacuum=off\n")
    started = True
    run([PG/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    q(BOOT)
    installed = FIXTURE.read_text()
    assert hashlib.md5(installed.encode()).hexdigest() == 'b07401212a118bc574611691e7bd152c'
    q(installed)
    q('REVOKE ALL ON FUNCTION public.fn_ca_cron_failure_watch() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_ca_cron_failure_watch() TO service_role;')
    assert q("SELECT md5(pg_get_functiondef('public.fn_ca_cron_failure_watch()'::regprocedure))") == 'b07401212a118bc574611691e7bd152c'

    # THE DEFECT: the installed rule sees only the per-minute job.
    before = raised()
    assert before == ['1', 'minute-dead=warning'], before

    acl = q("SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_cron_failure_watch()'::regprocedure")
    q(MIGRATION.read_text())
    after = raised()
    assert after == ['4', 'ca-conservation-sweep-hourly=warning,flapping-30m=warning,guard-hourly=critical,minute-dead=warning'], after
    assert q("SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_cron_failure_watch()'::regprocedure") == acl
    detail = q("SELECT detail FROM public.raised WHERE context->>'jobname' = 'ca-conservation-sweep-hourly'")
    assert 'failed 23 of 24 runs in 24h' in detail and 'statement timeout' in detail, detail
    assert q("SELECT dedup_key LIKE 'cron-failing:ca-conservation-sweep-hourly:%' FROM public.raised WHERE context->>'jobname' = 'ca-conservation-sweep-hourly'") == 't'

    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_ca_cron_failure_watch()'::regprocedure") == '81d2ad79b81b1f30c3d85b333396b5aa'

    # One bounded pass: the plan reads cron.job_run_details exactly once, and
    # only through a start_time filter, however many jobs are active.
    q("INSERT INTO cron.job SELECT g, 'bulk-' || g, '0 * * * *', 'select 1', true FROM generate_series(1000, 1100) g")
    plan = q("EXPLAIN (COSTS OFF) " + WATCH_QUERY)
    assert plan.count('job_run_details') == 1, plan
    assert "start_time > (now() - '7 days'::interval)" in plan, plan
    q("DELETE FROM cron.job WHERE jobid BETWEEN 1000 AND 1100")
    print('PASS: one bounded scan of job_run_details', flush=True)

    # A daily job whose last three runs failed is reported even though only one
    # of them is inside 24 hours; one older than 7 days is outside the window.
    q("INSERT INTO cron.job VALUES (306, 'daily-dead', '0 3 * * *', 'select 1', true);"
      "INSERT INTO cron.job_run_details (jobid, status, start_time) SELECT 306, 'failed', now() - d * interval '1 day' + interval '1 hour' FROM generate_series(1, 3) d;"
      "INSERT INTO cron.job_run_details (jobid, status, start_time) SELECT 306, 'succeeded', now() - d * interval '1 day' + interval '1 hour' FROM generate_series(4, 9) d;")
    daily = raised()
    assert daily == ['5', 'ca-conservation-sweep-hourly=warning,daily-dead=warning,flapping-30m=warning,guard-hourly=critical,minute-dead=warning'], daily
    q("DELETE FROM cron.job_run_details WHERE jobid = 306; DELETE FROM cron.job WHERE jobid = 306")

    # Re-applying refuses: the pre-image guard names the body it replaces.
    q(MIGRATION.read_text(), 'CRON_FAILURE_WATCH_PREIMAGE_CHANGED')
    print('PASS: before ' + before[1] + ' | after ' + after[1], flush=True)
finally:
    if started and (data/'postmaster.pid').exists():
        run([PG/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    shutil.rmtree(socket, ignore_errors=True)
