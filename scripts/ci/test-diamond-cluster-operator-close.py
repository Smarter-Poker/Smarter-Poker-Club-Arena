"""Isolated PostgreSQL regression: a Diamond cluster tick skips an operator
closed table.

Migration 20261015181551. On 2026-10-15 the owner's close_cash left the nine
tables of the Diamond must-move game f141626a status 'closed' with lifecycle
'live'. fn_poker_diamond_project_cluster's admission check asked
fn_poker_diamond_plain_cash_table of every non-closed-lifecycle table, that
answers false for status 'closed', and every pass of the game raised 23514
diamond_cluster_table_not_admitted (ClusterPassErrors), during the park and
after the resume, so the game could not reopen a table.

The test loads the exact production definitions captured on 2026-10-15
(pg_get_functiondef md5 equal to production's), proves the baseline refuses
a cluster whose only defect is an operator-closed sibling, applies the
candidate migration, and proves:
  * the projection now admits that cluster and still projects the open table;
  * a table that is open and not plain cash (a template) is still refused;
  * a closed table that reopens is judged again on the next projection;
  * the function reproduces production's derived postimage md5.
An empty throwaway cluster on a Unix socket; no network, no production
connection.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'diamond-cluster-operator-close'
CANDIDATE = ROOT / 'supabase' / 'migrations' / '20261015181551_a_diamond_cluster_tick_skips_an_operator_closed_table.sql'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/diamond-cluster-operator-close')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='diamond-close-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SIG = 'public.fn_poker_diamond_project_cluster(uuid,uuid)'
PRE = '06f2ed68958ddf35b5f61eb32b561c46'
POST = '49d1391b31e6bb2f12fcd803d4e317fd'
PLAIN_PRE = '9e940693c9ccfc74ed2a0ee38fe8b742'

CLUB = '00000000-0000-0000-0000-0000000000d1'
GAME = '00000000-0000-0000-0000-0000000000e1'

SCHEMA = '''
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.clubs (id uuid PRIMARY KEY, union_id uuid, asset text, is_platform boolean);
CREATE TABLE public.cash_games (
  id uuid PRIMARY KEY, club_id uuid, union_id uuid, variant text, sb numeric, bb numeric, handedness integer,
  ruleset_snapshot jsonb, must_move boolean, cluster_mode text, lightning_enabled boolean);
CREATE TABLE public.tables (
  id uuid PRIMARY KEY, club_id uuid, small_blind numeric, big_blind numeric, min_buy_in numeric, max_buy_in numeric,
  max_players integer, status text, updated_at timestamptz, game_variant text, run_it_twice boolean, ante numeric,
  allow_run_it_twice boolean, is_template boolean, bomb_pot_enabled boolean, pineapple_holdem boolean,
  seven_deuce_enabled boolean, nit_game boolean, cap_enabled boolean, action_time_seconds integer,
  auto_extension boolean, auto_restart boolean, auto_create_table boolean, auto_utg_straddle boolean,
  voluntary_straddle boolean, insurance_enabled boolean, run_it_mode character varying, rake_percent numeric,
  rake_cap_bb numeric, all_in_or_fold boolean, is_deleted boolean, bbj_percent numeric, tournament_id uuid,
  union_id uuid, big_blind_ante_enabled boolean, straddle_enabled boolean, run_it_twice_enabled boolean,
  ante_enabled boolean, bomb_pot_frequency integer, bomb_pot_ante_multiplier integer, bomb_pot_double_board boolean,
  bomb_pot_board_count smallint, bomb_pot_trigger_mode text, bomb_pot_interval_seconds integer,
  bomb_pot_ante_fixed numeric, bomb_pot_variant text, cluster_id uuid, role text, main_index integer, lifecycle text);
CREATE TABLE public.table_seats (table_id uuid, seat_number integer, left_at timestamptz);
'''

PLAIN = ('small_blind, big_blind, min_buy_in, max_buy_in, max_players, game_variant, run_it_twice, allow_run_it_twice, '
         'rake_percent, rake_cap_bb, bbj_percent, action_time_seconds, auto_extension, auto_restart, auto_create_table, '
         'is_deleted, cluster_id, role, main_index, club_id')
PLAIN_VALUES = (f"1, 2, 40, 200, 6, 'nlh', false, true, 0, 0, 0, 15, false, false, false, false, '{GAME}', 'main', ")


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


def project():
    """The projection's answer: the row count, or the refusal's message."""
    try:
        return run(f"SELECT public.fn_poker_diamond_project_cluster('{GAME}', NULL);")
    except RuntimeError as err:
        return 'refused: ' + ('diamond_cluster_table_not_admitted' if 'diamond_cluster_table_not_admitted' in str(err) else str(err))


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    for f in ['fn_poker_diamond_cash_variant', 'fn_poker_diamond_plain_cash_table', 'fn_poker_diamond_project_cluster']:
        run((FIXTURES / f'{f}.sql').read_text())
    run(f"""REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC, anon, authenticated;
            GRANT EXECUTE ON FUNCTION {SIG} TO service_role;""")
    check('baseline projection is the production text', run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure));") == PRE)
    check('baseline plain-cash rule is the production text',
          run("SELECT md5(pg_get_functiondef('public.fn_poker_diamond_plain_cash_table(tables)'::regprocedure));") == PLAIN_PRE)

    snapshot = json.dumps({'diamond_table': {'min_buy_in': 40, 'max_buy_in': 200, 'rake_percent': 0, 'rake_cap_bb': 0,
                                             'bbj_percent': 0, 'run_it_twice': False, 'allow_run_it_twice': True}})
    run(f"""
