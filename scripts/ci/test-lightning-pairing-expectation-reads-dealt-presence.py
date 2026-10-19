#!/usr/bin/env python3
"""PostgreSQL 17 proof: the PAIRING_CONCENTRATION expectation reads dealt presence.

fn_lightning_integrity_scan is installed from its exact production definition
(fingerprint pinned below), RED, and then changed by migration 20261019174213
itself, GREEN, on the same disposable database. Two Clusters are scanned over
the same four-hour window:

  STALL    the 2026-10-17 busted-anchor stall in miniature: 40 pool sessions
           stay open, but only 8 of those players can be dealt, so every hand
           is six of the same eight. Random seating, no collusion.
  HEALTHY  30 open sessions, all 30 dealt at random, except that one pair is
           always seated together: whenever the first is dealt the second is
           added to the hand, and the second is never dealt without the first.

RED: the production definition sizes the pool from open sessions and flags
every stall pair high. GREEN: the stall produces no PAIRING_CONCENTRATION
finding at all, while the colluding pair in the healthy pool is still flagged
high with the new method named in its evidence, and no random pair there is.
Then the migration refuses to apply twice. No production credentials, no
network: an owned cluster in a temporary directory, removed afterwards.
"""
import hashlib
import json
import os
import pathlib
import random
import subprocess
import tempfile
import uuid
from datetime import datetime, timedelta, timezone

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROBE = ROOT / 'scripts/ci/probes/lightning-pairing-expectation/fn_lightning_integrity_scan.sql'
MIGRATION = ROOT / 'supabase/migrations/20261019174213_lightning_pairing_expectation_reads_dealt_presence.sql'
PG_BIN = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
SIG = "'public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure"

# Production definition read 2026-10-19 on project kuklfnapbkmacvwxktbh.
LIVE = '342b9ff5021fe5e0df25c18dc5641149'
POST = '5454a3674ac80ebd920507464d224de5'
LABEL = 'dealt_presence_10m'

STALL = '5a000000-0000-4000-8000-000000000001'
HEALTHY = '5a000000-0000-4000-8000-000000000002'
W_FROM = datetime(2026, 10, 17, 22, 0, tzinfo=timezone.utc)
W_TO = W_FROM + timedelta(hours=4)


def pid(cluster, k):
    return str(uuid.UUID(int=(uuid.UUID(cluster).int & ~0xFFFF) + 0x100 + k))


def fixture_sql():
    rnd = random.Random(20261019)
    rows_h, rows_p, rows_s = [], [], []
    stall_players = [pid(STALL, k) for k in range(40)]
    playable = stall_players[:8]
    healthy_players = [pid(HEALTHY, k) for k in range(30)]
    c1, c2 = healthy_players[0], healthy_players[1]
    others = [p for p in healthy_players if p != c2]
    entered = W_FROM - timedelta(hours=1)
    for cluster, players in ((STALL, stall_players), (HEALTHY, healthy_players)):
        for p in players:
            rows_s.append(f"('{cluster}','{p}','{entered.isoformat()}')")

    def hand(cluster, at, seated):
        h = str(uuid.UUID(int=rnd.getrandbits(128) | (4 << 76)))
        rows_h.append(f"('{h}','{cluster}','{at.isoformat()}','{(at + timedelta(seconds=20)).isoformat()}')")
        for p in seated:
            rows_p.append(f"('{h}','{p}',0)")

    for i in range(360):  # one stall hand every 40 seconds, six of the eight playable
        hand(STALL, W_FROM + timedelta(seconds=40 * i + 5), rnd.sample(playable, 6))
    for i in range(720):  # one healthy hand every 20 seconds
        seated = rnd.sample(others, 6)
        if c1 in seated:
            swap = rnd.choice([p for p in seated if p != c1])
            seated[seated.index(swap)] = c2
        hand(HEALTHY, W_FROM + timedelta(seconds=20 * i + 5), seated)
    return f"""
      INSERT INTO cash_games VALUES ('{STALL}', 2), ('{HEALTHY}', 2);
      INSERT INTO lightning_pool_session(cluster_id, player_id, entered_at) VALUES {','.join(rows_s)};
      INSERT INTO lightning_hand VALUES {','.join(rows_h)};
      INSERT INTO lightning_hand_player VALUES {','.join(rows_p)};
    """, (c1, c2) if c1 < c2 else (c2, c1)


