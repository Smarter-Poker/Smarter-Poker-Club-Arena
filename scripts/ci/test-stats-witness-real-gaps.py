"""Isolated PostgreSQL regression for the stats gap and witness audit reads.

ca_stats_health() and ca_stats_witness_audit() must count only real defects:
  * a hand with no stat/index row AND no hand_projection_outbox row (a writer
    that finished without writing), never a hand still pending projection;
  * a button that disagrees with the small blind, never a tournament DEAD
    button (engine deadButton.ts, TDA Rule 30) that the small blind follows.

The test loads the exact pre-fix definitions (their prosrc md5 equals the
production functions measured 2026-09-27), proves they report the false
positives, then applies the candidate migration and proves it reports only
the real defects. An empty throwaway cluster on a Unix socket; no network,
no production connection.
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
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/stats-witness-real-gaps')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='stats-witness-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55817'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# prosrc md5 of the production functions read on 2026-09-27 (pre-fix).
LIVE_HEALTH_SRC_MD5 = '0a8c3ae1fe611a51957083b207800b36'
LIVE_AUDIT_SRC_MD5 = 'd1ee7bee735eef0e644b285d03648d9e'


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


def definition(path, name):
    source = path.read_text()
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1;', source, re.S)
    if not m:
        raise ValueError('missing definition: ' + name + ' in ' + path.name)
    return m.group(0)


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


def latest_definer(name):
    pattern = 'CREATE OR REPLACE FUNCTION public.' + name + '('
    return [p for p in sorted(MIGRATIONS.glob('*.sql')) if pattern in p.read_text()][-1]


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE hand_history(id uuid PRIMARY KEY, table_id uuid, hand_number bigint,
  tournament_id uuid, created_at timestamptz, button_seat integer, players jsonb,
  actions jsonb, showdown jsonb, has_human boolean);
CREATE TABLE ca_hand_player_stat(user_id uuid, hand_id uuid, created_at timestamptz);
CREATE TABLE ca_hand_player_idx(user_id uuid, created_at timestamptz, hand_id uuid);
CREATE TABLE hand_projection_outbox(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint, created_at timestamptz);
CREATE TABLE profiles(id uuid PRIMARY KEY, is_horse boolean);
CREATE TABLE ca_hand_facts(hand_id uuid, user_id uuid, was_all_in boolean, went_to_showdown boolean,
  all_in_street text, all_in_equity numeric, played_at timestamptz);
CREATE TABLE ca_hand_player_idx_state(id boolean DEFAULT true, watermark timestamptz, rows_indexed bigint DEFAULT 0,
  updated_at timestamptz DEFAULT now(), idx_floor timestamptz, idx_ceil timestamptz, backfill_complete boolean DEFAULT false);
CREATE TABLE ca_hand_player_stat_repair_state(id boolean DEFAULT true, cursor_at timestamptz, ceiling_at timestamptz,
  hands_seen bigint DEFAULT 0, rows_changed bigint DEFAULT 0, done boolean DEFAULT false, updated_at timestamptz DEFAULT now());
CREATE TABLE ca_idx_every_seat_state(id boolean DEFAULT true, cursor_at timestamptz, hands_seen bigint DEFAULT 0,
  rows_added bigint DEFAULT 0, done boolean DEFAULT false, updated_at timestamptz DEFAULT now());
CREATE TABLE ca_stats_witness_audit_log(id bigserial, ran_at timestamptz DEFAULT now(), window_from timestamptz,
  window_to timestamptz, hands integer, player_hands integer, hands_with_posts integer, button_disagree integer,
  showdown_disagree integer, hands_without_stat integer, human_player_hands integer, human_without_facts integer,
  idx_lag_seconds numeric, repair_done boolean, duration_ms integer, player_hands_without_idx integer DEFAULT 0,
  allin_showdown_7d integer DEFAULT 0, allin_showdown_without_equity_7d integer DEFAULT 0);
INSERT INTO ca_hand_player_idx_state(idx_ceil, backfill_complete) VALUES (now(), true);
INSERT INTO ca_hand_player_stat_repair_state(done) VALUES (true);
INSERT INTO ca_idx_every_seat_state(done) VALUES (true);
"""

# (key, tournament?, seats, stored button, small-blind seat, stat+idx written, pending in outbox)
HANDS = [
    ('cash-projected',            False, [1, 3, 5],          1,    3, True,  False),
    ('cash-pending-projection',   False, [1, 3, 5],          1,    3, False, True),
    ('cash-missing-stats',        False, [1, 3, 5],          1,    3, False, False),
    ('tourney-dead-button',       True,  [1, 2, 3, 4, 7, 8], 5,    7, True,  False),
    ('tourney-dead-button-wrong', True,  [1, 2, 3, 4, 7, 8], 5,    8, True,  False),
    ('tourney-live-button-wrong', True,  [1, 2, 3],          1,    3, True,  False),
    ('cash-empty-seat-button',    False, [1, 3, 5],          2,    3, True,  False),
    ('tourney-heads-up',          True,  [2, 6],             2,    2, True,  False),
    ('tourney-null-button',       True,  [1, 2, 3],          None, 1, True,  False),
]


