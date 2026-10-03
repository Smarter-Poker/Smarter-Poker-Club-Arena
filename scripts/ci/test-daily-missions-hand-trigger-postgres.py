#!/usr/bin/env python3
"""Native PostgreSQL certification of the settled-hand Daily Missions trigger.

This is where the settled-hand -> Daily Missions outbox trigger is certified.
It used to be certified by tests/e2e/production-daily-missions.spec.ts
inserting a synthetic hand_history row (table_id NULL, winners [], pot 600,
hand_number 1.7e9-1.8e9) into PRODUCTION through the service role and
deleting it in a finally block. Every run put a winnerless 600-chip hand into
the live hand ledger, and every run that was cancelled or timed out left one
behind: four survived (2026-09-11, 09-19, 09-23, 09-24) and tripped the
cash-pot conservation no_winner_recorded monitor twelve times (board #5070,
incident e2e-synthetic-hands). Production never receives a synthetic hand
again; tests/operations/production-e2e-ledger-write-guard.test.mjs refuses
any production e2e spec that writes a hand or ledger table.

The trigger body under test is read from the NEWEST migration that defines
public.fn_enqueue_hand_daily_missions(), and the trigger DDL from the newest
migration that creates trg_enqueue_hand_daily_missions, so a later
redefinition is certified automatically. The cluster is private: no TCP
listener, trust auth over a temporary unix socket, never a provider.
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
MIGRATIONS = ROOT / 'supabase/migrations'
FUNCTION_HEAD = 'CREATE OR REPLACE FUNCTION public.fn_enqueue_hand_daily_missions()'
TRIGGER_HEAD = 'CREATE TRIGGER trg_enqueue_hand_daily_missions'

parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-dm-hand-trigger-', dir=args.scratch))
data = cluster / 'data'
socket = cluster / 's'
socket.mkdir(mode=0o700)
start_attempted = False

PLAYER_A = '00000000-0000-4000-8000-00000000000a'
PLAYER_B = '00000000-0000-4000-8000-00000000000b'
HAND_1 = '00000000-0000-4000-8000-000000000101'
HAND_2 = '00000000-0000-4000-8000-000000000102'
HAND_3 = '00000000-0000-4000-8000-000000000103'
HAND_4 = '00000000-0000-4000-8000-000000000104'
HAND_5 = '00000000-0000-4000-8000-000000000105'
TABLE = '00000000-0000-4000-8000-0000000000aa'
ENDED_AT = '2026-09-27T12:00:00.123+00:00'

# The exact mixed-threshold candidate set the production spec used to
# certify: two values per threshold, one below and one exactly on it.
AMOUNTS = {'hands_played': 1, 'hands_won': 1, 'hands_won_no_showdown': 1,
           'chips_won': 600, 'big_pots': 2, 'strong_hands': 2}
MAGNITUDES = {'big_pots': 500, 'strong_hands': 7}
THRESHOLD_VALUES = {'big_pots': [499, 500], 'strong_hands': [6, 7]}


def newest_block(head, terminator):
    """Return (migration name, text) of the newest migration block starting at head."""
    for path in sorted(MIGRATIONS.glob('*.sql'), reverse=True):
        text = path.read_text()
        start = text.rfind(head)
        if start < 0:
            continue
        end = text.find(terminator, start)
        assert end > start, f'{path.name}: {head} has no terminator {terminator!r}'
        return path.name, text[start:end + len(terminator)]
    raise AssertionError(f'No migration defines {head}')


def run(argv, sql=None, expect_error=None):
    result = subprocess.run([str(v) for v in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=60)
    if expect_error:
        assert result.returncode != 0 and expect_error in result.stderr, result
        return result.stderr
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result


def query(sql, expect_error=None):
    result = run([pg / 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket,
                  '-U', 'postgres', '-d', 'postgres', '-p', '5432'], sql, expect_error)
    return result if expect_error else result.stdout.strip()


def query_with_notices(sql):
    result = run([pg / 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket,
                  '-U', 'postgres', '-d', 'postgres', '-p', '5432'], sql)
    return result.stdout.strip(), result.stderr


def hand(hand_id, events, *, table=TABLE):
    events_sql = 'NULL' if events is None else "'" + json.dumps(events).replace("'", "''") + "'::jsonb"
    table_sql = 'NULL' if table is None else f"'{table}'"
    return (
        "INSERT INTO public.hand_history(id,table_id,hand_number,pot_size,winners,players,"
        "ended_at,has_human,daily_mission_events) VALUES "
        f"('{hand_id}',{table_sql},42,600,'[]'::jsonb,'[]'::jsonb,'{ENDED_AT}',false,{events_sql});"
    )


def outbox(user_id, hand_id):
    raw = query(
        "SELECT coalesce(json_agg(json_build_object('event_key',event_key,'amounts',amounts,"
        "'magnitudes',magnitudes,'threshold_values',threshold_values,"
        "'occurred_at',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS'))),'[]') "
        f"FROM public.daily_challenge_event_outbox WHERE user_id='{user_id}' AND event_key='hand:{hand_id}';"
    )
    return json.loads(raw)


def event(user_id, *, amounts=AMOUNTS, magnitudes=MAGNITUDES, values=THRESHOLD_VALUES):
    return {'user_id': user_id, 'amounts': amounts, 'magnitudes': magnitudes, 'values': values}


try:
    function_source, function_sql = newest_block(FUNCTION_HEAD, '$function$;')
    trigger_source, trigger_sql = newest_block(TRIGGER_HEAD, ';')
    assert 'daily_challenge_event_outbox' in function_sql or 'enqueue_daily_challenge_event' in function_sql

    run([pg / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject',
         '--no-locale', '--encoding=UTF8'])
    with (data / 'postgresql.conf').open('a') as conf:
        conf.write("\nlisten_addresses = ''\nunix_socket_directories = '" + str(socket) + "'\nautovacuum = off\n")
    start_attempted = True
    run([pg / 'pg_ctl', '-D', data, '-l', cluster / 'server.log', '-w', 'start'])
    endpoint = json.loads(query(
        "select json_build_object('address',inet_server_addr(),'listen',current_setting('listen_addresses'));"))
    assert endpoint == {'address': None, 'listen': ''}, endpoint

    # Production column shapes (information_schema, 2026-09-27) for every
    # column the trigger reads or writes.
    query("""
      CREATE TABLE public.hand_history(
        id uuid PRIMARY KEY,
        table_id uuid,
        tournament_id uuid,
        hand_number integer,
        pot_size numeric,
        winners jsonb,
        players jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz,
        has_human boolean,
        daily_mission_events jsonb);
      CREATE TABLE public.daily_challenge_event_outbox(
        user_id uuid NOT NULL,
        event_key text NOT NULL,
        amounts jsonb NOT NULL,
        magnitudes jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        dead_lettered_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        threshold_values jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY(user_id,event_key));
    """)
    query(function_sql)
    query(trigger_sql)
    assert query("SELECT count(*) FROM pg_trigger WHERE tgname='trg_enqueue_hand_daily_missions' "
                 "AND tgrelid='public.hand_history'::regclass AND NOT tgisinternal;") == '1'

    # 1. A settled hand carrying the mixed exact threshold candidates queues
    #    exactly one event per player, preserving every value and the hand's
    #    own end time.
    query(hand(HAND_1, [event(PLAYER_A)]))
    assert outbox(PLAYER_A, HAND_1) == [{
        'event_key': f'hand:{HAND_1}', 'amounts': AMOUNTS, 'magnitudes': MAGNITUDES,
        'threshold_values': THRESHOLD_VALUES, 'occurred_at': '2026-09-27T12:00:00.123',
    }], outbox(PLAYER_A, HAND_1)

    # 2. Two players in one hand each get their own event; a missing
    #    magnitudes/values key is stored as {} rather than NULL.
    query(hand(HAND_2, [{'user_id': PLAYER_B, 'amounts': AMOUNTS}, event(PLAYER_A)]))
    b_rows = outbox(PLAYER_B, HAND_2)
    assert len(b_rows) == 1 and b_rows[0]['magnitudes'] == {} and b_rows[0]['threshold_values'] == {}, b_rows
    assert len(outbox(PLAYER_A, HAND_2)) == 1

    # 3. One malformed event never blocks the hand or its valid siblings:
    #    the hand commits, the warning is raised, the valid event is queued.
    _, notices = query_with_notices(hand(HAND_3, [{'user_id': 'not-a-uuid', 'amounts': AMOUNTS},
                                                  event(PLAYER_A)]))
    assert 'could not be queued' in notices, notices
    assert query(f"SELECT count(*) FROM public.hand_history WHERE id='{HAND_3}';") == '1'
    assert len(outbox(PLAYER_A, HAND_3)) == 1

    # 4. A hand with no mission events queues nothing and still commits.
    query(hand(HAND_4, None))
    assert query(f"SELECT count(*) FROM public.daily_challenge_event_outbox WHERE event_key='hand:{HAND_4}';") == '0'
    assert query(f"SELECT count(*) FROM public.hand_history WHERE id='{HAND_4}';") == '1'

    # 5. The event is one commit with its hand: a rolled-back hand leaves no
    #    outbox row behind, and an already-queued key is never duplicated.
    query('BEGIN;' + hand(HAND_5, [event(PLAYER_A)]) + 'ROLLBACK;')
    assert outbox(PLAYER_A, HAND_5) == []
    before = query("SELECT count(*) FROM public.daily_challenge_event_outbox;")
    query(f"INSERT INTO public.daily_challenge_event_outbox(user_id,event_key,amounts,occurred_at) "
          f"VALUES('{PLAYER_B}','hand:{HAND_5}','{{}}'::jsonb,now());")
    query(hand(HAND_5, [event(PLAYER_B)]))
    rows = outbox(PLAYER_B, HAND_5)
    assert len(rows) == 1 and rows[0]['amounts'] == {}, rows
    assert int(query("SELECT count(*) FROM public.daily_challenge_event_outbox;")) == int(before) + 1

    print(json.dumps({
        'ok': True,
        'function_source': function_source,
        'trigger_source': trigger_source,
        'server_version': query('SHOW server_version;'),
        'checks': ['mixed_exact_thresholds_preserved', 'per_player_events_and_defaults',
                   'malformed_event_isolated', 'no_events_no_outbox', 'atomic_and_idempotent'],
    }))
finally:
    if start_attempted:
        subprocess.run([str(pg / 'pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'],
                       capture_output=True, env=env, timeout=60)
    shutil.rmtree(cluster, ignore_errors=True)
