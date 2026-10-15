"""Isolated two-session PostgreSQL regression for three production deadlocks.

Each case rebuilds the exact production definition from the migrations that
wrote it (pg_get_functiondef md5 equal to production on 2026-10-15), drives
the two transactions that deadlocked on production in the order the
postgres_logs show, proves the live text deadlocks (40P01 in the server log),
applies the candidate migration, proves the same interleaving completes with
no deadlock, and proves nothing credited changes.

  bbj   fn_sweep_bbj_promo_all vs the hand post-commit path
        (rake writes union_wallets, then the BBJ leg locks the pool).
        Migration 20261015094402: the sweep never waits while holding a pool.
  proj  fn_project_hand_side_effects vs itself, two hands sharing players
        (promo pass and projection pass touch player_stats in two orders).
        Migration 20261015094418: one player order for the whole transaction.
  sat   fn_ensure_scheduled_mtt_satellite vs a feeder registration
        (the registration's satellite_target_id foreign-key check needs
        FOR KEY SHARE on the target the board held FOR UPDATE).
        Migration 20261015094435: the board locks the target FOR NO KEY UPDATE.

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
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/deadlock-lock-orders-r5')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='deadlock-r5-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
LOG = cluster / 'log'
results = {'checks': [], 'production_mutations': False}

LIVE = {
    'bbj': ('20260902220500_the_undeclared_legs_name_their_counterparty.sql', 'fn_sweep_bbj_promo_all',
            'public.fn_sweep_bbj_promo_all()', '11c5feb40c252909a4281e8faf31c9ac',
            '20261015094402_bbj_promo_sweep_never_waits_while_holding_a_pool.sql',
            'ff0157072680c056f3beddec28db5bb7'),
    'proj': ('20260908155252_hand_projection_takes_post_commit_lock_first.sql', 'fn_project_hand_side_effects',
             'public.fn_project_hand_side_effects(uuid)', 'fefbd3c58b8de6ba3c21c8acea1de884',
             '20261015094418_every_hand_projection_takes_its_players_in_one_order.sql',
             '5dbf4d0b1717a7ad0497f26c99ab2767'),
    'sat': ('20261002082303_satellite_board_stands_down_for_a_scheduled_series_and_orpha.sql',
            'fn_ensure_scheduled_mtt_satellite', 'public.fn_ensure_scheduled_mtt_satellite(jsonb)',
            '1760f4d9077253a29ed4243f0d16717b',
            '20261015094435_the_satellite_board_never_blocks_a_feeder_s_foreign_key_chec.sql',
            '7d2692a9dd3ba29538636bb35029ace0'),
}

U = 'fade0000-0000-0000-0000-000000000001'
C = 'a0000000-0000-0000-0000-000000000001'
POOL = 'b0000000-0000-0000-0000-000000000001'
A = '10000000-0000-0000-0000-00000000000a'
B = '20000000-0000-0000-0000-00000000000b'
T = 'c0000000-0000-0000-0000-0000000000a1'
F = 'c0000000-0000-0000-0000-0000000000f1'


def psql(db):
    return [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', db]


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(db, sql):
    return command(psql(db), sql)


def spawn(db, sql=None):
    p = subprocess.Popen(list(map(str, psql(db))), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, env=env)
    if sql is not None:
        p.stdin.write(sql)
        p.stdin.flush()
    return p


def send(p, sql):
    p.stdin.write(sql)
    p.stdin.flush()


def finish(p):
    if not p.stdin.closed:
        p.stdin.close()
    p.wait(timeout=120)
    return p.returncode, p.stdout.read().strip(), p.stderr.read().strip()


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def deadlocks():
    return LOG.read_text(errors='replace').count('deadlock detected')


def definition(file, name):
    source = (MIGRATIONS / file).read_text()
    found = list(re.finditer(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name)
                             + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1\s*;', source, re.S))
    if not found:
        raise ValueError('missing definition: ' + name + ' in ' + file)
    return found[-1].group(0)


def md5(db, sig):
    return run(db, f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def load_live(db, key):
    file, name, sig, live_md5, _, _ = LIVE[key]
    run(db, definition(file, name))
    run(db, f'REVOKE ALL ON FUNCTION {sig} FROM PUBLIC, anon, authenticated; '
            f'GRANT EXECUTE ON FUNCTION {sig} TO service_role;')
    check(f'{key}: the rebuilt definition is the production text', md5(db, sig) == live_md5)


def apply_candidate(db, key):
    _, _, sig, _, migration, post_md5 = LIVE[key]
    run(db, (MIGRATIONS / migration).read_text())
    check(f'{key}: the migration reproduces the postimage derived on production', md5(db, sig) == post_md5)


ROLES = 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;'
COMMON = """
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT 'service_role'::text$$;
"""

BBJ_SCHEMA = f"""
CREATE TABLE unions(id uuid PRIMARY KEY, promo_funded_from_bbj numeric DEFAULT 0, updated_at timestamptz);
CREATE TABLE clubs(id uuid PRIMARY KEY, union_id uuid REFERENCES unions(id), promo_balance numeric DEFAULT 0,
  chip_treasury numeric DEFAULT 0, updated_at timestamptz);
