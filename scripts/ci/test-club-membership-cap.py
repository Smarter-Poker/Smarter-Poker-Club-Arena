#!/usr/bin/env python3
"""Prove the club membership cap migration in an isolated PostgreSQL cluster.

Loads the five byte-exact production preimages (plus the untouched create
wrapper), proves each one reproduces its live md5, reproduces the defects,
applies supabase/migrations/20260922153234_one_club_membership_cap_one_count_one_lock.sql
verbatim, and then exercises every cap boundary, the departed and horse rules,
rejoin, concurrent joins and creates for one player, helper privileges and a
refused re-apply. Nothing here touches any shared database.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/club-membership-cap')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='club-membership-cap-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55743'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {
    'scope': 'club membership cap: preimage fidelity, 20260922153234 install, cap semantics, '
             'concurrency and privileges; the tables are minimal stand-ins, not the production schema',
    'cases': [], 'passed': False,
}

FIXTURES = ROOT / 'scripts/ci/fixtures/club-membership-cap/preimage'
MIGRATION = ROOT / 'supabase/migrations/20260922153234_one_club_membership_cap_one_count_one_lock.sql'
installer = MIGRATION.read_text()
proofs = [m.group(1).strip() for m in re.finditer(r'^--\s*@live-proof:\s*(.+?)\s*$', installer, re.M)]

# Byte-exact live definitions, md5 measured on production 2026-09-22.
PREIMAGES = {
    'fn_create_club_atomic': ('public.fn_create_club_atomic(uuid,text,text,text,boolean,boolean,text)',
                              'a48b60521c9c4eeaf3f2dbe014c86fb4', ['authenticated', 'service_role']),
    'fn_create_club_atomic_membership_impl': (
        'public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)',
        '50f4cb747d53f6a1761732aff16734e7', ['service_role']),
    'fn_get_club_creation_eligibility': ('public.fn_get_club_creation_eligibility()',
                                         '61717e5a31cc3505b7bd41edd56dde6c', ['authenticated', 'service_role']),
    'fn_enforce_four_club_limit': ('public.fn_enforce_four_club_limit()',
                                   '4c27b1c5f7b438dfa569699d19f2200a', ['service_role']),
    'fn_join_club_membership_impl': ('public.fn_join_club_membership_impl(uuid)',
                                     '3a88bf6f9a0bf5404b35bfd696f2df43', ['service_role']),
    'fn_join_club': ('public.fn_join_club(uuid)', 'ee391ec320de04e62b71ebad8f97689d',
                     ['authenticated', 'service_role']),
}

HUMAN = '00000000-0000-4000-8000-000000000001'
HORSE = '00000000-0000-4000-8000-000000000002'
OWNER = '00000000-0000-4000-8000-000000000003'
SIGNAL = 424242


def club(n):
    return '00000000-0000-4000-9000-%012d' % n


GATED = club(15)


def command(argv, sql=None):
    return subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=60)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None, error=None, record=True):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text('-- SQL\n' + sql + '\n-- STDOUT\n' + r.stdout + '-- STDERR\n' + r.stderr)
    if error:
        passed = r.returncode != 0 and all(e in r.stderr for e in ([error] if isinstance(error, str) else error))
    else:
        passed = r.returncode == 0
    got = r.stdout.rstrip('\n')
    if expected is not None:
        passed = passed and got == expected
    if record:
        results['cases'].append({'name': name, 'passed': passed, 'expected': expected,
                                 'expectedError': error, 'observed': got if not error else r.stderr.strip()[-400:]})
    require(passed, name + ': ' + r.stdout[-800:] + r.stderr[-1200:])
    return got


def probe(name, body, expected=None, error=None):
    """A case in a transaction that is always rolled back."""
    return run(name, 'BEGIN;\n' + body + '\nROLLBACK;', expected, error)


def mute(sql):
    """Run statements whose output is not the point of the case."""
    return '\\o /dev/null\n' + sql + '\\o\n'


def as_user(uid):
    """The rest of this transaction runs as the browser does: role authenticated, auth.uid() = uid."""
    return mute(f"SELECT set_config('request.jwt.claim.sub', '{uid}', true);\n") + 'SET LOCAL ROLE authenticated;\n'


def members(uid, first, last, status='active'):
    return (f"INSERT INTO club_members (club_id, user_id, role, status) SELECT id, '{uid}', 'player', '{status}' "
            f"FROM clubs WHERE club_id BETWEEN {10000 + first} AND {10000 + last};\n")


def count_of(uid):
    return f"SELECT public.fn_club_membership_count('{uid}');"


snapshot = ("SELECT md5(jsonb_build_object("
            "'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY club_id, user_id) FROM club_members m),"
            "'clubs',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM clubs c),"
            "'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM club_creation_requests r),"
            "'flags',(SELECT jsonb_agg(to_jsonb(f) ORDER BY key) FROM club_entry_feature_flags f))::text);")
catalogue = ("SELECT md5(string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)) || "
             "coalesce(p.proacl::text,'') || coalesce(p.proconfig::text,''), ',' ORDER BY p.oid::regprocedure::text)) "
             "FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;")
proof_query = ' UNION ALL '.join(
    f"SELECT {i} AS i, coalesce((SELECT ({p}))::text, 'null') AS answer" for i, p in enumerate(proofs)
) + ' ORDER BY i;'

SETUP = f"""
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth, extensions, public TO anon, authenticated, service_role;
-- Supabase's default: a function created in public is executable by all three API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, is_horse boolean);
CREATE TABLE public.clubs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id integer UNIQUE, name text NOT NULL, slug text, description text, color_theme text,
  is_public boolean, requires_approval boolean, owner_id uuid, level integer,
  logo_url text, avatar_url text, lifecycle_status text NOT NULL DEFAULT 'active');
