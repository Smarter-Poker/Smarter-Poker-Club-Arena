"""Isolated PostgreSQL regression for fn_ca_knockout_door_stalled.

The knockout-door stall read must page only when a player is actually behind
the door: an unresolved knockout candidate of a tournament that is still being
played. A candidate left unresolved in a tournament that was later CANCELLED
or COMPLETED has no door behind it (its terminal authority refunded or paid
the field), and must not turn a quiet platform into a "stopped" door.

The test loads the exact production definition captured on 2026-10-15 (its
pg_get_functiondef md5 equals production's), proves it fires on a lone stale
candidate of a cancelled tournament, then applies the candidate migration (a
pinned-text substitution) and proves:
  * the stale candidate of a CANCELLED or COMPLETED event no longer fires it;
  * a pending candidate of a RUNNING or COMPLETING event still fires it;
  * resolved rows of finished events still date the door (last_resolved_at);
  * a recent knockout still keeps a quiet door quiet;
  * the result reproduces production's derived postimage md5, keeps grants,
    and the migration refuses a second run.
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
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'knockout-door-terminal-events'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/knockout-door-terminal-events')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='knockout-door-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production function read on 2026-10-15, before
# and after the candidate (the postimage derived read-only on production).
LIVE_DEF_MD5 = 'd127587cb49af85834ad5144b9401f29'
POST_DEF_MD5 = '0ac830e35079db87132632bab2e6cf37'
SIG = "'public.fn_ca_knockout_door_stalled(integer)'::regprocedure"
# Production's grants (read 2026-10-15): {postgres=X/postgres,service_role=X/postgres}.
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_ca_knockout_door_stalled(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_knockout_door_stalled(integer) TO service_role;
'''

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE tournaments(id uuid PRIMARY KEY, status text);
CREATE TABLE tournament_knockout_candidates(
  id uuid PRIMARY KEY, tournament_id uuid NOT NULL, eliminated_user_id uuid NOT NULL,
  state text NOT NULL, rebuy_prompt_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz);
"""


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


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


def tid(n):
    return str(uuid.UUID(int=0x7000 + n))


def board(tournaments, candidates):
    """tournaments: {n: status}; candidates: [(n, created_ago_min, resolved_ago_min or None)]."""
    sql = ['TRUNCATE tournaments, tournament_knockout_candidates;']
    for n, status in tournaments.items():
        sql.append(f"INSERT INTO tournaments VALUES ('{tid(n)}', '{status}');")
    for i, (n, created_ago, resolved_ago) in enumerate(candidates, start=1):
        resolved = 'NULL' if resolved_ago is None else f"now() - interval '{resolved_ago} minutes'"
        state = 'pending' if resolved_ago is None else 'eliminated'
        sql.append(
            'INSERT INTO tournament_knockout_candidates VALUES ('
            f"'{uuid.UUID(int=0x9000 + i)}', '{tid(n)}', '{uuid.UUID(int=0x5000 + i)}', '{state}', NULL, "
            f"now() - interval '{created_ago} minutes', {resolved});")
    run('\n'.join(sql))


def stalled():
    rows = run("SELECT coalesce(json_agg(r), '[]'::json) FROM public.fn_ca_knockout_door_stalled(15) r")
    return json.loads(rows)


# The production shape on 2026-10-15: the last knockout anywhere was 30 minutes
# ago, and one candidate of a tournament CANCELLED on 2026-09-27 is unresolved.
STALE_CANCELLED = ({1: 'CANCELLED', 2: 'COMPLETED'}, [(1, 37000, None), (2, 60, 30)])
STALE_COMPLETED = ({1: 'COMPLETED', 2: 'COMPLETED'}, [(1, 900, None), (2, 60, 30)])
STALE_LOWER_CASE = ({1: 'cancelled', 2: 'COMPLETED'}, [(1, 900, None), (2, 60, 30)])
REAL_STALL_RUNNING = ({1: 'CANCELLED', 2: 'COMPLETED', 3: 'RUNNING'}, [(1, 37000, None), (2, 60, 30), (3, 40, None)])
REAL_STALL_COMPLETING = ({2: 'COMPLETED', 3: 'COMPLETING'}, [(2, 60, 30), (3, 40, None)])
QUIET_DOOR = ({2: 'COMPLETED', 3: 'RUNNING'}, [(2, 60, 2), (3, 40, None)])
ORPHAN_TOURNAMENT = ({2: 'COMPLETED'}, [(2, 60, 30), (4, 40, None)])