SCHEMA = """
  CREATE TABLE cash_games(id uuid PRIMARY KEY, bb numeric);
  CREATE TABLE lightning_hand(hand_id uuid PRIMARY KEY, cluster_id uuid NOT NULL,
    formed_at timestamptz NOT NULL, settled_at timestamptz);
  CREATE TABLE lightning_hand_player(hand_id uuid, player_id uuid, net_result numeric,
    PRIMARY KEY (hand_id, player_id));
  CREATE TABLE lightning_pool_session(id bigserial PRIMARY KEY, cluster_id uuid NOT NULL,
    player_id uuid NOT NULL, entered_at timestamptz NOT NULL, exited_at timestamptz, exit_reason text);
  CREATE TABLE cash_cluster_epoch(cluster_id uuid, started_at timestamptz);
  CREATE TABLE user_sessions(user_id uuid, ip_address inet);
  CREATE TABLE profiles(id uuid PRIMARY KEY, referred_by uuid);
  CREATE TABLE lightning_integrity_signal(id bigserial PRIMARY KEY, cluster_id uuid NOT NULL,
    pattern_type text NOT NULL, source text NOT NULL, player_a uuid NOT NULL, player_b uuid,
    window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, suspicion_score smallint NOT NULL,
    severity text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'open',
    detected_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    reviewed_by uuid, reviewed_at timestamptz, notes text);
  CREATE UNIQUE INDEX ON lightning_integrity_signal(cluster_id, pattern_type, window_start, window_end, player_a, player_b);
  CREATE TABLE ca_collusion_signals(id bigserial PRIMARY KEY, detected_at timestamptz NOT NULL DEFAULT now(),
    window_days integer NOT NULL, user_a uuid NOT NULL, user_b uuid NOT NULL, hands_together integer NOT NULL,
    gross_flow numeric NOT NULL, net_flow numeric NOT NULL, direction_ratio numeric NOT NULL,
    both_cert boolean NOT NULL, detail jsonb NOT NULL DEFAULT '{}');
  CREATE UNIQUE INDEX ON ca_collusion_signals((detail ->> 'lightning_signal_id'))
    WHERE (detail ->> 'signal') = 'lightning_chip_flow';
  CREATE FUNCTION fn_ca_is_cert_account(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
  CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT false';
  CREATE FUNCTION fn_active_maintenance_release_boundary() RETURNS timestamptz LANGUAGE sql AS 'SELECT NULL::timestamptz';
  CREATE SCHEMA supabase_migrations;
  CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
"""


