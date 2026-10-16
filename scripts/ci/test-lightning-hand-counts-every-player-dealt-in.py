"""Isolated PostgreSQL regression: a Lightning hand counts every player dealt in.

fn_lightning_settle_hand builds the post-commit rake envelope it hands to the
physical door, and set its num_players to the number of keys of v_contrib,
the map of participants whose contribution is > 0. A fast folder who never
put a chip in is dealt in but is not a payer, so a four-handed Lightning hand
with two such folders was booked as num_players = 2. The money was right
(the engine priced the rake with four dealt), but rake_records.num_players
said two, and both rake monitors read it as the dealt count:
fn_rake_law_violations priced the hand heads-up and filed over_spec and
bbj_over_spec, and fn_rake_bbj_invariants I1 filed "drop under 3 dealt".
On 2026-10-15 that was 148 hands of the Lightning Internal Pilot between
20:11 and 20:53 UTC, 336 open alert rows.

The test rebuilds production's exact text of fn_lightning_settle_hand from
the repository (the Phase 6 definition plus the substitutions of the Phase 6
remediation and Phase 8) and proves it hashes to production's
pg_get_functiondef md5 read on 2026-10-15. It settles a four-handed hand in
which two players fast-folded without posting, through stand-ins for the
tables it reads and the physical door it calls, and captures the envelope the
door receives. On the production text num_players is 2. The candidate
migration (a pinned-text substitution) is then applied: it must reproduce
production's derived postimage md5, the same hand must be booked with
num_players 4, the contribution map must be unchanged (only payers, summing
to the pot), and a second run of the migration must refuse. An empty
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

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/lightning-hand-counts-every-player-dealt-in')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='lightning-dealt-in-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55831'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SIG = 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'
# pg_get_functiondef md5 of production's function, read on 2026-10-15, and
# the postimage derived read-only on production with replace().
LIVE_DEF_MD5 = 'fcd616a9a339d8a25ab72bfa822678f7'
POST_DEF_MD5 = '0432654c1fd742eeedb2920140cda3b5'
GRANTS = f'''
REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {SIG} TO service_role;
'''


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


def defmd5():
    return run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")


def base_definition():
    source = one('20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql').read_text()
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.fn_lightning_settle_hand\(.*?AS \$function\$.*?\$function\$;', source, re.S)
    if not m:
        raise ValueError('missing the Phase 6 definition of fn_lightning_settle_hand')
    return m.group(0)


def dollar_items(block, tag):
    return re.findall(r'\$' + tag + r'\$(.*?)\$' + tag + r'\$', block, re.S)


def later_substitutions():
    """The (anchor, replacement) pairs production applied after Phase 6, in order."""
    pairs = []
    remediation = one('20261001201216_lightning_phase_6_remediation_a_frozen_cluster_settles_nothi.sql').read_text()
    block = re.search(r'DO \$sub_settle\$(.*?)\$sub_settle\$;', remediation, re.S).group(1)
    a_part = block.split('b text[] := ARRAY[')[0]
    b_part = block.split('b text[] := ARRAY[')[1].split('c integer[]')[0]
    pairs += list(zip(dollar_items(a_part, 'a'), dollar_items(b_part, 'b')))
    phase8 = one('20261007212735_lightning_phase_8_multi_table_limits_session_statistics_pool.sql').read_text()
    call = re.search(r"SELECT pg_temp\.lp8_rewrite\(\s*'public\.fn_lightning_settle_hand\(.*?ARRAY\[1\]\);", phase8, re.S).group(0)
    pairs += list(zip(dollar_items(call, 'a'), dollar_items(call, 'b')))
    if len(pairs) != 3:
        raise RuntimeError(f'expected three later substitutions, found {len(pairs)}')
    return pairs


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE clubs(id uuid PRIMARY KEY, asset text);
CREATE TABLE tables(id uuid PRIMARY KEY, club_id uuid, tournament_id uuid, small_blind numeric, big_blind numeric,
  max_buy_in numeric, game_variant text, cluster_id uuid);
CREATE TABLE cash_games(id uuid PRIMARY KEY, cluster_mode text);
CREATE TABLE engine_table_leases(table_id uuid PRIMARY KEY, instance_id text, lease_generation uuid,
  protocol_version integer, heartbeat_at timestamptz);
CREATE TABLE lightning_instance(id uuid PRIMARY KEY, state text, started_at timestamptz, abandon_reason text,
  cluster_id uuid, cluster_epoch integer, completed_at timestamptz);
CREATE TABLE lightning_hand(hand_id uuid PRIMARY KEY, lightning_instance_id uuid, cluster_id uuid, cluster_epoch integer,
  hand_number bigint, host_table_id uuid, settle_request_hash text, settle_receipt jsonb, hand_history_id uuid,
  settled_at timestamptz, settle_request_id uuid);
CREATE TABLE lightning_pool_session(id uuid PRIMARY KEY, anchor_seat_id uuid, hands integer DEFAULT 0,
  fast_folds integer DEFAULT 0, normal_folds integer DEFAULT 0, fold_and_watch integer DEFAULT 0,
  showdowns integer DEFAULT 0, net_result numeric DEFAULT 0, updated_at timestamptz);
CREATE TABLE lightning_pool_slot(id uuid PRIMARY KEY, pool_session_id uuid, hands integer DEFAULT 0,
  fast_folds integer DEFAULT 0, normal_folds integer DEFAULT 0, fold_and_watch integer DEFAULT 0,
  showdowns integer DEFAULT 0, updated_at timestamptz);
CREATE TABLE lightning_hand_player(hand_id uuid, player_id uuid, pool_slot_id uuid, seat integer,
  stack_before numeric, stack_after numeric, net_result numeric, fold_type text DEFAULT 'none',
  folded_at timestamptz, committed_at_fold numeric, showed boolean);
CREATE TABLE table_seats(id uuid PRIMARY KEY, table_id uuid, user_id uuid, left_at timestamptz, joined_at timestamptz,
  stack numeric, time_bank_uses_remaining integer, time_bank_remaining integer);
CREATE TABLE lightning_settlement_marker(txid xid8, seat_id uuid, anchor_table_id uuid, player_id uuid,
  hand_id uuid, host_table_id uuid, hand_number bigint);
CREATE TABLE cash_cluster_events(game_id uuid, kind text, payload jsonb, cluster_epoch integer, request_id uuid);
-- What the physical door was handed, captured verbatim.
CREATE TABLE door_calls(envelope jsonb, hand_row jsonb);

CREATE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer LANGUAGE sql AS $f$ SELECT 60 $f$;
CREATE FUNCTION public.fn_lightning_settlement_freeze(uuid, integer, uuid, uuid, uuid, text, jsonb)
RETURNS jsonb LANGUAGE sql AS $f$ SELECT jsonb_build_object('ok', false, 'frozen', true, 'reason', $6) $f$;
CREATE FUNCTION public.fn_ca_commit_hand_settlement(p_table_id uuid, p_hand_number bigint, p_stacks jsonb,
  p_rake numeric, p_bbj numeric, p_key text, p_x numeric, p_row jsonb, p_y jsonb, p_lease_instance text,
  p_lease_generation uuid, p_post_commit_obligations jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO door_calls VALUES (p_post_commit_obligations, p_row);
  RETURN jsonb_build_object('success', true, 'atomic_hand_commit', true, 'post_commit_obligations', true,
                            'history_id', gen_random_uuid(), 'commit_hash', 'c', 'post_commit_payload_hash', 'p');
END $f$;
"""

