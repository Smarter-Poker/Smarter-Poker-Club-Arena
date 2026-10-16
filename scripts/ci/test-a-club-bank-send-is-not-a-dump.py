"""Isolated PostgreSQL regression: a club bank send is not a player transfer.

fn_union_integrity_sweep() raises 'direct_chip_transfer' signals for chips a
player moved to another player. A 'club_bank_send' moves chips out of the
CLUB BANK (metadata bank_before/bank_after); from_user_id names the owner only
as the bank's face, as to_user_id does on the already excluded
'club_bank_claim'. The owner's 2026-10-15 horse wallet reset (one send of
10,000 to every live horse from four club banks) was raised as 739 owner
dumps.

The test loads the exact production definition captured on 2026-10-16 (its
pg_get_functiondef md5 equals production's), proves it flags a club bank
send, then applies the candidate migration and proves:
  * a club bank send is not flagged and raises no financial alert;
  * a club bank claim is still not flagged;
  * a player to player transfer is still flagged and still raises the alert;
  * an agent's transfer is still not flagged;
  * the postimage md5 equals production's derived postimage, grants are
    unchanged, and a second install is refused by the pin.
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
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261016013849_a_club_bank_send_is_not_a_player_transfer.sql'
FIXTURE = ROOT / 'scripts' / 'ci' / 'fixtures' / 'bank-send-not-a-dump' / 'fn_union_integrity_sweep.live-20261016.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/a-club-bank-send-is-not-a-dump')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='bank-send-not-a-dump-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production function read 2026-10-16, before
# and after the candidate (the postimage derived read-only on production).
LIVE_DEF_MD5 = '8b7ba9bcadeb38bc7021cf04af28a877'
POST_DEF_MD5 = 'b3adb49ea93ac361b16c3c7ed19a865d'
UNION = 'fade0000-0000-0000-0000-000000000001'
CLUB = 'a0000000-0000-0000-0000-000000000001'
OWNER = '00000000-0000-0000-0000-00000000aaaa'
HORSE = '00000000-0000-0000-0000-000000000002'
PLAYER_A = '00000000-0000-0000-0000-00000000000a'
PLAYER_B = '00000000-0000-0000-0000-00000000000b'
AGENT = '00000000-0000-0000-0000-00000000000c'

SCHEMA = f"""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION public.fn_is_union_overseer(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE TABLE union_clubs(union_id uuid, club_id uuid);
CREATE TABLE clubs(id uuid PRIMARY KEY, is_union boolean);
CREATE TABLE club_members(club_id uuid, user_id uuid, agent_id uuid);
CREATE TABLE profiles(id uuid PRIMARY KEY, is_horse boolean);
CREATE TABLE wallet_transactions(user_id uuid, type text, category text, amount numeric,
  created_at timestamptz, table_id uuid, related_entity_id uuid);
CREATE TABLE tables(id uuid PRIMARY KEY, union_id uuid, club_id uuid);
CREATE TABLE tournaments(id uuid PRIMARY KEY, union_id uuid, club_id uuid);
CREATE TABLE rake_records(rake_amount numeric, player_contributions jsonb, created_at timestamptz,
  table_id uuid, tournament_id uuid, club_id uuid);
CREATE TABLE chip_transactions(club_id uuid, from_user_id uuid, to_user_id uuid, amount numeric,
  transaction_type text, metadata jsonb, created_at timestamptz);
CREATE TABLE agents(user_id uuid, club_id uuid);
CREATE TABLE table_seats(table_id uuid, user_id uuid, joined_at timestamptz);
CREATE TABLE financial_alerts(severity text, source text, message text, context jsonb,
  created_at timestamptz DEFAULT now());
INSERT INTO clubs VALUES ('{UNION}', true), ('{CLUB}', false);
INSERT INTO union_clubs VALUES ('{UNION}', '{CLUB}');
INSERT INTO profiles VALUES ('{HORSE}', true), ('{PLAYER_A}', false), ('{PLAYER_B}', false), ('{AGENT}', false);
INSERT INTO agents VALUES ('{AGENT}', '{CLUB}');
"""
GRANTS = """
REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_union_integrity_sweep(uuid, integer) TO service_role;
"""

ROWS = {
    'bank_send': f"('{CLUB}','{OWNER}','{HORSE}',10000,'club_bank_send','{{\"bank_before\":1,\"bank_after\":0}}',now())",
    'bank_claim': f"('{CLUB}','{PLAYER_A}','{OWNER}',500,'club_bank_claim','{{}}',now())",
    'player_dump': f"('{CLUB}','{PLAYER_A}','{PLAYER_B}',700,'player_transfer','{{}}',now())",
    'agent_send': f"('{CLUB}','{AGENT}','{PLAYER_B}',300,'player_transfer','{{}}',now())",
}


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


def sweep(kinds):
    run('TRUNCATE chip_transactions, financial_alerts;'
        + ''.join(f'INSERT INTO chip_transactions VALUES {ROWS[k]};' for k in kinds))
    result = json.loads(run(f"SELECT fn_union_integrity_sweep('{UNION}', 24)"))
    alerts = int(run("SELECT count(*) FROM financial_alerts WHERE source = 'fn_union_integrity_sweep'"))
    return sorted((f['from_user'], f['to_user']) for f in result['direct_chip_transfer']), alerts


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run(FIXTURE.read_text() + ';' + GRANTS)
    check('baseline-is-production-preimage',
          run("SELECT md5(pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure))")
          == LIVE_DEF_MD5)
    flags, alerts = sweep(['bank_send'])
    check('baseline-flags-a-club-bank-send', flags == [(OWNER, HORSE)] and alerts == 1, {'flags': flags, 'alerts': alerts})

    body = MIGRATION.read_text()
    run(body)
    check('postimage-is-production-derived-postimage',
          run("SELECT md5(pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure))")
          == POST_DEF_MD5)
    check('grants-unchanged',
          run("SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_integrity_sweep(uuid,integer)'::regprocedure")
          == '{postgres=X/postgres,service_role=X/postgres}')

    flags, alerts = sweep(['bank_send'])
    check('a-club-bank-send-is-not-flagged', flags == [] and alerts == 0, {'flags': flags, 'alerts': alerts})
    flags, alerts = sweep(['bank_claim'])
    check('a-club-bank-claim-is-still-not-flagged', flags == [] and alerts == 0, {'flags': flags, 'alerts': alerts})
    flags, alerts = sweep(['player_dump'])
    check('a-player-transfer-is-still-flagged', flags == [(PLAYER_A, PLAYER_B)] and alerts == 1,
          {'flags': flags, 'alerts': alerts})
    flags, alerts = sweep(['agent_send'])
    check('an-agent-transfer-is-still-not-flagged', flags == [] and alerts == 0, {'flags': flags, 'alerts': alerts})
    flags, alerts = sweep(list(ROWS))
    check('together-only-the-player-transfer', flags == [(PLAYER_A, PLAYER_B)] and alerts == 1,
          {'flags': flags, 'alerts': alerts})

    # A second install is refused by the pinned preimage, not applied twice.
    try:
        run(body)
        check('reinstall-is-refused', False, 'second install succeeded')
    except RuntimeError as e:
        check('reinstall-is-refused', 'is not the pinned text' in str(e), str(e)[:200])
    results['passed'] = True
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps(results, indent=2))