def psql(env, *args, ok=True):
    r = subprocess.run([str(PG_BIN / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', *args],
                       env=env, capture_output=True, text=True, timeout=120)
    if ok and r.returncode:
        raise AssertionError(r.stderr[-3000:])
    return r


def scan(env, cluster):
    out = psql(env, '-c', f"SELECT public.fn_lightning_integrity_scan('{cluster}', "
                          f"'{W_FROM.isoformat()}', '{W_TO.isoformat()}')").stdout.strip()
    return json.loads(out)


def pairing(env, cluster):
    out = psql(env, '-c', "SELECT coalesce(json_agg(json_build_object('a', player_a, 'b', player_b, "
                          "'severity', severity, 'evidence', evidence) ORDER BY id), '[]') "
                          f"FROM lightning_integrity_signal WHERE cluster_id = '{cluster}' "
                          "AND pattern_type = 'PAIRING_CONCENTRATION'").stdout.strip()
    return json.loads(out)


def digest(env):
    return psql(env, '-c', f'SELECT md5(pg_get_functiondef({SIG}))').stdout.strip()


def main():
    text = PROBE.read_text()
    assert hashlib.md5(text.encode()).hexdigest() == LIVE, 'fixture is not the production definition'
    migration = MIGRATION.read_text()
    assert f"'{LIVE}','{POST}'" in migration and f"='{POST}')" in migration, 'migration pins'
    data, colluders = fixture_sql()
    with tempfile.TemporaryDirectory(prefix='lpe-') as temp:
        root = pathlib.Path(temp)
        sock = root / 's'
        sock.mkdir()
        pgdata = root / 'd'
        subprocess.run([str(PG_BIN / 'initdb'), '-D', str(pgdata), '-U', 'postgres', '-A', 'trust',
                        '--no-locale', '-E', 'UTF8'], check=True, capture_output=True)
        with (pgdata / 'postgresql.conf').open('a') as f:
            f.write(f"\nlisten_addresses=''\nunix_socket_directories='{sock}'\n")
        subprocess.run([str(PG_BIN / 'pg_ctl'), '-D', str(pgdata), '-l', str(root / 'log'), '-w', 'start'],
                       check=True, capture_output=True)
        try:
            env = dict(os.environ, PGHOST=str(sock), PGUSER='postgres', PGDATABASE='postgres')
            psql(env, '-c', SCHEMA)
            psql(env, '-c', data)
            psql(env, '-c', text)
            assert digest(env) == LIVE, 'installed RED definition is not the production fingerprint'

            # RED: open sessions size the pool, so the stall flags every playable pair.
            red = scan(env, STALL)
            assert red['ok'] is True and red['thresholds']['pairing_expectation'] == 'co_presence', red
            stall_red = pairing(env, STALL)
            high = [s for s in stall_red if s['severity'] == 'high']
            assert len(high) == 28, f'RED should flag all 28 stall pairs high, got {len(stall_red)}/{len(high)}'
            assert min(s['evidence']['concentration_ratio'] for s in high) > 3.5, high
            scan(env, HEALTHY)
            red_healthy = pairing(env, HEALTHY)
            assert [(s['a'], s['b']) for s in red_healthy] == [colluders], red_healthy
            print(f'RED: the production definition flags all {len(high)} stall pairs high '
                  f'(ratios {min(s["evidence"]["concentration_ratio"] for s in high)}'
                  f'-{max(s["evidence"]["concentration_ratio"] for s in high)}) from 40 open, 8 playable sessions')

            psql(env, '-c', 'TRUNCATE lightning_integrity_signal, ca_collusion_signals')
            psql(env, '-f', str(MIGRATION))
            assert digest(env) == POST, 'migration postimage'

            green = scan(env, STALL)
            assert green['ok'] is True and green['thresholds']['pairing_expectation'] == LABEL, green
            assert pairing(env, STALL) == [], pairing(env, STALL)
            scan(env, HEALTHY)
            found = pairing(env, HEALTHY)
            assert [(s['a'], s['b']) for s in found] == [colluders], found
            ev = found[0]['evidence']
            assert found[0]['severity'] == 'high' and ev['expectation'] == LABEL, found
            assert ev['concentration_ratio'] >= 3.48 and ev['hands_together'] == ev['hands_a'] == ev['hands_b'], ev
            print(f'GREEN: the stall yields no pairing finding; the always-together pair in a healthy '
                  f'30-player pool is still high (ratio {ev["concentration_ratio"]}, '
                  f'{ev["hands_together"]} together vs {ev["expected_together"]} expected), no random pair is')

            again = psql(env, '-f', str(MIGRATION), ok=False)
            assert again.returncode and 'lightning_pairing_expectation_preimage_refused' in again.stderr, again.stderr
            assert digest(env) == POST
            print('PASS: the pairing expectation reads dealt presence; stall false positives are gone, '
                  'real concentration is still flagged, and the migration is exact and not re-appliable')
        finally:
            subprocess.run([str(PG_BIN / 'pg_ctl'), '-D', str(pgdata), '-m', 'immediate', '-w', 'stop'],
                           capture_output=True)


if __name__ == '__main__':
    main()