try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # ── Baseline: the exact production definition before this change ───────
    run((FIXTURES / 'live-fn_ca_knockout_door_stalled.sql').read_text() + ';' + GRANTS)
    check('baseline-is-production-preimage', run(f'SELECT md5(pg_get_functiondef({SIG}))') == LIVE_DEF_MD5)
    board(*STALE_CANCELLED)
    base = stalled()
    results['baseline'] = base
    check('baseline-fires-on-a-stale-candidate-of-a-cancelled-event',
          len(base) == 1 and base[0]['pending_past_prompt'] == 1, base)
    board(*REAL_STALL_RUNNING)
    base_real = stalled()
    check('baseline-fires-on-a-real-stall', len(base_real) == 1 and base_real[0]['pending_past_prompt'] == 2, base_real)

    # ── Candidate: the migration under test, applied as production would ───
    migration = one('*_the_knockout_door_counts_only_candidates_of_events_still_bei.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-sets-lock-timeout', "SET LOCAL lock_timeout" in migration)
    check('candidate-carries-live-proof', '@live-proof:' in migration and POST_DEF_MD5 in migration)
    run(migration)
    check('candidate-reproduces-production-derived-postimage',
          run(f'SELECT md5(pg_get_functiondef({SIG}))') == POST_DEF_MD5)
    check('candidate-keeps-owner-security-and-grants',
          run("SELECT p.proacl::text || '|' || pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text "
              f"|| '|' || coalesce(p.proconfig::text, '') FROM pg_proc p WHERE p.oid = {SIG}")
          == '{postgres=X/postgres,service_role=X/postgres}|postgres|false|')

    cases = {}
    for name, shape in [('stale-cancelled', STALE_CANCELLED), ('stale-completed', STALE_COMPLETED),
                        ('stale-lower-case-status', STALE_LOWER_CASE), ('real-stall-running', REAL_STALL_RUNNING),
                        ('real-stall-completing', REAL_STALL_COMPLETING), ('quiet-door', QUIET_DOOR),
                        ('candidate-without-a-tournament-row', ORPHAN_TOURNAMENT)]:
        board(*shape)
        cases[name] = stalled()
    results['candidate'] = cases
    check('a-stale-candidate-of-a-cancelled-event-is-nobody-waiting', cases['stale-cancelled'] == [], cases['stale-cancelled'])
    check('a-stale-candidate-of-a-completed-event-is-nobody-waiting', cases['stale-completed'] == [], cases['stale-completed'])
    check('status-is-read-case-insensitively', cases['stale-lower-case-status'] == [], cases['stale-lower-case-status'])
    real = cases['real-stall-running']
    check('a-real-stall-still-fires-with-only-the-live-candidate',
          len(real) == 1 and real[0]['pending_candidates'] == 1 and real[0]['pending_past_prompt'] == 1, real)
    check('resolved-rows-of-finished-events-still-date-the-door',
          len(real) == 1 and 29 <= float(real[0]['stalled_minutes']) <= 31, real)
    check('the-oldest-wait-is-the-live-candidate',
          len(real) == 1 and 39 <= float(real[0]['oldest_expired_prompt_minutes']) <= 41, real)
    check('a-completing-event-is-still-behind-the-door',
          len(cases['real-stall-completing']) == 1, cases['real-stall-completing'])
    check('a-recent-knockout-keeps-a-quiet-door-quiet', cases['quiet-door'] == [], cases['quiet-door'])
    check('a-candidate-whose-event-cannot-be-read-still-counts',
          len(cases['candidate-without-a-tournament-row']) == 1, cases['candidate-without-a-tournament-row'])

    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT * FROM fn_ca_knockout_door_stalled(15);',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-read-the-door', r.returncode != 0 and 'permission denied' in r.stderr, r.stderr[-200:])
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', run(f'SELECT md5(pg_get_functiondef({SIG}))') == POST_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'output': str(out / 'RESULTS.json')}))
