"""Isolated PostgreSQL regression: the money check board reads the cron runs.

Migration 20261015101106 fixes fn_money_check_health, which read only
money_check_heartbeat, a table nothing writes (fn_record_money_check_run has
no caller), so it reported every money check as "never run" while pg_cron ran
each of them every hour and raised seven false criticals on 2026-10-15.

The test loads the exact production function captured 2026-10-15 (md5 equal
to the live one), seeds the production registry and a cron history with the
real job commands, proves the board calls every check never run, applies the
migration as production would, and proves it now reports only a check whose
job is failing, still reports a check whose job is deactivated, keeps owner,
security, settings and grants, reproduces the derived postimage md5, and
refuses a second run. An empty throwaway cluster on a Unix socket; no
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

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'money-check-health-reads-cron'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/money-check-health-reads-cron')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/16/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='money-board-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55833'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

LIVE_MD5 = '5fccb514423f4867faaf3b09408f470b'
POST_MD5 = '7bcc8d063db2746334c5c7a617015fe9'
SIG = 'public.fn_money_check_health(numeric)'


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
CREATE ROLE service_role;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE TABLE cron.job_run_details(runid bigserial PRIMARY KEY, jobid bigint, status text,
  start_time timestamptz, end_time timestamptz, return_message text);
CREATE TABLE public.money_check_heartbeat(check_name text PRIMARY KEY, expected_interval_minutes integer NOT NULL,
  last_run_at timestamptz, last_result jsonb, run_count bigint NOT NULL DEFAULT 0,
  registered_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TABLE public.raised(severity text, source text, message text, context jsonb, entity text);
CREATE FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text,
  p_context jsonb, p_entity text DEFAULT NULL, p_extra text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.raised VALUES (p_severity, p_source, p_message, p_context, p_entity); SELECT NULL::uuid $$;
INSERT INTO public.money_check_heartbeat(check_name, expected_interval_minutes, note) VALUES
  ('fn_backpay_unfinalised_bounty_pools', 60, 'settles a funded bounty pool a completed event never paid out'),
  ('fn_cash_pot_conservation_check', 60, 'pot = rake + bbj + awarded, on every completed cash hand'),
  ('fn_detect_results_without_a_hand', 360, 'a result no poker produced'),
  ('fn_pay_backed_payout_shortfalls', 60, 'pays what an event still owes when the event is holding the chips'),
  ('fn_payout_guarantee_check', 60, 'vacant paid places, unpaid earners, retained bounty pools, unrecorded payouts'),
  ('fn_tournament_money_conservation', 360, 'per-event money in against money out'),
  ('fn_uncollected_entry_check', 60, 'Phase 2. Seats in paid events with no entry paid for them.');
"""

# (jobname, schedule, command, [(status, minutes_ago), ...]) - commands as on production.
JOBS = [
    ('ca-payout-guarantee-check-hourly', '18 * * * *',
     "SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-payout-guarantee-check')) THEN (SELECT count(*) FROM public.fn_payout_guarantee_check()) ELSE -1 END;",
     [('succeeded', m) for m in (30, 90, 150)]),
    ('ca-pay-backed-payout-shortfalls-hourly', '26 * * * *',
     "SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-pay-backed-payout-shortfalls')) THEN (public.fn_pay_backed_payout_shortfalls())::text ELSE 'locked' END;",
     [('succeeded', m) for m in (40, 100)]),
    ('ca-uncollected-entry-check-hourly', '47 * * * *', ' SELECT public.fn_uncollected_entry_check(60); ',
     [('succeeded', 900)] + [('failed', m) for m in (20, 80, 140, 200, 260)]),
    ('tourney_money_conservation_hourly', '12 * * * *',
     "select case when pg_try_advisory_lock(hashtext('tourney-money-conservation-hourly')) then (public.fn_tournament_money_conservation(2)) is not null else false end;",
     [('succeeded', m) for m in (55, 115)]),
    ('ca-cash-pot-conservation-hourly', '34 */6 * * *',
     "SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-cash-pot-conservation')) THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check(8)) ELSE -1 END;",
     [('succeeded', m) for m in (215, 575)]),
    ('ca-results-without-a-hand-6h', '46 */6 * * *',
     "SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-results-without-a-hand')) THEN (SELECT count(*)::int FROM public.fn_detect_results_without_a_hand(1)) ELSE -1 END;",
     [('succeeded', m) for m in (560, 920)]),
]


