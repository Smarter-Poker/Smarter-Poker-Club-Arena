"""Isolated PostgreSQL regression: a declared guard install is not a review notice.

fn_ca_guard_defs_watch() raised an open info notice for every watched guard
whose hash moved off its baseline, even when an installed migration had
declared that exact end state in its "-- @live-proof:" line (2026-10-15 17:25
UTC: fn_ca_raise_drift_incident, declared and installed by migration
20261015024752). Migration 20261015181950 makes the watch read the installed
migrations' recorded text before it raises.

The test loads the exact production definition captured on 2026-10-15 (its
pg_get_functiondef md5 equals production's), proves it raises a notice for a
declared install, then applies the candidate migration and proves:
  * a redefinition whose md5 an installed migration pins on its @live-proof
    line moves the baseline naming that migration, supersedes an older open
    notice for the guard, and raises nothing;
  * a redefinition no migration declares is still raised;
  * a hash that only appears elsewhere in a migration (a pinned preimage) is
    NOT a declaration and is still raised;
  * the candidate reproduces production's derived postimage md5, keeps owner,
    SECURITY DEFINER, settings and grants, declares its own redefinition, and
    refuses a second run.
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
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'guard-watch-declared-install'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/guard-watch-declared-install')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='guard-watch-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production watch read on 2026-10-15, before
# and after the candidate (derived read-only on production with replace()).
LIVE_WATCH_DEF_MD5 = 'eed0ea56a08ecefdf538ebba2318b600'
POST_WATCH_DEF_MD5 = 'c39d324b3677d55feceb4522d67cc590'
WATCH_SIG = 'public.fn_ca_guard_defs_watch()'
# Production's grants on the watch (read 2026-10-15: postgres and service_role).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_ca_guard_defs_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_defs_watch() TO service_role;
'''


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


def definition(path, name):
    source = path.read_text()
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1;', source, re.S)
    if not m:
        raise ValueError('missing definition: ' + name + ' in ' + path.name)
    return m.group(0)


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text);
CREATE TABLE public.ca_guard_defs(proname text PRIMARY KEY, def_hash text, updated_at timestamptz,
  declared_ref text, declared_at timestamptz);
CREATE TABLE public.ca_guard_def_history(id bigserial PRIMARY KEY, proname text, def_hash text, def_text text,
  captured_at timestamptz DEFAULT now(), UNIQUE (proname, def_hash));
CREATE TABLE public.ca_drift_incidents(id bigserial PRIMARY KEY, source text, classification text, severity text,
  dedupe_key text, status text DEFAULT 'open', resolved_at timestamptz, resolution text, suspected_cause text,
  metadata jsonb);
-- The real raiser dedupes and routes; the watch only needs a row per notice.
CREATE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text,
  p_dedupe_key text, p_discrepancy numeric DEFAULT NULL, p_expected numeric DEFAULT NULL,
  p_actual numeric DEFAULT NULL, p_layer text DEFAULT NULL, p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL, p_club_id uuid DEFAULT NULL, p_union_id uuid DEFAULT NULL,
  p_table_id uuid DEFAULT NULL, p_tournament_id uuid DEFAULT NULL, p_hand_id uuid DEFAULT NULL,
  p_settlement_id text DEFAULT NULL, p_wallet_ids uuid[] DEFAULT NULL, p_transaction_ids uuid[] DEFAULT NULL,
  p_suspected_cause text DEFAULT NULL, p_ledger_balanced boolean DEFAULT NULL, p_metadata jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.ca_drift_incidents(source, classification, severity, dedupe_key, suspected_cause, metadata)
  VALUES (p_source, p_classification, p_severity, p_dedupe_key, p_suspected_cause, p_metadata);
  SELECT NULL::uuid;
$f$;
CREATE FUNCTION public.fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT ARRAY['g_declared','g_undeclared','g_preimage_only','fn_ca_guard_defs_watch']::text[];
$f$;
"""

GUARDS_V1 = """
CREATE OR REPLACE FUNCTION public.g_declared() RETURNS int LANGUAGE sql AS $f$ SELECT 1 $f$;
CREATE OR REPLACE FUNCTION public.g_undeclared() RETURNS int LANGUAGE sql AS $f$ SELECT 1 $f$;
CREATE OR REPLACE FUNCTION public.g_preimage_only() RETURNS int LANGUAGE sql AS $f$ SELECT 1 $f$;
"""

GUARDS_V2 = """
CREATE OR REPLACE FUNCTION public.g_declared() RETURNS int LANGUAGE sql AS $f$ SELECT 2 $f$;
CREATE OR REPLACE FUNCTION public.g_undeclared() RETURNS int LANGUAGE sql AS $f$ SELECT 2 $f$;
CREATE OR REPLACE FUNCTION public.g_preimage_only() RETURNS int LANGUAGE sql AS $f$ SELECT 2 $f$;
"""


def md5_of(name):
    return run(f"SELECT md5(pg_get_functiondef('public.{name}()'::regprocedure))")


def install_v2_with_declarations(version_prefix):
    """Redefine the three guards; record one installed migration that declares
    g_declared's end state on its @live-proof line, and one that only names
    g_preimage_only's new hash outside any @live-proof line."""
    run(GUARDS_V2)
    declared = md5_of('g_declared')
    mentioned = md5_of('g_preimage_only')
    declaring = (f"-- {version_prefix}1_declares_g\n--\n"
                 f"-- @live-proof: (SELECT md5(pg_get_functiondef('public.g_declared()'::regprocedure)) = '{declared}')\n\n"
                 "BEGIN;\nCOMMIT;\n")
    mentioning = (f"-- {version_prefix}2_mentions_a_hash\n--\n"
                  f"SELECT pg_temp.subst('public.g_preimage_only()', '{mentioned}', 'ffffffffffffffffffffffffffffffff');\n")
    run("INSERT INTO supabase_migrations.schema_migrations VALUES "
        f"('{version_prefix}1', ARRAY[$m${declaring}$m$], 'declares_g'), "
        f"('{version_prefix}2', ARRAY[$m${mentioning}$m$], 'mentions_a_hash');")
    return declared