def lit(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def seed():
    sql = ['TRUNCATE hand_history, ca_hand_player_stat, ca_hand_player_idx, hand_projection_outbox;']
    for n, (key, tourney, seats, button, sb, projected, pending) in enumerate(HANDS, start=1):
        hid = uuid.UUID(int=n << 16)
        users = {s: uuid.UUID(int=(n << 16) + s) for s in seats}
        players = [{'userId': str(users[s]), 'seat': s} for s in seats]
        # Everyone but the last seat folds: no showdown, so the showdown
        # check agrees and only the checks under test can move.
        actions = [{'userId': str(users[sb]), 'action': 'sb'}] + [
            {'userId': str(users[s]), 'action': 'fold'} for s in seats[:-1]]
        sql.append(
            'INSERT INTO hand_history VALUES (' + ','.join([
                lit(hid), lit(uuid.UUID(int=900 + n)), str(n), lit(uuid.UUID(int=700) if tourney else None),
                "now() - interval '120 seconds'", 'NULL' if button is None else str(button),
                lit(json.dumps(players)) + '::jsonb', lit(json.dumps(actions)) + '::jsonb', "'[]'::jsonb", 'false']) + ');')
        if projected:
            for u in users.values():
                sql.append(f"INSERT INTO ca_hand_player_stat VALUES ({lit(u)},{lit(hid)},now());")
                sql.append(f"INSERT INTO ca_hand_player_idx VALUES ({lit(u)},now(),{lit(hid)});")
        if pending:
            sql.append(f"INSERT INTO hand_projection_outbox VALUES ({lit(hid)},{lit(uuid.UUID(int=900 + n))},{n},now());")
    run('\n'.join(sql))


def health():
    return json.loads(run('SELECT ca_stats_health()'))


def audit():
    return json.loads(run('SELECT ca_stats_witness_audit(10, 90)'))


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # ── Baseline: the exact production definitions before this change ──────
    base_health = definition(one('*_stats_phase_3_pulse_timezone_and_ev_coverage.sql'), 'ca_stats_health')
    base_audit = definition(one('*_stats_witness_checks_showdown_without_money_reconstruction.sql'), 'ca_stats_witness_audit')
    run(base_health + base_audit)
    check('baseline-health-is-production-preimage',
          run("SELECT md5(prosrc) FROM pg_proc WHERE proname='ca_stats_health'") == LIVE_HEALTH_SRC_MD5)
    check('baseline-audit-is-production-preimage',
          run("SELECT md5(prosrc) FROM pg_proc WHERE proname='ca_stats_witness_audit'") == LIVE_AUDIT_SRC_MD5)
    seed()
    h, a = health(), audit()
    results['baseline'] = {'health': {k: h.get(k) for k in ('recentHands', 'recentHandsWithoutStat')},
                           'audit': {k: a[k] for k in ('button_disagree', 'hands_without_stat', 'player_hands_without_idx', 'showdown_disagree')}}
    check('baseline-counts-pending-hand-as-missing', h['recentHandsWithoutStat'] == 2, h)
    check('baseline-audit-counts-pending-hand-as-missing', a['hands_without_stat'] == 2, a)
    check('baseline-audit-counts-pending-seats-as-unindexed', a['player_hands_without_idx'] == 6, a)
    check('baseline-audit-counts-dead-button-as-defect', a['button_disagree'] == 5, a)

    # ── Candidate: the migration under test, applied as production would ───
    candidate = one('*_stats_gap_and_witness_count_real_gaps_not_pending_projection.sql')
    check('candidate-is-latest-health-definition', latest_definer('ca_stats_health') == candidate)
    check('candidate-is-latest-audit-definition', latest_definer('ca_stats_witness_audit') == candidate)
    migration = candidate.read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    seed()
    h, a = health(), audit()
    results['candidate'] = {'health': {k: h.get(k) for k in ('recentHands', 'recentHandsWithoutStat', 'recentHandsPendingProjection')},
                            'audit': {k: a[k] for k in ('button_disagree', 'hands_without_stat', 'player_hands_without_idx', 'showdown_disagree')}}
    check('health-counts-only-the-real-missing-hand', h['recentHandsWithoutStat'] == 1, h)
    check('health-reports-pending-separately', h['recentHandsPendingProjection'] == 1, h)
    check('health-sees-every-hand', h['recentHands'] == len(HANDS), h)
    check('audit-counts-only-the-real-missing-hand', a['hands_without_stat'] == 1, a)
    check('audit-counts-only-the-real-unindexed-seats', a['player_hands_without_idx'] == 3, a)
    # tourney-dead-button agrees; the wrong dead button, the wrong live
    # button, the cash empty-seat button and the NULL button still disagree.
    check('audit-dead-button-agrees-and-real-disagreements-remain', a['button_disagree'] == 4, a)
    check('audit-showdown-unchanged', a['showdown_disagree'] == 0, a)
    check('audit-hands-and-posts-unchanged', a['hands'] == len(HANDS) and a['hands_with_posts'] == len(HANDS), a)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT ca_stats_health();',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-read-health', r.returncode != 0 and 'permission denied' in r.stderr)
    check('service-role-reads-health', run('SET ROLE service_role; SELECT ca_stats_health() IS NOT NULL') == 't')
    first = run("SELECT md5(pg_get_functiondef('ca_stats_witness_audit(integer,integer)'::regprocedure))")
    run(migration)
    check('migration-replays', run("SELECT md5(pg_get_functiondef('ca_stats_witness_audit(integer,integer)'::regprocedure))") == first)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
