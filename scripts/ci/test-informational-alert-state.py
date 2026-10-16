"""Isolated PostgreSQL regression: an informational alert is recorded informational.

fn_record_operational_alert() let every row default to investigation_status
'new', including the rows its writers mark status 'info' AND severity 'info'
(the hourly "Accounting Documents Issued (Owner Copy)" summary and the
per-release receipts of a Post-Deploy episode), and the store had no state for
a record that is not an incident. Migration 20261015183650 adds the
'informational' state and has the writer use it.

The test loads the exact production writer captured on 2026-10-15 (its
pg_get_functiondef md5 equals production's) and the store's CHECK as
production prints it, proves an info/info row lands 'new', then applies the
candidate migration and proves:
  * an info/info row lands 'informational'; firing, resolved and info rows
    with any other severity still land 'new';
  * a repeat delivery bumps the receipt and leaves the state alone;
  * the batch writer follows the single writer;
  * only the info/info rows already recorded 'new' are reclassified;
  * the store admits 'informational' and still refuses an unknown state;
  * the candidate reproduces production's derived postimage md5, keeps owner,
    SECURITY DEFINER, settings and grants, and refuses a second run.
An empty throwaway cluster on a Unix socket; no network, no production
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
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'informational-alert-state'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/informational-alert-state')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='informational-alert-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production writer read on 2026-10-15, before
# and after the candidate (derived read-only on production with replace()).
LIVE_WRITER_DEF_MD5 = '4bab2581b3dff1e09b22d0df46c68df8'
POST_WRITER_DEF_MD5 = '42d7a1af30b4f8e83c40ad9dd21de11c'
LIVE_BATCH_DEF_MD5 = '1ed60e92c3f7741793dd435bedb9538a'
WRITER = 'public.fn_record_operational_alert(text,text,text,text,text,jsonb)'
# Production's grants on both writers (read 2026-10-15: postgres and service_role).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_record_operational_alerts(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alerts(jsonb) TO service_role;
'''
# The store's columns and the constraints this change touches, as production
# prints them (pg_get_constraintdef read 2026-10-15).
SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.operational_alert_events(
  id bigserial PRIMARY KEY,
  source text NOT NULL, event_key text NOT NULL, alertname text NOT NULL,
  status text NOT NULL, severity text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(), last_received_at timestamptz NOT NULL DEFAULT now(),
  delivery_count bigint NOT NULL DEFAULT 1, investigation_status text NOT NULL DEFAULT 'new'::text,
  investigation jsonb NOT NULL DEFAULT '{}'::jsonb, investigation_touched_at timestamptz,
  CONSTRAINT operational_alert_events_source_event_key_key UNIQUE (source, event_key),
  CONSTRAINT operational_alert_events_status_check CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text, 'info'::text]))),
  CONSTRAINT operational_alert_events_investigation_status_check CHECK ((investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text, 'verified_fixed'::text, 'historical'::text, 'test'::text])))
);
CREATE FUNCTION public.fn_operational_alert_investigation_touched() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public' AS $f$
BEGIN
  NEW.investigation_touched_at := clock_timestamp();
  RETURN NEW;
END;
$f$;
CREATE TRIGGER a_operational_alert_investigation_touched BEFORE UPDATE OF investigation, investigation_status
  ON public.operational_alert_events FOR EACH ROW
  WHEN (((old.investigation IS DISTINCT FROM new.investigation) OR (old.investigation_status IS DISTINCT FROM new.investigation_status)))
  EXECUTE FUNCTION public.fn_operational_alert_investigation_touched();
"""
PINNED_CHECK = ("CHECK ((investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text, "
                "'verified_fixed'::text, 'historical'::text, 'test'::text])))")


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


def record(key, status, severity, source='src'):
    return run(f"SELECT public.fn_record_operational_alert('{source}', '{key}', 'Name', '{status}', '{severity}', "
               "'{\"target_task_id\": \"01a09b86-5ba8-7290-8657-1041f13dd3ca\"}'::jsonb)")


def state(key, source='src'):
    return run(f"SELECT investigation_status || ':' || delivery_count FROM public.operational_alert_events "
               f"WHERE source = '{source}' AND event_key = '{key}'")


def writer_md5():
    return run(f"SELECT md5(pg_get_functiondef('{WRITER}'::regprocedure))")


