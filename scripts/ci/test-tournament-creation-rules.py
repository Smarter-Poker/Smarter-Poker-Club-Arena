#!/usr/bin/env python3
"""Prove the tournament creation rules migration in an isolated PostgreSQL cluster.

Installs the two authoring RPCs exactly as the repo's newest definitions carry
them (20260917204152, proven byte-exact by md5), with minimal stand-ins for the
tables and helpers they call, then applies
supabase/migrations/20260924033701_tournament_creation_refuses_what_the_client_refuses.sql
verbatim and shows:

  - a drifted preimage is refused and installs nothing;
  - every case in scripts/ci/fixtures/tournament-creation-rules/cases.json gets
    the answer the browser's validator gives (the shared parity table);
  - fn_create_tournament refuses each rule before the governed creator writes a
    row, after authentication and authorisation, and still creates a valid event;
  - fn_upsert_tournament_schedule refuses a new or changed configuration, and
    leaves an unchanged accepted one alone;
  - the validator is not executable by the browser roles;
  - a second apply is refused.

The tables are minimal stand-ins, not the production schema. Nothing here
touches any shared database.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/tournament-creation-rules')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='tournament-creation-rules-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55761'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {
    'scope': 'tournament creation rules: preimage fidelity, 20260924033701 install, the shared '
             'parity cases, both authoring RPCs end to end, privileges and a refused re-apply; '
             'the tables are minimal stand-ins, not the production schema',
    'cases': [], 'passed': False,
}

MIGRATION = ROOT / 'supabase/migrations/20260924033701_tournament_creation_refuses_what_the_client_refuses.sql'
PREIMAGE_SOURCE = ROOT / 'supabase/migrations/20260917204152_mtt_authored_ladders_only_contain_playing_levels.sql'
CASES = json.loads((ROOT / 'scripts/ci/fixtures/tournament-creation-rules/cases.json').read_text())['cases']
installer = MIGRATION.read_text()
proofs = [m.group(1).strip() for m in re.finditer(r'^--\s*@live-proof:\s*(.+?)\s*$', installer, re.M)]

PRE = {
    'public.fn_create_tournament(uuid,jsonb)': '4c5c8783d1f6f534fdaf5cefbb460d62',
    'public.fn_upsert_tournament_schedule(jsonb)': 'b8dd7cc8e0996889a936affdc732b664',
}
POST = {
    'public.fn_create_tournament(uuid,jsonb)': 'bc5e5dcea11302574163b21f10b63465',
    'public.fn_upsert_tournament_schedule(jsonb)': 'f56ec7122c5a2cc2b72f5b6f13aeefbb',
}

source = PREIMAGE_SOURCE.read_text()
PREIMAGES = source[source.index('CREATE OR REPLACE FUNCTION public.fn_create_tournament('):source.index('DO $post$')]

OWNER = '00000000-0000-4000-8000-000000000001'
CLUB = '00000000-0000-4000-9000-000000000001'
DENIED_CLUB = '00000000-0000-4000-9000-000000000002'


def command(argv, sql=None):
    return subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=60)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None, error=None, record=True):
    r = command(cmd, sql)
    (out / (re.sub(r'[^a-z0-9]+', '-', name.lower())[:120] + '.log')).write_text(
        '-- SQL\n' + sql + '\n-- STDOUT\n' + r.stdout + '-- STDERR\n' + r.stderr)
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


def lit(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"


def as_owner():
    """The rest of this transaction runs as the browser does: role authenticated, auth.uid() = the owner."""
    return (f"\\o /dev/null\nSELECT set_config('request.jwt.claim.sub', '{OWNER}', true);\n\\o\n"
            'SET LOCAL ROLE authenticated;\n')


def config_sql(case):
    """The case's config as SQL, with a start time relative to the database clock."""
    base = lit(case['config'])
    if case.get('startOffsetMinutes') is None or isinstance(case['config'], list):
        return base
    return (f"({base} || jsonb_build_object('startTime', "
            f"to_char((now() + interval '{int(case['startOffsetMinutes'])} minutes') AT TIME ZONE 'UTC', "
            "'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')))")


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

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid NOT NULL,
  config jsonb, payout_percent smallint, is_mystery_bounty boolean NOT NULL DEFAULT false,
  mystery_bounty_profile text, mystery_bounty_activation text, mystery_bounty_activation_value numeric,
  mystery_bounty_pool_percent numeric, mystery_bounty_regular_pool_percent numeric,
  mystery_bounty_top_percent numeric);
