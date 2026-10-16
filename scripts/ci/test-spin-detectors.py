"""Isolated PostgreSQL regression for migration 20261015025123.

Two Spin detectors paged on conditions that cannot hurt a player:

1. fn_spin_metrics.reserve_thin_clubs (SpinReservePoolThin) counted every thin
   reserve pool, 1,143 of 1,146 on 2026-10-15, while every Spin drew from one
   healthy pool. It must count a thin pool only when that pool owns a Spin
   started in the last 24 hours: not an empty pool of a club that never ran a
   Spin, and not a drained pool whose club stopped running Spins (which the
   superseded #6473 rule, spin_count > 0, still counted).
2. fn_spin_fairness_check raised a distribution_warning on a chance p < 0.01
   crossing of its hourly sliding window. A warning must need the preceding,
   independent window to cross too; a critical (p < 0.001), an expectation
   drift and an off-ladder draw must still raise.

The test loads the exact production definitions captured on 2026-10-15 (their
pg_get_functiondef md5 equal production's), proves each baseline pages on the
harmless case, applies the migration as production would, and proves the
candidate reproduces production's derived postimage md5, pages only on the
real cases, keeps every other gauge, owner, security, settings and grants, and
refuses a second run. An empty throwaway cluster on a Unix socket; no network,
no production connection.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'spin-detectors'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/spin-detectors')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='spin-detectors-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55833'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

METRICS = 'public.fn_spin_metrics(integer)'
FAIRNESS = 'public.fn_spin_fairness_check(integer)'
# pg_get_functiondef md5 read on production 2026-10-15, before and after the
# candidate (the postimage derived read-only there with replace()).
PRE = {METRICS: '9a85c17823966c26901422a473dcb911', FAIRNESS: '7020ab8e6d565b3aa1884a5252364e49'}
POST = {METRICS: '7e92b1acfd7b86b557a464c6f4e00a6f', FAIRNESS: 'f481e023244f76359626544c661f9c0f'}
# Production's grants on both (proacl {postgres=X/postgres,service_role=X/postgres}).
GRANTS = ''.join(f'REVOKE ALL ON FUNCTION {s} FROM PUBLIC; GRANT EXECUTE ON FUNCTION {s} TO service_role;\n'
                 for s in (METRICS, FAIRNESS))

# Only what the two functions read. The views fn_spin_metrics reads are stood
# in for by tables with the same columns so they can be seeded directly.
SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE tournaments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), variant text, status text, club_id uuid,
  spin_reveal_lag_ms integer, spin_multiplier numeric, buy_in_amount numeric, buy_in_fee numeric,
  started_at timestamptz, ended_at timestamptz, created_at timestamptz, spin_locked_tiers jsonb);
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
-- A club's Spins draw from its union's pool; a club in no union owns its own.
CREATE TABLE club_union(club_id uuid PRIMARY KEY, union_id uuid);
CREATE FUNCTION fn_spin_reserve_owner(p_club uuid) RETURNS uuid LANGUAGE sql STABLE AS
  'SELECT coalesce((SELECT union_id FROM club_union WHERE club_id = p_club), p_club)';
CREATE TABLE spin_tier_spec(multiplier integer PRIMARY KEY, freq numeric);
INSERT INTO spin_tier_spec VALUES (2,4809776),(3,3930716),(4,900000),(5,250000),(10,100000),
  (25,7500),(50,1000),(100,1008);
CREATE TABLE financial_alerts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), severity text, source text,
  message text, context jsonb, resolved boolean DEFAULT false, resolved_at timestamptz,
  created_at timestamptz DEFAULT now(), resolved_by uuid, resolution text);
"""

U = lambda n: uuid.UUID(int=n)
UNION_POOL, CHILD_CLUB = U(1), U(11)
# (pool, balance, spin_count, is_thin, its own Spin started this many hours ago or None, counts under the fix?)
POOLS = [
    (UNION_POOL, 50881.24, 280876, False, None, False),  # funds Spins (through CHILD_CLUB), healthy
    (U(2), 5.00, 40, True, 2, True),                      # funds Spins today and has run thin
    (U(3), 0.00, 86048, True, 24 * 30, False),            # drained, its club stopped Spins a month ago
    (U(4), 0.00, 0, True, None, False),                   # never ran a Spin
    (U(5), 0.00, None, True, None, False),                # never ran a Spin, no count at all
]


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=120)
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