INSERT INTO public.clubs VALUES ('{CLUB}', NULL, 'diamonds', true);
INSERT INTO public.cash_games VALUES ('{GAME}', '{CLUB}', NULL, 'nlh', 1, 2, 6, '{snapshot}', true, 'must_move', false);
-- Main 1 open and plain; Main 2 closed by an operator close (status closed, lifecycle live).
INSERT INTO public.tables (id, status, lifecycle, {PLAIN}) VALUES
  ('00000000-0000-0000-0000-000000000f01', 'waiting', 'live', {PLAIN_VALUES}1, '{CLUB}'),
  ('00000000-0000-0000-0000-000000000f02', 'closed',  'live', {PLAIN_VALUES}2, '{CLUB}');
""")
    check('baseline refuses the whole cluster for one operator-closed sibling',
          project() == 'refused: diamond_cluster_table_not_admitted', project())

    run(CANDIDATE.read_text())
    check('the projection reproduces the derived postimage',
          run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure));") == POST)
    check('a closed sibling no longer refuses the cluster', project() == '0', project())

    run("UPDATE public.tables SET min_buy_in = 20 WHERE id = '00000000-0000-0000-0000-000000000f01';")
    check('the open table is still projected', project() == '1'
          and run("SELECT min_buy_in FROM public.tables WHERE id = '00000000-0000-0000-0000-000000000f01';") == '40')

    # is_template is a plain-cash disqualifier the projection never rewrites.
    run("UPDATE public.tables SET is_template = true WHERE id = '00000000-0000-0000-0000-000000000f01';")
    check('an open table that is not plain cash is still refused',
          project() == 'refused: diamond_cluster_table_not_admitted', project())
    run("UPDATE public.tables SET is_template = false WHERE id = '00000000-0000-0000-0000-000000000f01';")
    check('and admitted again once it is', project() == '0', project())

    run("UPDATE public.tables SET is_template = true WHERE id = '00000000-0000-0000-0000-000000000f02';")
    check('a closed table is not judged while it is closed', project() == '0', project())
    run("UPDATE public.tables SET status = 'waiting' WHERE id = '00000000-0000-0000-0000-000000000f02';")
    check('a closed table that reopens is judged again', project() == 'refused: diamond_cluster_table_not_admitted', project())

    results['passed'] = True
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)
print(json.dumps({'passed': results.get('passed', False), 'checks': len(results['checks'])}))
