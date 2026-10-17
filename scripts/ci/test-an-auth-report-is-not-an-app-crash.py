"""Isolated PostgreSQL regression: the daily digest's app crash count leaves
out the auth flow's own failure reports and delivery probes.

fn_sp_daily_metrics_compute counted every client_crash_log row as an app
crash, so a wrong password and an unconfirmed email (boundary 'auth', written
by the World Hub's /api/auth/log-client-error) filed DailyDigest.client_crash
on the alert board. Migration 20261016104606 counts only rows outside the
auth flow and outside delivery probes.

The function is built from its exact production text (20261016100458, md5
equal to production's live text) with #7080's 20261016103449 applied on top,
which is the text this migration pins. The test proves the 'crashes' read
counts the auth and probe rows before, counts only the render crash after,
leaves the 'deploys' read byte-identical, reproduces the derived postimage
md5 and refuses a second install. The function body is never executed; only
the two metric subqueries are, exactly as the function text has them. An
empty throwaway cluster on a Unix socket; no network, no production
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
MIGRATION = MIGRATIONS / '20261016104606_an_auth_report_is_not_an_app_crash.sql'
# The live fn_sp_daily_metrics_compute is the text of this migration exactly.
LIVE_SOURCE = MIGRATIONS / '20261016100458_sp_daily_digest_standalone_rake_and_club_ranking.sql'
# #7080's edit of the same function, which this migration installs after.
PRIOR = MIGRATIONS / '20261016103449_sp_daily_digest_counts_superseded_deploys_and_house_diamond_.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/an-auth-report-is-not-an-app-crash')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='auth-report-crash-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55833'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SIG = 'public.fn_sp_daily_metrics_compute(date)'
LIVE_MD5 = 'ba689a29f14e0e922969645550f8e9e6'   # production, read 2026-10-16
PRIOR_MD5 = '0a7241d8426993393e54accdeec01676'  # after 20261016103449
POST_MD5 = '8056093672bc76bbe02244a6615af79c'   # after this migration
ACL = '{postgres=X/postgres,service_role=X/postgres}'

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.client_crash_log(id bigserial, created_at timestamptz, boundary text, section text, error_name text);
CREATE TABLE public.ca_engine_deploy_attempts(id bigserial, at timestamptz, shipped boolean, reason text, target_sha text);
"""
GRANTS = """
REVOKE ALL ON FUNCTION public.fn_sp_daily_metrics_compute(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_sp_daily_metrics_compute(date) TO service_role;
"""
# The Oct 15 rows the digest read, as production holds them, plus one probe
# row and one real render crash.
ROWS = """
INSERT INTO public.client_crash_log(created_at, boundary, section, error_name) VALUES
  ('2026-10-16 02:11:40+00', 'auth', 'login_form_submit', 'invalid_credentials'),
  ('2026-10-16 02:32:42+00', 'auth', 'login_form_submit', 'email_not_confirmed'),
  ('2026-10-16 03:00:00+00', 'page', 'club-arena-probe:delivery-verification', 'Probe'),
  ('2026-10-16 03:30:00+00', 'page', 'table', 'TypeError'),
  ('2026-10-16 06:00:00+00', 'page', 'table', 'TypeError');
INSERT INTO public.ca_engine_deploy_attempts(at, shipped, reason, target_sha) VALUES
  ('2026-10-15 06:03:47+00', false, 'stood down before cutover; protected main had moved to 655469f9ba192ccb766b666b53710c9b248de784', 'aaaa'),
  ('2026-10-15 06:10:00+00', true, 'Hetzner transaction sealed and independently verified', '655469f9ba192ccb766b666b53710c9b248de784'),
  ('2026-10-15 07:10:00+00', false, 'the durable Hetzner release transaction did not complete; production still runs the previously sealed release', 'bbbb');
"""
S, E = '2026-10-15 05:00:00+00', '2026-10-16 05:00:00+00'


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def md5():
    return run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")


def metric(key, next_key):
    """Evaluate one metric's subquery, exactly as the function text has it."""
    defn = run(f"SELECT pg_get_functiondef('{SIG}'::regprocedure)")
    m = re.search(r"'" + key + r"', (\(.*?\)),\n(?:\s*--[^\n]*\n)*\s*'" + next_key + "'", defn, re.S)
    if not m:
        raise ValueError(f'{key} not found in the function text')
    value = run(f"WITH w AS (SELECT timestamptz '{S}' AS s, timestamptz '{E}' AS e) SELECT {m.group(1)} FROM w")
    return value, m.group(1)


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    for path, pr in ((LIVE_SOURCE, '#7077'), (PRIOR, '#7080')):
        if not path.exists():
            raise RuntimeError(f'{path.name} ({pr}) is not on this tree; this migration installs after it')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    live = re.search(r'CREATE OR REPLACE FUNCTION public\.fn_sp_daily_metrics_compute\(.*?\$fn\$;',
                     LIVE_SOURCE.read_text(), re.S).group(0)
    # The function reads tables this cluster does not have; its body is never
    # executed here.
    run('SET check_function_bodies = off;\n' + live + GRANTS + ROWS)
    check('live-text-is-production', md5() == LIVE_MD5, md5())
    run('SET check_function_bodies = off;\n' + PRIOR.read_text())
    check('prior-postimage-is-the-pinned-preimage', md5() == PRIOR_MD5, md5())

    crashes_before, _ = metric('crashes', 'signup_errors')
    deploys_before, deploys_text_before = metric('deploys', 'alerts_new')
    results['before'] = {'crashes': crashes_before, 'deploys': deploys_before}
    check('baseline-counts-auth-reports-and-probes-as-crashes', crashes_before == '4', results['before'])

    run(MIGRATION.read_text())
    check('postimage-is-the-derived-postimage', md5() == POST_MD5, md5())
    check('grants-unchanged', run(f"SELECT proacl::text FROM pg_proc WHERE oid = '{SIG}'::regprocedure") == ACL)
    crashes_after, _ = metric('crashes', 'signup_errors')
    deploys_after, deploys_text_after = metric('deploys', 'alerts_new')
    results['after'] = {'crashes': crashes_after, 'deploys': deploys_after}
    check('counts-only-the-render-crash', crashes_after == '1', results['after'])
    check('deploys-read-untouched', deploys_text_after == deploys_text_before and deploys_after == deploys_before,
          results['after'])

    try:
        run(MIGRATION.read_text())
        check('reinstall-is-refused', False, 'second install succeeded')
    except RuntimeError as e:
        check('reinstall-is-refused', 'is not the pinned text' in str(e), str(e)[:200])
    results['passed'] = True
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps(results, indent=2))
