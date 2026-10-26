"""Native PostgreSQL regression for Lightning's accepted stats facts.

Rebuild the exact production settlement preimage from maintained migrations,
apply the candidate, capture the existing physical-door boundary, then run the
real durable stats projector. This is an isolated socket-only cluster: no
production connections or financial writes. Required fields, scope, duplicate
rows, row types, replay and private permissions are exercised.
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
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/lightning-stats-facts')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='lightning-stats-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55839'
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
    row = {'_accepted_post_commit_facts': {'stats_facts': STATS}, 'pot_size': POT, 'big_blind': 0.04, 'small_blind': 0.02, 'game_variant': 'nlh',
           'players': [{'userId': p, 'seat': s, 'stack': round(b - c + w, 2), 'cards': []}
                       for p, s, b, c, w, _ in PLAYERS]}
    answer = run(f"""SELECT public.fn_lightning_settle_hand('{HAND}', gen_random_uuid(), '{HOST}', 'engine-1', '{LEASE_GEN}',
  $j${json.dumps(res)}$j$::jsonb, {RAKE}, {BBJ}, $j${json.dumps(row)}$j$::jsonb)""")
    answer = json.loads(answer)
    rake = json.loads(run("SELECT (envelope -> 'rake')::text FROM door_calls"))
    return answer, rake


def extract(source, pattern):
    match = re.search(pattern, source, re.S)
    if not match:
        raise RuntimeError('missing native fixture source: ' + pattern)
    return match.group(0)


STATS = {'version': 1, 'facts': [], 'transfers': []}
for player, seat, before, contributed, won, fold in PLAYERS:
    net = round(won - contributed, 2)
    fact = dict(hand_id=HAND, user_id=player, club_id=CLUB, table_id=HOST,
                tournament_id=None, played_at='2026-10-25T12:00:00+00:00', game_variant='nlh',
                big_blind=0.04, seat=seat, position='BB', players_dealt=4,
                invested=contributed, returned=won, net=net, net_bb=round(net / .04, 2),
                rake_paid=0, aggressive_actions=0, passive_actions=0, ev_net=net,
                ev_net_bb=round(net / .04, 2))
    for name in ('vpip pfr three_bet four_bet faced_three_bet folded_to_three_bet had_cbet_flop_opp '
                 'cbet_flop saw_flop went_to_showdown won_at_showdown was_all_in').split():
        fact[name] = False
    STATS['facts'].append(fact)
STATS['transfers'] = [dict(hand_id=HAND, table_id=HOST, club_id=CLUB,
    winner_id=PLAYERS[0][0], loser_id=PLAYERS[1][0], amount=.09,
    played_at='2026-10-25T12:00:00+00:00')]


def validate(payload):
    row = {'_accepted_post_commit_facts': {'stats_facts': payload}}
    return json.loads(run(f"SELECT public.fn_lightning_hand_stats_facts($j${json.dumps(row)}$j$, '{HAND}', '{HOST}', '{CLUB}')"))


try:
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run('''CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations(version text);
    CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.fn_active_maintenance_release_boundary() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
    CREATE TABLE hand_atomic_commits(hand_id uuid PRIMARY KEY, table_id uuid, post_commit_payload jsonb);''')
    old_stats = one('20260821_ca_hand_facts.sql').read_text()
    for table in ('ca_hand_facts', 'ca_hand_transfers'):
        run(extract(old_stats, r'CREATE TABLE public\.' + table + r' \(.*?\n\);'))
    run('ALTER TABLE ca_hand_facts ADD COLUMN opponent_ids uuid[], ADD COLUMN four_bet boolean NOT NULL DEFAULT false, ADD COLUMN source_hash text;')
    stats_source = one('20261003134650_stats_facts_outbox_and_corrections.sql').read_text()
    run(extract(stats_source, r'CREATE TABLE public\.ca_hand_fact_projection_receipts \(.*?\n\);'))
    run(extract(stats_source, r'CREATE OR REPLACE FUNCTION public\.ca_project_hand_stats_facts\(.*?\$function\$;'))
    # Apply the maintained opportunity extension to the actual projector, not a stand-in.
    opportunity = one('20261003140344_stats_cash_opportunity_facts.sql').read_text()
    run(extract(opportunity, r'ALTER TABLE public\.ca_hand_facts.*?;'))
    run(extract(opportunity, r'DO \$patch_fact_projector\$.*?\$patch_fact_projector\$;'))
    run(base_definition() + '\n' + GRANTS)
    definition = run(f"SELECT pg_get_functiondef('{SIG}'::regprocedure)")
    for anchor, replacement in later_substitutions():
        check('baseline-anchor-once', definition.count(anchor) == 1)
        definition = definition.replace(anchor, replacement)
    run(definition + ';')
    check('historical-preimage', defmd5() == LIVE_DEF_MD5, defmd5())
    run(one('20261015222121_a_lightning_hand_counts_every_player_dealt_in.sql').read_text())
    run(one('20261018230728_lightning_settlement_names_zero_contribution_dealt_players.sql').read_text())
    check('current-production-preimage', defmd5() == '0670ed75762f05e7ad3346a1c95e84dc', defmd5())
    seed()
    answer, money_before = settle()
    check('baseline-settles-without-stats', answer.get('ok') and run("SELECT hand_row #> '{_accepted_post_commit_facts,stats_facts}' IS NULL FROM door_calls") == 't')
    migration = one('20261025000729_lightning_hands_reach_the_stats_facts_and_the_collusion_scan.sql').read_text()
    run(migration)
    check('exact-postimage', defmd5() == 'e6cc04d7031ed3fa1454df89c45533a1', defmd5())
    check('valid-payload-kept', validate(STATS) == {'stats_facts': STATS})
    import copy
    for label, mutate in [
        ('wrong-hand', lambda s: s['facts'][0].update(hand_id=HOST)),
        ('wrong-table', lambda s: s['facts'][0].update(table_id=HAND)),
        ('wrong-club', lambda s: s['facts'][0].update(club_id=HOST)),
        ('malformed-type', lambda s: s['facts'][0].update(vpip='nonsense')),
        ('coerced-boolean', lambda s: s['facts'][0].update(vpip='false')),
        ('coerced-number', lambda s: s['facts'][0].update(invested='0.14')),
        ('unknown-fact-field', lambda s: s['facts'][0].update(unknown='value')),
        ('unknown-transfer-field', lambda s: s['transfers'][0].update(unknown='value')),
        ('missing-required', lambda s: s['facts'][0].pop('invested')),
        ('empty-row', lambda s: s.update(facts=[{}])),
        ('equity-range', lambda s: s['facts'][0].update(all_in_equity=2)),
        ('duplicate-player', lambda s: s['facts'].append(s['facts'][0])),
        ('nonpositive-transfer', lambda s: s['transfers'][0].update(amount=0)),
        ('self-transfer', lambda s: s['transfers'][0].update(loser_id=PLAYERS[0][0])),
        ('unknown-transfer-player', lambda s: s['transfers'][0].update(loser_id=HOST)),
        ('duplicate-transfer', lambda s: s['transfers'].append(s['transfers'][0])),
        ('bad-version', lambda s: s.update(version=3)),
        ('empty-facts', lambda s: s.update(facts=[])),
    ]:
        bad = copy.deepcopy(STATS); mutate(bad)
        check('refuses-' + label, validate(bad) == {})
    for field in ('played_at game_variant big_blind position players_dealt invested returned net net_bb '
                  'rake_paid vpip pfr three_bet four_bet faced_three_bet folded_to_three_bet '
                  'had_cbet_flop_opp cbet_flop saw_flop went_to_showdown won_at_showdown '
                  'aggressive_actions passive_actions was_all_in ev_net ev_net_bb').split():
        bad = copy.deepcopy(STATS); bad['facts'][0][field] = None
        check('refuses-null-' + field, validate(bad) == {})
    version2 = copy.deepcopy(STATS); version2['version'] = 2
    check('version-two-payload-kept', validate(version2) == {'stats_facts': version2})
    seed()
    answer, money_after = settle()
    check('candidate-settles-and-keeps-money', answer.get('ok') and money_before == money_after)
    row = json.loads(run('SELECT hand_row FROM door_calls'))
    check('history-id-is-lightning-id', row['id'] == HAND)
    check('accepted-stats-kept', row['_accepted_post_commit_facts']['stats_facts'] == STATS)
    run(f"INSERT INTO hand_atomic_commits SELECT '{HAND}', '{HOST}', jsonb_build_object('accepted_hand_facts',hand_row->'_accepted_post_commit_facts') FROM door_calls;")
    projected = json.loads(run(f"SELECT public.ca_project_hand_stats_facts('{HAND}')"))
    check('real-projector-writes-all-participants-and-transfer', projected.get('ok') and projected['facts'] == 4 and projected['transfers'] == 1, projected)
    check('all-four-fact-rows-persist', run('SELECT count(*) FROM ca_hand_facts') == '4')
    check('transfer-row-persists', run('SELECT count(*) FROM ca_hand_transfers') == '1')
    replay = json.loads(run(f"SELECT public.ca_project_hand_stats_facts('{HAND}')"))
    check('projection-replay-idempotent', replay == projected and run('SELECT count(*) FROM ca_hand_facts') == '4')
    valid_stats = STATS
    for label, payload in [('absent', None), ('invalid', {'version': 1, 'facts': [{}], 'transfers': []})]:
        STATS = payload
        seed(); fallback, fallback_money = settle()
        fallback_row = json.loads(run('SELECT hand_row FROM door_calls'))
        check(label + '-facts-settle-with-original-money', fallback.get('ok') and fallback_money == money_before)
        check(label + '-facts-dropped', 'stats_facts' not in fallback_row['_accepted_post_commit_facts'] and 'id' not in fallback_row)
    STATS = valid_stats
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f"SET ROLE {role}; SELECT public.fn_lightning_hand_stats_facts(NULL,NULL,NULL,NULL);", text=True, capture_output=True, env=env)
        check(role + '-cannot-call-validator', r.returncode != 0 and 'permission denied' in r.stderr)
    r = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env)
    check('migration-replay-refused', r.returncode != 0)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'passed':len(results['checks']), 'output':str(out / 'RESULTS.json')}))
