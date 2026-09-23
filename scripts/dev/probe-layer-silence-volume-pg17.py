#!/usr/bin/env python3
"""PostgreSQL 17 replay of fn_audit_layer_drift on production's 2026-09-20 rows.

Builds a throwaway cluster on a private Unix socket, installs the definition
production holds (read from the migration that last defined it, and refused
unless its pg_get_functiondef md5 is production's), replays the real
2026-09-13..20 telemetry and bomb-pot volume from
scripts/dev/fixtures/layer-silence-volume/, and runs the old rule and the new
one (supabase/migrations/*_layer_silence_is_measured_against_its_own_volume.sql)
over the same rows.

What it proves, on production's numbers for the day the 2026-09-20 audit named:
the four *_reason_multiboard_owned_by_phase13 counters of plo4, plo6, plo8 and
pineapple stop being layer_went_silent (their variants dealt zero bomb pots),
while the Phase 15 journal and Phase 8 counters are still reported. It reads
no database URL and has no TCP listener, so it cannot reach production.
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/dev/fixtures/layer-silence-volume/production-2026-09-13-to-2026-09-20.sql'
BASELINE = ROOT / 'supabase/migrations/20260912101626_audit_detectors_name_what_they_cannot_tell.sql'
CANDIDATES = sorted((ROOT / 'supabase/migrations').glob('*_layer_silence_is_measured_against_its_own_volume.sql'))

# pg_get_functiondef md5 of public.fn_audit_layer_drift(date) as production held
# it on 2026-09-22 (read-only query against project kuklfnapbkmacvwxktbh).
PRODUCTION_MD5 = 'deec72616a6dbf948253a5b519250977'
TELEMETRY_DIGEST = '7af2f1cccd68ea23b4505c28fa4c8e0a'
BOMB_DIGEST = '599f8d5e822028b65b0335e44d83b04b'
DAY = '2026-09-20'

FOUR = [
    'phase10_reason_multiboard_owned_by_phase13',
    'phase11_plo6_reason_multiboard_owned_by_phase13',
    'phase11_plo8_reason_multiboard_owned_by_phase13',
    'phase12_pineapple_reason_multiboard_owned_by_phase13',
]
PHASE15 = {
    'phase15_journal_enqueued': 287973.5,
    'phase15_journal_recorded': 287957.5,
    'phase15_journal_queue_capacity': 29913.4,
}
PHASE8 = {
    'phase8_reason_unsupported_variant': 251.8,
    'phase8_eligible': 88.0,
    'phase8_reason_continuation_operation_budget': 80.2,
}

checks = []


def check(name, passed, detail=None):
    checks.append({'name': name, 'passed': bool(passed), **({'detail': detail} if detail is not None else {})})


def pg_bin():
    choices = [os.environ.get('PG_BIN'), '/usr/lib/postgresql/17/bin', '/opt/homebrew/opt/postgresql@17/bin']
    for choice in choices:
        if choice and (pathlib.Path(choice) / 'initdb').is_file():
            return pathlib.Path(choice)
    raise RuntimeError('PostgreSQL 17 tools required; set PG_BIN. Nothing was installed.')


def definition(source, name):
    match = re.search(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1;', source, re.S)
    if not match:
        raise ValueError('no definition of ' + name + ' found')
    return match.group(0)


def main():
    if len(CANDIDATES) != 1:
        raise RuntimeError('expected exactly one *_layer_silence_is_measured_against_its_own_volume.sql, found %d' % len(CANDIDATES))
    candidate = CANDIDATES[0]
    pg = pg_bin()
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update({'LC_ALL': 'C', 'LANG': 'C', 'TZ': 'UTC'})
    runtime = pathlib.Path(tempfile.mkdtemp(prefix='layer-silence-'))
    runtime.chmod(0o700)
    data = runtime / 'data'
    sock = runtime / 'socket'
    sock.mkdir(mode=0o700)
    port = str(46000 + os.getpid() % 9000)
    started = False

    def command(args, sql=None, allow_fail=False):
        result = subprocess.run([str(a) for a in args], input=sql, text=True, capture_output=True, env=env, timeout=120)
        if result.returncode and not allow_fail:
            raise RuntimeError(' '.join(str(a) for a in args[:1]) + ': ' + result.stderr)
        return result

    psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', port, '-U', 'postgres', '-d', 'postgres']

    def run(sql):
        return command(psql, sql).stdout.strip()

    def findings():
        rows = json.loads(run("SELECT fn_audit_layer_drift('%s')::text" % DAY))
        silent = {f['evidence']['feature']: f for f in rows if f['code'] == 'layer_went_silent'}
        quiet = [f for f in rows if f['code'] == 'layer_quiet_at_low_volume']
        listed = {x['feature']: x for q in quiet for x in q['evidence']['features']}
        return silent, quiet, listed

    try:
        version = command([pg / 'postgres', '--version']).stdout
        check('postgres-17', version.startswith('postgres (PostgreSQL) 17.'), version.strip())
        command([pg / 'initdb', '-D', data, '-U', 'postgres', '--auth=trust', '--no-locale', '-E', 'UTF8'])
        command([pg / 'pg_ctl', '-D', data, '-l', runtime / 'server.log', '-o',
                 f"-k {sock} -p {port} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                 '-w', 'start'])
        started = True
        # Only the relations the function reads, shaped as production has them.
        run("""
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE horse_brain_telemetry (day date NOT NULL, feature text NOT NULL, fires bigint NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (day, feature));
        CREATE TABLE hand_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz,
          game_variant text, bomb_pot jsonb, has_human boolean);
        CREATE INDEX idx_hand_history_bomb_pot_created ON hand_history (created_at) WHERE bomb_pot IS NOT NULL;
        CREATE TABLE hand_history_retention_policy (id boolean PRIMARY KEY DEFAULT true, horse_retention_days integer,
          updated_at timestamptz DEFAULT now(), note text);
        CREATE TABLE fixture_bomb_pot_hands (day date, variant text, hands bigint);
        CREATE TABLE fixture_layer_silent (feature text);
        -- fn_audit_layer_silence returned no layer_silent finding for 2026-09-20
        -- in production; the stub returns whatever fixture_layer_silent holds.
        CREATE FUNCTION fn_audit_layer_silence(p_day date) RETURNS jsonb LANGUAGE sql STABLE AS $$
          SELECT coalesce(jsonb_agg(jsonb_build_object('code', 'layer_silent', 'evidence', jsonb_build_object('feature', feature))), '[]'::jsonb)
            FROM fixture_layer_silent $$;
        """)
        run(FIXTURE.read_text())
        check('fixture-telemetry-is-production',
              run("SELECT md5(string_agg(day || ',' || feature || ',' || fires, ';' ORDER BY day, feature)) FROM horse_brain_telemetry") == TELEMETRY_DIGEST)
        check('fixture-bomb-pots-are-production',
              run("SELECT md5(string_agg(day || ',' || variant || ',' || hands, ';' ORDER BY day, variant)) FROM fixture_bomb_pot_hands") == BOMB_DIGEST)
        # One hand_history row per bomb-pot hand, at noon UTC on its day, plus
        # hands that were NOT bomb pots, which must not count as volume.
        run("""
        INSERT INTO hand_history (created_at, game_variant, bomb_pot, has_human)
        SELECT (b.day + time '12:00') AT TIME ZONE 'UTC', b.variant, '{"anteMultiplier": 2}'::jsonb, false
          FROM fixture_bomb_pot_hands b, generate_series(1, b.hands);
        INSERT INTO hand_history (created_at, game_variant, bomb_pot, has_human)
        SELECT timestamptz '2026-09-20 12:00+00', v, NULL, false
          FROM unnest(array['plo4', 'plo6', 'plo8', 'pineapple']) v, generate_series(1, 500);
        """)
        # hand_history holds 2026-09-15 onward in full, as it did when these
        # rows were read: the first held day is (today - retention) + 1.
        run("INSERT INTO hand_history_retention_policy (horse_retention_days) "
            "SELECT (now() AT TIME ZONE 'UTC')::date - date '2026-09-14'")

        # THE RULE PRODUCTION RUNS
        run(definition(BASELINE.read_text(), 'fn_audit_layer_drift'))
        run("REVOKE ALL ON FUNCTION public.fn_audit_layer_drift(date) FROM PUBLIC, anon, authenticated;"
            "GRANT EXECUTE ON FUNCTION public.fn_audit_layer_drift(date) TO service_role;")
        live = run("SELECT md5(pg_get_functiondef('public.fn_audit_layer_drift(date)'::regprocedure))")
        check('baseline-is-exactly-production', live == PRODUCTION_MD5, live)
        old_silent, old_quiet, _ = findings()
        for f in FOUR:
            check('old-rule-false-silence-' + f, f in old_silent)
        for f in list(PHASE15) + list(PHASE8):
            check('old-rule-reports-' + f, f in old_silent)
        check('old-rule-reports-the-aggregate', 'phase11_reason_canonical_state_unavailable' in old_silent)
        check('old-rule-has-no-quiet-note', not old_quiet)
        check('old-rule-exact-warn-set', set(old_silent) == set(FOUR) | set(PHASE15) | set(PHASE8) | {
            'phase11_reason_canonical_state_unavailable', 'phase11_plo5_reason_canonical_state_unavailable',
            'phase11_plo6_reason_canonical_state_unavailable', 'phase11_plo8_reason_canonical_state_unavailable',
            'phase8_fired', 'phase8_completed', 'phase8_reason_budget_exhausted', 'v41_limp_bloat_read'},
              sorted(old_silent))

        # THE RULE THIS PULL REQUEST SHIPS, applied as the migration file is
        # written (its own BEGIN/COMMIT), twice.
        for attempt in (1, 2):
            command(psql + ['-f', candidate])
        new_silent, new_quiet, listed = findings()
        for f in FOUR:
            check('new-rule-no-silence-' + f, f not in new_silent)
            q = listed.get(f)
            check('new-rule-quiet-at-zero-bomb-pots-' + f,
                  q is not None and q['volume_basis'] == 'bomb_pot_hands' and q['volume_today'] == 0 and float(q['expected_today']) == 0,
                  q)
        for f, expected in PHASE15.items():
            e = new_silent.get(f, {}).get('evidence', {})
            check('new-rule-still-silent-' + f,
                  f in new_silent and e.get('volume_basis') == 'decides' and e.get('volume_today') == 914234
                  and abs(float(e.get('expected_today', -1)) - expected) <= 0.1 and float(e.get('p_zero', 1)) == 0, e)
        for f, expected in PHASE8.items():
            e = new_silent.get(f, {}).get('evidence', {})
            check('new-rule-still-silent-' + f,
                  f in new_silent and e.get('volume_basis') == 'tournament_postflop_decides' and e.get('volume_today') == 82426
                  and abs(float(e.get('expected_today', -1)) - expected) <= 0.1, e)
        # The line at twelve, on the two counters nearest it that day.
        e = new_silent.get('v41_limp_bloat_read', {}).get('evidence', {})
        check('new-rule-silent-above-twelve-v41_limp_bloat_read',
              abs(float(e.get('expected_today', -1)) - 15.1) <= 0.1, e)
        q = listed.get('phase8_reason_budget_exhausted')
        check('new-rule-quiet-below-twelve-phase8_reason_budget_exhausted',
              'phase8_reason_budget_exhausted' not in new_silent and q is not None and abs(float(q['expected_today']) - 6.45) <= 0.01, q)
        for f in ('phase8_fired', 'phase8_completed'):
            q = listed.get(f)
            check('new-rule-quiet-' + f, f not in new_silent and q is not None and abs(float(q['expected_today']) - 1.13) <= 0.01, q)
        check('new-rule-aggregate-judged-through-its-parts',
              'phase11_reason_canonical_state_unavailable' not in new_silent
              and 'phase11_reason_canonical_state_unavailable' not in listed
              and all(p in listed for p in ('phase11_plo5_reason_canonical_state_unavailable',
                                            'phase11_plo6_reason_canonical_state_unavailable',
                                            'phase11_plo8_reason_canonical_state_unavailable')))
        check('new-rule-one-quiet-note', len(new_quiet) == 1 and new_quiet[0]['severity'] == 'note'
              and new_quiet[0]['evidence']['bomb_pot_volume_held_from'] == '2026-09-15', new_quiet[0]['evidence'].get('bomb_pot_volume_held_from') if new_quiet else None)
        check('new-rule-exact-warn-set', set(new_silent) == set(PHASE15) | set(PHASE8) | {'v41_limp_bloat_read'},
              sorted(new_silent))
        check('new-rule-exact-quiet-set', set(listed) == set(FOUR) | {
            'phase11_plo5_reason_canonical_state_unavailable', 'phase11_plo6_reason_canonical_state_unavailable',
            'phase11_plo8_reason_canonical_state_unavailable', 'phase8_fired', 'phase8_completed',
            'phase8_reason_budget_exhausted'}, sorted(listed))

        # VOLUME COMES BACK AND THE COUNTER STILL READS ZERO: that is a silence.
        run("INSERT INTO hand_history (created_at, game_variant, bomb_pot, has_human) "
            "SELECT timestamptz '2026-09-20 12:00+00', 'plo4', '{}'::jsonb, false FROM generate_series(1, 606)")
        s, _, _ = findings()
        e = s.get('phase10_reason_multiboard_owned_by_phase13', {}).get('evidence', {})
        check('new-rule-silent-when-bomb-pots-return', e.get('volume_today') == 606
              and abs(float(e.get('expected_today', -1)) - 27173 * 606 / 3192) <= 0.1, e)
        check('new-rule-other-variants-unaffected', all(f not in s for f in FOUR[1:]))
        run("DELETE FROM hand_history WHERE game_variant = 'plo4' AND bomb_pot = '{}'::jsonb")

        # A DAY hand_history NO LONGER HOLDS IN FULL IS "COULD NOT TELL".
        run("UPDATE hand_history_retention_policy SET horse_retention_days = 1")
        s, _, listed = findings()
        check('new-rule-unheld-day-is-not-silent', all(f not in s for f in FOUR))
        check('new-rule-unheld-day-says-so', all(f in listed and listed[f]['volume_today'] is None for f in FOUR),
              {f: listed.get(f) for f in FOUR})
        run("UPDATE hand_history_retention_policy SET horse_retention_days = (now() AT TIME ZONE 'UTC')::date - date '2026-09-14'")

        # fn_audit_layer_silence still owns what it already reported.
        run("INSERT INTO fixture_layer_silent VALUES ('phase15_journal_enqueued')")
        s, _, listed = findings()
        check('new-rule-defers-to-layer-silence', 'phase15_journal_enqueued' not in s and 'phase15_journal_enqueued' not in listed
              and 'phase15_journal_recorded' in s)
        run("DELETE FROM fixture_layer_silent")

        # Authority is what production holds: owner, definer, volatility,
        # search_path, and EXECUTE for postgres and service_role only.
        meta = json.loads(run("""
        SELECT jsonb_build_object('owner', pg_get_userbyid(proowner), 'definer', prosecdef, 'volatile', provolatile,
          'config', proconfig, 'acl', proacl::text, 'result', pg_get_function_result(oid),
          'anon', has_function_privilege('anon', oid, 'EXECUTE'),
          'authenticated', has_function_privilege('authenticated', oid, 'EXECUTE'),
          'service_role', has_function_privilege('service_role', oid, 'EXECUTE'))
          FROM pg_proc WHERE oid = 'public.fn_audit_layer_drift(date)'::regprocedure"""))
        check('authority-unchanged', meta == {
            'owner': 'postgres', 'definer': True, 'volatile': 's', 'config': ['search_path=public'],
            'acl': '{postgres=X/postgres,service_role=X/postgres}', 'result': 'jsonb',
            'anon': False, 'authenticated': False, 'service_role': True}, meta)
        check('one-signature', run("SELECT count(*) FROM pg_proc WHERE proname = 'fn_audit_layer_drift'") == '1')
    finally:
        if started:
            command([pg / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'], allow_fail=True)
        shutil.rmtree(runtime, ignore_errors=True)

    failed = [c for c in checks if not c['passed']]
    for c in checks:
        print(('PASS  ' if c['passed'] else 'FAIL  ') + c['name'])
    print(json.dumps({'passed': len(checks) - len(failed), 'failed': len(failed), 'failures': failed}, indent=2))
    if failed:
        return 1
    print('layer silence probe: every check passed on production 2026-09-20 rows')
    return 0


if __name__ == '__main__':
    sys.exit(main())