CREATE TABLE public.club_members (
  club_id uuid NOT NULL REFERENCES public.clubs(id), user_id uuid NOT NULL,
  role text, status text, tier text, rank_level integer, orange_ball_status text,
  chip_balance numeric(20,2) NOT NULL DEFAULT 0, is_active boolean DEFAULT true,
  membership_lifecycle_status text NOT NULL DEFAULT 'active',
  departed_at timestamptz, departed_by uuid, departure_reason text, updated_at timestamptz,
  UNIQUE (club_id, user_id));
CREATE TABLE public.club_creation_requests (
  user_id uuid NOT NULL, request_id uuid NOT NULL, club_id uuid NOT NULL,
  PRIMARY KEY (user_id, request_id));
CREATE TABLE public.club_entry_feature_flags (
  key text PRIMARY KEY, enabled boolean NOT NULL, rollout_percent integer NOT NULL);
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
"""

ACLS = ''
for fname, (sig, _md5, grantees) in PREIMAGES.items():
    ACLS += f"REVOKE ALL ON FUNCTION {sig} FROM PUBLIC, anon, authenticated, service_role;\n"
    for g in grantees:
        ACLS += f"GRANT EXECUTE ON FUNCTION {sig} TO {g};\n"

TRIGGERS = """
CREATE TRIGGER trg_four_club_limit_ins BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_club_limit();
CREATE TRIGGER trg_four_club_limit_upd BEFORE UPDATE OF status ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_club_limit();
"""

SEED = f"""
INSERT INTO profiles VALUES ('{HUMAN}', false), ('{HORSE}', true), ('{OWNER}', false);
INSERT INTO clubs (id, club_id, name, slug, is_public, requires_approval, owner_id, level)
SELECT format('00000000-0000-4000-9000-%s', lpad(n::text, 12, '0'))::uuid, 10000 + n,
       'Seed Club ' || n, 'seed-club-' || n, true, n = 15, '{OWNER}', 1
  FROM generate_series(1, 15) n;