def md5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def seed_pools():
    sql = ['TRUNCATE v_spin_reserve_health, tournaments, club_union;',
           f"INSERT INTO club_union VALUES ('{CHILD_CLUB}','{UNION_POOL}');"]
    for pool, balance, spins, thin, hours_ago, _ in POOLS:
        sql.append(f"INSERT INTO v_spin_reserve_health VALUES ('{pool}',{balance},"
                   f"{'NULL' if spins is None else spins},{'true' if thin else 'false'});")
        if hours_ago is not None:
            sql.append("INSERT INTO tournaments(variant,status,club_id,spin_reveal_lag_ms,spin_multiplier,"
                       "buy_in_amount,buy_in_fee,started_at,created_at) VALUES "
                       f"('spin','COMPLETED','{pool}',400,2,10,0,now() - interval '{hours_ago} hours',"
                       f"now() - interval '{hours_ago} hours');")
    # The healthy union pool's Spin runs at a member club, a minute ago.
    sql.append("INSERT INTO tournaments(variant,status,club_id,spin_reveal_lag_ms,spin_multiplier,buy_in_amount,"
               f"buy_in_fee,started_at,created_at) VALUES ('spin','RUNNING','{CHILD_CLUB}',400,2,10,0,"
               "now() - interval '1 minute', now() - interval '1 minute');")
    # A Spin that never started (still registering) says nothing about funding.
    sql.append("INSERT INTO tournaments(variant,status,club_id,started_at,created_at) VALUES "
               f"('spin','REGISTERING','{U(4)}',NULL,now());")
    run('\n'.join(sql))


def metrics():
    return json.loads(run('SELECT to_jsonb(m) FROM fn_spin_metrics(60) m'))


# Tier counts. CURRENT_CHANCE is production's 7-day window that raised the
# 2026-10-14 22:44 warning (chi-square about 18.5 on 7 df: p < 0.01, not
# p < 0.001). ON_SPEC is each tier at its expected count for 86,546 draws.
CURRENT_CHANCE = {2: 41282, 3: 34224, 4: 7832, 5: 2229, 10: 867, 25: 86, 50: 17, 100: 9}
ON_SPEC = {2: 41627, 3: 34019, 4: 7789, 5: 2164, 10: 865, 25: 65, 50: 9, 100: 8}
CRITICAL = {**ON_SPEC, 50: 40, 2: ON_SPEC[2] - 31}


def seed_draws(current, previous):
    sql = ['TRUNCATE tournaments, financial_alerts;']
    for window, counts in (('1 hour', current), ('8 days', previous)):
        for mult, n in counts.items():
            sql.append("INSERT INTO tournaments(variant,status,spin_multiplier,created_at) "
                       f"SELECT 'spin','COMPLETED',{mult},now() - interval '{window}' - (g * interval '1 second') "
                       f"FROM generate_series(1,{n}) g;")
    run('\n'.join(sql))