def privileges():
    return run(f"SELECT proacl::text || pg_get_userbyid(proowner) || prosecdef::text || coalesce(proconfig::text, '') "
               f"FROM pg_proc WHERE oid = '{WRITER}'::regprocedure")


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    check('store-check-prints-as-production', run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'operational_alert_events_investigation_status_check'") == PINNED_CHECK)

    # -- Baseline: the exact production writers before this change ----------
    run((FIXTURES / 'fn_record_operational_alert.live-20261015.sql').read_text() + ';'
        + (FIXTURES / 'fn_record_operational_alerts.live-20261015.sql').read_text() + ';' + GRANTS)
    check('baseline-writer-is-production-preimage', writer_md5() == LIVE_WRITER_DEF_MD5)
    check('baseline-batch-is-production-preimage',
          run("SELECT md5(pg_get_functiondef('public.fn_record_operational_alerts(jsonb)'::regprocedure))") == LIVE_BATCH_DEF_MD5)
    record('owner-accounting:2026-10-15T16', 'info', 'info', 'owner-accounting-notifications')
    record('episode:failed-release:abc', 'info', 'info', 'club-arena.post-deploy-e2e')
    record('old-firing', 'firing', 'warning')
    record('old-info-warning', 'info', 'warning')
    record('old-info-closed', 'info', 'info')
    run("UPDATE public.operational_alert_events SET investigation_status = 'historical' WHERE event_key = 'old-info-closed'")
    results['baseline'] = {k: state(k, s) for k, s in (
        ('owner-accounting:2026-10-15T16', 'owner-accounting-notifications'),
        ('episode:failed-release:abc', 'club-arena.post-deploy-e2e'), ('old-firing', 'src'))}
    check('baseline-records-an-informational-summary-as-new',
          state('owner-accounting:2026-10-15T16', 'owner-accounting-notifications') == 'new:1', results['baseline'])

    # -- Candidate: the migration under test, applied as production would ----
    migration = one('*_an_informational_alert_is_recorded_informational.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-live-proof-names-the-postimage', f"= '{POST_WRITER_DEF_MD5}'" in migration)
    before = privileges()
    run(migration)
    check('candidate-reproduces-production-derived-postimage', writer_md5() == POST_WRITER_DEF_MD5)
    check('candidate-keeps-owner-security-settings-grants', privileges() == before)
    check('store-admits-informational', 'informational' in run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'operational_alert_events_investigation_status_check'"))
    check('existing-informational-rows-reclassified',
          state('owner-accounting:2026-10-15T16', 'owner-accounting-notifications') == 'informational:1'
          and state('episode:failed-release:abc', 'club-arena.post-deploy-e2e') == 'informational:1')
    check('existing-incidents-untouched', state('old-firing') == 'new:1' and state('old-info-warning') == 'new:1')
    check('existing-closed-row-untouched', state('old-info-closed') == 'historical:1')

    record('owner-accounting:2026-10-15T17', 'info', 'info', 'owner-accounting-notifications')
    check('new-informational-summary-is-informational',
          state('owner-accounting:2026-10-15T17', 'owner-accounting-notifications') == 'informational:1')
    record('owner-accounting:2026-10-15T17', 'info', 'info', 'owner-accounting-notifications')
    check('repeat-delivery-bumps-receipt-and-keeps-state',
          state('owner-accounting:2026-10-15T17', 'owner-accounting-notifications') == 'informational:2')
    record('new-firing', 'firing', 'critical')
    record('new-resolved', 'resolved', 'info')
    record('new-info-warning', 'info', 'warning')
    check('a-firing-alert-still-lands-new', state('new-firing') == 'new:1')
    check('a-resolved-row-still-lands-new', state('new-resolved') == 'new:1')
    check('an-info-row-with-another-severity-still-lands-new', state('new-info-warning') == 'new:1')
    run("SELECT public.fn_record_operational_alerts('[{\"source\":\"src\",\"event_key\":\"batch-info\",\"alertname\":\"B\","
        "\"status\":\"info\",\"severity\":\"info\",\"payload\":{}},{\"source\":\"src\",\"event_key\":\"batch-firing\","
        "\"alertname\":\"B\",\"status\":\"firing\",\"severity\":\"warning\",\"payload\":{}}]'::jsonb)")
    check('batch-writer-follows', state('batch-info') == 'informational:1' and state('batch-firing') == 'new:1')
    bogus = subprocess.run(list(map(str, psql)),
                           input="UPDATE public.operational_alert_events SET investigation_status = 'bogus' WHERE event_key = 'new-firing';",
                           text=True, capture_output=True, env=env, timeout=30)
    check('store-still-refuses-an-unknown-state',
          bogus.returncode != 0 and 'operational_alert_events_investigation_status_check' in bogus.stderr, bogus.stderr[-200:])
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)),
                           input=f"SET ROLE {role}; SELECT public.fn_record_operational_alert('a','b','c','info','info','{{}}'::jsonb);",
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-write-the-store', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned list' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', writer_md5() == POST_WRITER_DEF_MD5)
    results['candidate'] = {k: state(k) for k in ('new-firing', 'new-resolved', 'new-info-warning', 'batch-info')}
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
