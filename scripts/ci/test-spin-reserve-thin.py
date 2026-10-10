"""Isolated PostgreSQL regression for fn_spin_metrics.reserve_thin_clubs.

poker_spin_reserve_thin_clubs (SpinReservePoolThin) must count a reserve pool
that funds Spins and has fallen below the thin line, and must not count an
empty pool of a club that has never run a Spin: no draw is constrained by it.
Before this change 641 of 645 production pools were such empty pools, so the
alert fired continuously on nothing.

The test loads the exact production definition captured on 2026-10-08 (its
pg_get_functiondef md5 equals production's), proves it counts the never-used
pools, then applies the candidate migration (a pinned-text substitution) and
proves it counts only the thin pool that funds Spins, leaves the other gauges
alone and reproduces production's derived postimage md5 exactly. An empty
throwaway cluster on a Unix socket; no network, no production connection.
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
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'spin-reserve-thin'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/spin-reserve-thin')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='spin-reserve-thin-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of production's fn_spin_metrics(integer) read on
# 2026-10-08, before and after the candidate (derived read-only there).
LIVE_DEF_MD5 = '9a85c17823966c26901422a473dcb911'
POST_DEF_MD5 = 'd216239e859c33741cdd09f54f74f13f'
SIG = 'public.fn_spin_metrics(integer)'
# Production's grants (proacl {postgres=X/postgres,service_role=X/postgres}).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_spin_metrics(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_spin_metrics(integer) TO service_role;
'''

# Only the columns fn_spin_metrics reads. The two views it reads are stood in
# for by tables with the same columns, so the pools can be seeded directly.
SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE tournaments(id uuid PRIMARY KEY, variant text, status text, club_id uuid,
  spin_reveal_lag_ms integer, spin_multiplier numeric, buy_in_amount numeric, buy_in_fee numeric,
  started_at timestamptz, ended_at timestamptz);
CREATE TABLE tournament_players(tournament_id uuid);
CREATE TABLE spin_reserve_ledger(tournament_id uuid, amount numeric, kind text);
CREATE TABLE wallet_transactions(related_entity_id uuid, amount numeric, type text, category text);
CREATE TABLE v_spin_draw_fairness(window_label text, draws bigint, realised_e numeric, spec_e numeric,
  z numeric, drift boolean, constrained_draws bigint);
CREATE TABLE v_spin_reserve_health(club_id uuid, balance numeric, spin_count integer, is_thin boolean);
CREATE TABLE v_tournament_rake_attribution_gaps(id integer);
CREATE TABLE v_spin_unfilled_waits(id integer);
CREATE FUNCTION fn_spin_unpaid_settlements(integer) RETURNS TABLE(chips_short numeric)
  LANGUAGE sql AS 'SELECT 0::numeric WHERE false';
"""

# (key, balance, spin_count, is_thin as the view computes it, counts under the fix?)
POOLS = [
    ('funds-spins-healthy',   81032.60, 120000, False, False),
    ('funds-spins-thin',          5.00,      3, True,  True),
    ('never-ran-a-spin-a',        0.00,      0, True,  False),
    ('never-ran-a-spin-b',        0.00,      0, True,  False),
    ('never-ran-a-spin-null',     0.00,   None, True,  False),
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


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


def seed():
    sql = ['TRUNCATE v_spin_reserve_health, tournaments;']
    for n, (_, balance, spins, thin, _) in enumerate(POOLS, start=1):
        sql.append(f"INSERT INTO v_spin_reserve_health VALUES ('{uuid.UUID(int=n)}',{balance},"
                   f"{'NULL' if spins is None else spins},{'true' if thin else 'false'});")
    # One Spin that started a minute ago, so the liveness and lag gauges read.
    sql.append(f"INSERT INTO tournaments VALUES ('{uuid.UUID(int=500)}','spin','RUNNING','{uuid.UUID(int=1)}',"
               "400,2,10,0,now() - interval '1 minute',NULL);")
    run('\n'.join(sql))


def metrics():
    return json.loads(run('SELECT to_jsonb(m) FROM fn_spin_metrics(60) m'))


def md5():
    return run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Baseline: the exact production definition before this change.
    base = (FIXTURES / 'fn_spin_metrics.live-20261008.sql').read_text()
    run(base + ';' + GRANTS)
    check('baseline-is-production-preimage', md5() == LIVE_DEF_MD5, md5())
    seed()
    m = metrics()
    results['baseline'] = {k: m[k] for k in ('reserve_thin_clubs', 'reserve_min_balance', 'reveal_spins', 'open_boards')}
    check('baseline-counts-the-pools-that-never-ran-a-spin', m['reserve_thin_clubs'] == 4, m)

    # Candidate: the migration under test, applied as production would.
    migration = one('*_the_spin_reserve_gauge_counts_only_pools_that_funded_a_spin.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', md5() == POST_DEF_MD5, md5())
    seed()
    c = metrics()
    results['candidate'] = {k: c[k] for k in ('reserve_thin_clubs', 'reserve_min_balance', 'reveal_spins', 'open_boards')}
    expected = sum(1 for p in POOLS if p[4])
    check('gauge-counts-only-a-thin-pool-that-funds-spins', c['reserve_thin_clubs'] == expected == 1, c)
    check('every-other-gauge-unchanged', {k: v for k, v in c.items() if k != 'reserve_thin_clubs'}
          == {k: v for k, v in m.items() if k != 'reserve_thin_clubs'}, (m, c))
    meta = run(f"SELECT pg_get_userbyid(proowner)||' '||prosecdef::text||' '||provolatile::text||' '||coalesce(proconfig::text,'-')"
               f" FROM pg_proc WHERE oid = '{SIG}'::regprocedure")
    check('owner-security-volatility-and-settings-kept', meta == 'postgres true s {"search_path=public, pg_temp"}', meta)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT * FROM fn_spin_metrics(60);',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-read-the-metrics', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', md5() == POST_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
