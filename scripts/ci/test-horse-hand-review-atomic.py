#!/usr/bin/env python3
"""Qualify the atomic horse hand-review publication on a private socket-only PG17.

Applies supabase/migrations/20261007020953_horse_hand_review_atomic_publication.sql,
UNCHANGED, over the real prerequisites (tests/sql/fixtures/horse-hand-review-atomic/
schema.sql: both tables and the current fn_hhr_rollup_add copied from the migrations
that installed them), then proves the publication contract by reading the raw review
row, the rollup aggregate and the receipt together after every call.

No DSN, host, credentials, production fixtures, or existing cluster are accepted.
PG_BIN (or argv[1]) selects the PostgreSQL 17 binaries. TMPDIR/RUNNER_TEMP selects
scratch storage; on macOS it must be the external SSD. Must not run as root
(initdb refuses).
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/sql/fixtures/horse-hand-review-atomic'
MIGRATION = ROOT / 'supabase/migrations/20261007020953_horse_hand_review_atomic_publication.sql'
DB = 'horse_hand_review_atomic_test'
PORT = '55496'
DEADLINE_SECONDS = 300
FN = 'public.fn_hhr_record_atomic'
SIGNATURE = 'public.fn_hhr_record_atomic(jsonb)'
OLD_SIGNATURE = 'public.fn_hhr_rollup_add(uuid,date,text,boolean,numeric,text[])'


def u(seed):
    """A stable uuid per label, so a failing case names the same ids every run."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'hhr-atomic/' + seed))