def notices():
    return json.loads(run("SELECT coalesce(json_agg(json_build_object('key', dedupe_key, 'status', status, "
                          "'resolution', resolution) ORDER BY id), '[]') FROM public.ca_drift_incidents"))


def open_keys():
    return sorted(n['key'].split(':')[1] for n in notices() if n['status'] != 'resolved')


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run(definition(one('*_a_declared_guard_change_is_recorded_not_raised.sql'), 'fn_ca_declare_guard_redefinition'))

    # -- Baseline: the exact production watch before this change ------------
    run((FIXTURES / 'fn_ca_guard_defs_watch.live-20261015.sql').read_text() + ';' + GRANTS)
    check('baseline-watch-is-production-preimage', md5_of('fn_ca_guard_defs_watch') == LIVE_WATCH_DEF_MD5)
    run(GUARDS_V1)
    run('SELECT public.fn_ca_guard_defs_watch()')
    check('baseline-first-run-only-baselines', notices() == [], notices())
    install_v2_with_declarations('2026101500000')
    changes = int(run('SELECT public.fn_ca_guard_defs_watch()'))
    results['baseline'] = {'changes': changes, 'open': open_keys()}
    check('baseline-raises-a-notice-for-the-declared-install', 'g_declared' in open_keys(), open_keys())
    check('baseline-raises-all-three', changes == 3 and len(open_keys()) == 3, results['baseline'])

    # Reset to v1 with the baseline watch, and leave an OLD open notice for
    # g_declared, so the candidate must supersede it.
    run("TRUNCATE public.ca_guard_defs, public.ca_guard_def_history, public.ca_drift_incidents, "
        "supabase_migrations.schema_migrations")
    run(GUARDS_V1)
    run('SELECT public.fn_ca_guard_defs_watch()')
    run("SELECT public.fn_ca_raise_drift_incident('fn_ca_guard_defs_watch', 'unknown', 'info', "
        "'guard-def-drift:g_declared:000000000000')")

    # -- Candidate: the migration under test, applied as production would ----
    candidate = one('*_a_declared_guard_install_is_not_a_review_notice.sql')
    migration = candidate.read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-live-proof-names-the-postimage', f"= '{POST_WATCH_DEF_MD5}')" in migration)
    acl_before = run(f"SELECT proacl::text || pg_get_userbyid(proowner) || prosecdef::text || coalesce(proconfig::text, '') "
                     f"FROM pg_proc WHERE oid = '{WATCH_SIG}'::regprocedure")
    run(migration)
    check('candidate-reproduces-production-derived-postimage', md5_of('fn_ca_guard_defs_watch') == POST_WATCH_DEF_MD5)
    check('candidate-keeps-owner-security-settings-grants',
          run(f"SELECT proacl::text || pg_get_userbyid(proowner) || prosecdef::text || coalesce(proconfig::text, '') "
              f"FROM pg_proc WHERE oid = '{WATCH_SIG}'::regprocedure") == acl_before)
    check('candidate-declares-its-own-redefinition',
          run("SELECT declared_ref FROM public.ca_guard_defs WHERE proname = 'fn_ca_guard_defs_watch'")
          == 'migration 20261015181950_a_declared_guard_install_is_not_a_review_notice')
    # The migration's own text is what production records; record it so the
    # watch's self-check below reads the same evidence production will.
    run("INSERT INTO supabase_migrations.schema_migrations VALUES "
        f"('20261015181950', ARRAY[$m${migration}$m$], 'a_declared_guard_install_is_not_a_review_notice')")

    declared = install_v2_with_declarations('2026101500001')
    changes = int(run('SELECT public.fn_ca_guard_defs_watch()'))
    results['candidate'] = {'changes': changes, 'open': open_keys(), 'notices': notices()}
    check('declared-install-raises-nothing', 'g_declared' not in open_keys(), open_keys())
    check('undeclared-redefinition-is-still-raised', 'g_undeclared' in open_keys(), open_keys())
    check('a-preimage-mention-declares-nothing', 'g_preimage_only' in open_keys(), open_keys())
    check('the-watch-does-not-report-its-own-declared-change', 'fn_ca_guard_defs_watch' not in open_keys(), open_keys())
    check('only-the-undeclared-count', changes == 2, changes)
    baseline = json.loads(run("SELECT row_to_json(d) FROM public.ca_guard_defs d WHERE proname = 'g_declared'"))
    check('declared-baseline-moves-to-the-live-hash', baseline['def_hash'] == declared, baseline)
    check('declared-baseline-names-the-migration',
          baseline['declared_ref'] == 'migration 20261015000011 (@live-proof)' and baseline['declared_at'], baseline)
    superseded = [n for n in notices() if n['key'] == 'guard-def-drift:g_declared:000000000000']
    check('older-open-notice-is-superseded',
          len(superseded) == 1 and superseded[0]['status'] == 'resolved'
          and 'declared migration 20261015000011' in (superseded[0]['resolution'] or ''), superseded)
    check('a-second-run-is-quiet', int(run('SELECT public.fn_ca_guard_defs_watch()')) == 0)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT public.fn_ca_guard_defs_watch();',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-run-the-watch', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', md5_of('fn_ca_guard_defs_watch') == POST_WATCH_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': {k: v for k, v in (results.get('candidate') or {}).items() if k != 'notices'},
                  'output': str(out / 'RESULTS.json')}))
