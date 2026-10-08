"""Isolated PostgreSQL regression: the satellite audit finds a seat by its payout.

fn_satellite_conservation_audit counts a funded seat from three sources. Its
payout arm joined the award to the payout ON (tournament_id, place =
position). A receipt_version 3 satellite keeps the survivor's real finishing
position on the payout row, which for an unranked co-qualifier is NULL, so the
join found nothing and a satellite that paid every seat read as undisbursed
(production: "Sunday Deep Stack Satellite $25", e2ea5f2a, 2026-10-07).

The test loads the exact production definition captured on 2026-10-07 (its
pg_get_functiondef md5 equals production's), proves it flags the NULL-position
satellites, then applies the candidate migration (a pinned-text substitution)
and proves:
  * a satellite whose NULL-position seats all have their award by payout_id
    balances;
  * a cash delivery is still not a seat (an award with delivery_kind cash);
  * a satellite really short of a seat is still flagged, with the seats it did
    fund counted;
  * a ranked (version 2) satellite and an out-of-window one are unchanged;
  * the result reproduces production's derived postimage md5, grants stay
    service_role only, and a second run refuses.
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
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/satellite-audit-seat-by-payout')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='satellite-audit-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55818'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production function read on 2026-10-07, and
# the postimage derived read-only on production with replace().
LIVE_AUDIT_DEF_MD5 = '462b1c631010e4bab0361967d2da2a75'
POST_AUDIT_DEF_MD5 = '5d847143055fab40063ee1d968f2bb36'
SIG = "'public.fn_satellite_conservation_audit(integer)'::regprocedure"
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'satellite-audit-seat-by-payout'
# Production's grant (read 2026-10-07: {postgres=X/postgres,service_role=X/postgres}).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_satellite_conservation_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_satellite_conservation_audit(integer) TO service_role;
'''

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE tournaments(id uuid PRIMARY KEY, name text, prize_pool numeric DEFAULT 0, satellite_seats integer,
  satellite_target_id uuid, status text, ended_at timestamptz, buy_in_amount numeric, buy_in_fee numeric);
CREATE TABLE tournament_escrow(tournament_id uuid PRIMARY KEY, prize_out numeric, prize_balance numeric);
CREATE TABLE chip_ledger(id bigserial, from_type text, from_entity_id uuid, category text, amount numeric, idempotency_key text);
CREATE TABLE tournament_players(tournament_id uuid, user_id uuid, position integer);
CREATE TABLE rake_records(id bigserial, source text, metadata jsonb);
CREATE TABLE tournament_tickets(id uuid PRIMARY KEY, source_satellite_id uuid, holder_id uuid, status text);
CREATE TABLE tournament_payouts(id uuid PRIMARY KEY, tournament_id uuid, user_id uuid, position integer,
  source text, amount numeric);
CREATE TABLE tournament_satellite_awards(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL UNIQUE REFERENCES tournament_payouts(id), tournament_id uuid, place integer,
  delivery_kind text, ticket_id uuid);
CREATE TABLE wallet_transactions(id bigserial, related_entity_id uuid, user_id uuid, category text, type text, amount numeric);
CREATE TABLE tournament_conservation_baseline(tournament_id uuid PRIMARY KEY, amount numeric);
"""

TARGET = uuid.uuid4()
SAT = {k: uuid.uuid4() for k in ('null-position-seats', 'ranked-v2', 'seat-and-cash', 'one-seat-short', 'out-of-window')}
NAMES = {v: k for k, v in SAT.items()}


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


def q(v):
    return 'NULL' if v is None else "'" + str(v) + "'"


def satellite(key, pool, seats, survivors, ranked, payouts, ended="now() - interval '1 hour'", cash=()):
    """payouts: (place, position, source, delivery_kind); survivor users take the payouts in order."""
    sid = SAT[key]
    sql = [f"INSERT INTO tournaments(id, name, satellite_seats, satellite_target_id, status, ended_at) VALUES "
           f"({q(sid)}, {q(key)}, {seats}, {q(TARGET)}, 'COMPLETED', {ended});",
           f"INSERT INTO tournament_escrow VALUES ({q(sid)}, {pool}, 0);"]
    users = [uuid.uuid4() for _ in range(survivors)]
    for u in users:
        sql.append(f"INSERT INTO tournament_players VALUES ({q(sid)}, {q(u)}, NULL);")
    for pos in ranked:
        sql.append(f"INSERT INTO tournament_players VALUES ({q(sid)}, {q(uuid.uuid4())}, {pos});")
    for i, (place, position, source, kind) in enumerate(payouts):
        pid = uuid.uuid4()
        user = users[i] if i < len(users) else uuid.uuid4()
        if position is not None:
            sql.append(f"INSERT INTO tournament_players VALUES ({q(sid)}, {q(user)}, {position});")
        sql.append(f"INSERT INTO tournament_payouts VALUES ({q(pid)}, {q(sid)}, {q(user)}, {q(position)}, {q(source)}, 200);")
        sql.append(f"INSERT INTO tournament_satellite_awards(payout_id, tournament_id, place, delivery_kind) "
                   f"VALUES ({q(pid)}, {q(sid)}, {place}, {q(kind)});")
        if kind == 'cash':
            sql.append(f"INSERT INTO wallet_transactions(related_entity_id, user_id, category, type, amount) "
                       f"VALUES ({q(sid)}, {q(user)}, 'prize', 'credit', 200);")
    return '\n'.join(sql)