CREATE TABLE union_wallets(union_id uuid PRIMARY KEY REFERENCES unions(id), promo_wallet numeric DEFAULT 0,
  rake_wallet numeric DEFAULT 0);
CREATE TABLE bbj_pools(id uuid PRIMARY KEY, club_id uuid REFERENCES clubs(id), union_id uuid REFERENCES unions(id),
  main_balance numeric DEFAULT 0, promo_balance numeric DEFAULT 0, status text, created_at timestamptz DEFAULT now(),
  updated_at timestamptz);
CREATE TABLE union_wallet_transactions(id uuid PRIMARY KEY, union_id uuid REFERENCES unions(id), wallet text,
  direction text, amount numeric, balance_after numeric, tx_type text, club_id uuid REFERENCES clubs(id),
  notes text, created_at timestamptz);
CREATE TABLE chip_transactions(id uuid PRIMARY KEY, club_id uuid, from_user_id uuid, to_user_id uuid,
  amount numeric, transaction_type text, notes text, balance_after numeric, created_at timestamptz);
CREATE FUNCTION fn_ca_declare_ledger(text, text, uuid, uuid, text, text[]) RETURNS void LANGUAGE sql AS '';
INSERT INTO unions(id) VALUES ('{U}');
INSERT INTO clubs(id, union_id) VALUES ('{C}', '{U}');
INSERT INTO union_wallets(union_id) VALUES ('{U}');
INSERT INTO bbj_pools(id, union_id, promo_balance, status) VALUES ('{POOL}', '{U}', 37.25, 'active');
"""

# The hand post-commit path's lock order, statement for statement:
# atomic_distribute_rake's union wallet leg, then the BBJ leg's pool lock
# (fn_ca_process_hand_post_commit_obligations line 169 on production).
HAND_RAKE = f"BEGIN;\nUPDATE union_wallets SET rake_wallet = rake_wallet + 1 WHERE union_id = '{U}';\n"
HAND_BBJ = (f"SELECT p.id FROM public.bbj_pools p WHERE p.union_id = '{U}' AND p.status = 'active' "
            "ORDER BY p.created_at, p.id LIMIT 1 FOR UPDATE;\n"
            f"UPDATE bbj_pools SET main_balance = main_balance + 1 WHERE id = '{POOL}';\nSELECT 'hand-done';\nCOMMIT;\n")


def bbj_round(db):
    """The hand holds the wallet; the sweep starts; the hand asks for the pool."""
    before = deadlocks()
    hand = spawn(db, HAND_RAKE)
    time.sleep(0.4)
    sweep = spawn(db, 'SELECT public.fn_sweep_bbj_promo_all();\n')
    sweep.stdin.close()
    time.sleep(0.6)
    send(hand, HAND_BBJ)
    hand.stdin.close()
    h = finish(hand)
    s = finish(sweep)
    return deadlocks() - before, h, s


PROJ_SCHEMA = f"""
CREATE TABLE hand_projection_outbox(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint);
CREATE TABLE hand_history(id uuid PRIMARY KEY, table_id uuid, hand_number bigint, players jsonb);
CREATE TABLE hand_atomic_commits(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint);
CREATE TABLE hand_promo(hand_id uuid, user_id uuid);
CREATE TABLE player_stats(user_id uuid, club_id uuid, hands_dealt integer DEFAULT 0,
  total_losses numeric DEFAULT 0, updated_at timestamptz DEFAULT now(), UNIQUE (user_id, club_id));
