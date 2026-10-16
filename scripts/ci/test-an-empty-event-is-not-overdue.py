"""Isolated PostgreSQL regression: an event nobody entered is not overdue
until the engine's own cancel of it is overdue.

fn_tournament_metrics().overdue_start feeds poker_tournaments_overdue_start
and TournamentNeverStarted. It counted an MTT with zero entrants 10 minutes
past its start, while the engine is designed to cancel exactly that event 30
minutes past its start (server/src/tournament/emptyPastStartEvent.ts), so the
alert paged every day at 19:15 UTC on the pilot club's empty Daily 25 Chip
Freezeout and resolved when the engine cancelled it at 19:30.

The test loads the exact production definition captured on 2026-10-16 (its
pg_get_functiondef md5 equals production's), proves it counts the empty event
at 15 minutes, then applies the candidate migration and proves:
  * an MTT with a registered or playing entrant still counts at 15 minutes;
  * an MTT with a nonzero counter still counts at 15 minutes;
  * an empty MTT does not count at 15 or 35 minutes;
  * an empty MTT counts at 45 minutes (the cancel path is then late);
  * an MTT under an owner floor park still does not count;
  * the postimage md5 equals production's derived postimage, and the other
    gauges are unchanged.
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
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261016013324_an_empty_event_is_not_overdue_until_its_cancel_is.sql'
FIXTURE = ROOT / 'scripts' / 'ci' / 'fixtures' / 'empty-event-overdue' / 'fn_tournament_metrics.live-20261016.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/an-empty-event-is-not-overdue')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='empty-event-overdue-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production function read 2026-10-16, before
# and after the candidate (the postimage derived read-only on production).
LIVE_DEF_MD5 = '26e08b560250346a619faeb3bc1353af'
POST_DEF_MD5 = '3f79a8eef4de9068eb9f0acbfc303dc0'

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE tournaments(id uuid PRIMARY KEY, status text, tournament_type text,
  start_time timestamptz, updated_at timestamptz, ended_at timestamptz,
  prize_pool numeric, current_players integer, club_id uuid, union_id uuid);
CREATE TABLE tournament_players(tournament_id uuid, user_id uuid, status text, chips numeric);
CREATE TABLE tables(id uuid PRIMARY KEY, tournament_id uuid);
CREATE TABLE table_seats(table_id uuid, user_id uuid, left_at timestamptz);
CREATE TABLE wallet_transactions(related_entity_id uuid, category text);
CREATE TABLE poker_diamond_tournament_ledger(tournament_id uuid, kind text, wallet_journal_id uuid);
CREATE TABLE tournament_satellite_awards(tournament_id uuid, place integer);
CREATE TABLE parked_clubs(club_id uuid);
CREATE FUNCTION public.fn_ca_operator_floor_park_holds(p_club uuid, p_union uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM parked_clubs WHERE club_id IN (p_club, p_union)) $$;
"""
GRANTS = """
REVOKE ALL ON FUNCTION public.fn_tournament_metrics(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_metrics(integer, integer, integer) TO service_role;
"""

# (uuid suffix, minutes past start, entrant roster status or None, counter, parked)
EVENTS = [
    (1, 15, 'registered', 1, False),  # entered, 15m late: overdue
    (2, 15, None, 0, False),          # nobody entered, 15m late: engine has 15m left
    (3, 35, None, 0, False),          # nobody entered, 35m late: inside the engine's cancel margin
    (4, 45, None, 0, False),          # nobody entered, 45m late: the cancel itself is late
    (5, 15, 'playing', 1, False),     # a playing entrant: overdue
    (6, 15, None, 2, False),          # roster unread but counter says entrants: overdue
    (7, 60, 'registered', 1, True),   # held by an owner floor park: not overdue
    (8, 15, 'eliminated', 0, False),  # only a non-entrant roster row: empty
]


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


def tid(n):
    return f'00000000-0000-0000-0000-{n:012d}'


def seed(only=None):
    sql = ['TRUNCATE tournaments, tournament_players, parked_clubs;']
    for n, late, roster, counter, parked in EVENTS:
        if only is not None and n not in only:
            continue
        club = tid(1000 + n)
        sql.append(
            f"INSERT INTO tournaments VALUES ('{tid(n)}','REGISTERING','MTT',"
            f"now() - make_interval(mins => {late}), now(), NULL, 0, {counter}, '{club}', NULL);")
        if roster:
            sql.append(f"INSERT INTO tournament_players VALUES ('{tid(n)}','{tid(2000 + n)}','{roster}',0);")
        if parked:
            sql.append(f"INSERT INTO parked_clubs VALUES ('{club}');")
    run('\n'.join(sql))


def overdue(only=None):
    seed(only)
    return int(run('SELECT overdue_start FROM fn_tournament_metrics(10, 10, 6)'))


def other_gauges():
    seed()
    return run('SELECT running, registering, stuck_completing, seatless_phantoms, unpaid_completed, seat_first_waiting '
               'FROM fn_tournament_metrics(10, 10, 6)')


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run(FIXTURE.read_text() + ';' + GRANTS)
    check('baseline-is-production-preimage',
          run("SELECT md5(pg_get_functiondef('public.fn_tournament_metrics(integer,integer,integer)'::regprocedure))")
          == LIVE_DEF_MD5)

    before_other = other_gauges()
    check('baseline-counts-the-empty-event-at-15-minutes', overdue({2}) == 1, overdue({2}))
    check('baseline-counts-the-entered-event-at-15-minutes', overdue({1}) == 1, overdue({1}))

    body = MIGRATION.read_text()
    run(body)
    check('postimage-is-production-derived-postimage',
          run("SELECT md5(pg_get_functiondef('public.fn_tournament_metrics(integer,integer,integer)'::regprocedure))")
          == POST_DEF_MD5)
    check('grants-unchanged',
          run("SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_tournament_metrics(integer,integer,integer)'::regprocedure")
          == '{postgres=X/postgres,service_role=X/postgres}')

    expected = {1: 1, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 0, 8: 0}
    for n, want in expected.items():
        got = overdue({n})
        check(f'event-{n}-overdue-is-{want}', got == want, {'event': n, 'got': got})
    check('all-events-together', overdue() == sum(expected.values()), overdue())
    check('other-gauges-unchanged', other_gauges() == before_other, {'before': before_other, 'after': other_gauges()})

    # A second install is refused by the pinned preimage, not applied twice.
    try:
        run(body)
        check('reinstall-is-refused', False, 'second install succeeded')
    except RuntimeError as e:
        check('reinstall-is-refused', 'is not the pinned text' in str(e), str(e)[:200])
    results['passed'] = True
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps(results, indent=2))
