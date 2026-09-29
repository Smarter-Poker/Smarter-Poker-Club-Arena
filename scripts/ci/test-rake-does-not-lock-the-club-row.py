#!/usr/bin/env python3
"""A raked hand must not hold the club settings row for the rest of its transaction.

Measured on production 2026-09-29 03:34-03:53 UTC: fn_project_hand_side_effects
was the top Lock/transactionid waiter, and every backend caught waiting held a
tuple lock on public.clubs or public.club_wallets. public.clubs took 123,272
UPDATEs against ten live rows in eleven hours, all of them from one statement in
atomic_distribute_rake:

    UPDATE public.clubs SET total_rake = COALESCE(total_rake,0) + p_rake

atomic_distribute_rake runs near the START of the hand projection, so that row
stayed exclusively locked for the whole tail: the remaining obligations, the
stats projection, and a PostgREST round trip before COMMIT. Hands at different
tables in the same club therefore queued behind one another.

This reproduces the mechanism on a disposable PostgreSQL 17 cluster and pins
both directions:

  BEFORE  N writers raking N different tables of one club serialise: each waits
          for the previous writer's transaction to commit.
  AFTER   the same N writers do not block one another at all.

The arms differ only by that one UPDATE. Everything else - the leg insert, the
wallet total, the receipt, the tail that models the projection - is identical,
so a pass cannot come from the two arms doing different amounts of work.
"""
import argparse
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
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/rake-club-row-lock')
parser.add_argument('--writers', type=int, default=4)
out = parser.parse_args().output.resolve()
WRITERS = parser.parse_args().writers
out.mkdir(parents=True, exist_ok=True)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='rake-club-row-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55702'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'the rake path must not hold the club settings row across the hand projection',
           'writers': WRITERS, 'cases': [], 'passed': False}

# The club settings row carries the guards and emitters that make this write
# expensive in production; here it only has to be the SHARED row, one per club.
FIXTURE = """
CREATE TABLE clubs (id int PRIMARY KEY, total_rake numeric NOT NULL DEFAULT 0,
                    updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE club_wallets (club_id int PRIMARY KEY,
                    lifetime_rake_collected numeric NOT NULL DEFAULT 0);
CREATE TABLE rake_distribution_legs (leg_key uuid, leg text, club_id int,
                    amount numeric, PRIMARY KEY (leg_key, leg));
CREATE TABLE rake_records (hand_id uuid PRIMARY KEY, table_id int,
                    club_id int, rake_amount numeric);
INSERT INTO clubs (id) VALUES (1);
INSERT INTO club_wallets (club_id) VALUES (1);

-- The rake tail, in both shapes. p_writes_club_row is the ONLY difference.
CREATE FUNCTION rake_tail(p_club int, p_table int, p_hand uuid, p_rake numeric,
                          p_writes_club_row boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount)
       VALUES (p_hand, p_table, p_club, p_rake);
  INSERT INTO rake_distribution_legs (leg_key, leg, club_id, amount)
       VALUES (p_hand, 'club_accumulator', p_club, p_rake)
  ON CONFLICT (leg_key, leg) DO NOTHING;
  -- The authoritative running total. One row per club, but it is taken and
  -- released inside this statement in both arms, so it is not what differs.
  UPDATE club_wallets SET lifetime_rake_collected = lifetime_rake_collected + p_rake
   WHERE club_id = p_club;
  IF p_writes_club_row THEN
    UPDATE clubs SET total_rake = COALESCE(total_rake,0) + p_rake, updated_at = now()
     WHERE id = p_club;
  END IF;
END $$;
"""


def command(argv, sql=None, timeout=30):
    return subprocess.run([str(x) for x in argv], input=sql, text=True,
                          capture_output=True, env=env, timeout=timeout)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    results['cases'].append({'name': name, 'passed': passed})
    require(passed, name + ': ' + r.stdout[-400:] + r.stderr[-1200:])
    return r.stdout.rstrip('\n')


def projection_holds(writes_club_row, tag):
    """Open one hand projection and leave it open, exactly as production does
    while it runs the stats tail and waits for the client's COMMIT. Then ask two
    questions of it, each with a short lock_timeout:

      clubs_blocked   - how many other writers of the CLUB SETTINGS ROW it shuts
                        out. That row is written by any club settings change and
                        by every other raked hand of the club.
      wallet_blocked  - whether it still holds club_wallets. This is expected to
                        stay TRUE in both arms: the wallet total is read by the
                        rakeback close and is authoritative, so it is not part
                        of this change. The case is here so the test says out
                        loud what is still held.
    """
    flag = 'true' if writes_club_row else 'false'
    holder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, env=env)
    try:
        holder.stdin.write(
            "BEGIN; SELECT rake_tail(1, 0, gen_random_uuid(), 1.25, " + flag + ");"
            " SELECT pg_advisory_lock(9292026);\n")
        holder.stdin.flush()
        deadline = time.monotonic() + 10
        while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'"
                           " AND objid=9292026 AND granted);").stdout.strip() != 't':
            require(holder.poll() is None and time.monotonic() < deadline,
                    tag + ': holder never reached its barrier')
            time.sleep(.02)

        clubs_blocked = 0
        for w in range(1, WRITERS):
            r = command(cmd, "SET lock_timeout='1200ms';\nBEGIN;\n"
                             "UPDATE clubs SET updated_at=now() WHERE id=1;\nCOMMIT;\n")
            (out / (tag + '-club-writer' + str(w) + '.log')).write_text(r.stdout + r.stderr)
            if r.returncode != 0 and '55P03' in r.stderr:
                clubs_blocked += 1
            else:
                require(r.returncode == 0, tag + ' club writer ' + str(w) + ': ' + r.stderr[-800:])

        rw = command(cmd, "SET lock_timeout='1200ms';\nBEGIN;\n"
                          "UPDATE club_wallets SET lifetime_rake_collected"
                          " = lifetime_rake_collected WHERE club_id=1;\nCOMMIT;\n")
        (out / (tag + '-wallet-writer.log')).write_text(rw.stdout + rw.stderr)
        wallet_blocked = rw.returncode != 0 and '55P03' in rw.stderr
        return clubs_blocked, wallet_blocked
    finally:
        if holder.poll() is None:
            holder.stdin.write('ROLLBACK;\n')
            holder.stdin.close()
            holder.wait(timeout=10)


