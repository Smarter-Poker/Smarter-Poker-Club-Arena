#!/usr/bin/env python3
"""A schedule keeps its time zone: migration 20260924045822 on an isolated PostgreSQL cluster.

DEPENDENCY: 20260924045822 installs on top of 20260924033701 (tournament creation refuses
what the client refuses, its own pull request), whose fn_upsert_tournament_schedule
postimage is this migration's preimage. The harness installs 033701 verbatim from
supabase/migrations/ when it is there, otherwise from --creation-rules-migration PATH; with
neither it exits 2 naming the missing migration instead of failing mid-run.

Proves, natively:
  * without 20260924033701 the migration refuses, naming it, and changes nothing;
  * the migration refuses a drifted fn_upsert_tournament_schedule preimage and installs
    the pinned postimage otherwise;
  * every creation-rule refusal 20260924033701 added still holds after it: a new or
    changed configuration the rules refuse is refused and writes nothing, and an
    unchanged accepted configuration can still be switched off;
  * every pre-existing schedule and spawn row is byte-identical afterwards, with a NULL
    zone (the original UTC contract);
  * time_zone accepts IANA Area/Location names and refuses abbreviations, POSIX strings
    and unknown names, both through the RPC and through a direct write;
  * the RPC stores, keeps (key absent), changes and clears the zone as documented;
  * the shared DST case table (scripts/ci/fixtures/schedule-time-zone/cases.json, also
    asserted by the engine's scheduleWallClock.test.ts) matches PostgreSQL's tz database
    under the same definition: the earliest instant at which the zone's wall clock reads
    at or after the scheduled local time on that date;
  * each expected spawn key claims once against the real UNIQUE(spawn_key), a re-run of
    the same poll (a restart) claims nothing, and the fall-back day has one key.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase/migrations'
CREATION_RULES_NAME = '20260924033701_tournament_creation_refuses_what_the_client_refuses.sql'
parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/schedule-time-zone')
parser.add_argument('--creation-rules-migration', type=Path, default=None,
                    help='path to ' + CREATION_RULES_NAME + ' when it is not yet in supabase/migrations/')
args = parser.parse_args()
creation_rules = args.creation_rules_migration or MIGRATIONS / CREATION_RULES_NAME
if not creation_rules.is_file():
    print('FAIL a schedule keeps its time zone (20260924045822) depends on the tournament creation rules '
          'migration 20260924033701 (tournament_creation_refuses_what_the_client_refuses), which installs '
          'before this change. Not found: %s. Merge the creation rules first, or pass '
          '--creation-rules-migration PATH.' % creation_rules, file=sys.stderr)
    sys.exit(2)
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='schedule-time-zone-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55724'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'tournament_schedules.time_zone, its validator, fn_upsert_tournament_schedule '
                    'and the shared DST occurrence/spawn-key case table; the engine computes '
                    'occurrences, this proves the zone data and the claim identity',
           'cases': [], 'passed': False}

BASE = (MIGRATIONS / '20260822100100_tournament_schedules.sql').read_text()
PREIMAGE_SOURCE = (MIGRATIONS / '20260917204152_mtt_authored_ladders_only_contain_playing_levels.sql').read_text()
INSTALLER = (MIGRATIONS / '20260924045822_a_schedule_keeps_its_time_zone.sql').read_text()
CREATION_RULES = creation_rules.read_text()
PROOFS = [m.group(1).strip() for m in re.finditer(r'^--\s*@live-proof:\s*(.+?)\s*$', INSTALLER, re.M)]
FIXTURE = (ROOT / 'scripts/ci/fixtures/schedule-time-zone/fixture.sql').read_text()
CASES = json.loads((ROOT / 'scripts/ci/fixtures/schedule-time-zone/cases.json').read_text())

ADMIN = '00000000-0000-4000-8000-0000000000a1'
STRANGER = '00000000-0000-4000-8000-0000000000b2'
CLUB = '00000000-0000-4000-8000-00000000c1ab'
LEGACY = 'aaaaaaaa-0000-4000-8000-000000000001'
LEGACY_INTERVAL = 'aaaaaaaa-0000-4000-8000-000000000002'


def command(argv, sql=None):
    return subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=60)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None, error=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    results['cases'].append({'name': name, 'passed': passed, 'expectedError': error})
    require(passed, name + ': ' + r.stdout[-800:] + r.stderr[-1500:])
    return r.stdout.rstrip('\n')


def probe(name, body, expected=None, error=None):
    """A case whose writes are always rolled back."""
    return run(name, 'BEGIN;\n' + body + '\nROLLBACK;', expected, error)


def as_user(uid):
    return f"SET LOCAL request.jwt.claim.sub = '{uid}';\n"


def rpc(payload):
    """The RPC call as an expression."""
    return "public.fn_upsert_tournament_schedule('" + json.dumps(payload).replace("'", "''") + "'::jsonb)"


def upsert(payload):
    return "SELECT " + rpc(payload)


def function_block(source, head):
    start = source.index('CREATE OR REPLACE FUNCTION public.' + head)
    end = source.index('$function$\n;', start) + len('$function$\n;')
    return source[start:end]


def upsert_function_block(source):
    return function_block(source, 'fn_upsert_tournament_schedule')


SNAPSHOT_SCHEDULES = ("SELECT jsonb_agg(jsonb_build_object('id', id, 'union_id', union_id, 'club_id', club_id, "
                      "'name', name, 'description', description, 'active', active, 'days_of_week', days_of_week, "
                      "'start_times_utc', start_times_utc, 'interval_minutes', interval_minutes, 'config', config, "
                      "'created_by', created_by, 'created_at', created_at, 'updated_at', updated_at) ORDER BY id) "
                      "FROM public.tournament_schedules;")
SNAPSHOT_SPAWNS = "SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.tournament_schedule_spawns s;"
PREIMAGE_MD5 = ("SELECT md5(prosrc) || ' ' || md5(pg_get_functiondef(oid)) FROM pg_proc "
                "WHERE oid = 'public.fn_upsert_tournament_schedule(jsonb)'::regprocedure;")
# fn_upsert_tournament_schedule as 20260917204152 left it, as 20260924033701 leaves it (this
# migration's preimage), and as this migration leaves it.
NEWEST_BEFORE_RULES = '1ba7d70943cf1553a07cb7dc1a13d6e9 b8dd7cc8e0996889a936affdc732b664'
AFTER_RULES = 'a9a78b0e15acf966d9b1e24c8236b022 f56ec7122c5a2cc2b72f5b6f13aeefbb'
AFTER_TIME_ZONE = 'c9a308e1ab8117e00cbb19868be87a6b 358f8137847a8a4a5a3f68ff387d2dc2'

try:
    version = command([pg / 'postgres', '--version']).stdout
    require(re.search(r'PostgreSQL\) 1[67]\.', version), 'PostgreSQL 16 or 17 required, got ' + version)
    results['postgres'] = version.strip()
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                 '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\n"
                "unix_socket_permissions=0700\nport=" + PORT + "\nshared_buffers='16MB'\nmax_connections=10\n"
                "timezone='UTC'\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)

    # ── The preimage, installed from the repository migrations themselves ──
    run('fixture', FIXTURE)
    run('install-base-schedules-migration', BASE)
    run('install-newest-upsert-body', upsert_function_block(PREIMAGE_SOURCE))
    run('newest-upsert-matches-20260917204152-postimage', PREIMAGE_MD5, NEWEST_BEFORE_RULES)
    # 20260924033701 also pins fn_create_tournament, so it is installed from the same
    # repository body with the authority 033701 checks. Nothing here calls it.
    run('install-newest-create-body',
        'CREATE SCHEMA IF NOT EXISTS extensions;\n' + function_block(PREIMAGE_SOURCE, 'fn_create_tournament(') +
        "\nREVOKE ALL ON FUNCTION public.fn_create_tournament(uuid, jsonb) FROM PUBLIC, anon;\n"
        "GRANT EXECUTE ON FUNCTION public.fn_create_tournament(uuid, jsonb) TO authenticated, service_role;")

    # ── The dependency: without 20260924033701 this migration refuses and changes nothing ──
    run('without-creation-rules-refuses-naming-them', INSTALLER,
        error='SCHEDULE_TIME_ZONE_REQUIRES_20260924033701')
    run('without-creation-rules-upsert-untouched', PREIMAGE_MD5, NEWEST_BEFORE_RULES)
    run('without-creation-rules-added-no-column',
        "SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.tournament_schedules'::regclass AND attname = 'time_zone';",
        '0')
    run('install-creation-rules-20260924033701', CREATION_RULES)
    run('preimage-matches-pinned-md5', PREIMAGE_MD5, AFTER_RULES)

    # Owner-approved-shaped rows written before the change: a UTC weekly row, an
    # interval row, and a spawn already claimed under the original key shape.
    run('seed-existing-utc-schedules', f"""
      INSERT INTO public.tournament_schedules
        (id, club_id, name, description, active, days_of_week, start_times_utc, interval_minutes, config, created_at, updated_at)
      VALUES
        ('{LEGACY}', '{CLUB}', 'Sunday Deep Stack', 'owner approved', true, ARRAY[0], ARRAY['01:00','19:30'], NULL,
         '{{"type":"mtt","buyIn":200}}', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
        ('{LEGACY_INTERVAL}', '{CLUB}', 'Hourly Turbo', NULL, false, ARRAY[0,1,2,3,4,5,6], '{{}}', 60,
         '{{"type":"mtt"}}', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z');
      INSERT INTO public.tournament_schedule_spawns (schedule_id, spawn_key, created_at)
      VALUES ('{LEGACY}', '{LEGACY}:2026-11-01:01:00', '2026-10-29T01:00:00Z');
    """)
    schedules_before = run('snapshot-schedules-before', SNAPSHOT_SCHEDULES)
    spawns_before = run('snapshot-spawns-before', SNAPSHOT_SPAWNS)

    # ── Drift refusal: an unknown preimage refuses the whole migration ──
    run('drifted-preimage-refuses',
        "BEGIN; ALTER FUNCTION public.fn_upsert_tournament_schedule(jsonb) SET search_path = public, pg_temp;\n"
        + INSTALLER, error='SCHEDULE_TIME_ZONE_PREIMAGE_DRIFT')
    run('refusal-left-preimage-intact', PREIMAGE_MD5, AFTER_RULES)
    run('refusal-added-no-column',
        "SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.tournament_schedules'::regclass AND attname = 'time_zone';",
        '0')

    # ── Apply ──
    run('apply', INSTALLER)
    run('postimage-pinned', PREIMAGE_MD5, AFTER_TIME_ZONE)
    require(len(PROOFS) == 3, 'expected three @live-proof lines, found %d' % len(PROOFS))
    run('live-proofs-true', ' UNION ALL '.join(
        "SELECT %d, coalesce((SELECT (%s))::text, 'null')" % (i, p) for i, p in enumerate(PROOFS)) + ' ORDER BY 1;',
        '\n'.join('%d|true' % i for i in range(len(PROOFS))))
    run('rerun-refuses-as-successor', INSTALLER, error='SCHEDULE_TIME_ZONE_PREIMAGE_DRIFT')
    require(run('existing-schedules-unchanged', SNAPSHOT_SCHEDULES) == schedules_before,
            'the migration changed an existing schedule row')
    require(run('existing-spawns-unchanged', SNAPSHOT_SPAWNS) == spawns_before,
            'the migration changed spawn history')
    run('existing-schedules-stay-utc', "SELECT count(*) FILTER (WHERE time_zone IS NULL) || '/' || count(*) FROM public.tournament_schedules;", '2/2')
    run('column-shape',
        "SELECT data_type || ' ' || is_nullable || ' ' || COALESCE(column_default, 'no-default') FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'tournament_schedules' AND column_name = 'time_zone';",
        'text YES no-default')
    run('validator-authority',
        "SELECT NOT p.prosecdef AND p.provolatile = 's' AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') "
        "AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') "
        "FROM pg_proc p WHERE p.oid = 'public.fn_schedule_time_zone_is_known(text)'::regprocedure;", 't')
    run('upsert-authority-unchanged',
        "SELECT p.prosecdef AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' "
        "FROM pg_proc p WHERE p.oid = 'public.fn_upsert_tournament_schedule(jsonb)'::regprocedure;", 't')

    # ── The validator ──
    for zone, known in [('America/Chicago', 't'), ('Europe/London', 't'), ('UTC', 't'), ('Etc/GMT+5', 't'),
                        ('America/Argentina/Buenos_Aires', 't'), ('CST', 'f'), ('UTC+3', 'f'), ('EST5EDT', 'f'),
                        ('Mars/Olympus_Mons', 'f'), ('', 'f'), ('posix/America/Chicago', 'f'),
                        ('America/Chicago ', 'f'), ('america/chicago', 'f')]:
        run('zone-' + (re.sub(r'[^A-Za-z0-9]+', '-', zone).strip('-') or 'empty') + ('-known' if known == 't' else '-refused'),
            "SELECT public.fn_schedule_time_zone_is_known('" + zone + "');", known)
    probe('direct-write-refuses-unknown-zone',
          f"INSERT INTO public.tournament_schedules (club_id, name, days_of_week, start_times_utc, config, time_zone) "
          f"VALUES ('{CLUB}', 'x', ARRAY[0], ARRAY['20:00'], '{{}}', 'CST');", error='23514')
    probe('direct-write-accepts-known-zone',
          f"INSERT INTO public.tournament_schedules (club_id, name, days_of_week, start_times_utc, config, time_zone) "
          f"VALUES ('{CLUB}', 'x', ARRAY[0], ARRAY['20:00'], '{{}}', 'Europe/London') RETURNING time_zone;", 'Europe/London')

    # ── The RPC ──
    base = {'clubId': CLUB, 'name': 'Friday 8 PM', 'daysOfWeek': [5], 'startTimesUtc': ['20:00'],
            'config': {'type': 'mtt', 'buyIn': 10}}
    probe('rpc-create-stores-local-wall-clock-and-zone', as_user(ADMIN) + "CREATE TEMP TABLE r AS " + upsert({**base, 'timeZone': ' America/Chicago '}) + " AS res;\n"
          "SELECT s.time_zone || ' ' || s.start_times_utc::text || ' ' || s.days_of_week::text FROM public.tournament_schedules s, r WHERE s.id = (r.res->>'schedule_id')::uuid;",
          'America/Chicago {20:00} {5}')
    probe('rpc-create-without-zone-is-utc', as_user(ADMIN) + "CREATE TEMP TABLE r AS " + upsert(base) + " AS res;\n"
          "SELECT COALESCE(s.time_zone, 'NULL') FROM public.tournament_schedules s, r WHERE s.id = (r.res->>'schedule_id')::uuid;",
          'NULL')
    probe('rpc-create-null-zone-is-utc', as_user(ADMIN) + "CREATE TEMP TABLE r AS " + upsert({**base, 'timeZone': None}) + " AS res;\n"
          "SELECT COALESCE(s.time_zone, 'NULL') FROM public.tournament_schedules s, r WHERE s.id = (r.res->>'schedule_id')::uuid;",
          'NULL')
    probe('rpc-create-refuses-unknown-zone', as_user(ADMIN) + "SELECT " + rpc({**base, 'timeZone': 'CST'}) + "->>'error';\n"
          "SELECT count(*) FROM public.tournament_schedules WHERE name = 'Friday 8 PM';",
          'time_zone_unknown\n0')
    zoned = ("CREATE TEMP TABLE r AS " + upsert({**base, 'timeZone': 'America/Chicago'}) + " AS res;\n"
             "CREATE TEMP VIEW z AS SELECT s.* FROM public.tournament_schedules s, r WHERE s.id = (r.res->>'schedule_id')::uuid;\n")
    for label, patch, want in [
        ('rpc-update-toggle-keeps-zone', {'active': False}, 'America/Chicago {20:00} false'),
        ('rpc-update-times-keeps-zone', {'startTimesUtc': ['21:00']}, 'America/Chicago {21:00} true'),
        ('rpc-update-changes-zone', {'timeZone': 'Europe/London'}, 'Europe/London {20:00} true'),
        ('rpc-update-null-clears-zone', {'timeZone': None}, 'UTC {20:00} true'),
    ]:
        probe(label, as_user(ADMIN) + zoned +
              "SELECT public.fn_upsert_tournament_schedule(jsonb_build_object('id', (SELECT res->>'schedule_id' FROM r)) || '"
              + json.dumps(patch) + "'::jsonb)->>'ok';\n"
              "SELECT COALESCE(time_zone, 'UTC') || ' ' || start_times_utc::text || ' ' || active FROM z;",
              'true\n' + want)
    probe('rpc-update-refuses-unknown-zone-and-keeps-row', as_user(ADMIN) + zoned +
          "SELECT public.fn_upsert_tournament_schedule(jsonb_build_object('id', (SELECT res->>'schedule_id' FROM r), 'timeZone', 'UTC+3'))->>'error';\n"
          "SELECT time_zone FROM z;",
          'time_zone_unknown\nAmerica/Chicago')
    probe('rpc-stranger-still-refused', as_user(STRANGER) + "SELECT " + rpc({**base, 'timeZone': 'America/Chicago'}) + "->>'error';",
          'not_authorised')

    # ── The creation rules of 20260924033701 still hold after this migration ──
    probe('rpc-create-still-refuses-a-satellite-without-target', as_user(ADMIN) + "SELECT " +
          rpc({**base, 'timeZone': 'America/Chicago', 'config': {'type': 'satellite'}}) + "->>'error';\n"
          "SELECT count(*) FROM public.tournament_schedules WHERE name = 'Friday 8 PM';",
          'satellite_target_required\n0')
    probe('rpc-create-still-refuses-a-deck-overflow-without-zone', as_user(ADMIN) + "SELECT " +
          rpc({**base, 'config': {'type': 'mtt', 'gameVariant': 'PLO5', 'tableSize': 10}}) + "->>'error';\n"
          "SELECT count(*) FROM public.tournament_schedules WHERE name = 'Friday 8 PM';",
          'table_size_exceeds_deck\n0')
    probe('rpc-update-still-refuses-a-changed-config-and-keeps-row', as_user(ADMIN) + zoned +
          "SELECT public.fn_upsert_tournament_schedule(jsonb_build_object('id', (SELECT res->>'schedule_id' FROM r), "
          "'timeZone', 'Europe/London', 'config', '{\"type\":\"mtt\",\"buyIn\":10,\"isReentry\":true,"
          "\"lateRegistrationLevels\":0}'::jsonb))->>'error';\n"
          "SELECT time_zone || ' ' || config::text FROM z;",
          'rebuy_requires_late_registration\nAmerica/Chicago {"type": "mtt", "buyIn": 10}')
    UNCHECKED = 'aaaaaaaa-0000-4000-8000-000000000003'
    probe('rpc-unchanged-accepted-config-still-toggles-and-takes-a-zone', as_user(ADMIN) +
          f"INSERT INTO public.tournament_schedules (id, club_id, name, days_of_week, start_times_utc, config) "
          f"VALUES ('{UNCHECKED}', '{CLUB}', 'Old Satellite', ARRAY[0], ARRAY['18:00'], '{{\"type\":\"satellite\"}}');\n"
          f"SELECT public.fn_upsert_tournament_schedule('{{\"id\":\"{UNCHECKED}\",\"active\":false,"
          f"\"timeZone\":\"America/Chicago\"}}'::jsonb)->>'ok';\n"
          f"SELECT active || ' ' || time_zone || ' ' || config::text FROM public.tournament_schedules WHERE id = '{UNCHECKED}';",
          'true\nfalse America/Chicago {"type": "satellite"}')
    probe('rpc-legacy-row-toggle-stays-utc', as_user(ADMIN) +
          f"SELECT public.fn_upsert_tournament_schedule('{{\"id\":\"{LEGACY}\",\"active\":false}}'::jsonb)->>'ok';\n"
          f"SELECT COALESCE(time_zone, 'UTC') || ' ' || start_times_utc::text FROM public.tournament_schedules WHERE id = '{LEGACY}';",
          'true\nUTC {01:00,19:30}')

    # ── The shared DST case table against PostgreSQL's tz database ──
    oracle = []
    for c in CASES['occurrences']:
        oracle.append(
            "SELECT '" + c['name'] + "', to_char(min(u) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.000\"Z\"') "
            "FROM generate_series((timestamp '" + c['localDate'] + ' ' + c['time'] + "' - interval '15 hours') AT TIME ZONE 'UTC', "
            "(timestamp '" + c['localDate'] + ' ' + c['time'] + "' + interval '15 hours') AT TIME ZONE 'UTC', interval '1 minute') u "
            "WHERE (u AT TIME ZONE '" + c['zone'] + "') >= timestamp '" + c['localDate'] + ' ' + c['time'] + "'")
    got = run('dst-case-table-matches-postgres', ' UNION ALL '.join(oracle) + ';')
    want = '\n'.join(c['name'] + '|' + c['utc'] for c in CASES['occurrences'])
    require(sorted(got.split('\n')) == sorted(want.split('\n')),
            'DST case table disagrees with PostgreSQL:\n' + got + '\nexpected:\n' + want)
    run('dst-case-zones-are-known', "SELECT bool_and(public.fn_schedule_time_zone_is_known(z)) FROM unnest(ARRAY["
        + ','.join("'" + z + "'" for z in sorted({c['zone'] for c in CASES['occurrences']})) + "]) z;", 't')

    # ── Spawn identity: each start claims once; a re-run poll claims nothing ──
    for c in CASES['spawns']:
        zone = 'NULL' if c['zone'] is None else "'" + c['zone'] + "'"
        run('schedule-row-' + c['name'],
            f"INSERT INTO public.tournament_schedules (id, club_id, name, days_of_week, start_times_utc, config, time_zone) "
            f"VALUES ('{c['scheduleId']}', '{CLUB}', '{c['name']}', ARRAY{c['daysOfWeek']}::int[], "
            f"ARRAY[{','.join(repr(t) for t in c['times'])}]::text[], '{{}}', {zone}) ON CONFLICT (id) DO NOTHING;")
    keyed = [(c['scheduleId'], e['spawnKey']) for c in CASES['spawns'] for e in c['expect']]
    require(len({k for _, k in keyed}) == len(keyed), 'case table repeats a spawn key across polls')
    values = ','.join(f"('{s}','{k}')" for s, k in keyed)
    run('first-poll-claims-every-start-once',
        f"WITH ins AS (INSERT INTO public.tournament_schedule_spawns (schedule_id, spawn_key) VALUES {values} "
        f"ON CONFLICT (spawn_key) DO NOTHING RETURNING 1) SELECT count(*) FROM ins;", str(len(keyed)))
    run('restart-re-poll-claims-nothing',
        f"WITH ins AS (INSERT INTO public.tournament_schedule_spawns (schedule_id, spawn_key) VALUES {values} "
        f"ON CONFLICT (spawn_key) DO NOTHING RETURNING 1) SELECT count(*) FROM ins;", '0')
    overlap = next(e['spawnKey'] for c in CASES['spawns'] if c['name'] == 'chicago-overlap-day-spawns-once' for e in c['expect'])
    run('fall-back-second-reading-cannot-claim-again',
        f"INSERT INTO public.tournament_schedule_spawns (schedule_id, spawn_key) VALUES "
        f"('22222222-2222-4222-8222-222222222222', '{overlap}');", error='23505')
    run('fall-back-day-has-one-spawn',
        "SELECT count(*) FROM public.tournament_schedule_spawns WHERE schedule_id = '22222222-2222-4222-8222-222222222222' "
        "AND spawn_key LIKE '%:2026-11-01:%';", '1')
    run('legacy-utc-key-still-blocks-its-respawn',
        f"INSERT INTO public.tournament_schedule_spawns (schedule_id, spawn_key) VALUES ('{LEGACY}', '{LEGACY}:2026-11-01:01:00');",
        error='23505')
    results['passed'] = True
finally:
    if (cluster / 'data/postmaster.pid').exists():
        r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        require(r.returncode == 0, 'Could not stop owned cluster: ' + r.stderr)
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    require(not (cluster / 'data/postmaster.pid').exists(), 'Owned cluster still running')
    shutil.rmtree(cluster)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']), 'evidence': str(out)}))