INSERT INTO club_entry_feature_flags VALUES ('create_club', true, 100);
"""


def race(prefix, holder_sql, holder_expected, waiter_sql, waiter_expected=None, waiter_error=None, lock_expected=True):
    """Holder commits a membership write while a second session for the same player tries another."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        holder = pool.submit(run, prefix + '-holder',
                             'BEGIN;\n' + holder_sql +
                             f"DO $$ BEGIN PERFORM pg_advisory_lock({SIGNAL}); PERFORM pg_sleep(2); END $$;\nCOMMIT;",
                             holder_expected)
        deadline = time.monotonic() + 10
        while command(cmd, f"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid={SIGNAL} AND granted);").stdout.strip() != 't':
            require(time.monotonic() < deadline, prefix + ': holder never reached its signal')
            require(not holder.done() or holder.exception() is None, prefix + ': holder failed early')
            time.sleep(0.02)
        waiter = pool.submit(run, prefix + '-waiter', "SET application_name = 'race-waiter';\nBEGIN;\n" + waiter_sql + '\nCOMMIT;',
                             waiter_expected, waiter_error)
        waited = False
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline and not waiter.done():
            if command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid "
                            "WHERE a.application_name = 'race-waiter' AND l.locktype = 'advisory' AND NOT l.granted);").stdout.strip() == 't':
                waited = True
                break
            time.sleep(0.02)
        holder_done_first = not waiter.done()
        holder.result()
        waiter.result()
    ok = waited == lock_expected and (holder_done_first or not lock_expected)
    results['cases'].append({'name': prefix + '-waiter-queued-on-player-lock', 'passed': ok,
                             'expected': lock_expected, 'observed': waited})
    require(ok, prefix + ': waiter queued on the player lock = %s, expected %s' % (waited, lock_expected))


def reset_player():
    run('reset', f"DELETE FROM club_members WHERE user_id = '{HUMAN}';\n"
                 f"DELETE FROM club_creation_requests WHERE user_id = '{HUMAN}';\n"
                 f"DELETE FROM clubs WHERE owner_id = '{HUMAN}';", record=False)