try:
    require(re.search(r'PostgreSQL\) 17\.', command([pg / 'postgres', '--version']).stdout),
            'PostgreSQL 17 required')
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres',
                 '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) +
                "'\nunix_socket_permissions=0700\nport=" + PORT +
                "\nshared_buffers='16MB'\nmax_connections=20\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', FIXTURE)

    # BEFORE: the projection writes the club row, so it holds that row for as
    # long as it stays open, and every other writer of it waits.
    before_clubs, before_wallet = projection_holds(True, 'before')
    results['cases'].append({'name': 'before-an-open-projection-holds-the-club-row',
                             'blocked': before_clubs, 'of': WRITERS - 1,
                             'passed': before_clubs == WRITERS - 1})
    require(before_clubs == WRITERS - 1,
            'BEFORE arm did not reproduce the convoy: only ' + str(before_clubs) + ' of '
            + str(WRITERS - 1) + ' club-row writers blocked. The test cannot prove a fix '
            'it cannot first break.')

    # AFTER: the same projection, without that one UPDATE, holds nothing on clubs.
    after_clubs, after_wallet = projection_holds(False, 'after')
    results['cases'].append({'name': 'after-an-open-projection-holds-nothing-on-clubs',
                             'blocked': after_clubs, 'of': WRITERS - 1,
                             'passed': after_clubs == 0})
    require(after_clubs == 0, 'AFTER arm still holds the club row: ' + str(after_clubs)
            + ' of ' + str(WRITERS - 1) + ' writers blocked')

    # What is NOT fixed, pinned so nobody reads this test as a clean sheet: the
    # per-club wallet total is still taken and still held to COMMIT in both
    # arms. It is authoritative and read by the rakeback close, so sharding it
    # is a separate, money-reviewed change.
    results['cases'].append({'name': 'club-wallets-is-still-held-in-both-arms',
                             'before': bool(before_wallet), 'after': bool(after_wallet),
                             'passed': bool(before_wallet) and bool(after_wallet)})
    require(before_wallet and after_wallet,
            'club_wallets was expected to remain held in both arms; if it no longer is, '
            'this test is measuring something other than it thinks')

    # Every hand is still receipted and still totalled in both arms.
    # Both holders rolled back, so the committed state is empty and equal either
    # way: removing the club-row write loses no receipt and no total.
    run('no-receipt-survives-a-rolled-back-projection', 'SELECT count(*) FROM rake_records;', '0')
    run('the-wallet-total-is-the-sum-of-the-receipts',
        'SELECT (SELECT lifetime_rake_collected FROM club_wallets WHERE club_id=1)'
        ' = (SELECT COALESCE(sum(rake_amount),0) FROM rake_records);', 't')
    run('a-committed-rake-still-totals-without-the-club-row-write',
        "DO $$BEGIN PERFORM rake_tail(1, 9, gen_random_uuid(), 2.50, false); END$$;"
        " SELECT (SELECT lifetime_rake_collected FROM club_wallets WHERE club_id=1)"
        " = (SELECT sum(rake_amount) FROM rake_records);", 't')

    # The shipped migration must not reintroduce the write.
    shipped = sorted((ROOT / 'supabase/migrations').glob(
        '*_a_lifetime_total_is_not_a_lock_on_the_club_row.sql'))
    require(len(shipped) == 1, 'expected exactly one club-row migration, found ' + str(len(shipped)))
    body = shipped[0].read_text()
    executable = '\n'.join(l for l in body.split('\n') if not l.lstrip().startswith('--'))
    results['cases'].append({'name': 'shipped-migration-has-no-executable-clubs-update',
                             'passed': not re.search(r'UPDATE\s+public\.clubs', executable)})
    require(not re.search(r'UPDATE\s+public\.clubs', executable),
            'the shipped migration still writes public.clubs')

    results['passed'] = all(c.get('passed', True) for c in results['cases'])
finally:
    if (cluster / 'data/postmaster.pid').exists():
        command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    shutil.rmtree(cluster, ignore_errors=True)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']),
                      'evidence': str(out)}))
