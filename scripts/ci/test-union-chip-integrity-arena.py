"""Isolated PostgreSQL regression for fn_union_chip_integrity_check.

The Diamond Arena (asset diamonds, is_platform) keeps no club_members rows:
every live account is a member of it by rule (fn_poker_arena_context), and an
arena cash-out lands in the Diamond wallet. The live check asked for a
club_members row anyway, so every arena seat and live arena tournament entry
read as an "orphan stamp" and fn_ca_conservation_sweep raised two CRITICAL
incidents every hour from 2026-10-06 20:52 UTC.

The test loads the exact production definition captured on 2026-10-08 (its
pg_get_functiondef md5 equals production's 35e372f3...), proves it reports a
live arena seat and entry as orphans, then applies the candidate migration (a
pinned-text substitution) and proves:
  * a live arena player's seat and entry are no longer orphans;
  * an arena seat or entry of a deleted sign-in or a closed profile still is;
  * a chip-club seat or entry with no club_members row still is;
  * a chip club whose asset is not diamonds is not exempted by is_platform;
  * negative_club_balance and seat_stamped_outside_union are unchanged;
  * fn_union_law_integrity_breaches (which reads this function) follows;
  * the result reproduces production's derived postimage md5, keeps owner,
    SECURITY DEFINER, search_path and grants, and a second run refuses.
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
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'union-chip-integrity-arena'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/union-chip-integrity-arena')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='union-chip-arena-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of production's function read on 2026-10-08, before
# and after the candidate (the postimage derived read-only on production).
LIVE_DEF_MD5 = '35e372f310ce794d10c5201943fd6ddc'
POST_DEF_MD5 = '057b118890dcd29fccb3aec5b189edf7'
SIG = 'public.fn_union_chip_integrity_check()'
# Production's grants (proacl {postgres=X/postgres,service_role=X/postgres}).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_union_chip_integrity_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_union_chip_integrity_check() TO service_role;
'''
# fn_union_law_integrity_breaches, word for word as production serves it.
LAW = '''
CREATE OR REPLACE FUNCTION public.fn_union_law_integrity_breaches()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'check', invariant, 'count', offenders, 'detail', detail)), '[]'::jsonb)
    FROM public.fn_union_chip_integrity_check();
$function$;
'''

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY, deleted_at timestamptz);
CREATE TABLE profiles(id uuid PRIMARY KEY, status text);
CREATE TABLE clubs(id uuid PRIMARY KEY, asset text, is_platform boolean, union_id uuid);
CREATE TABLE club_members(user_id uuid, club_id uuid, chip_balance numeric DEFAULT 0);
CREATE TABLE union_clubs(club_id uuid, union_id uuid);
CREATE TABLE tables(id uuid PRIMARY KEY, union_id uuid);
CREATE TABLE table_seats(table_id uuid, user_id uuid, club_id uuid, left_at timestamptz);
CREATE TABLE tournaments(id uuid PRIMARY KEY, status text);
CREATE TABLE tournament_players(tournament_id uuid, user_id uuid, club_id uuid);
"""

ARENA = '00000000-0000-0000-0000-00000000a000'
CHIP = '00000000-0000-0000-0000-00000000c000'
ODD = '00000000-0000-0000-0000-00000000d000'   # is_platform but asset chips
UNION = '00000000-0000-0000-0000-00000000e000'
T_ARENA = '00000000-0000-0000-0000-0000000000a1'
T_UNION = '00000000-0000-0000-0000-0000000000e1'
TOURNEY = '00000000-0000-0000-0000-0000000000f1'
DONE = '00000000-0000-0000-0000-0000000000f2'


def u(n):
    return f'00000000-0000-0000-0000-{n:012d}'


LIVE, DELETED_SIGNIN, CLOSED, NO_PROFILE, CHIP_MEMBER, CHIP_STRANGER, NEGATIVE = (u(i) for i in range(1, 8))

