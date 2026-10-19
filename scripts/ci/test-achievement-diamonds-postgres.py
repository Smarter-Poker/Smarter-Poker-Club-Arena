#!/usr/bin/env python3
"""Native PostgreSQL certification of achievement diamonds (2026-10-19).

Dan, 2026-10-19: "Pay achievement rewards as diamonds through
award_diamonds_v2." and "NO, ONLY FROM NOW ON" (no back-pay).

This installs, on a throwaway private cluster (no TCP listener, trust auth over
a temporary unix socket, never a provider), the bodies production runs today -
award_diamonds_v2 from the newest migration that defines it, and the pre-image
fn_achievement_record_progress / fn_notify_achievement_unlocked exactly as the
production schema capture holds them (their 2026-08-30 migrations with the
comments stripped, which is how they were installed) - then applies
20261019155445 BYTE FOR BYTE, including its pre-image md5 guards, and proves:

  * a browser cannot unlock anything by sending its own target, cannot write an
    unknown id, and cannot write an achievement the server proves;
  * a hand the engine records with a winning Royal Flush (strong_hands = 10)
    unlocks royal_flush and pays 500 diamonds once, horses alike, through
    award_diamonds_v2 under achievement:royal_flush:<user>; a second Royal
    Flush pays nothing; a straight flush pays nothing; a malformed event list
    never fails the hand;
  * the login streak is counted by the server: the 30th day pays streak_30
    100 once, a second visit the same day writes nothing, a broken run restarts
    at 1, and a browser can no longer write the streak columns;
  * an achievement unlocked before the migration is never paid (no back-pay);
  * an issuance freeze leaves the achievement unearned (and the hand intact),
    so the next qualifying event pays it;
  * the unlock notification carries the diamonds actually credited.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase/migrations'
MIGRATION = MIGRATIONS / '20261019155445_achievements_pay_diamonds_from_server_evidence.sql'
# The production schema capture already in this repo (pg_dump of the live
# database). Its two achievement bodies are byte-identical to production's
# (md5(prosrc) e3055777... and 0ad6dc7f..., read 2026-10-19).
CAPTURE = ROOT / ('scripts/ci/probes/bbj-bank-replay/funded/source/'
                  'internal-ledger-native-fixture-0006/build/10-historical-schema.sql')

parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-ach-', dir=args.scratch))
data = cluster / 'data'
socket = cluster / 's'
socket.mkdir(mode=0o700)
start_attempted = False

HUMAN = '00000000-0000-4000-8000-0000000000a1'
HORSE = '00000000-0000-4000-8000-0000000000b2'
VETERAN = '00000000-0000-4000-8000-0000000000c3'   # unlocked streak_30 before the migration
STREAKER = '00000000-0000-4000-8000-0000000000d4'
FROZEN = '00000000-0000-4000-8000-0000000000e5'
CHEAT = '00000000-0000-4000-8000-0000000000f6'

IDS = ['bad_beat', 'biggest_pot_500', 'clubs_3', 'friends_25', 'friends_5', 'hands_100',
       'hands_1000', 'hands_10000', 'hands_100000', 'profit_1000', 'profit_10000', 'quads',
       'royal_flush', 'straight_flush', 'streak_100', 'streak_30', 'streak_7',
       'tourney_played_50', 'tourney_top3_10', 'tourney_win_1', 'wins_10', 'wins_100',
       'wins_1000']


def block(path, head, terminator):
    text = (MIGRATIONS / path).read_text()
    start = text.find(head)
    assert start >= 0, f'{path}: {head!r} not found'
    end = text.find(terminator, start)
    assert end > start, f'{path}: {head!r} has no terminator {terminator!r}'
    return text[start:end + len(terminator)]


def captured(text, head):
    start = text.find(head)
    assert start >= 0, f'production capture has no {head!r}'
    end = text.find('$$;', text.find('AS $$', start) + 5)
    assert end > start, f'production capture: {head!r} has no body terminator'
    return text[start:end + 3]


def newest_block(head, terminator):
    for path in sorted(MIGRATIONS.glob('*.sql'), reverse=True):
        if path.name >= MIGRATION.name:
            continue
        text = path.read_text()
        if text.startswith('-- SUPERSEDED BY'):
            continue
        start = text.rfind(head)
        if start < 0:
            continue
        end = text.find(terminator, start)
        assert end > start, f'{path.name}: {head} has no terminator'
        return path.name, text[start:end + len(terminator)]
    raise AssertionError(f'No migration defines {head}')


def run(argv, sql=None):
    result = subprocess.run([str(v) for v in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=120)
    return result


def psql(sql, *, expect_error=None):
    result = run([pg / 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket,
                  '-U', 'postgres', '-d', 'postgres', '-p', '5432'], sql)
    if expect_error:
        assert result.returncode != 0 and expect_error in result.stderr, (expect_error, result)
        return result.stderr
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()


def as_user(uid, sql, **kw):
    return psql(f"SET ROLE authenticated; SET test.uid = '{uid}';\n" + sql, **kw)


def hand(hand_id, events):
    ev = 'NULL' if events is None else "'" + json.dumps(events).replace("'", "''") + "'::jsonb"
    return (f"INSERT INTO public.hand_history(id, table_id, hand_number, daily_mission_events) "
            f"VALUES ('{hand_id}', '00000000-0000-4000-8000-0000000000aa', 7, {ev});")


def royal(uid):
    return {'user_id': uid, 'amounts': {'hands_played': 1, 'hands_won': 1, 'strong_hands': 1},
            'magnitudes': {'strong_hands': 10}, 'values': {'strong_hands': [10]}}


def loser(uid):
    return {'user_id': uid, 'amounts': {'hands_played': 1}, 'magnitudes': {}, 'values': {}}


def paid(uid, achievement):
    return psql("SELECT coalesce(sum(amount), 0) || '/' || count(*) FROM public.diamond_transactions "
                f"WHERE user_id = '{uid}' AND reference_id = 'achievement:{achievement}:{uid}' "
                "AND transaction_type = 'achievement';")


def unlocked(uid, achievement):
    return psql("SELECT coalesce(bool_or(unlocked_at IS NOT NULL), false) FROM public.training_user_achievements "
                f"WHERE user_id = '{uid}' AND achievement_id = '{achievement}';")


try:
    award_source, award_sql = newest_block(
        'CREATE OR REPLACE FUNCTION public.award_diamonds_v2(', '$function$;')
    capture = CAPTURE.read_text()
    progress_sql = captured(capture, 'CREATE FUNCTION public.fn_achievement_record_progress(')
    notify_sql = captured(capture, 'CREATE FUNCTION public.fn_notify_achievement_unlocked()')
    notify_trigger = block('20260830051000_an_unlocked_achievement_notifies_from_the_server.sql',
                           'CREATE TRIGGER trg_notify_achievement_unlocked', ';')

    for argv in ([pg / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust',
                  '--auth-host=reject', '--no-locale', '--encoding=UTF8'],):
        r = run(argv)
        assert r.returncode == 0, r
    with (data / 'postgresql.conf').open('a') as conf:
        conf.write("\nlisten_addresses = ''\nunix_socket_directories = '" + str(socket) + "'\nautovacuum = off\n")
    start_attempted = True
    r = run([pg / 'pg_ctl', '-D', data, '-l', cluster / 'server.log', '-w', 'start'])
    assert r.returncode == 0, r
    assert json.loads(psql("SELECT json_build_object('a', inet_server_addr(), 'l', current_setting('listen_addresses'));")) == {'a': None, 'l': ''}

    # Production shapes (information_schema, 2026-10-19) for every column read or written.
    psql("""
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE TABLE public.profiles(
        id uuid PRIMARY KEY, diamonds integer DEFAULT 0, diamond_balance integer DEFAULT 0,
        diamond_multiplier numeric(6,2) DEFAULT 1.00, is_vip boolean DEFAULT false, vip_tier text,
        vip_expires_at timestamptz, updated_at timestamptz, login_streak integer DEFAULT 0,
        last_login_date date, is_horse boolean DEFAULT false);
      GRANT SELECT ON public.profiles TO authenticated;
      GRANT UPDATE (login_streak, last_login_date) ON public.profiles TO authenticated;
      CREATE TABLE public.diamond_reward_catalog(
        action_key text PRIMARY KEY, diamonds integer, max_per_day integer,
        counts_toward_daily_cap boolean, lifetime boolean, category text, active boolean,
        updated_at timestamptz DEFAULT now());
      INSERT INTO public.diamond_reward_catalog VALUES
        ('achievement', 0, NULL, false, false, 'training', true, now()),
        ('daily_login', 10, 1, true, false, 'engagement', true, now());
      CREATE TABLE public.diamond_transactions(
        id bigserial PRIMARY KEY, user_id uuid, amount integer, transaction_type text, type text,
        description text, balance_after integer, reference_id text, metadata jsonb,
        created_at timestamptz DEFAULT now(), counterparty text, issuance_class text);
      CREATE UNIQUE INDEX idx_diamond_transactions_reference_id ON public.diamond_transactions(reference_id);
      CREATE UNIQUE INDEX diamond_transactions_user_reference_uidx ON public.diamond_transactions(user_id, reference_id);
      CREATE TABLE public.ca_payout_freeze(scope text, cleared_at timestamptz);
      CREATE TABLE public.training_achievement_definitions(
        id text PRIMARY KEY, category text, name text, description text, icon_url text,
        threshold integer DEFAULT 0, reward_diamonds integer DEFAULT 0, created_at timestamptz DEFAULT now());
      GRANT ALL ON public.training_achievement_definitions TO anon, authenticated;
      CREATE TABLE public.training_user_achievements(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, achievement_id text,
        achievement_key text, progress numeric DEFAULT 0, target numeric DEFAULT 1,
        unlocked boolean DEFAULT false, unlocked_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX training_user_achievements_user_achievement_uidx
        ON public.training_user_achievements(user_id, achievement_id);
      GRANT SELECT ON public.training_user_achievements TO anon, authenticated;
      CREATE TABLE public.notifications(
        id bigserial PRIMARY KEY, user_id uuid, type text, title text, message text, data jsonb,
        created_at timestamptz DEFAULT now());
      CREATE TABLE public.hand_history(
        id uuid PRIMARY KEY, table_id uuid, hand_number integer, daily_mission_events jsonb,
        created_at timestamptz DEFAULT now());
    """)
    psql("INSERT INTO public.training_achievement_definitions(id, category, name) VALUES "
         + ', '.join(f"('{i}', 'x', '{'Royal Flush' if i == 'royal_flush' else i}')" for i in IDS) + ';')
    for uid, horse, streak, last in ((HUMAN, False, 0, None), (HORSE, True, 0, None),
                                     (VETERAN, False, 30, "current_date - 1"),
                                     (STREAKER, False, 29, "(now() AT TIME ZONE 'UTC')::date - 1"),
                                     (FROZEN, False, 0, None), (CHEAT, False, 0, None)):
        psql(f"INSERT INTO public.profiles(id, is_horse, login_streak, last_login_date) VALUES "
             f"('{uid}', {str(horse).lower()}, {streak}, {last or 'NULL'});")
    psql(award_sql)
    psql(progress_sql)
    psql("REVOKE ALL ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) FROM PUBLIC;"
         "GRANT EXECUTE ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) TO authenticated, service_role;")
    psql(notify_sql)
    psql(notify_trigger)

    # The hole, before: target 1 from a browser unlocked a 100-hand badge.
    assert as_user(CHEAT, "SELECT public.fn_achievement_record_progress("
                   f"'{CHEAT}', 'hands_100', 1, 1);") == 't'
    psql(f"DELETE FROM public.training_user_achievements WHERE user_id = '{CHEAT}';"
         "DELETE FROM public.notifications;")

    # A veteran who unlocked streak_30 before the migration (no back-pay).
    psql("INSERT INTO public.training_user_achievements(user_id, achievement_id, progress, target, unlocked, unlocked_at) "
         f"VALUES ('{VETERAN}', 'streak_30', 30, 30, true, now() - interval '3 days');")

    # The pre-image guards run against these bodies: the bodies production runs.
    pre = json.loads(psql("""SELECT json_build_object(
        'progress', md5(pg_get_functiondef('public.fn_achievement_record_progress(uuid,text,numeric,numeric)'::regprocedure)),
        'notify', md5(pg_get_functiondef('public.fn_notify_achievement_unlocked()'::regprocedure)),
        'award', (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.award_diamonds_v2(uuid,text,text,text,jsonb)'::regprocedure));"""))
    assert pre == {'progress': 'a7a3141b2ab6edb3a6b557e245ec0146',
                   'notify': 'ff113dbcc77a23bd8cb2187d5d72577b',
                   'award': '2218957f43bc6c653f7827b6344164ea'}, pre

    # The migration, byte for byte.
    psql(MIGRATION.read_text())
    assert psql("SELECT count(*) FROM public.diamond_transactions;") == '0'

    # 1. The browser door: its own target is ignored, unknown ids are refused,
    #    evidence-backed achievements take nothing from it.
    assert as_user(CHEAT, f"SELECT public.fn_achievement_record_progress('{CHEAT}', 'hands_100', 1, 1);") == 'f'
    assert psql(f"SELECT progress || '/' || target || '/' || unlocked FROM public.training_user_achievements "
                f"WHERE user_id = '{CHEAT}' AND achievement_id = 'hands_100';") == '1/100/false'
    as_user(CHEAT, f"SELECT public.fn_achievement_record_progress('{CHEAT}', 'free_money', 1, 1);",
            expect_error='unknown achievement')
    for aid in ('royal_flush', 'streak_30', 'streak_100', 'streak_7'):
        assert as_user(CHEAT, f"SELECT public.fn_achievement_record_progress('{CHEAT}', '{aid}', 1000, 1);") == 'f'
        assert unlocked(CHEAT, aid) == 'f'
    as_user(CHEAT, f"SELECT public.fn_achievement_unlock_server('{CHEAT}', 'royal_flush', 1, '{{}}');",
            expect_error='permission denied')
    as_user(CHEAT, f"UPDATE public.profiles SET login_streak = 99 WHERE id = '{CHEAT}';",
            expect_error='permission denied')
    as_user(CHEAT, "UPDATE public.training_achievement_definitions SET reward_diamonds = 500 WHERE id = 'hands_100';",
            expect_error='permission denied')
    psql("UPDATE public.training_achievement_definitions SET reward_diamonds = 5 WHERE id = 'hands_100';",
         expect_error='training_achievement_definitions_reward_needs_evidence')
    psql("SET ROLE anon; SELECT public.fn_achievement_record_login();", expect_error='permission denied')

    # 2. Royal Flush from the recorded hand: human and horse alike, once each.
    psql(hand('00000000-0000-4000-8000-000000000101', [royal(HUMAN), loser(HORSE)]))
    assert paid(HUMAN, 'royal_flush') == '500/1', paid(HUMAN, 'royal_flush')
    assert unlocked(HUMAN, 'royal_flush') == 't'
    assert unlocked(HORSE, 'royal_flush') == 'f'
    psql(hand('00000000-0000-4000-8000-000000000102', [royal(HORSE), royal(HUMAN)]))
    assert paid(HORSE, 'royal_flush') == '500/1'
    assert paid(HUMAN, 'royal_flush') == '500/1'
    assert psql(f"SELECT diamonds FROM public.profiles WHERE id = '{HORSE}';") == '500'
    meta = json.loads(psql(f"SELECT metadata FROM public.diamond_transactions WHERE user_id = '{HORSE}';"))
    assert meta['achievement_id'] == 'royal_flush' and meta['proof']['hand_id'].endswith('102'), meta
    note = json.loads(psql(f"SELECT json_build_object('m', message, 'd', data) FROM public.notifications "
                           f"WHERE user_id = '{HORSE}' AND type = 'achievement';"))
    assert note == {'m': 'Royal Flush: +500 Diamonds',
                    'd': {'achievement_id': 'royal_flush', 'achievement_name': 'Royal Flush',
                          'diamonds_awarded': 500}}, note
    # A straight flush (9) is not a Royal Flush.
    sf = royal(FROZEN); sf['magnitudes'] = {'strong_hands': 9}
    psql(hand('00000000-0000-4000-8000-000000000103', [sf]))
    assert unlocked(FROZEN, 'royal_flush') == 'f'
    # A malformed event list never fails the hand.
    psql(hand('00000000-0000-4000-8000-000000000104', [{'user_id': 'not-a-uuid', 'magnitudes': {'strong_hands': 10}},
                                                      {'user_id': 7, 'magnitudes': {'strong_hands': '10'}}]))
    psql(hand('00000000-0000-4000-8000-000000000105', {'user_id': HUMAN, 'magnitudes': {'strong_hands': 10}}))
    psql(hand('00000000-0000-4000-8000-000000000106', None))
    assert psql("SELECT count(*) FROM public.hand_history;") == '6'

    # 3. A frozen issuance leaves the achievement unearned and the hand intact;
    #    the next Royal Flush after the freeze clears pays it.
    psql("INSERT INTO public.ca_payout_freeze VALUES ('diamond_issuance', NULL);")
    psql(hand('00000000-0000-4000-8000-000000000107', [royal(FROZEN)]))
    assert psql("SELECT count(*) FROM public.hand_history WHERE id = '00000000-0000-4000-8000-000000000107';") == '1'
    assert unlocked(FROZEN, 'royal_flush') == 'f' and paid(FROZEN, 'royal_flush') == '0/0'
    psql("UPDATE public.ca_payout_freeze SET cleared_at = now();")
    psql(hand('00000000-0000-4000-8000-000000000108', [royal(FROZEN)]))
    assert unlocked(FROZEN, 'royal_flush') == 't' and paid(FROZEN, 'royal_flush') == '500/1'

    # 4. Login streaks, counted by the server. Day 30 pays streak_30 once.
    first = json.loads(as_user(STREAKER, "SELECT public.fn_achievement_record_login();"))
    assert first['counted'] is True and first['streak'] == 30, first
    assert first['unlocked'] == [{'achievement_id': 'streak_7', 'diamonds_awarded': 0},
                                 {'achievement_id': 'streak_30', 'diamonds_awarded': 100}], first
    assert paid(STREAKER, 'streak_30') == '100/1'
    again = json.loads(as_user(STREAKER, "SELECT public.fn_achievement_record_login();"))
    assert again == {'ok': True, 'counted': False, 'streak': 30, 'unlocked': []}, again
    assert paid(STREAKER, 'streak_30') == '100/1'
    assert psql(f"SELECT progress FROM public.training_user_achievements WHERE user_id = '{STREAKER}' "
                "AND achievement_id = 'streak_100';") == '30'
    # A broken run restarts at 1 and pays nothing more.
    psql(f"UPDATE public.profiles SET last_login_date = current_date - 5 WHERE id = '{STREAKER}';")
    broken = json.loads(as_user(STREAKER, "SELECT public.fn_achievement_record_login();"))
    assert broken['streak'] == 1 and broken['unlocked'] == [], broken
    assert paid(STREAKER, 'streak_30') == '100/1'

    # 5. No back-pay: the veteran's streak_30, unlocked before, is never paid,
    #    even as the streak runs on past it.
    vet = json.loads(as_user(VETERAN, "SELECT public.fn_achievement_record_login();"))
    assert vet['streak'] == 31 and vet['unlocked'] == [{'achievement_id': 'streak_7', 'diamonds_awarded': 0}], vet
    assert paid(VETERAN, 'streak_30') == '0/0'

    # 6. Every credit went through award_diamonds_v2, as an achievement.
    total = json.loads(psql("SELECT json_build_object('n', count(*), 'sum', sum(amount), "
                            "'types', array_agg(DISTINCT transaction_type), 'issuance', array_agg(DISTINCT issuance_class)) "
                            "FROM public.diamond_transactions;"))
    assert total == {'n': 4, 'sum': 1600, 'types': ['achievement'], 'issuance': ['promotional']}, total

    print(json.dumps({
        'ok': True,
        'migration': MIGRATION.name,
        'award_source': award_source,
        'server_version': psql('SHOW server_version;'),
        'checks': ['browser_target_ignored', 'unknown_id_refused', 'evidence_backed_not_browser_written',
                   'definitions_and_streak_not_browser_writable', 'royal_flush_paid_once_human_and_horse',
                   'notification_carries_diamonds', 'straight_flush_not_royal', 'malformed_events_never_fail_hand',
                   'freeze_leaves_unearned_then_pays', 'login_streak_server_counted_pays_once',
                   'no_back_pay', 'only_award_diamonds_v2_credits'],
    }))
finally:
    if start_attempted:
        subprocess.run([str(pg / 'pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'],
                       capture_output=True, env=env, timeout=60)
    shutil.rmtree(cluster, ignore_errors=True)