def seed():
    run('TRUNCATE tournaments, tournament_escrow, chip_ledger, tournament_players, rake_records, tournament_tickets, '
        'tournament_satellite_awards, tournament_payouts, wallet_transactions, tournament_conservation_baseline;')
    run('\n'.join([
        f"INSERT INTO tournaments(id, name, status, buy_in_amount, buy_in_fee) VALUES ({q(TARGET)}, 'target', 'RUNNING', 180, 20);",
        # The production case: three unranked co-qualifiers, three seats, pool 600,
        # 21 busted players ranked 4..24.
        satellite('null-position-seats', 600, 3, 3, range(4, 25),
                  [(1, None, 'satellite_seat', 'seat'), (2, None, 'satellite_seat', 'seat'), (3, None, 'satellite_seat', 'seat')]),
        # A ranked version 2 receipt: place = position, already correct.
        satellite('ranked-v2', 400, 2, 0, range(3, 11),
                  [(1, 1, 'satellite_seat', 'seat'), (2, 2, 'satellite_ticket', 'seat')]),
        # One seat and one capped winner paid in cash, both unranked.
        satellite('seat-and-cash', 400, 2, 2, range(3, 9),
                  [(1, None, 'satellite_seat', 'seat'), (2, None, 'satellite_ticket', 'cash')]),
        # Three seats owed, only two delivered: really short, must stay flagged.
        satellite('one-seat-short', 600, 3, 3, range(4, 12),
                  [(1, None, 'satellite_seat', 'seat'), (2, None, 'satellite_seat', 'seat')]),
        # Ended outside the window.
        satellite('out-of-window', 600, 3, 3, range(4, 12),
                  [(1, None, 'satellite_seat', 'seat')], ended="now() - interval '48 hours'"),
    ]))


def audit():
    rows = run("SELECT satellite_id, seats_funded, cash_paid, excess_disbursed, unpaid_winners "
               "FROM fn_satellite_conservation_audit(24) ORDER BY 1;")
    found = {}
    for line in filter(None, rows.splitlines()):
        sid, seats, cash, excess, unpaid = line.split('|')
        found[NAMES[uuid.UUID(sid)]] = {'seats_funded': int(seats), 'cash_paid': float(cash),
                                       'excess_disbursed': float(excess), 'unpaid_winners': int(unpaid)}
    return found


def defmd5():
    return run(f'SELECT md5(pg_get_functiondef({SIG}))')


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
    base = (FIXTURES / 'fn_satellite_conservation_audit.live-20261007.sql').read_text()
    run(base + ';' + GRANTS)
    check('baseline-is-production-preimage', defmd5() == LIVE_AUDIT_DEF_MD5, defmd5())
    seed()
    a = audit()
    results['baseline'] = a
    check('baseline-flags-the-null-position-seats',
          a.get('null-position-seats', {}).get('seats_funded') == 0, a)
    check('baseline-flags-the-unranked-seat-beside-cash',
          a.get('seat-and-cash', {}).get('seats_funded') == 0, a)
    check('baseline-flags-the-short-satellite', a.get('one-seat-short', {}).get('seats_funded') == 0, a)
    check('baseline-ranked-v2-balances', 'ranked-v2' not in a, a)
    check('baseline-out-of-window-ignored', 'out-of-window' not in a, a)

    # ── Candidate: the migration under test, applied as production would ───
    migration = (MIGRATIONS / '20261007215112_the_satellite_audit_finds_a_seat_by_its_payout.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', defmd5() == POST_AUDIT_DEF_MD5, defmd5())
    seed()
    a = audit()
    results['candidate'] = a
    check('null-position-seats-balance', 'null-position-seats' not in a, a)
    check('a-cash-delivery-is-not-a-seat', 'seat-and-cash' not in a, a)
    short = a.get('one-seat-short')
    check('a-really-short-satellite-is-still-flagged',
          short is not None and short['seats_funded'] == 2 and short['excess_disbursed'] == 0, a)
    check('ranked-v2-unchanged', 'ranked-v2' not in a, a)
    check('out-of-window-unchanged', 'out-of-window' not in a, a)
    check('only-the-short-satellite-remains', set(a) == {'one-seat-short'}, a)

    check('grant-is-service-role-only',
          run(f"SELECT proacl::text FROM pg_proc WHERE oid = {SIG}") == '{postgres=X/postgres,service_role=X/postgres}',
          run(f"SELECT proacl::text FROM pg_proc WHERE oid = {SIG}"))
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT * FROM fn_satellite_conservation_audit(24);',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-run-the-audit', r.returncode != 0 and 'permission denied' in r.stderr, r.stderr[-200:])
    check('service-role-runs-the-audit',
          run('SET ROLE service_role; SELECT count(*) FROM fn_satellite_conservation_audit(24);') == '1')
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', defmd5() == POST_AUDIT_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
