"""Isolated PostgreSQL regression: the ledger replay's felt counts no Diamond seat.

fn_ca_account_balance('table_stack', ..., 'table_seats.stack') is the balance
fn_ca_ledger_replay judges the cash felt by. It must read the felt exactly as
fn_ca_supply_snapshot does: live seats, no tournament table and no table of a
club whose asset is 'diamonds' (a Diamond seat holds Diamonds that no
chip_ledger row moves). The test loads the exact production definitions
captured on 2026-10-08 (their pg_get_functiondef md5 equals production's),
proves the felt still counts a Diamond seat, applies the candidate migration
(a pinned-text substitution) and proves the felt then counts chips only, the
replay moved to basis one-snapshot-v5 (so every account rebaselines once
instead of judging a v4 felt that held Diamonds against a v5 one), both
postimages equal production's derived md5, grants did not move, and a second
run refuses because the preimage is no longer the pinned text.
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
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261008050323_the_ledger_replay_felt_counts_no_diamond_seat.sql'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'ledger-replay-felt-no-diamond'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/ledger-replay-felt-no-diamond')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='replay-felt-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production functions read on 2026-10-08,
# before and after the candidate (derived read-only on production).
BALANCE_SIG = 'public.fn_ca_account_balance(text,uuid,uuid,text)'
REPLAY_SIG = 'public.fn_ca_ledger_replay(integer)'
LIVE_BALANCE_MD5 = 'ff503f0f56f190fabc0af53d9f8b7703'
LIVE_REPLAY_MD5 = 'a6dd975e58b6dd8043d2771d9505fc6d'
POST_BALANCE_MD5 = '87c04e23118c9d8e05716ac032d30bbb'
POST_REPLAY_MD5 = '667ce8ace7773451a7969d0ad5f55729'
# Production's grants on both functions (read 2026-10-08):
# {postgres=X/postgres,service_role=X/postgres}.
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_ca_account_balance(text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_account_balance(text, uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_replay(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_replay(integer) TO service_role;
'''
FELT = "SELECT public.fn_ca_account_balance('table_stack', '00000000-0000-0000-0000-0000000fe17e'::uuid, NULL, 'table_seats.stack')"

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.clubs(id uuid PRIMARY KEY, asset text NOT NULL DEFAULT 'chips');
CREATE TABLE public.tables(id uuid PRIMARY KEY, club_id uuid, tournament_id uuid);
CREATE TABLE public.table_seats(id uuid PRIMARY KEY, table_id uuid, stack numeric, left_at timestamptz);
"""

# Chip cash 100 + 250.50 live (and 999 that left), a chip cash table whose
# club row is missing 40 (an unknown club stays counted, as in the supply
# meter), a tournament table 5000, a Diamond cash table 140006.
SEED = """
INSERT INTO public.clubs VALUES ('00000000-0000-0000-0000-00000000c001', 'chips'),
                                ('00000000-0000-0000-0000-00000000d001', 'diamonds');
INSERT INTO public.tables VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c001', NULL),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000c0ff', NULL),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-000000000777'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-00000000d001', NULL);
INSERT INTO public.table_seats VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000a1', 100.00, NULL),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-0000000000a1', 250.50, NULL),
  ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-0000000000a1', 999.00, now()),
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-0000000000a2', 40.00, NULL),
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-0000000000a3', 5000.00, NULL),
  ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-0000000000a4', 140006, NULL);
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


def md5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def acl(sig):
    return run(f"SELECT proacl::text || '|' || pg_get_userbyid(proowner) || '|' || prosecdef || '|' || "
               f"COALESCE(proconfig::text, '') FROM pg_proc WHERE oid = '{sig}'::regprocedure")


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Baseline: the exact production definitions before this change.
    run((FIXTURES / 'fn_ca_account_balance.live-20261008.sql').read_text() + ';\n'
        + (FIXTURES / 'fn_ca_ledger_replay.live-20261008.sql').read_text() + ';\n' + GRANTS)
    check('baseline-balance-is-production-preimage', md5(BALANCE_SIG) == LIVE_BALANCE_MD5, md5(BALANCE_SIG))
    check('baseline-replay-is-production-preimage', md5(REPLAY_SIG) == LIVE_REPLAY_MD5, md5(REPLAY_SIG))
    run(SEED)
    before = run(FELT)
    # The defect: the chip felt the replay judges carries the Diamond seat.
    check('baseline-felt-counts-the-diamond-seat', before == '140396.50', before)
    acl_before = (acl(BALANCE_SIG), acl(REPLAY_SIG))

    # The candidate migration, exactly as it would be installed.
    run(MIGRATION.read_text())
    after = run(FELT)
    check('felt-counts-chips-only', after == '390.50', after)
    check('balance-is-derived-postimage', md5(BALANCE_SIG) == POST_BALANCE_MD5, md5(BALANCE_SIG))
    check('replay-is-derived-postimage', md5(REPLAY_SIG) == POST_REPLAY_MD5, md5(REPLAY_SIG))
    replay = run(f"SELECT pg_get_functiondef('{REPLAY_SIG}'::regprocedure)")
    check('replay-basis-is-v5', "v_basis text := 'one-snapshot-v5';" in replay
          and "v_basis text := 'one-snapshot-v4';" not in replay)
    check('grants-owner-security-settings-unchanged', (acl(BALANCE_SIG), acl(REPLAY_SIG)) == acl_before,
          [acl_before, (acl(BALANCE_SIG), acl(REPLAY_SIG))])
    # A non-felt column still reads its own store (unchanged branch).
    check('missing-owner-is-unreadable-not-zero',
          run("SELECT public.fn_ca_account_balance('club_treasury', gen_random_uuid(), NULL, 'nope') IS NULL") == 't')

    # Invariant: the substitution refuses any text but the pinned preimage.
    try:
        run(MIGRATION.read_text())
        refused = False
    except RuntimeError as e:
        refused = 'is not the pinned text' in str(e)
    check('second-run-refuses-on-the-pinned-preimage', refused)
    check('second-run-left-the-postimage', md5(BALANCE_SIG) == POST_BALANCE_MD5 and md5(REPLAY_SIG) == POST_REPLAY_MD5)
    results['passed'] = True
except Exception as e:  # noqa: BLE001 - recorded, then re-raised
    results['passed'] = False
    results['error'] = str(e)
    raise
finally:
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:  # noqa: BLE001
        pass
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    shutil.rmtree(cluster, ignore_errors=True)
    print(json.dumps(results, indent=2))