try:
    version = command([pg / 'postgres', '--version']).stdout.strip()
    results['postgres'] = version
    require(re.search(r'PostgreSQL\) 1[6-9]\.', version), 'PostgreSQL 16 or newer required, found ' + version)
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0700\nport=" + PORT + "\nshared_buffers='16MB'\nmax_connections=20\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)

    fixtures = ''.join((FIXTURES / (name + '.sql')).read_text() + ';\n' for name in PREIMAGES)
    run('schema-and-preimages', SETUP + fixtures + ACLS + TRIGGERS + SEED)

    # 1. The fixtures ARE production: each reproduces its measured live md5.
    for name, (sig, md5, _g) in PREIMAGES.items():
        run('fixture-fidelity-' + name, f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));", md5)
    require(len(proofs) == 7, 'expected seven @live-proof lines, found %d' % len(proofs))
    answers = run('live-proofs-before-install', proof_query)
    require(all(not line.endswith('|true') for line in answers.split('\n')), 'a live proof is already true before install')

    # 2. The defects, reproduced on the preimage.
    probe('baseline-preflight-says-four', members(HUMAN, 1, 4) + as_user(HUMAN) +
          "SELECT e->>'limit', e->>'can_create' FROM public.fn_get_club_creation_eligibility() e;", '4|false')
    probe('baseline-create-at-four-succeeds', members(HUMAN, 1, 4) + as_user(HUMAN) +
          "SELECT public.fn_create_club_atomic(gen_random_uuid(), 'Baseline Club')->>'name';", 'Baseline Club')
    run('baseline-seed-nine', members(HUMAN, 1, 9))
    race('baseline-two-joins-at-nine', as_user(HUMAN) + f"SELECT public.fn_join_club('{club(10)}')->>'status';\n", 'active',
         as_user(HUMAN) + f"SELECT public.fn_join_club('{club(11)}')->>'status';", 'active', lock_expected=False)
    run('baseline-two-joins-overshoot-the-cap', f"SELECT count(*) FROM club_members WHERE user_id = '{HUMAN}' AND status = 'active';", '11')
    reset_player()

    before = run('snapshot-before-install', snapshot)

    # 3. A drifted preimage is refused and the refusal is atomic.
    drifted_fn = run('catalogue-before-drift', catalogue)
    run('drift-refusal-is-atomic', "BEGIN;\nALTER FUNCTION public.fn_join_club(uuid) SET work_mem = '64kB';\n" + installer,
        error=['CLUB_MEMBERSHIP_CAP_PREIMAGE_CHANGED', 'public.fn_join_club(uuid)'])
    run('drift-refusal-changed-nothing', catalogue, drifted_fn)
    run('drift-refusal-created-no-helper', "SELECT to_regprocedure('public.fn_club_membership_cap()') IS NULL;", 't')

    # 4. Install, verbatim.
    run('install', installer)
    require(run('install-leaves-data-alone', snapshot) == before, 'install rewrote rows')
    answers = run('live-proofs-after-install', proof_query)
    require(answers.split('\n') == ['%d|true' % i for i in range(len(proofs))], 'a live proof is false after install: ' + answers)
    run('create-wrapper-untouched', f"SELECT md5(pg_get_functiondef('{PREIMAGES['fn_create_club_atomic'][0]}'::regprocedure));",
        PREIMAGES['fn_create_club_atomic'][1])
    run('cap-is-ten', 'SELECT public.fn_club_membership_cap();', '10')

    # 5. The preflight tells the truth.
    probe('preflight-at-four', members(HUMAN, 1, 4) + as_user(HUMAN) + 'SELECT public.fn_get_club_creation_eligibility();',
          '{"limit": 10, "reason": null, "remaining": 6, "can_create": true, "creation_open": true, "membership_count": 4}')
    probe('preflight-at-ten', members(HUMAN, 1, 10) + as_user(HUMAN) + 'SELECT public.fn_get_club_creation_eligibility();',
          '{"limit": 10, "reason": "membership_cap", "remaining": 0, "can_create": false, "creation_open": true, "membership_count": 10}')
    probe('preflight-flag-off', members(HUMAN, 1, 3) + "UPDATE club_entry_feature_flags SET enabled = false;\n" + as_user(HUMAN) +
          'SELECT public.fn_get_club_creation_eligibility();',
          '{"limit": 10, "reason": "creation_unavailable", "remaining": 7, "can_create": false, "creation_open": false, "membership_count": 3}')
    probe('preflight-rollout-zero', "UPDATE club_entry_feature_flags SET rollout_percent = 0;\n" + as_user(HUMAN) +
          "SELECT e->>'reason', e->>'creation_open' FROM public.fn_get_club_creation_eligibility() e;", 'creation_unavailable|false')
    probe('create-refused-when-flag-off', "UPDATE club_entry_feature_flags SET enabled = false;\n" + as_user(HUMAN) +
          "SELECT public.fn_create_club_atomic(gen_random_uuid(), 'Closed Door Club');",
          error=['P0001', 'Club creation is temporarily unavailable.'])
    probe('preflight-anonymous-refused', "SET LOCAL ROLE authenticated;\nSELECT public.fn_get_club_creation_eligibility();",
          error=['28000', 'Authentication required'])

    # 6. Joining.
    probe('join-tenth-ok', members(HUMAN, 1, 9) + as_user(HUMAN) +
          f"SELECT public.fn_join_club('{club(10)}')->>'status';\n" + count_of(HUMAN).replace('SELECT', 'RESET ROLE;\nSELECT'),
          'active\n10')
    probe('join-eleventh-refused', members(HUMAN, 1, 10) + as_user(HUMAN) + f"SELECT public.fn_join_club('{club(11)}');",
          error=['P0001', 'You can only be a member of up to 10 clubs. Leave a club to join a new one.'])
    probe('join-gated-club-at-cap-refused', members(HUMAN, 1, 10) + as_user(HUMAN) + f"SELECT public.fn_join_club('{GATED}');",
          error='up to 10 clubs')
    probe('direct-insert-eleventh-refused-by-trigger', members(HUMAN, 1, 10) + members(HUMAN, 11, 11),
          error=['23514', 'You can only be a member of up to 10 clubs. Leave a club to join a new one.'])
    probe('approval-at-cap-refused-by-trigger', members(HUMAN, 1, 10) + members(HUMAN, 15, 15, 'pending') +
          f"UPDATE club_members SET status = 'active' WHERE user_id = '{HUMAN}' AND club_id = '{GATED}';",
          error=['23514', 'up to 10 clubs'])
    probe('approval-below-cap-ok', members(HUMAN, 1, 9) + members(HUMAN, 15, 15, 'pending') +
          f"UPDATE club_members SET status = 'active' WHERE user_id = '{HUMAN}' AND club_id = '{GATED}' RETURNING status;\n" + count_of(HUMAN),
          'active\n10')

    # 7. Creating.
    probe('create-at-nine-ok', members(HUMAN, 1, 9) + as_user(HUMAN) +
          "SELECT public.fn_create_club_atomic(gen_random_uuid(), 'Tenth Club')->>'name';\nRESET ROLE;\n" + count_of(HUMAN),
          'Tenth Club\n10')
    probe('create-at-ten-refused', members(HUMAN, 1, 10) + as_user(HUMAN) +
          "SELECT public.fn_create_club_atomic(gen_random_uuid(), 'Eleventh Club');",
          error=['23514', 'You can only be a member of up to 10 clubs. Leave a club to create a new one.'])
    probe('create-idempotent-replay-at-cap', members(HUMAN, 1, 9) + as_user(HUMAN) +
          "SELECT public.fn_create_club_atomic('11111111-1111-4111-8111-111111111111', 'Replay Club')->>'name';\n"
          "SELECT public.fn_create_club_atomic('11111111-1111-4111-8111-111111111111', 'Replay Club')->>'name';",
          'Replay Club\nReplay Club')

    # 8. Departed rows, horses, rejoin.
    depart = f"UPDATE club_members SET membership_lifecycle_status = 'departed' WHERE user_id = '{HUMAN}' AND club_id = '{club(1)}';\n"
    probe('departed-not-counted', members(HUMAN, 1, 10) + depart + as_user(HUMAN) +
          "SELECT e->>'membership_count', e->>'can_create' FROM public.fn_get_club_creation_eligibility() e;\n"
          f"SELECT public.fn_join_club('{club(11)}')->>'status';\nRESET ROLE;\n" + count_of(HUMAN),
          '9|true\nactive\n10')
    probe('horse-exemption-unchanged', members(HORSE, 1, 12) +
          f"SELECT count(*) FROM club_members WHERE user_id = '{HORSE}' AND status = 'active';", '12')
    probe('rejoin-below-cap-ok', members(HUMAN, 1, 10) + depart +
          as_user(HUMAN) + f"SELECT public.fn_join_club('{club(1)}')->>'membership_lifecycle_status';\nRESET ROLE;\n" + count_of(HUMAN),
          'active\n10')
    probe('rejoin-at-cap-refused', members(HUMAN, 1, 1) + depart + members(HUMAN, 2, 11) + as_user(HUMAN) +
          f"SELECT public.fn_join_club('{club(1)}');", error=['P0001', 'up to 10 clubs'])
    # Staff removal writes status 'suspended' as well as 'departed', so the
    # rejoin's status write also passes through the trigger (and its lock).
    removed = (f"UPDATE club_members SET status = 'suspended', membership_lifecycle_status = 'departed' "
               f"WHERE user_id = '{HUMAN}' AND club_id = '{club(1)}';\n")
    probe('rejoin-after-staff-removal-ok', members(HUMAN, 1, 10) + removed + as_user(HUMAN) +
          f"SELECT public.fn_join_club('{club(1)}')->>'status';\nRESET ROLE;\n" + count_of(HUMAN), 'active\n10')
    probe('rejoin-after-staff-removal-at-cap-refused', members(HUMAN, 1, 1) + removed + members(HUMAN, 2, 11) +
          as_user(HUMAN) + f"SELECT public.fn_join_club('{club(1)}');", error=['P0001', 'up to 10 clubs'])

    # 9. Privileges: the browser reads the cap through the preflight only.
    for role in ('authenticated', 'anon'):
        for label, call in (('count', f"public.fn_club_membership_count('{HUMAN}')"),
                            ('lock', f"public.fn_club_membership_lock('{HUMAN}')"),
                            ('open', f"public.fn_club_creation_open('{HUMAN}')"),
                            ('cap', 'public.fn_club_membership_cap()')):
            probe(f'{role}-cannot-execute-{label}', f"SET LOCAL ROLE {role};\nSELECT {call};", error='42501')
    probe('service-role-can-execute-count', f"SET LOCAL ROLE service_role;\nSELECT public.fn_club_membership_count('{HUMAN}');", '0')
    probe('anon-cannot-read-preflight', "SET LOCAL ROLE anon;\nSELECT public.fn_get_club_creation_eligibility();", error='42501')

    require(run('all-probes-rolled-back', snapshot) == before, 'a rolled-back probe leaked rows')

    # 10. Concurrency: one player, one lock, exactly one write lands at 9.
    run('race-seed-nine-a', members(HUMAN, 1, 9))
    race('race-join-vs-join', as_user(HUMAN) + f"SELECT public.fn_join_club('{club(10)}')->>'status';\n", 'active',
         as_user(HUMAN) + f"SELECT public.fn_join_club('{club(11)}');",
         waiter_error=['P0001', 'up to 10 clubs'])
    run('race-join-vs-join-final-count', count_of(HUMAN), '10')
    reset_player()
    run('race-seed-nine-b', members(HUMAN, 1, 9))
    race('race-join-vs-create', as_user(HUMAN) + f"SELECT public.fn_join_club('{club(10)}')->>'status';\n", 'active',
         as_user(HUMAN) + "SELECT public.fn_create_club_atomic(gen_random_uuid(), 'Racing Club');",
         waiter_error=['23514', 'Leave a club to create a new one'])
    run('race-join-vs-create-final-count', count_of(HUMAN) + f"\nSELECT count(*) FROM clubs WHERE owner_id = '{HUMAN}';", '10\n0')
    reset_player()
    run('race-seed-nine-c', members(HUMAN, 1, 9))
    race('race-create-vs-join', as_user(HUMAN) + "SELECT public.fn_create_club_atomic(gen_random_uuid(), 'First Past The Post')->>'name';\n",
         'First Past The Post', as_user(HUMAN) + f"SELECT public.fn_join_club('{club(10)}');",
         waiter_error=['P0001', 'up to 10 clubs'])
    run('race-create-vs-join-final-count', count_of(HUMAN), '10')
    reset_player()
    require(run('races-cleaned-up', snapshot) == before, 'race cleanup left rows behind')

    # 11. A second apply is refused on the preimage pin and changes nothing.
    installed = run('catalogue-before-reapply', catalogue)
    run('reapply-refused-on-preimage-pin', installer, error=['CLUB_MEMBERSHIP_CAP_PREIMAGE_CHANGED', '55000'])
    run('reapply-changed-no-function', catalogue, installed)
    require(run('reapply-changed-no-row', snapshot) == before, 're-apply changed rows')
    answers = run('live-proofs-after-reapply', proof_query)
    require(answers.split('\n') == ['%d|true' % i for i in range(len(proofs))], 'a live proof is false after re-apply')
    results['passed'] = all(c['passed'] for c in results['cases'])
finally:
    if (cluster / 'data/postmaster.pid').exists():
        r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        require(r.returncode == 0, 'Could not stop owned cluster: ' + r.stderr)
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    require(not (cluster / 'data/postmaster.pid').exists(), 'Owned cluster still running')
    shutil.rmtree(cluster)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']), 'evidence': str(out)}))