CLUB = '00000000-0000-0000-0000-00000000c001'
HOST = '00000000-0000-0000-0000-00000000a001'
CLUSTER = '00000000-0000-0000-0000-00000000e001'
INSTANCE = '00000000-0000-0000-0000-00000000f001'
HAND = '00000000-0000-0000-0000-00000000b001'
LEASE_GEN = '00000000-0000-0000-0000-00000000d001'
# (player, seat, stack_before, contributed, won, fold_type): hand a5998a9c's
# shape. Two players fast-fold preflop without posting; the blinds play it
# out to a 0.28 pot, 0.03 rake and 0.02 BBJ drop.
PLAYERS = [
    ('00000000-0000-0000-0000-000000000001', 1, 3.57, 0.14, 0.23, 'none'),
    ('00000000-0000-0000-0000-000000000002', 2, 15.01, 0.14, 0.00, 'none'),
    ('00000000-0000-0000-0000-000000000003', 3, 4.51, 0.00, 0.00, 'fast'),
    ('00000000-0000-0000-0000-000000000004', 4, 2.16, 0.00, 0.00, 'fast'),
]
RAKE, BBJ, POT = 0.03, 0.02, 0.28


def pid(n):
    return f'00000000-0000-0000-0000-{n:012d}'


def seed():
    sql = [f"""TRUNCATE clubs, tables, cash_games, engine_table_leases, lightning_instance, lightning_hand,
  lightning_pool_session, lightning_pool_slot, lightning_hand_player, table_seats, lightning_settlement_marker,
  cash_cluster_events, door_calls;
INSERT INTO clubs VALUES ('{CLUB}', 'chips');
INSERT INTO tables VALUES ('{HOST}', '{CLUB}', NULL, 0.02, 0.04, 8, 'nlh', '{CLUSTER}');
INSERT INTO cash_games VALUES ('{CLUSTER}', 'lightning');
INSERT INTO engine_table_leases VALUES ('{HOST}', 'engine-1', '{LEASE_GEN}', 2, now());
INSERT INTO lightning_instance VALUES ('{INSTANCE}', 'dealing', now() - interval '1 minute', NULL, '{CLUSTER}', 1, NULL);
INSERT INTO lightning_hand(hand_id, lightning_instance_id, cluster_id, cluster_epoch, hand_number, host_table_id)
  VALUES ('{HAND}', '{INSTANCE}', '{CLUSTER}', 1, 35180474, '{HOST}');"""]
    for i, (player, seat, before, contributed, won, fold) in enumerate(PLAYERS, start=1):
        anchor, session, slot = pid(100 + i), pid(200 + i), pid(300 + i)
        sql.append(f"""INSERT INTO table_seats VALUES ('{anchor}', '{pid(900 + i)}', '{player}', NULL, now() - interval '1 hour', {before}, 4, 30);
INSERT INTO lightning_pool_session(id, anchor_seat_id) VALUES ('{session}', '{anchor}');
INSERT INTO lightning_pool_slot(id, pool_session_id) VALUES ('{slot}', '{session}');
INSERT INTO lightning_hand_player(hand_id, player_id, pool_slot_id, seat, stack_before, fold_type, folded_at, committed_at_fold)
  VALUES ('{HAND}', '{player}', '{slot}', {seat}, {before}, '{fold}',
          {"now()" if fold != 'none' else 'NULL'}, {contributed if fold != 'none' else 'NULL'});""")
    run('\n'.join(sql))


