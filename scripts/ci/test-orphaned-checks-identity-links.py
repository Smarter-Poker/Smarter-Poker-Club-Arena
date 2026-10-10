"""Isolated PostgreSQL regression: the identity links reader is not an orphaned check.

fn_ca_orphaned_checks() lists a function whose name looks like an integrity
check and that nothing runs (no cron entry, no caller, not in
fn_ca_conservation_sweep, no exemption). fn_ca_integrity_identity_links is a
STABLE paged reader for the integrity review screen, like its exempted
siblings. The test loads the exact production fn_ca_orphaned_checks captured
on 2026-10-08 (pg_get_functiondef md5 equal to production's), proves it lists
the reader, applies the candidate migration and proves it no longer does,
that a real unrun check is still listed (the exemption is not a mute), and
that a second run is a no-op.
An empty throwaway cluster on a Unix socket; no network, no production
connection.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261008052116_the_identity_links_reader_is_exempt_from_the_orphaned_checks.sql'
FIXTURE = ROOT / 'scripts' / 'ci' / 'fixtures' / 'orphaned-checks-identity-links' / 'fn_ca_orphaned_checks.live-20261008.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/orphaned-checks-identity-links')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='orphaned-checks-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}
LIVE_ORPHANED_MD5 = 'cd84dc64c1856c469fcd66cea4a609e0'

# Production shapes, read 2026-10-08: the exemption table, cron.job, a sweep,
# the reader (signature as installed by 20261006022123), an exempted sibling
# and a genuine check that nothing runs.
SCHEMA = """
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY, command text);
CREATE TABLE public.ca_check_sweep_exemptions(proname text PRIMARY KEY, reason text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.ca_check_sweep_exemptions(proname, reason) VALUES ('fn_ca_integrity_flags', 'paged reader');
CREATE FUNCTION public.fn_ca_conservation_sweep() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION public.fn_ca_integrity_identity_links(
  p_include_horses boolean DEFAULT true, p_since timestamptz DEFAULT now() - interval '90 days',
  p_as_of timestamptz DEFAULT now(), p_limit integer DEFAULT 25, p_cursor jsonb DEFAULT NULL)
  RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.fn_ca_integrity_flags(p_as_of timestamptz, p_limit integer, p_cursor jsonb)
  RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.fn_zz_unrun_conservation_check() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
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


def orphans():
    return run('SELECT string_agg(proname, \',\' ORDER BY proname) FROM public.fn_ca_orphaned_checks()')


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run(FIXTURE.read_text() + ';')
    got = run("SELECT md5(pg_get_functiondef('public.fn_ca_orphaned_checks()'::regprocedure))")
    check('baseline-is-production-preimage', got == LIVE_ORPHANED_MD5, got)
    before = orphans()
    # The defect: the paged reader reads as an unrun integrity check.
    check('baseline-lists-the-reader', before == 'fn_ca_integrity_identity_links,fn_zz_unrun_conservation_check', before)

    run(MIGRATION.read_text())
    after = orphans()
    check('reader-no-longer-listed-real-check-still-listed', after == 'fn_zz_unrun_conservation_check', after)
    reason = run("SELECT reason FROM public.ca_check_sweep_exemptions WHERE proname = 'fn_ca_integrity_identity_links'")
    check('exemption-carries-a-reason', 'paged reader' in reason, reason)

    run(MIGRATION.read_text())
    check('second-run-is-a-no-op', run('SELECT count(*) FROM public.ca_check_sweep_exemptions') == '2')

    # Invariant: the migration refuses if the function is not the paged reader.
    run("DROP FUNCTION public.fn_ca_integrity_identity_links(boolean, timestamptz, timestamptz, integer, jsonb);"
        "DELETE FROM public.ca_check_sweep_exemptions WHERE proname = 'fn_ca_integrity_identity_links';"
        "CREATE FUNCTION public.fn_ca_integrity_identity_links(p_actor uuid) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;")
    try:
        run(MIGRATION.read_text())
        refused = False
    except RuntimeError as e:
        refused = 'is not the stable paged reader' in str(e)
    check('refuses-a-function-that-is-not-the-reader', refused)
    results['passed'] = True
except Exception as e:  # noqa: BLE001 - recorded, then re-raised
    results['passed'] = False
    results['error'] = str(e)
    raise
finally:
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:  # noqa: BLE001
        pass
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    shutil.rmtree(cluster, ignore_errors=True)
    print(json.dumps(results, indent=2))