CREATE TABLE public.tournament_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), union_id uuid, club_id uuid NOT NULL,
  name text NOT NULL, description text, active boolean NOT NULL DEFAULT true,
  days_of_week integer[] NOT NULL, start_times_utc text[] NOT NULL DEFAULT '{{}}',
  interval_minutes integer, config jsonb NOT NULL, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

-- Stand-ins for what the two RPCs call. The governed creator records exactly
-- what reached it, so a refusal can be shown to write nothing.
CREATE FUNCTION public.fn_can_create_games(p_club uuid, p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT p_club <> '{DENIED_CLUB}'::uuid $$;
CREATE FUNCTION public.fn_can_manage_tournament_schedule(p_union uuid, p_club uuid, p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT p_club <> '{DENIED_CLUB}'::uuid $$;
CREATE FUNCTION public.fn_ca_is_new_mtt(p jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_mystery_bounty_creation_document(p jsonb) RETURNS jsonb
  LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION public.fn_create_tournament_governed_legacy(p_club_id uuid, p_config jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.tournaments (club_id, config) VALUES (p_club_id, p_config) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'tournament_id', v_id, 'status', 'REGISTERING');
END $$;
REVOKE ALL ON FUNCTION public.fn_create_tournament_governed_legacy(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
-- Production lets the browser read both (a public SELECT policy); it writes neither.
GRANT SELECT ON public.tournaments, public.tournament_schedules TO authenticated;
"""

ACLS = ''.join(
    f"REVOKE ALL ON FUNCTION {sig} FROM PUBLIC, anon, authenticated, service_role;\n"
    f"GRANT EXECUTE ON FUNCTION {sig} TO authenticated, service_role;\n" for sig in PRE)

catalogue = ("SELECT md5(string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)) || "
             "coalesce(p.proacl::text,'') || coalesce(p.proconfig::text,''), ',' ORDER BY p.oid::regprocedure::text)) "
             "FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;")
rows = ("SELECT md5(jsonb_build_object("
        "'t',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tournaments t),"
        "'s',(SELECT jsonb_agg(to_jsonb(s) - 'updated_at' ORDER BY id) FROM tournament_schedules s))::text);")
proof_query = ' UNION ALL '.join(
    f"SELECT {i} AS i, coalesce((SELECT ({p}))::text, 'null') AS answer" for i, p in enumerate(proofs)
) + ' ORDER BY i;'


def create(config_sql_text, club=CLUB):
    # Two statements: the count must see what the call wrote.
    return (as_owner() + f"SELECT public.fn_create_tournament('{club}', {config_sql_text})->>'error';\n"
            "SELECT count(*) FROM public.tournaments;")


def schedule(payload):
    return as_owner() + f"SELECT public.fn_upsert_tournament_schedule({lit(payload)}) - 'schedule_id';"


try:
    version = command([pg / 'postgres', '--version']).stdout.strip()
    results['postgres'] = version
    require(re.search(r'PostgreSQL\) 1[6-9]\.', version), 'PostgreSQL 16 or newer required, found ' + version)
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                 '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0700\nport="
                + PORT + "\nshared_buffers='16MB'\nmax_connections=20\ntimezone='UTC'\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)

    run('schema-and-preimages', SETUP + PREIMAGES + ACLS)

    # 1. The preimages ARE the repo's newest definitions: each reproduces its pinned md5.
    for sig, md5 in PRE.items():
        run('preimage-fidelity ' + sig, f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));", md5)
    require(len(proofs) == 3, 'expected three @live-proof lines, found %d' % len(proofs))

    # 2. A drifted preimage is refused, atomically.
    before_catalogue = run('catalogue-before', catalogue, record=False)
    drift = PREIMAGES.replace("RETURN jsonb_build_object('success',false,'error','not_authorised');",
                              "RETURN jsonb_build_object('success',false,'error','not_authorised' );", 1)
    require(drift != PREIMAGES, 'drift substitution matched nothing')
    run('drifted-preimage', drift, record=False)
    drifted_catalogue = run('catalogue-drifted', catalogue, record=False)
    run('drifted-preimage-refused', installer, error=['TOURNAMENT_CREATION_RULES_PREIMAGE_CHANGED', '55000'])
    run('drifted-preimage-installs-nothing', catalogue, drifted_catalogue)
    run('restore-preimage', PREIMAGES, record=False)
    run('restored-catalogue-matches', catalogue, before_catalogue)

    # 3. Install, verbatim.
    run('install', installer)
    for sig, md5 in POST.items():
        run('postimage ' + sig, f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));", md5)
    answers = run('live-proofs', proof_query)
    require(answers.split('\n') == ['%d|true' % i for i in range(len(proofs))], 'a live proof is false')

    # 4. The parity table: the database answers every case the browser answers.
    for case in CASES:
        want = case['expect'] if case['expect'] is not None else ''
        run('parity: ' + case['name'],
            f"SELECT coalesce(public.fn_tournament_config_refusal({config_sql(case)}, '{case['surface']}'), '');",
            want)

    # 5. fn_create_tournament, end to end, as the browser calls it.
    ok = {'type': 'mtt', 'name': 'Rules', 'buyIn': 10, 'startingStack': 10000, 'tableSize': 9,
          'gameVariant': 'NLH', 'payoutStructure': [{'place': 1, 'percentage': 100}],
          'lateRegistrationLevels': 8, 'payoutPercent': 15}
    refusals = [
        ('satellite without a target', {**ok, 'type': 'satellite'}, 'satellite_target_required'),
        ('rebuy with no late window', {**ok, 'isRebuy': True, 'lateRegistrationLevels': 0},
         'rebuy_requires_late_registration'),
        ('PLO6 at nine seats', {**ok, 'gameVariant': 'PLO6'}, 'table_size_exceeds_deck'),
        ('Sit And Go ladder that falls', {**ok, 'type': 'sng', 'tableSize': 6, 'blindStructure': [
            {'smallBlind': 20, 'bigBlind': 40}, {'smallBlind': 10, 'bigBlind': 20}]},
         'blind_structure_must_not_decrease'),
        ('Spin stack of 0', {**ok, 'type': 'spin', 'tableSize': 3, 'startingStack': 0},
         'starting_stack_must_be_positive'),
        ('zero payout total', {**ok, 'payoutStructure': [{'place': 1, 'percentage': 0}]}, 'payouts_must_total_100'),
    ]
    for label, cfg, code in refusals:
        probe = 'BEGIN;\n' + create(lit(cfg)) + '\nROLLBACK;'
        run('create refuses ' + label + ' and writes nothing', probe, f'{code}\n0')
    run('create refuses a start an hour ago and writes nothing',
        'BEGIN;\n' + create(f"({lit(ok)} || jsonb_build_object('startTime', now() - interval '1 hour'))")
        + '\nROLLBACK;', 'start_time_in_past\n0')
    run('an unauthenticated caller is told so first',
        "BEGIN;\nSET LOCAL ROLE authenticated;\n"
        f"SELECT public.fn_create_tournament('{CLUB}', {lit({'type': 'satellite'})})->>'error';\nROLLBACK;",
        'not_authenticated')
    run('an unauthorised caller learns nothing about the config',
        'BEGIN;\n' + create(lit({'type': 'satellite'}), DENIED_CLUB) + '\nROLLBACK;', 'not_authorised\n0')
    run('a valid event is still created, with its payout depth',
        'BEGIN;\n' + as_owner()
        + f"SELECT public.fn_create_tournament('{CLUB}', {lit(ok)})->>'success';\n"
        "SELECT payout_percent FROM public.tournaments;\nROLLBACK;", 'true\n15')
    run('rebuy and re-entry together with a late window are created',
        'BEGIN;\n' + as_owner()
        + f"SELECT public.fn_create_tournament('{CLUB}', "
        + lit({**ok, 'isRebuy': True, 'isReentry': True, 'lateRegistrationLevels': 6})
        + ")->>'success';\nROLLBACK;", 'true')
    run('a Free Buy with late registration 0 is created',
        'BEGIN;\n' + as_owner()
        + f"SELECT public.fn_create_tournament('{CLUB}', "
        + lit({**ok, 'buyIn': 0, 'isRebuy': True, 'isReentry': True, 'lateRegistrationLevels': 0})
        + ")->>'success';\nROLLBACK;", 'true')

    # 6. fn_upsert_tournament_schedule: new and changed configs are checked; unchanged ones are not.
    sched = {'clubId': CLUB, 'name': 'Weekly', 'daysOfWeek': [0], 'startTimesUtc': ['18:00']}
    for label, cfg, code in [
        ('satellite without a target', {'type': 'satellite'}, 'satellite_target_required'),
        ('re-entry with late registration 0', {'type': 'mtt', 'buyIn': 10, 'isReentry': True,
                                               'lateRegistrationLevels': 0}, 'rebuy_requires_late_registration'),
        ('PLO5 table of ten', {'type': 'mtt', 'gameVariant': 'PLO5', 'tableSize': 10}, 'table_size_exceeds_deck'),
    ]:
        run('schedule refuses ' + label + ' and writes nothing',
            'BEGIN;\n' + schedule({**sched, 'config': cfg})
            + "\nSELECT count(*) FROM public.tournament_schedules;\nROLLBACK;", '{"error": "%s"}\n0' % code)
    run('schedule accepts a satellite named by target',
        'BEGIN;\n' + schedule({**sched, 'config': {'type': 'satellite', 'satelliteTargetName': 'Sunday'}})
        + '\nROLLBACK;', '{"ok": true}')
    LEGACY = '00000000-0000-4000-a000-000000000001'
    legacy = {'type': 'satellite', 'maxPlayers': 50}
    seed = (f"INSERT INTO public.tournament_schedules (id, club_id, name, days_of_week, start_times_utc, config) "
            f"VALUES ('{LEGACY}', '{CLUB}', 'Legacy', '{{0}}', '{{18:00}}', {lit(legacy)});\n")
    run('an accepted schedule with an unchanged config can still be switched off',
        'BEGIN;\n' + seed + schedule({'id': LEGACY, 'active': False})
        + f"\nSELECT active, config = {lit(legacy)} FROM public.tournament_schedules;\nROLLBACK;",
        '{"ok": true}\nf|t')
    run('the same schedule with a changed config is checked',
        'BEGIN;\n' + seed + schedule({'id': LEGACY, 'config': {**legacy, 'maxPlayers': 60}})
        + f"\nSELECT config = {lit(legacy)} FROM public.tournament_schedules;\nROLLBACK;",
        '{"error": "satellite_target_required"}\nt')

    # 7. The validator is not a browser endpoint.
    for role in ('authenticated', 'anon'):
        run(f'{role} cannot call the validator',
            f"BEGIN;\nSET LOCAL ROLE {role};\nSELECT public.fn_tournament_config_refusal('{{}}'::jsonb, 'create');\nROLLBACK;",
            error=['permission denied', '42501'])
    run('an unknown surface is an error, not a pass',
        "SELECT public.fn_tournament_config_refusal('{}'::jsonb, 'elsewhere');", error=['unknown surface', '22023'])

    # 8. A second apply is refused and changes nothing.
    installed = run('catalogue-installed', catalogue, record=False)
    before_rows = run('rows-before-reapply', rows, record=False)
    run('reapply-refused-on-preimage-pin', installer, error=['TOURNAMENT_CREATION_RULES_PREIMAGE_CHANGED', '55000'])
    run('reapply-changed-no-function', catalogue, installed)
    run('reapply-changed-no-row', rows, before_rows)
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