CREATE INDEX ON player_stats(updated_at);
INSERT INTO player_stats(user_id, club_id) VALUES ('{A}', '{C}'), ('{B}', '{C}');
-- The promo pass (promo_apply_playthrough, per promo player in user order).
CREATE FUNCTION public.fn_ca_process_hand_post_commit_obligations(p_hand_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT user_id FROM hand_promo WHERE hand_id = p_hand_id ORDER BY user_id LOOP
    INSERT INTO player_stats AS ps(user_id, club_id, total_losses) VALUES (r.user_id, '{C}', 1)
    ON CONFLICT (user_id, club_id) DO UPDATE SET total_losses = ps.total_losses + 1, updated_at = now();
  END LOOP;
  RETURN jsonb_build_object('ok', true);
END $$;
-- The projection pass (Projection 2, every seated player in uuid order). The
-- shared advisory gate lets the test hold both hands between the passes.
CREATE FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(p_hand_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_lock_shared(4242);
  PERFORM pg_advisory_unlock_shared(4242);
  INSERT INTO player_stats AS ps(user_id, club_id, hands_dealt)
  SELECT DISTINCT (pl->>'userId')::uuid, '{C}'::uuid, 1
    FROM hand_history h, jsonb_array_elements(h.players) pl WHERE h.id = p_hand_id
   ORDER BY 1
  ON CONFLICT (user_id, club_id) DO UPDATE SET hands_dealt = ps.hands_dealt + 1, updated_at = now();
  DELETE FROM hand_projection_outbox WHERE hand_id = p_hand_id;
  RETURN jsonb_build_object('ok', true, 'hand_id', p_hand_id);
END $$;
"""


def proj_hands(db, n):
    """Two hands at two tables with the same two players; each promo pass touches the other's second player."""
    h1, h2 = f'd{n}000000-0000-0000-0000-000000000001', f'd{n}000000-0000-0000-0000-000000000002'
    t1, t2 = 'e0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002'
    players = json.dumps([{'userId': A}, {'userId': B}])
    run(db, f"""
INSERT INTO hand_projection_outbox VALUES ('{h1}', '{t1}', {n}), ('{h2}', '{t2}', {n});
INSERT INTO hand_history VALUES ('{h1}', '{t1}', {n}, '{players}'), ('{h2}', '{t2}', {n}, '{players}');
INSERT INTO hand_atomic_commits VALUES ('{h1}', '{t1}', {n}), ('{h2}', '{t2}', {n});
INSERT INTO hand_promo VALUES ('{h1}', '{B}'), ('{h2}', '{A}');
""")
    return h1, h2


def proj_round(db, n):
    h1, h2 = proj_hands(db, n)
    before = deadlocks()
    gate = spawn(db, 'SELECT pg_advisory_lock(4242);\n')
    time.sleep(0.3)
    s1 = spawn(db, f"SELECT public.fn_project_hand_side_effects('{h1}');\n")
    s1.stdin.close()
    time.sleep(0.5)
    s2 = spawn(db, f"SELECT public.fn_project_hand_side_effects('{h2}');\n")
    s2.stdin.close()
    time.sleep(0.5)
    send(gate, 'SELECT pg_advisory_unlock(4242);\n')
    gate.stdin.close()
    finish(gate)
    r1, r2 = finish(s1), finish(s2)
    return deadlocks() - before, r1, r2


SAT_SCHEMA = f"""
CREATE TABLE public.tournaments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, game_type text,
  variant text, buy_in_amount numeric(15,2), buy_in_fee numeric(15,2), guaranteed_prize numeric(15,2),
  start_time timestamptz, status text, current_players integer, max_players integer, late_reg_mins integer,
  starting_chips integer, blind_structure text, payout_structure text, club_id uuid, prize_pool numeric(18,2),
  min_players integer, tournament_type text, union_id uuid, prize_pool_finalized boolean, is_turbo boolean,
  blind_speed text, total_rake numeric(18,2), late_reg_levels integer, satellite_target uuid,
  satellite_target_id uuid REFERENCES public.tournaments(id), bounty_pool numeric(18,2), short_description text,
  table_size integer, synchronized_breaks boolean, satellite_seats integer, schedule_id uuid,
  format_contract text, restart_source_id uuid REFERENCES public.tournaments(id));
CREATE TABLE public.tables(id uuid PRIMARY KEY, tournament_id uuid, is_deleted boolean, status text,
  club_id uuid, max_players integer);
CREATE TABLE public.tournament_players(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid REFERENCES public.tournaments(id), user_id uuid, status text DEFAULT 'registered');
-- trg_sync_tournament_current_players: the roster insert refreshes the cache.
CREATE FUNCTION fn_sync_tournament_current_players() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.tournaments SET current_players = (SELECT count(*) FROM public.tournament_players
                                                     WHERE tournament_id = NEW.tournament_id)
   WHERE id = NEW.tournament_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sync_tournament_current_players AFTER INSERT ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION fn_sync_tournament_current_players();
CREATE FUNCTION public.fn_ca_mtt_blind_contract(text, integer) RETURNS jsonb LANGUAGE sql AS $$SELECT '{{}}'::jsonb$$;
CREATE FUNCTION public.fn_ca_lock_mtt_admission_contract() RETURNS text LANGUAGE sql AS $$SELECT 'unlimited-mtt-v2'::text$$;
CREATE FUNCTION public.fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
INSERT INTO public.tournaments(id, name, club_id, status, current_players, buy_in_amount, buy_in_fee, start_time)
VALUES ('{T}', 'Target', '{C}', 'REGISTERING', 0, 180, 20, now() + interval '1 day');
INSERT INTO public.tournaments(id, name, club_id, status, current_players, satellite_target_id, format_contract,
  game_type, tournament_type, start_time)
VALUES ('{F}', 'Feeder', '{C}', 'REGISTERING', 0, '{T}', 'mtt-v2', 'NLH', 'SATELLITE', now() + interval '2 hours');
"""

SAT_COMMON = {'club_id': C, 'satellite_target_id': T, 'name': 'Feeder', 'game_type': 'NLH',
              'tournament_type': 'SATELLITE', 'status': 'REGISTERING', 'current_players': 0,
              'starting_chips': 1000, 'blind_structure': '[{"level":1}]',
              'payout_structure': '[{"place":1,"percentage":100}]', 'satellite_seats': 1,
              'guaranteed_prize': 0, 'late_reg_levels': 0, 'late_reg_mins': 0,
              'start_time': '2099-01-01T00:00:00Z'}
SAT_CONFIG = json.dumps({
    'legacy_config': dict(SAT_COMMON, variant='sng', max_players=2, min_players=2, table_size=2,
                          buy_in_amount=19, buy_in_fee=1),
    'scheduled_config': dict(SAT_COMMON, variant='satellite', min_players=3, table_size=6,
                             synchronized_breaks=True, buy_in_amount=18, buy_in_fee=2),
})


def sat_round(db, n):
    """The registration holds the feeder; the board locks the target; the registration's UPDATE re-checks the FK."""
    before = deadlocks()
    reg = spawn(db, f"""BEGIN;
SELECT id FROM public.tournaments WHERE id = '{F}' FOR UPDATE;
INSERT INTO public.tournament_players(tournament_id, user_id) VALUES ('{F}', gen_random_uuid());
""")
    time.sleep(0.4)
    board = spawn(db, f"SELECT public.fn_ensure_scheduled_mtt_satellite('{SAT_CONFIG}'::jsonb)->>'outcome';\n")
    board.stdin.close()
    time.sleep(0.6)
    send(reg, f"""UPDATE public.tournaments
   SET current_players = {n}, prize_pool = COALESCE(prize_pool, 0) + 18, total_rake = COALESCE(total_rake, 0) + 2
 WHERE id = '{F}';
SELECT 'registration-done';
COMMIT;
""")
    reg.stdin.close()
    r = finish(reg)
    b = finish(board)
    return deadlocks() - before, r, b


try:
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-A', 'trust', '-U', 'postgres'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c deadlock_timeout=200ms",
                        '-l', LOG, '-w', 'start'])
    run('postgres', ROLES)
    for db in ('bbj', 'proj', 'sat'):
        run('postgres', f'CREATE DATABASE {db}')
    for db in ('bbj', 'proj', 'sat'):
        run(db, COMMON)
    run('bbj', BBJ_SCHEMA)
    run('proj', PROJ_SCHEMA)
    run('sat', SAT_SCHEMA)

    # ---- bbj ------------------------------------------------------------
    load_live('bbj', 'bbj')
    n, h, s = bbj_round('bbj')
    check('bbj: the live sweep deadlocks with the hand path', n >= 1, {'deadlocks': n, 'hand': h, 'sweep': s})
    # Reset the pool and wallet to the same starting point.
    run('bbj', f"UPDATE bbj_pools SET promo_balance = 37.25 WHERE id = '{POOL}'; "
               f"UPDATE union_wallets SET promo_wallet = 0 WHERE union_id = '{U}'; "
               "DELETE FROM union_wallet_transactions; UPDATE unions SET promo_funded_from_bbj = 0;")
    apply_candidate('bbj', 'bbj')
    n, h, s = bbj_round('bbj')
    sweep_result = json.loads(s[1]) if s[0] == 0 and s[1] else None
    check('bbj: after the fix the same interleaving does not deadlock', n == 0 and h[0] == 0 and s[0] == 0,
          {'deadlocks': n, 'hand': h, 'sweep': s})
    check('bbj: the busy pool is left for the next run, not counted as an error',
          sweep_result is not None and sweep_result.get('busy_retry_next_run') == 1
          and sweep_result.get('errors') == 0 and sweep_result.get('pools_swept') == 0, sweep_result)
    check('bbj: the promo slice is still in the pool',
          run('bbj', f"SELECT promo_balance FROM bbj_pools WHERE id = '{POOL}'") == '37.25')
    nxt = json.loads(run('bbj', 'SELECT public.fn_sweep_bbj_promo_all()'))
    money = run('bbj', f"SELECT (SELECT promo_wallet FROM union_wallets WHERE union_id = '{U}') || '|' || "
                       f"(SELECT promo_balance FROM bbj_pools WHERE id = '{POOL}') || '|' || "
                       f"(SELECT promo_funded_from_bbj FROM unions WHERE id = '{U}') || '|' || "
                       "(SELECT count(*) FROM union_wallet_transactions)")
    check('bbj: the next run sweeps exactly the same amount to the same wallet',
          nxt.get('pools_swept') == 1 and money == '37.25|0|37.25|1', {'next': nxt, 'money': money})

    # ---- proj -----------------------------------------------------------
    load_live('proj', 'proj')
    n, r1, r2 = proj_round('proj', 1)
    check('proj: the live projection deadlocks between its passes', n >= 1, {'deadlocks': n, 's1': r1, 's2': r2})
    run('proj', f"UPDATE player_stats SET hands_dealt = 0, total_losses = 0; DELETE FROM hand_projection_outbox;")
    apply_candidate('proj', 'proj')
    n, r1, r2 = proj_round('proj', 2)
    check('proj: after the fix two hands sharing players do not deadlock',
          n == 0 and r1[0] == 0 and r2[0] == 0, {'deadlocks': n, 's1': r1, 's2': r2})
    stats = run('proj', "SELECT string_agg(user_id || ':' || hands_dealt || ':' || total_losses, ',' ORDER BY user_id) "
                        "FROM player_stats")
    check('proj: both hands wrote every pass exactly once', stats == f'{A}:2:1,{B}:2:1', stats)

    # ---- sat ------------------------------------------------------------
    load_live('sat', 'sat')
    n, r, b = sat_round('sat', 1)
    check('sat: the live board deadlocks with a feeder registration', n >= 1, {'deadlocks': n, 'reg': r, 'board': b})
    apply_candidate('sat', 'sat')
    n, r, b = sat_round('sat', 2)
    check('sat: after the fix the registration commits and the board answers',
          n == 0 and r[0] == 0 and 'registration-done' in r[1] and b[0] == 0 and b[1] == 'existing_active',
          {'deadlocks': n, 'reg': r, 'board': b})
    check('sat: the board still refuses a writer to the target while it decides',
          run('sat', "SELECT 'FOR NO KEY UPDATE' = substring(pg_get_functiondef("
                     "'public.fn_ensure_scheduled_mtt_satellite(jsonb)'::regprocedure) "
                     "FROM 'v_row.satellite_target_id (FOR NO KEY UPDATE);')") == 't')
    results['passed'] = True
finally:
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')

print(json.dumps(results, indent=2))