def fairness():
    r = json.loads(run('SELECT fn_spin_fairness_check(7)'))
    alerts = json.loads(run("SELECT coalesce(jsonb_agg(jsonb_build_object('severity',severity,'verdict',"
                            "context->>'verdict')),'[]') FROM financial_alerts"))
    return r, alerts


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=32MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Baseline: the exact production definitions before this change.
    run((FIXTURES / 'fn_spin_metrics.live-20261015.sql').read_text() + ';\n'
        + (FIXTURES / 'fn_spin_fairness_check.live-20261015.sql').read_text() + ';\n' + GRANTS)
    for sig in (METRICS, FAIRNESS):
        check(f'baseline-is-production-preimage:{sig}', md5(sig) == PRE[sig], md5(sig))

    seed_pools()
    base_m = metrics()
    results['baseline_metrics'] = {k: base_m[k] for k in ('reserve_thin_clubs', 'reserve_min_balance', 'reveal_spins')}
    check('baseline-counts-every-thin-pool', base_m['reserve_thin_clubs'] == 4, base_m)

    seed_draws(CURRENT_CHANCE, ON_SPEC)
    base_f, base_alerts = fairness()
    results['baseline_chance'] = {'verdict': base_f['verdict'], 'chi': base_f['chi_square'], 'alerts': base_alerts}
    check('baseline-raises-a-warning-on-a-chance-crossing',
          base_f['verdict'] == 'distribution_warning' and base_alerts == [{'severity': 'warning',
                                                                           'verdict': 'distribution_warning'}],
          base_f)

    # Candidate: the migration under test, applied as production would.
    migration = one('20261015025123_spin_detectors_measure_what_can_fail.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-sets-lock-timeout', 'SET LOCAL lock_timeout' in migration)
    proof = re.search(r'^-- @live-proof: (.+)$', migration, re.M)
    check('candidate-carries-a-live-proof', proof is not None)
    run(migration)
    for sig in (METRICS, FAIRNESS):
        check(f'candidate-reproduces-production-derived-postimage:{sig}', md5(sig) == POST[sig], md5(sig))
    check('live-proof-reads-true-after-install', run(proof.group(1)) == 't')

    seed_pools()
    cand_m = metrics()
    results['candidate_metrics'] = {k: cand_m[k] for k in ('reserve_thin_clubs', 'reserve_min_balance', 'reveal_spins')}
    expected = sum(1 for p in POOLS if p[5])
    check('gauge-counts-only-a-thin-pool-that-funds-spins-today', cand_m['reserve_thin_clubs'] == expected == 1, cand_m)
    check('every-other-gauge-unchanged',
          {k: v for k, v in cand_m.items() if k != 'reserve_thin_clubs'}
          == {k: v for k, v in base_m.items() if k != 'reserve_thin_clubs'}, (base_m, cand_m))
    # A union pool that runs thin while a member club runs its Spins pages.
    run(f"UPDATE v_spin_reserve_health SET balance = 1, is_thin = true WHERE club_id = '{UNION_POOL}'")
    check('a-thin-union-pool-funding-a-member-club-pages', metrics()['reserve_thin_clubs'] == 2)

    seed_draws(CURRENT_CHANCE, ON_SPEC)
    f, alerts = fairness()
    results['candidate_chance'] = {'verdict': f['verdict'], 'chi': f['chi_square'],
                                   'prior_chi': f.get('prior_window_chi_square'), 'alerts': alerts}
    check('a-chance-crossing-is-reported-not-raised',
          f['verdict'] == 'distribution_unconfirmed' and alerts == [] and f['prior_window_confirms'] is False, f)
    check('the-window-statistic-is-unchanged', f['chi_square'] == base_f['chi_square'], (f, base_f))

    seed_draws(CURRENT_CHANCE, CURRENT_CHANCE)
    f, alerts = fairness()
    results['candidate_persistent'] = {'verdict': f['verdict'], 'alerts': alerts}
    check('a-drift-in-both-windows-still-raises-a-warning',
          f['verdict'] == 'distribution_warning' and alerts == [{'severity': 'warning',
                                                                 'verdict': 'distribution_warning'}], f)

    seed_draws(CRITICAL, ON_SPEC)
    f, alerts = fairness()
    results['candidate_critical'] = {'verdict': f['verdict'], 'chi': f['chi_square'], 'alerts': alerts}
    check('a-p001-crossing-still-raises-critical-on-one-window',
          f['verdict'] == 'distribution_critical' and alerts == [{'severity': 'critical',
                                                                  'verdict': 'distribution_critical'}], f)

    seed_draws({**ON_SPEC, 7: 3}, ON_SPEC)
    f, alerts = fairness()
    check('an-off-ladder-draw-still-raises-critical',
          f['verdict'] == 'off_ladder' and alerts == [{'severity': 'critical', 'verdict': 'off_ladder'}], f)

    for sig in (METRICS, FAIRNESS):
        meta = run(f"SELECT pg_get_userbyid(proowner)||' '||prosecdef::text||' '||coalesce(proconfig::text,'-')"
                   f"||' '||coalesce(proacl::text,'-') FROM pg_proc WHERE oid = '{sig}'::regprocedure")
        check(f'owner-security-settings-and-grants-kept:{sig}',
              meta == 'postgres true {"search_path=public, pg_temp"} {postgres=X/postgres,service_role=X/postgres}',
              meta)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT * FROM fn_spin_metrics(60);',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-read-the-metrics', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    for sig in (METRICS, FAIRNESS):
        check(f'second-run-left-the-postimage:{sig}', md5(sig) == POST[sig])
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'output': str(out / 'RESULTS.json')}))
print(command([sys.executable, ROOT / 'scripts/ci/test-spin-critical-confirmation-postgres.py',
               '--pg-bin', pg]))
