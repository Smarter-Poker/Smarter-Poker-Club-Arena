#!/usr/bin/env python3
"""PostgreSQL 17 qualification: the satellite seat migration's preimage guard
accepts production's real functions and refuses every contract break.

Migration 20260925205909 (a satellite seat into a running target is dealt in)
guards itself with a PREIMAGE block before it replaces
fn_ca_settle_satellite_cohort and starts calling fn_seat_late_registrant. The
merged guard compared pg_get_function_identity_arguments(oid) to 'uuid, uuid'.
That string carries the parameter NAMES - production answers
'p_tournament_id uuid, p_user_id uuid' - so the guard matched no function and
would have refused the install against the very authority it was written for,
leaving the stranded-entrant door open. A text test cannot see that; only a
catalog can.

RED  is the guard exactly as merged (reconstructed from the candidate by
     restoring the one predicate), refused against production's functions.
GREEN is the candidate guard, accepted against the same functions.
The negative controls prove nothing was weakened: a seat authority that stops
taking the lane, stops reaching the terminal gate, runs as INVOKER, takes other
argument types, or a one-byte change to the function being replaced, is still
refused. A re-declaration that only renames parameters is accepted, because
names are not part of what the seat delivery depends on.

Fixtures are production's real definitions: fn_ca_settle_satellite_cohort from
20260921095012 in this repository (asserted to hash to the installed
86709c35...), and fn_seat_late_registrant as read from production
(asserted to hash to the installed 28b68b7f...). The guard block is read out of
the migration file itself, so it is the exact bytes that will be installed.

No production credentials, no network, no production rows: an owned cluster in
a temporary directory, removed in the finally block.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROBE = ROOT / 'scripts/ci/probes/satellite-seat-preimage'
MIGRATION = ROOT / 'supabase/migrations/20260925205909_a_satellite_seat_into_a_running_target_is_dealt_in.sql'
SOURCE = ROOT / 'supabase/migrations/20260921095012_satellite_awards_and_final_table_deals_rank_a_same_hand_bust.sql'

# Production identities read 2026-09-26 on project kuklfnapbkmacvwxktbh.
SETTLE_PROSRC_MD5 = '86709c353867d59865ba23c5bdbcd7a8'
SEAT_PROSRC_MD5 = '28b68b7f0fac74c76d6fc11bdac3f972'
SEAT_IDENTITY_ARGS = 'p_tournament_id uuid, p_user_id uuid'

# The one predicate as merged in #5264 (32cfae6094). RED restores it.
MERGED_PREDICATE = "AND pg_get_function_identity_arguments(p.oid) = 'uuid, uuid'"
CANDIDATE_PREDICATE = "AND oidvectortypes(p.proargtypes) = 'uuid, uuid'"
REFUSAL = 'SATELLITE_SEAT_PREIMAGE_CHANGED'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/satellite-seat-preimage')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
env['LANG'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ca-satellite-preimage-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
PORT = '55771'
results = {
    'checks': [],
    'production_mutations': False,
    'scope': 'The PREIMAGE guard of migration 20260925205909 against production\'s real fn_ca_settle_satellite_cohort and fn_seat_late_registrant definitions, in an owned PG17 cluster. No production row is read or written.',
}
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']


def command(args, sql=None, timeout=120):
    result = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def run(sql):
    return command(psql, sql)


def attempt(sql):
    """Run in one transaction that is always rolled back; return (ok, stderr)."""
    result = subprocess.run(list(map(str, psql)), input='BEGIN;\nSET LOCAL check_function_bodies = off;\n' + sql + '\nROLLBACK;\n',
                            text=True, capture_output=True, env=env, timeout=60)
    return result.returncode == 0, result.stderr.strip()


def check(name, passed, detail=None):
    entry = {'name': name, 'passed': bool(passed)}
    if detail is not None:
        entry['detail'] = detail
    results['checks'].append(entry)
    if not passed:
        raise AssertionError(name + ('' if detail is None else ': ' + str(detail)))


def accepts(name, guard, setup=''):
    ok, err = attempt(setup + '\n' + guard)
    check(name, ok, err[-400:] if err else None)


def refuses(name, guard, setup=''):
    ok, err = attempt(setup + '\n' + guard)
    check(name, (not ok) and REFUSAL in err, err[-400:])


def dollar_block(text, opener, tag):
    start = text.index(opener)
    end = text.index(tag + ';', start) + len(tag) + 1
    return text[start:end]


def prosrc_md5(name):
    return run("SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace"
               " WHERE n.nspname='public' AND p.proname='" + name + "'")


SEAT_BODY = """
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_seat_late_registrant_before_terminal_seat_gate(
    p_tournament_id,p_user_id);