def literal(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"


def row(hand, horse, **over):
    base = {
        'hand_id': hand, 'table_id': u('table'), 'tournament_id': None, 'club_id': u('club'),
        'played_at': '2026-10-06T21:15:30.125Z', 'game_variant': 'nlh', 'format': 'cash',
        'big_blind': 2, 'horse_user_id': horse, 'seat': 3, 'net_amount': 48.5, 'net_bb': 24.25,
        'pot_size': 120, 'hole_cards': [{'rank': 'A', 'suit': 's'}, {'rank': 'K', 'suit': 's'}],
        'board': [{'rank': '2', 'suit': 'h'}], 'actions': [{'userId': horse, 'action': 'raise', 'amount': 6}],
        'leak_tags': ['river_aggr_won'],
    }
    base.update(over)
    return base


def main():
    started_at = time.monotonic()
    if hasattr(os, 'geteuid') and os.geteuid() == 0:
        raise RuntimeError('Run as a non-root user: initdb refuses to run as root')
    base = Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()).resolve()
    if sys.platform == 'darwin' and not str(base).startswith('/Volumes/SmarterWork/agent-work/'):
        raise RuntimeError('Set TMPDIR to the assigned external SSD task scratch directory')
    base.mkdir(parents=True, exist_ok=True)
    pg_bin = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
    for name in ('initdb', 'pg_ctl', 'psql', 'createdb'):
        if not (pg_bin / name).is_file():
            raise RuntimeError(f'PG17 tool missing: {pg_bin / name}')
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update({'LANG': 'C', 'LC_ALL': 'C'})
    passed, failed = [], []

    with tempfile.TemporaryDirectory(prefix='hhra-', dir=base) as raw:
        work = Path(raw)
        socket_dir = work / 's'
        socket_owner = None
        if len(str(socket_dir / f'.s.PGSQL.{PORT}').encode()) >= 104:
            socket_owner = tempfile.TemporaryDirectory(prefix='hhra-', dir=base.parent)
            socket_dir = Path(socket_owner.name)
        socket_dir.mkdir(exist_ok=True)
        if len(str(socket_dir / f'.s.PGSQL.{PORT}').encode()) >= 104:
            raise RuntimeError('Assigned scratch path is too long for a private PostgreSQL Unix socket')
        data_dir = work / 'data'
        started = False

        def remaining():
            left = DEADLINE_SECONDS - (time.monotonic() - started_at)
            if left <= 0:
                raise TimeoutError(f'qualification exceeded its {DEADLINE_SECONDS}s budget')
            return min(120, left)

        def command(args, **kwargs):
            return subprocess.run([str(x) for x in args], env=env, text=True,
                                  capture_output=True, timeout=remaining(), **kwargs)

        def sql(text, succeeds=True):
            result = command([pg_bin / 'psql', '-X', '-qAt', '-h', socket_dir, '-p', PORT,
                              '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1',
                              '-v', 'VERBOSITY=verbose'], input=text)
            if succeeds and result.returncode:
                raise AssertionError(result.stderr)
            if not succeeds and not result.returncode:
                raise AssertionError('Expected refusal unexpectedly succeeded: ' + result.stdout)
            return result.stdout.strip() if succeeds else result.stderr

        def case(name, fn):
            try:
                fn()
                passed.append(name)
            except Exception as exc:  # noqa: BLE001 - every case is reported, then the run fails
                failed.append({'case': name, 'error': f'{type(exc).__name__}: {exc}'})

        def publish(rows, role='service_role', prefix=''):
            out = sql(f'{prefix}SET ROLE {role}; SELECT {FN}({literal(rows)});')
            return json.loads(out.splitlines()[-1])

        def refused(rows, code, role='service_role'):
            err = sql(f'SET ROLE {role}; SELECT {FN}({literal(rows)});', succeeds=False)
            assert f'ERROR:  P0001: {code}' in err, f'expected P0001 {code}, got: {err.strip()}'
            return err

        def snapshot():
            return json.loads(sql("""SELECT jsonb_build_object(
              'reviews', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') FROM public.horse_hand_reviews r),
              'rollup', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.horse_user_id, r.day, r.game_variant), '[]') FROM public.horse_review_rollup r),
              'receipts', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.hand_id, r.horse_user_id), '[]') FROM public.horse_hand_review_receipts r));"""))

        def rollup(horse, day='2026-10-06', variant='nlh'):
            out = sql(f"""SELECT to_jsonb(r) - 'horse_user_id' - 'updated_at' FROM public.horse_review_rollup r
                          WHERE horse_user_id='{horse}' AND day='{day}' AND game_variant='{variant}';""")
            return json.loads(out) if out else None

        def old_add(horse, r):
            """The installed fn_hhr_rollup_add, called exactly as the old writer did."""
            tags = '{' + ','.join('"' + t + '"' for t in r['leak_tags']) + '}'
            sql(f"""SET ROLE service_role; SELECT {OLD_SIGNATURE.split('(')[0]}('{horse}', '{r['played_at'][:10]}',
                    '{r['game_variant']}', {str(r['net_bb'] > 0).lower()}, {r['net_bb']}, '{tags}'::text[]);""")

        def statuses(reply):
            return [(x['horse_user_id'], x['status']) for x in reply['rows']]

        def catalog_old():
            return sql(f"""SELECT md5(pg_get_functiondef('{OLD_SIGNATURE}'::regprocedure)) || ' ' ||
                           coalesce(proacl::text, '') || ' ' || prosecdef::text || ' ' || proconfig::text
                           FROM pg_proc WHERE oid = '{OLD_SIGNATURE}'::regprocedure;""")

        try:
            for args in ([pg_bin / 'initdb', '-D', data_dir, '-U', 'postgres', '-A', 'trust'],
                         [pg_bin / 'pg_ctl', '-D', data_dir, '-l', work / 'postgres.log',
                          '-o', f"-k {socket_dir} -p {PORT} -c listen_addresses=''", '-w', 'start']):
                result = command(args)
                if result.returncode:
                    raise RuntimeError(result.stderr + result.stdout)
            started = True
            result = command([pg_bin / 'createdb', '-h', socket_dir, '-p', PORT, '-U', 'postgres', DB])
            if result.returncode:
                raise RuntimeError(result.stderr)
            assert sql(f"SELECT current_database() = '{DB}' AND inet_server_addr() IS NULL AND "
                       "current_setting('server_version_num')::int BETWEEN 170000 AND 179999;") == 't', \
                'not an isolated socket-only PostgreSQL 17'
            passed.append('isolated socket-only PostgreSQL 17')

            sql((FIXTURE / 'schema.sql').read_text())
            migration = MIGRATION.read_text()
            old_before = catalog_old()

            # ── preimage ───────────────────────────────────────────────────
            def preimage_refuses_missing_rollup_fn():
                sql(f'ALTER FUNCTION {OLD_SIGNATURE} RENAME TO fn_hhr_rollup_add_hidden;')
                try:
                    err = sql(migration, succeeds=False)
                    assert 'hhr_atomic preimage: public.fn_hhr_rollup_add' in err, err
                    assert sql("SELECT to_regclass('public.horse_hand_review_receipts') IS NULL;") == 't'
                finally:
                    sql('ALTER FUNCTION public.fn_hhr_rollup_add_hidden(uuid,date,text,boolean,numeric,text[]) '
                        'RENAME TO fn_hhr_rollup_add;')
            case('preimage refuses a missing fn_hhr_rollup_add and rolls back', preimage_refuses_missing_rollup_fn)

            sql(migration)
            passed.append('migration applies unchanged in one transaction')

            def reapply_refused():
                err = sql(migration, succeeds=False)
                assert 'hhr_atomic preimage: public.horse_hand_review_receipts already exists' in err, err
            case('reapplying the migration is refused by its preimage', reapply_refused)

            def old_function_unchanged():
                assert catalog_old() == old_before, 'fn_hhr_rollup_add definition/ACL changed'
            case('fn_hhr_rollup_add stays installed and byte-identical', old_function_unchanged)

            # ── security contract ─────────────────────────────────────────
            def function_security():
                got = json.loads(sql(f"""SELECT jsonb_build_object('definer', prosecdef, 'config', proconfig,
                    'result', pg_get_function_result(oid), 'args', pg_get_function_identity_arguments(oid),
                    'lang', (SELECT lanname FROM pg_language WHERE oid = prolang))
                    FROM pg_proc WHERE oid = '{SIGNATURE}'::regprocedure;"""))
                assert got == {'definer': True, 'result': 'jsonb', 'args': 'p_rows jsonb', 'lang': 'plpgsql',
                               'config': ['search_path=pg_catalog, pg_temp', 'lock_timeout=5s',
                                          'statement_timeout=15s']}, got
            case('function is SECURITY DEFINER with search_path=pg_catalog, pg_temp and its timeouts', function_security)

            def execute_privileges():
                got = sql(f"""SELECT has_function_privilege('anon', '{SIGNATURE}', 'EXECUTE')::text || ',' ||
                    has_function_privilege('authenticated', '{SIGNATURE}', 'EXECUTE')::text || ',' ||
                    has_function_privilege('service_role', '{SIGNATURE}', 'EXECUTE')::text;""")
                assert got == 'false,false,true', got
                for role in ('anon', 'authenticated'):
                    err = sql(f"SET ROLE {role}; SELECT {FN}({literal([row(u('x'), u('y'))])});", succeeds=False)
                    assert 'permission denied for function fn_hhr_record_atomic' in err, err
            case('anon and authenticated cannot execute; service_role can', execute_privileges)

            def receipts_closed():
                for role in ('anon', 'authenticated', 'service_role'):
                    for priv in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'):
                        got = sql(f"SELECT has_table_privilege('{role}', 'public.horse_hand_review_receipts', '{priv}');")
                        assert got == 'f', f'{role} has {priv} on receipts'
                    err = sql(f'SET ROLE {role}; SELECT count(*) FROM public.horse_hand_review_receipts;', succeeds=False)
                    assert 'permission denied for table horse_hand_review_receipts' in err, err
                    err = sql(f"""SET ROLE {role}; INSERT INTO public.horse_hand_review_receipts
                        VALUES ('{u('h')}', '{u('h')}', repeat('a', 64), 1, '2026-10-06', 'nlh');""", succeeds=False)
                    assert 'permission denied for table horse_hand_review_receipts' in err, err
                assert sql("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.horse_hand_review_receipts'::regclass;") == 't'
                assert sql("SELECT count(*) FROM pg_policy WHERE polrelid = 'public.horse_hand_review_receipts'::regclass;") == '0'
                assert sql("""SELECT count(*) FROM pg_constraint WHERE contype = 'f'
                              AND conrelid = 'public.horse_hand_review_receipts'::regclass;""") == '0'
            case('receipts: RLS on, no policy, no FK, no read/write for anon/authenticated/service_role', receipts_closed)

            # ── A. first publication ──────────────────────────────────────
            hand_a = u('hand-a')
            horse_1, horse_2 = sorted([u('horse-1'), u('horse-2')])
            twin_1, twin_2 = u('twin-1'), u('twin-2')
            rows_a = [row(hand_a, horse_2.upper(), net_bb=-31.5, net_amount=-63, seat=6,
                          leak_tags=['big_bet_fold', 'big_bet_fold', 'river_aggr_lost']),
                      row(hand_a, horse_1, tournament_id=u('t1'), format='tournament', pot_size=None, seat=None,
                          hole_cards=None, board=None, actions=None)]
            state_a = {}

            def first_call():
                reply = publish(rows_a)
                assert reply == {'version': 1, 'hand_id': hand_a,
                                 'rows': [{'horse_user_id': horse_1, 'status': 'applied'},
                                          {'horse_user_id': horse_2, 'status': 'applied'}]}, reply
                snap = snapshot()
                reviews = {r['horse_user_id']: r for r in snap['reviews'] if r['hand_id'] == hand_a}
                receipts = {r['horse_user_id']: r for r in snap['receipts'] if r['hand_id'] == hand_a}
                assert set(reviews) == set(receipts) == {horse_1, horse_2}
                for src in rows_a:
                    horse = src['horse_user_id'].lower()
                    rv, rc = reviews[horse], receipts[horse]
                    for key in ('table_id', 'tournament_id', 'club_id', 'game_variant', 'format', 'seat',
                                'hole_cards', 'board', 'actions', 'leak_tags'):
                        assert rv[key] == src[key], (key, rv[key], src[key])
                    for key in ('big_blind', 'net_amount', 'net_bb', 'pot_size'):
                        assert (rv[key] is None and src[key] is None) or float(rv[key]) == float(src[key]), key
                    assert sql(f"SELECT played_at = '2026-10-06T21:15:30.125Z'::timestamptz FROM "
                               f"public.horse_hand_reviews WHERE id = {rv['id']};") == 't', rv['played_at']
                    assert rv['is_win'] == (src['net_bb'] > 0) and rv['review_status'] == 'auto_reviewed'
                    assert rc['review_id'] == rv['id'] and rc['rollup_day'] == '2026-10-06'
                    assert rc['game_variant'] == 'nlh' and len(rc['identity_digest']) == 64
                    assert all(c in '0123456789abcdef' for c in rc['identity_digest'])
                # JSON null evidence is stored as SQL NULL, not as a jsonb 'null'.
                assert sql(f"""SELECT count(*) FROM public.horse_hand_reviews WHERE hand_id = '{hand_a}'
                               AND horse_user_id = '{horse_1}' AND hole_cards IS NULL AND board IS NULL
                               AND actions IS NULL AND pot_size IS NULL AND seat IS NULL;""") == '1'
                # The aggregate is what the installed fn_hhr_rollup_add makes of the same input.
                old_add(twin_1, rows_a[1])
                old_add(twin_2, rows_a[0])
                assert rollup(horse_1) == rollup(twin_1), (rollup(horse_1), rollup(twin_1))
                assert rollup(horse_2) == rollup(twin_2), (rollup(horse_2), rollup(twin_2))
                assert rollup(horse_2)['leak_counts'] == {'big_bet_fold': 2, 'river_aggr_lost': 1}
                assert rollup(horse_2)['big_losses'] == 1 and rollup(horse_1)['big_wins'] == 1
                state_a['snap'] = snapshot()
            case('A first call: review rows, rollup and receipts present and consistent; upper-case id canonicalised',
                 first_call)

            # ── B. exact replay ────────────────────────────────────────────
            def exact_replay():
                reply = publish(rows_a)
                assert statuses(reply) == [(horse_1, 'replayed'), (horse_2, 'replayed')], reply
                assert snapshot() == state_a['snap'], 'replay changed rows/aggregate/receipts'
                # Same content, reversed input order and different letter case: still the same publication.
                flipped = [dict(rows_a[1], horse_user_id=horse_1.upper()), dict(rows_a[0], horse_user_id=horse_2)]
                assert statuses(publish(flipped)) == [(horse_1, 'replayed'), (horse_2, 'replayed')]
                assert snapshot() == state_a['snap']
            case('B exact replay answers replayed and changes nothing (order and case independent)', exact_replay)

            # ── C. replay after the 30-day prune ──────────────────────────
            def replay_after_prune():
                sql(f"DELETE FROM public.horse_hand_reviews WHERE hand_id = '{hand_a}';")
                pruned = snapshot()
                reply = publish(rows_a)
                assert statuses(reply) == [(horse_1, 'replayed'), (horse_2, 'replayed')], reply
                after = snapshot()
                assert after == pruned, 'replay after prune wrote something'
                assert not [r for r in after['reviews'] if r['hand_id'] == hand_a], 'review re-inserted'
                assert after['rollup'] == state_a['snap']['rollup'], 'aggregate moved'
            case('C replay after the review rows are pruned: replayed, no re-insert, aggregate unchanged',
                 replay_after_prune)

            # ── D. identity conflict ──────────────────────────────────────
            hand_d = u('hand-d')
            horse_lo, horse_hi = sorted([u('horse-d-1'), u('horse-d-2')])

            def identity_conflict():
                publish([row(hand_d, horse_hi)])
                before = snapshot()
                for change in ({'net_bb': 24.26}, {'leak_tags': []}, {'played_at': '2026-10-06T21:15:30.126Z'},
                               {'seat': 4}, {'game_variant': 'plo'}):
                    refused([row(hand_d, horse_hi, **change)], 'hhr_identity_conflict')
                    assert snapshot() == before, change
                # The conflict is on the LAST horse processed, after the first horse's review,
                # rollup and receipt were written inside the call: all of it must roll back.
                refused([row(hand_d, horse_hi, net_bb=99), row(hand_d, horse_lo)], 'hhr_identity_conflict')
                assert snapshot() == before, 'earlier horse persisted after a later conflict'
                # Evidence payloads are not identity: a resend with re-serialised evidence is a replay.
                assert statuses(publish([row(hand_d, horse_hi, actions=[], board=None)])) == [(horse_hi, 'replayed')]
                assert snapshot() == before
            case('D changed immutable content refused P0001 hhr_identity_conflict; written rows roll back',
                 identity_conflict)

            # ── E. invalid row late in a payload ──────────────────────────
            hand_e = u('hand-e')

            def invalid_late_row():
                before = snapshot()
                good = [row(hand_e, u('horse-e-1')), row(hand_e, u('horse-e-2'))]
                bad_rows = [
                    ({'net_bb': 'abc'}, 'hhr_invalid_number'),
                    ({'net_bb': None}, 'hhr_invalid_number'),
                    ({'net_bb': 0}, 'hhr_invalid_net_bb'),
                    ({'big_blind': 0}, 'hhr_invalid_big_blind'),
                    ({'horse_user_id': 'not-a-uuid'}, 'hhr_invalid_value'),
                    ({'played_at': '2026-10-06T21:15:30'}, 'hhr_invalid_played_at'),
                    ({'played_at': 'infinity'}, 'hhr_invalid_played_at'),
                    ({'played_at': '2026-10-06'}, 'hhr_invalid_played_at'),
                    ({'played_at': '2026-02-30T00:00:00Z'}, 'hhr_invalid_value'),
                    ({'leak_tags': 'river'}, 'hhr_invalid_leak_tags'),
                    ({'leak_tags': ['ok', 3]}, 'hhr_invalid_leak_tags'),
                    ({'hand_id': u('other-hand')}, 'hhr_mixed_hand'),
                    ({'seat': 2.5}, 'hhr_invalid_value'),
                    ({'game_variant': ' '}, 'hhr_invalid_label'),
                ]
                for change, code in bad_rows:
                    refused(good + [row(hand_e, u('horse-e-3'), **change)], code)
                    assert snapshot() == before, change
                extra = dict(row(hand_e, u('horse-e-3')), is_win=True)
                refused(good + [extra], 'hhr_row_keys')
                missing = row(hand_e, u('horse-e-3'))
                del missing['leak_tags']
                refused(good + [missing], 'hhr_row_keys')
                refused({'rows': good}, 'hhr_payload_not_array')
                refused([], 'hhr_payload_size')
                refused([row(hand_e, u(f'many-{i}')) for i in range(11)], 'hhr_payload_size')
                refused(good + ['not an object'], 'hhr_row_not_object')
                assert snapshot() == before
            case('E an invalid row late in a multi-horse payload refuses P0001 and persists nothing', invalid_late_row)

            # ── F. temp-table shadowing ───────────────────────────────────
            hand_f = u('hand-f')

            def temp_shadow_ignored():
                out = sql(f"""SET ROLE service_role;
                    CREATE TEMP TABLE horse_hand_reviews (LIKE public.horse_hand_reviews);
                    CREATE TEMP TABLE horse_review_rollup (LIKE public.horse_review_rollup);
                    CREATE TEMP TABLE horse_hand_review_receipts (hand_id uuid, horse_user_id uuid,
                      identity_digest text, review_id bigint, rollup_day date, game_variant text,
                      applied_at timestamptz);
                    SET search_path = pg_temp, public;
                    SELECT {FN}({literal([row(hand_f, u('horse-f'))])}) ->> 'hand_id';
                    SELECT (SELECT count(*) FROM pg_temp.horse_hand_reviews) + (SELECT count(*) FROM pg_temp.horse_review_rollup)
                         + (SELECT count(*) FROM pg_temp.horse_hand_review_receipts);""").splitlines()
                assert out == [hand_f, '0'], out
                snap = snapshot()
                assert [r for r in snap['reviews'] if r['hand_id'] == hand_f]
                assert [r for r in snap['receipts'] if r['hand_id'] == hand_f]
                assert rollup(u('horse-f')) is not None
            case('F caller temp tables named like the real ones are ignored; real tables receive the writes',
                 temp_shadow_ignored)

            # ── G. mixed-case duplicates ──────────────────────────────────
            def mixed_case_duplicate():
                before = snapshot()
                horse = u('horse-g')
                refused([row(u('hand-g'), horse), row(u('hand-g'), horse.upper())], 'hhr_duplicate_horse')
                assert snapshot() == before
                reply = publish([row(u('hand-g2'), horse.upper())])
                assert statuses(reply) == [(horse, 'applied')], reply
                assert sql(f"SELECT horse_user_id FROM public.horse_hand_review_receipts WHERE hand_id = '{u('hand-g2')}';") == horse
            case('G mixed-case duplicate horse ids refused hhr_duplicate_horse; upper case canonicalised',
                 mixed_case_duplicate)

            # ── H. legacy row with no receipt ─────────────────────────────
            def legacy_unknown():
                hand_h, legacy, fresh = u('hand-h'), u('horse-h-legacy'), u('horse-h-fresh')
                sql(f"""INSERT INTO public.horse_hand_reviews (hand_id, table_id, played_at, game_variant, format,
                        big_blind, horse_user_id, net_amount, net_bb, leak_tags)
                        VALUES ('{hand_h}', '{u('table')}', '2026-10-06T21:15:30.125Z', 'nlh', 'cash', 2,
                                '{legacy}', 48.5, 24.25, ARRAY['river_aggr_won']);""")
                old_add(legacy, row(hand_h, legacy))  # its history: maybe applied, maybe not
                before = snapshot()
                reply = publish([row(hand_h, legacy)])
                assert statuses(reply) == [(legacy, 'historical_unknown')], reply
                assert snapshot() == before, 'historical_unknown wrote something'
                # Mixed with a new horse in the same hand: only the new horse is applied.
                reply = publish([row(hand_h, legacy), row(hand_h, fresh)])
                assert dict(statuses(reply)) == {legacy: 'historical_unknown', fresh: 'applied'}, reply
                after = snapshot()
                assert [r for r in after['rollup'] if r['horse_user_id'] == legacy] == \
                       [r for r in before['rollup'] if r['horse_user_id'] == legacy]
                assert not [r for r in after['receipts'] if r['horse_user_id'] == legacy]
                assert len([r for r in after['reviews'] if r['hand_id'] == hand_h]) == 2
            case('H a legacy review row with no receipt answers historical_unknown and writes nothing', legacy_unknown)

            # ── I. concurrent writers ─────────────────────────────────────
            def concurrent_writers():
                a, b = sorted([u('race-a'), u('race-b')])
                # Fixture instrumentation: widen every rollup write so a wrong lock
                # order between two writers would deadlock rather than race past.
                sql("""CREATE FUNCTION public.zz_fixture_slow_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
                       BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END $$;
                       CREATE TRIGGER zz_fixture_slow_rollup BEFORE INSERT OR UPDATE ON public.horse_review_rollup
                       FOR EACH ROW EXECUTE FUNCTION public.zz_fixture_slow_rollup();""")
                try:
                    hands = [u(f'race-hand-{i}') for i in range(6)]
                    nets = [21.5, -33.25, 40.75, -22.0, 25.5, -60.125]
                    # pre-create both rollup rows so every writer contends on the same row locks
                    publish([row(u('race-seed'), a, net_bb=20.0), row(u('race-seed'), b, net_bb=20.0)])

                    def write(i):
                        pair = [row(hands[i], a, net_bb=nets[i], leak_tags=['t1', 't2']),
                                row(hands[i], b.upper(), net_bb=-nets[i], leak_tags=['t1'])]
                        if i % 2:
                            pair.reverse()
                        out = sql(f"""SET ROLE service_role; BEGIN; SELECT {FN}({literal(pair)});
                                      SELECT pg_sleep(0.05); COMMIT;""").splitlines()
                        return json.loads(next(line for line in out if line.startswith('{')))

                    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                        replies = list(pool.map(write, range(6)))
                    for reply in replies:
                        assert statuses(reply) == [(a, 'applied'), (b, 'applied')], reply
                    ra, rb = rollup(a), rollup(b)
                    exp_a = round(20.0 + sum(nets), 4)
                    exp_b = round(20.0 - sum(nets), 4)
                    assert round(float(ra['sum_net_bb']), 4) == exp_a, (ra, exp_a)
                    assert round(float(rb['sum_net_bb']), 4) == exp_b, (rb, exp_b)
                    assert ra['big_wins'] + ra['big_losses'] == 7 and rb['big_wins'] + rb['big_losses'] == 7
                    assert ra['leak_counts'] == {'river_aggr_won': 1, 't1': 6, 't2': 6}, ra
                    assert rb['leak_counts'] == {'river_aggr_won': 1, 't1': 6}, rb
                    assert sql(f"""SELECT count(*) FROM public.horse_hand_review_receipts
                                   WHERE horse_user_id IN ('{a}', '{b}');""") == '14'

                    # The same hand raced by two writers: one applies, the other waits on the
                    # unique index, re-reads the committed receipt and answers replayed.
                    same = [row(u('race-same'), a, net_bb=30.0), row(u('race-same'), b, net_bb=-30.0)]

                    def same_write(delay):
                        time.sleep(delay)
                        out = sql(f"""SET ROLE service_role; BEGIN; SELECT {FN}({literal(same)});
                                      SELECT pg_sleep(1.0); COMMIT;""").splitlines()
                        return json.loads(next(line for line in out if line.startswith('{')))

                    before_a = rollup(a)
                    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                        got = list(pool.map(same_write, [0.0, 0.25]))
                    kinds = sorted(statuses(r)[0][1] for r in got)
                    assert kinds == ['applied', 'replayed'], got
                    assert round(float(rollup(a)['sum_net_bb']) - float(before_a['sum_net_bb']), 4) == 30.0
                finally:
                    sql('DROP TRIGGER zz_fixture_slow_rollup ON public.horse_review_rollup; '
                        'DROP FUNCTION public.zz_fixture_slow_rollup();')
            case('I concurrent writers sharing two horses in reversed order: no deadlock, exact sum; '
                 'same-hand race applies once', concurrent_writers)

            # ── J. arithmetic equivalence with fn_hhr_rollup_add ──────────
            def arithmetic_equivalence():
                horse, twin = u('eq-horse'), u('eq-twin')
                series = [
                    dict(net_bb=20.555, leak_tags=['x', 'x', 'y']),
                    dict(net_bb=-21.004, leak_tags=['y', 'z']),
                    dict(net_bb=33.3333, leak_tags=[]),
                    dict(net_bb=-0.005, leak_tags=['x']),
                    dict(net_bb=1e-3, leak_tags=['z', 'x', 'z']),
                    dict(net_bb=-45.5, leak_tags=['q'], game_variant='plo'),
                    dict(net_bb=22.0, leak_tags=['x'], played_at='2026-10-07T00:00:00.000Z'),
                    dict(net_bb=-25.75, leak_tags=['x'], played_at='2026-10-06T23:59:59.999999Z'),
                ]
                for i, change in enumerate(series):
                    r = row(u(f'eq-hand-{i}'), horse, **change)
                    publish([r])
                    old_add(twin, r)
                compare = f"""SELECT coalesce(jsonb_agg(to_jsonb(r) - 'horse_user_id' - 'updated_at'
                              ORDER BY day, game_variant), '[]') FROM public.horse_review_rollup r
                              WHERE horse_user_id = '%s';"""
                mine, theirs = json.loads(sql(compare % horse)), json.loads(sql(compare % twin))
                assert mine == theirs, (mine, theirs)
                assert len(mine) == 3, mine
                # Rollup day follows played_at in UTC, whatever the session TimeZone.
                tz_horse = u('tz-horse')
                publish([row(u('tz-hand'), tz_horse, played_at='2026-10-06T23:30:00.000Z')],
                        prefix="SET TimeZone = 'Pacific/Auckland'; ")
                assert rollup(tz_horse, day='2026-10-06') is not None
                assert sql(f"SELECT rollup_day FROM public.horse_hand_review_receipts WHERE hand_id = '{u('tz-hand')}';") == '2026-10-06'
            case('J rollup arithmetic equals the installed fn_hhr_rollup_add (rounding, repeated tags, days, variants)',
                 arithmetic_equivalence)

            case('fn_hhr_rollup_add still byte-identical after every case', old_function_unchanged)
        finally:
            if started or (data_dir / 'postmaster.pid').exists():
                result = subprocess.run([str(pg_bin / 'pg_ctl'), '-D', str(data_dir), '-m', 'fast', '-w', 'stop'],
                                        env=env, text=True, capture_output=True, timeout=60)
                if result.returncode:
                    print('Private PostgreSQL cleanup failed: ' + result.stderr, file=sys.stderr)
            if socket_owner:
                socket_owner.cleanup()

    print(json.dumps({'status': 'failed' if failed else 'passed', 'checks': passed, 'checkCount': len(passed),
                      'failures': failed,
                      'migration': str(MIGRATION.relative_to(ROOT)),
                      'migrationSHA256': hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
                      'seconds': round(time.monotonic() - started_at, 1),
                      'boundary': 'isolated PostgreSQL 17; no production mutation'}, indent=2))
    print(f"\n{'FAIL' if failed else 'PASS'}: {len(passed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