SEED = f"""
INSERT INTO clubs VALUES ('{ARENA}','diamonds',true,NULL), ('{CHIP}','chips',false,'{UNION}'),
                         ('{ODD}','chips',true,NULL);
INSERT INTO union_clubs VALUES ('{CHIP}','{UNION}');
INSERT INTO tables VALUES ('{T_ARENA}',NULL), ('{T_UNION}','{UNION}');
INSERT INTO tournaments VALUES ('{TOURNEY}','RUNNING'), ('{DONE}','COMPLETED');
INSERT INTO auth.users VALUES ('{LIVE}',NULL), ('{DELETED_SIGNIN}',now()), ('{CLOSED}',NULL),
  ('{CHIP_MEMBER}',NULL), ('{CHIP_STRANGER}',NULL), ('{NEGATIVE}',NULL);
INSERT INTO profiles VALUES ('{LIVE}','active'), ('{DELETED_SIGNIN}','active'), ('{CLOSED}','deleted'),
  ('{CHIP_MEMBER}','active'), ('{CHIP_STRANGER}','active'), ('{NEGATIVE}',NULL);
INSERT INTO club_members VALUES ('{CHIP_MEMBER}','{CHIP}',10), ('{NEGATIVE}','{CHIP}',-5);
-- seats: a live arena player (not an orphan), three arena seats with no live
-- account (orphans), a chip-club member (fine), a chip-club stranger (orphan),
-- a live player stamped to a platform club that is not the Diamond asset
-- (orphan), a stranger's seat that already left (ignored), and a chip-club
-- seat at a table of a union the club is not in (outside union).
INSERT INTO table_seats VALUES
  ('{T_ARENA}','{LIVE}','{ARENA}',NULL),
  ('{T_ARENA}','{DELETED_SIGNIN}','{ARENA}',NULL),
  ('{T_ARENA}','{CLOSED}','{ARENA}',NULL),
  ('{T_ARENA}','{NO_PROFILE}','{ARENA}',NULL),
  ('{T_UNION}','{CHIP_MEMBER}','{CHIP}',NULL),
  ('{T_ARENA}','{CHIP_STRANGER}','{CHIP}',NULL),
  ('{T_ARENA}','{LIVE}','{ODD}',NULL),
  ('{T_ARENA}','{CHIP_STRANGER}','{ARENA}',now());
INSERT INTO table_seats VALUES ('{T_UNION}','{CHIP_MEMBER}','{ODD}',NULL);
INSERT INTO tournament_players VALUES
  ('{TOURNEY}','{LIVE}','{ARENA}'),
  ('{TOURNEY}','{CLOSED}','{ARENA}'),
  ('{TOURNEY}','{CHIP_MEMBER}','{CHIP}'),
  ('{TOURNEY}','{CHIP_STRANGER}','{CHIP}'),
  ('{DONE}','{CHIP_STRANGER}','{CHIP}');
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


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


def findings():
    rows = run("SELECT invariant || '=' || offenders FROM public.fn_union_chip_integrity_check()")
    return dict(r.split('=') for r in rows.splitlines() if r)


def md5():
    return run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")


def shape():
    return run(f"""SELECT p.proacl::text || '|' || pg_get_userbyid(p.proowner) || '|' || p.prosecdef
                         || '|' || array_to_string(p.proconfig, ',') || '|' || p.provolatile::text
                    FROM pg_proc p WHERE p.oid = '{SIG}'::regprocedure""")


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Baseline: the exact production definition before this change.
    base = (FIXTURES / 'fn_union_chip_integrity_check.live-20261008.sql').read_text()
    run(base + ';' + GRANTS + LAW)
    check('baseline-is-production-preimage', md5() == LIVE_DEF_MD5, md5())
    before_shape = shape()
    run(SEED)
    f = findings()
    results['baseline'] = f
    # 4 arena seats (one live player among them) + chip stranger + ODD x2.
    check('baseline-reports-the-live-arena-seat-as-an-orphan', f.get('orphan_stamped_seat') == '7', f)
    check('baseline-reports-the-live-arena-entry-as-an-orphan', f.get('orphan_stamped_entry') == '3', f)
    check('baseline-negative-balance', f.get('negative_club_balance') == '1', f)
    check('baseline-outside-union', f.get('seat_stamped_outside_union') == '1', f)

    # Candidate: the migration under test, applied as production would.
    migration = one('*_a_diamond_arena_seat_is_not_an_orphan_stamp.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', md5() == POST_DEF_MD5, md5())
    check('owner-security-settings-grants-volatility-unchanged', shape() == before_shape, [before_shape, shape()])
    f = findings()
    results['candidate'] = f
    # Left: arena deleted sign-in, arena closed profile, arena with no profile,
    # chip stranger, live player on the non-Diamond platform club, member of
    # CHIP stamped to ODD.
    check('live-arena-seat-is-not-an-orphan-and-dead-accounts-still-are', f.get('orphan_stamped_seat') == '6', f)
    # Left: arena closed profile, chip stranger in a running event.
    check('live-arena-entry-is-not-an-orphan-and-dead-accounts-still-are', f.get('orphan_stamped_entry') == '2', f)
    check('negative-balance-unchanged', f.get('negative_club_balance') == '1', f)
    check('outside-union-unchanged', f.get('seat_stamped_outside_union') == '1', f)
    run(f"DELETE FROM table_seats WHERE club_id = '{ARENA}' AND user_id <> '{LIVE}';"
        f"DELETE FROM tournament_players WHERE club_id = '{ARENA}' AND user_id <> '{LIVE}';"
        f"DELETE FROM table_seats WHERE club_id IN ('{CHIP}','{ODD}');"
        f"DELETE FROM tournament_players WHERE club_id = '{CHIP}';")
    f = findings()
    check('a-board-of-live-arena-players-reads-clean', 'orphan_stamped_seat' not in f and 'orphan_stamped_entry' not in f, f)
    law = json.loads(run('SELECT public.fn_union_law_integrity_breaches()'))
    check('law-breaches-follow-the-check', [b['check'] for b in law] == ['negative_club_balance'], law)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT * FROM public.fn_union_chip_integrity_check();',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-execute', r.returncode != 0 and 'permission denied' in r.stderr, r.stderr[-200:])
    check('service-role-executes', run('SET ROLE service_role; SELECT count(*) >= 0 FROM public.fn_union_chip_integrity_check()') == 't')
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run', replay.returncode != 0 and 'is not the pinned text' in replay.stderr,
          replay.stderr[-300:])
    check('second-run-left-the-postimage', md5() == POST_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