END;
"""


def redeclare_seat(args='p_tournament_id uuid, p_user_id uuid', body=SEAT_BODY, security='SECURITY DEFINER',
                   uses=('p_tournament_id', 'p_user_id')):
    b = body.replace('p_tournament_id', uses[0]).replace('p_user_id', uses[1])
    return ('DROP FUNCTION public.fn_seat_late_registrant(uuid, uuid);\n'
            'CREATE FUNCTION public.fn_seat_late_registrant(' + args + ') RETURNS jsonb LANGUAGE plpgsql '
            + security + " SET search_path TO 'public', 'pg_temp' AS $function$" + b + '$function$;\n')


try:
    check('postgres-17', command([pg / 'postgres', '--version']).startswith('postgres (PostgreSQL) 17.'))
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log',
             '-o', f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=8",
             '-w', 'start'])

    # ------------------------------------------------------------ fixtures ---
    # The catalog facts the guard reads are what is under test, not the tables
    # the bodies name, so bodies are stored without compiling them against a
    # schema this cluster does not have (check_function_bodies = off). prosrc is
    # stored byte-for-byte either way, which the md5 checks below prove.
    source = SOURCE.read_text()
    settle = dollar_block(source, 'CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_cohort(',
                          '$f08_fn_ca_settle_satellite_cohort$')
    run('SET check_function_bodies = off;\n' + settle)
    run('REVOKE ALL ON FUNCTION public.fn_ca_settle_satellite_cohort(uuid, uuid[]) FROM PUBLIC;')
    check('exact-production-settle-preimage', prosrc_md5('fn_ca_settle_satellite_cohort') == SETTLE_PROSRC_MD5,
          prosrc_md5('fn_ca_settle_satellite_cohort'))
    check('exact-production-settle-acl',
          run("SELECT proacl::text FROM pg_proc WHERE proname='fn_ca_settle_satellite_cohort'") == '{postgres=X/postgres}')

    run((PROBE / 'installed-seat-authority.sql').read_text())
    check('exact-production-seat-authority', prosrc_md5('fn_seat_late_registrant') == SEAT_PROSRC_MD5,
          prosrc_md5('fn_seat_late_registrant'))
    check('production-identity-arguments-carry-names',
          run("SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname='fn_seat_late_registrant'")
          == SEAT_IDENTITY_ARGS)

    migration = MIGRATION.read_text()
    guard = dollar_block(migration, 'DO $preimage$', '$preimage$')
    check('candidate-guard-uses-argument-types', guard.count(CANDIDATE_PREDICATE) == 1)
    check('candidate-guard-does-not-compare-identity-string', MERGED_PREDICATE not in guard)

    # ------------------------------------------------------------------ RED ---
    merged_guard = guard.replace(CANDIDATE_PREDICATE, MERGED_PREDICATE)
    refuses('RED-merged-guard-refuses-production-seat-authority', merged_guard)

    # ---------------------------------------------------------------- GREEN ---
    accepts('GREEN-candidate-guard-accepts-production-functions', guard)

    # ------------------------------------------ NOTHING WAS WEAKENED ---------
    refuses('refuses-seat-authority-that-skips-the-lane', guard,
            redeclare_seat(body=SEAT_BODY.replace('public.fn_ca_lock_tournament_seat_acquisition(',
                                                  'public.fn_some_other_gate(')))
    refuses('refuses-seat-authority-that-skips-the-terminal-gate', guard,
            redeclare_seat(body=SEAT_BODY.replace('public.fn_seat_late_registrant_before_terminal_seat_gate(',
                                                  'public.fn_some_other_seat(')))
    refuses('refuses-security-invoker-seat-authority', guard, redeclare_seat(security='SECURITY INVOKER'))
    refuses('refuses-other-argument-types', guard,
            redeclare_seat(args='p_tournament_id uuid, p_user_id text'))
    refuses('refuses-seat-authority-not-owned-by-postgres', guard,
            'CREATE ROLE probe_owner NOLOGIN;\n'
            'ALTER FUNCTION public.fn_seat_late_registrant(uuid, uuid) OWNER TO probe_owner;\n')
    refuses('refuses-missing-seat-authority', guard,
            'DROP FUNCTION public.fn_seat_late_registrant(uuid, uuid);\n')
    refuses('refuses-one-byte-change-to-the-replaced-function', guard,
            settle.replace("RAISE EXCEPTION 'satellite cohort admission is not activated'",
                           "RAISE EXCEPTION 'satellite cohort admission is not  activated'", 1))
    refuses('refuses-widened-acl-on-the-replaced-function', guard,
            'GRANT EXECUTE ON FUNCTION public.fn_ca_settle_satellite_cohort(uuid, uuid[]) TO PUBLIC;\n')
    accepts('accepts-a-redeclaration-that-only-renames-parameters', guard,
            redeclare_seat(args='p_target uuid, p_entrant uuid', uses=('p_target', 'p_entrant')))
    accepts('accepts-the-seat-authority-without-its-added-statement-timeout', guard,
            'ALTER FUNCTION public.fn_seat_late_registrant(uuid, uuid) RESET statement_timeout;\n')

    # The rolled-back attempts left production's shapes intact.
    check('fixtures-unchanged-after-attempts',
          prosrc_md5('fn_seat_late_registrant') == SEAT_PROSRC_MD5
          and prosrc_md5('fn_ca_settle_satellite_cohort') == SETTLE_PROSRC_MD5)
finally:
    subprocess.run(list(map(str, [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])),
                   capture_output=True, env=env)
    shutil.rmtree(cluster, ignore_errors=True)
    (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')

print(json.dumps({'passed': all(c['passed'] for c in results['checks']), 'checks': len(results['checks'])}))