def seed():
    for name, schedule, cmd, runs in JOBS:
        jid = run("INSERT INTO cron.job(jobname, schedule, command) VALUES ("
                  + ", ".join("'" + v.replace("'", "''") + "'" for v in (name, schedule, cmd)) + ") RETURNING jobid")
        for status, m in runs:
            run(f"INSERT INTO cron.job_run_details(jobid, status, start_time, end_time) VALUES ({jid}, '{status}', "
                f"now() - interval '{m} minutes', now() - interval '{m} minutes' + interval '5 seconds')")


def board():
    run('TRUNCATE public.raised')
    b = json.loads(run(f'SELECT {SIG.split("(")[0]}(3)::text'))
    raised = run("SELECT coalesce(string_agg(entity, ',' ORDER BY entity), '') FROM public.raised")
    return {r['check']: r['stale'] for r in b['board']}, [x for x in raised.split(',') if x], b


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run((FIXTURES / 'fn_money_check_health.live-20261015.sql').read_text()
        + f';\nREVOKE ALL ON FUNCTION {SIG} FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION {SIG} TO service_role;')
    check('baseline-is-production-preimage', run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == LIVE_MD5)
    seed()
    before, before_raised, _ = board()
    results['baseline'] = {'stale': before, 'raised': before_raised}
    check('baseline-calls-every-scheduled-check-never-run', all(before.values()) and len(before) == 7, before)
    check('baseline-raises-seven-false-criticals', len(before_raised) == 7, before_raised)

    migration = one('*_the_money_check_board_reads_the_cron_runs_that_drive_each_ch.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-carries-a-live-proof', '-- @live-proof: (' in migration)
    authority = "SELECT p.proacl::text || '|' || pg_get_userbyid(p.proowner) || '|' || p.prosecdef || '|' || p.proconfig::text FROM pg_proc p WHERE p.oid = '" + SIG + "'::regprocedure"
    before_authority = run(authority)
    run(migration)
    check('postimage-md5-is-the-derived-one', run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == POST_MD5)
    check('owner-security-settings-grants-unchanged', run(authority) == before_authority)
    check('live-proof-holds', run('SELECT ' + re.search(r'-- @live-proof: (.*)', migration).group(1)) == 't')

    after, after_raised, full = board()
    results['candidate'] = {'stale': after, 'raised': after_raised}
    check('retired-repair-job-leaves-the-board', 'fn_backpay_unfinalised_bounty_pools' not in after, after)
    for name in ('fn_payout_guarantee_check', 'fn_pay_backed_payout_shortfalls', 'fn_tournament_money_conservation',
                 'fn_cash_pot_conservation_check', 'fn_detect_results_without_a_hand'):
        check(f'{name}-runs-on-cron-and-is-not-stale', after.get(name) is False, after)
    check('a-failing-job-is-still-stale', after.get('fn_uncollected_entry_check') is True, after)
    check('only-the-failing-check-raises', after_raised == ['fn_uncollected_entry_check'], after_raised)
    runs = {r['check']: r['runs'] for r in full['board']}
    check('run-count-counts-the-cron-runs', runs.get('fn_payout_guarantee_check') == 3, runs)

    run("UPDATE cron.job SET active = false WHERE jobname = 'ca-payout-guarantee-check-hourly'")
    deactivated, _, _ = board()
    check('a-deactivated-job-is-stale', deactivated.get('fn_payout_guarantee_check') is True, deactivated)

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
