"""Isolated PostgreSQL regression: an idle floor is not a lagging stats index.

Migration 20261015223846. ca_stats_health() reported indexLagSeconds as now()
minus the index ceiling, and ca_refresh_hand_player_index sets that ceiling to
the newest hand it indexed. With no newer hand the ceiling stands still while
the index is complete, so an idle floor read as lag growing one second per
second: on 2026-10-15 the owner's floor park left no hand between 17:33:14 and
18:11:31 UTC and both ClubArenaStatsIndexLag (18:03) and StatsHandIndexLagging
(18:12, "38m 15s behind") fired for an index that had every hand.

The test builds production's exact ca_stats_health() text (the phase-3
definition plus migration 20261007212545, md5 checked against production's
93f1d174...), proves the baseline reads an idle floor as 40 minutes of lag,
applies the candidate and proves:
  * no hand newer than the ceiling reads 0;
  * a hand newer than the ceiling reads that hand's age, not the idle time;
  * a roller that really stopped while hands flow still reads the age of the
    oldest hand it has not reached (still above the 30-minute bar);
  * a NULL ceiling still reads NULL;
  * the function reproduces production's derived postimage md5, keeps its
    grants, and the migration refuses a second run.
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

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'stats-witness-real-gaps'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/an-idle-floor-is-not-index-lag')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='idle-index-lag-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of production's ca_stats_health(), read 2026-10-15,
# and the postimage derived read-only on production with replace().
LIVE_HEALTH_DEF_MD5 = '93f1d1746cc8e74bc27d368cc1c95b23'
POST_HEALTH_DEF_MD5 = 'edbe14c1d8a1c82dd4d210402104e4d1'
GRANTS = '''
REVOKE ALL ON FUNCTION public.ca_stats_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_health() TO service_role;
REVOKE ALL ON FUNCTION public.ca_stats_witness_audit(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_witness_audit(integer, integer) TO service_role;
'''

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE hand_history(id uuid PRIMARY KEY, table_id uuid, hand_number bigint,
  tournament_id uuid, created_at timestamptz, button_seat integer, players jsonb,
  actions jsonb, showdown jsonb, has_human boolean);
CREATE INDEX idx_hand_history_time_identity ON hand_history (created_at) INCLUDE (id, table_id, hand_number);
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


def health_md5():
    return run("SELECT md5(pg_get_functiondef('public.ca_stats_health()'::regprocedure))")


def scene(ceil_minutes_ago, hand_seconds_ago):
    """Index ceiling N minutes ago; one hand at the ceiling (indexed) and the
    given newer hands (seconds ago, none = idle floor)."""
    # One transaction, so now() is the same instant for the ceiling and the
    # hand that sits exactly on it.
    sql = ['BEGIN;', 'TRUNCATE hand_history;',
           f"UPDATE ca_hand_player_idx_state SET idx_ceil = "
           + ('NULL' if ceil_minutes_ago is None else f"now() - interval '{ceil_minutes_ago} minutes'") + ';']
    if ceil_minutes_ago is not None:
        sql.append(f"INSERT INTO hand_history(id, created_at) VALUES (gen_random_uuid(), now() - interval '{ceil_minutes_ago} minutes');")
    for s in hand_seconds_ago:
        sql.append(f"INSERT INTO hand_history(id, created_at) VALUES (gen_random_uuid(), now() - interval '{s} seconds');")
    sql.append('COMMIT;')
    run('\n'.join(sql))


def lag():
    v = json.loads(run('SELECT ca_stats_health()'))['indexLagSeconds']
    return None if v is None else float(v)


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Production's exact text: the phase-3 definition, then 20261007212545.
    base_health = definition(one('*_stats_phase_3_pulse_timezone_and_ev_coverage.sql'), 'ca_stats_health')
    base_audit = (FIXTURES / 'ca_stats_witness_audit.live-20261007.sql').read_text()
    run(base_health + base_audit + ';' + GRANTS)
    run(one('*_the_stats_gap_reads_count_a_pending_projection_as_pending.sql').read_text())
    check('baseline-health-is-production-text', health_md5() == LIVE_HEALTH_DEF_MD5, health_md5())

    # ── Baseline: an idle floor reads as lag ────────────────────────────────
    scene(40, [])
    base_idle = lag()
    results['baseline'] = {'idle_floor_lag': base_idle}
    check('baseline-reads-an-idle-floor-as-40-minutes-of-lag', base_idle is not None and base_idle >= 2399, base_idle)
    scene(40, [10])
    check('baseline-reads-a-fresh-hand-after-idle-as-the-idle-time', lag() >= 2399, lag())

    # ── Candidate ─────────────────────────────────────────────────────────────────
    migration = one('*_an_idle_floor_is_not_a_lagging_stats_index.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', health_md5() == POST_HEALTH_DEF_MD5, health_md5())

    scene(40, [])
    idle = lag()
    check('an-idle-floor-reads-zero-lag', idle == 0.0, idle)
    scene(40, [10])
    fresh = lag()
    check('a-fresh-hand-after-idle-reads-its-own-age', fresh is not None and 9 <= fresh <= 30, fresh)
    scene(40, [39 * 60, 20 * 60, 60, 5])
    stalled = lag()
    check('a-stalled-roller-with-hands-flowing-still-reads-lag-above-the-bar', stalled is not None and stalled >= 39 * 60 - 1
          and stalled > 1800, stalled)
    scene(None, [5])
    check('a-null-ceiling-still-reads-null', lag() is None, lag())
    scene(0, [])
    check('a-current-index-reads-zero', lag() == 0.0, lag())
    results['candidate'] = {'idle_floor_lag': idle, 'fresh_hand_lag': fresh, 'stalled_roller_lag': stalled}

    health = json.loads(run('SELECT ca_stats_health()'))
    check('every-other-key-is-still-reported',
          all(k in health for k in ('checkedAt', 'indexCeil', 'indexBackfillComplete', 'indexRows', 'recentHands',
                                    'recentHandsWithoutStat', 'recentHandsPendingProjection', 'repair',
                                    'seatBackfill', 'evCoverage7d', 'lastAudit')), sorted(health))
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT ca_stats_health();',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-read-health', r.returncode != 0 and 'permission denied' in r.stderr)
    check('service-role-reads-health', run('SET ROLE service_role; SELECT ca_stats_health() IS NOT NULL') == 't')
    check('still-security-definer-and-stable',
          run("SELECT prosecdef::text || provolatile::text FROM pg_proc WHERE oid = 'public.ca_stats_health()'::regprocedure") == 'trues')
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', health_md5() == POST_HEALTH_DEF_MD5, health_md5())
    results['passed'] = True
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': results.get('passed', False), 'checks': len(results['checks']),
                  'baseline': results.get('baseline'), 'candidate': results.get('candidate')}))