def settle():
    res = [{'player_id': p, 'stack_after': round(b - c + w, 2), 'contributed': c, 'won': w,
            'fold_type': f, 'showed': f == 'none'} for p, _, b, c, w, f in PLAYERS]
    row = {'pot_size': POT, 'big_blind': 0.04, 'small_blind': 0.02, 'game_variant': 'nlh',
           'players': [{'userId': p, 'seat': s, 'stack': round(b - c + w, 2), 'cards': []}
                       for p, s, b, c, w, _ in PLAYERS]}
    answer = run(f"""SELECT public.fn_lightning_settle_hand('{HAND}', gen_random_uuid(), '{HOST}', 'engine-1', '{LEASE_GEN}',
  $j${json.dumps(res)}$j$::jsonb, {RAKE}, {BBJ}, $j${json.dumps(row)}$j$::jsonb)""")
    answer = json.loads(answer)
    rake = json.loads(run("SELECT (envelope -> 'rake')::text FROM door_calls"))
    return answer, rake


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Baseline: production's text, rebuilt the way production built it.
    run(base_definition() + '\n' + GRANTS)
    text = run(f"SELECT pg_get_functiondef('{SIG}'::regprocedure)")
    for anchor, replacement in later_substitutions():
        check('later-substitution-anchor-occurs-once', text.count(anchor) == 1, anchor[:80])
        text = text.replace(anchor, replacement)
    run(text + ';\n')
    check('baseline-is-production-preimage', defmd5() == LIVE_DEF_MD5, defmd5())
    seed()
    answer, rake = settle()
    results['baseline'] = {'answer_ok': answer.get('ok'), 'rake': rake}
    check('baseline-settles', answer.get('ok') is True, answer)
    check('baseline-books-a-four-handed-hand-as-two', rake.get('num_players') == 2, rake)

    # Candidate: the migration under test, applied as production would.
    candidate = one('*_a_lightning_hand_counts_every_player_dealt_in.sql')
    migration = candidate.read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', defmd5() == POST_DEF_MD5, defmd5())
    seed()
    answer, rake = settle()
    results['candidate'] = {'answer_ok': answer.get('ok'), 'rake': rake}
    check('candidate-settles', answer.get('ok') is True, answer)
    check('every-player-dealt-in-is-counted', rake.get('num_players') == len(PLAYERS), rake)
    contributions = rake.get('contributions') or {}
    check('contributions-still-name-only-payers',
          sorted(contributions) == sorted(p for p, _, _, c, _, _ in PLAYERS if c > 0), contributions)
    check('contributions-still-sum-to-the-pot', abs(sum(contributions.values()) - POT) < 0.005, contributions)
    check('rake-and-bbj-unchanged', rake.get('amount') == RAKE and rake.get('bbj') == BBJ, rake)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f"SET ROLE {role}; SELECT public.fn_lightning_settle_hand(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);",
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-settle', r.returncode != 0 and 'permission denied' in r.stderr, r.stderr[-200:])
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', defmd5() == POST_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
