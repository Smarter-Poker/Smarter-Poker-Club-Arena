"""Isolated PostgreSQL regression for I7 of fn_rake_bbj_invariants.

I7_raked_hand_never_banked must count a raked cash hand that nothing banked,
and must not count a DIAMOND-club hand whose rake is banked in
ca_diamond_rake_accrual. fn_ca_process_hand_post_commit_obligations refuses
chip obligations on a diamond hand, so such a hand never has a rake_records
row; before this change I7 read every diamond hand as a genuine loss and
fn_rake_bbj_audit raised a critical alert every hour.

The test loads the exact production definition captured on 2026-10-08 (its
pg_get_functiondef md5 equals production's), proves it counts the banked
diamond hand, then applies the candidate migration (a pinned-text
substitution) and proves it counts only the real losses, keeps guarding a
short or missing diamond accrual, leaves chip clubs alone and reproduces
production's derived postimage md5 exactly. An empty throwaway cluster on a
Unix socket; no network, no production connection.
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
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'rake-audit-diamond-accrual'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/rake-audit-diamond-accrual')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='rake-audit-diamond-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of production's fn_rake_bbj_invariants(integer) read
# on 2026-10-08, before and after the candidate (derived read-only there).
LIVE_DEF_MD5 = '9360904177348173aac4d07e3a4ed091'
POST_DEF_MD5 = 'f0cfc5a0b6a7a362e400ee01081804c0'
SIG = 'public.fn_rake_bbj_invariants(integer)'
# Production's grants (proacl {postgres=X/postgres,service_role=X/postgres}).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_rake_bbj_invariants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_rake_bbj_invariants(integer) TO service_role;
'''

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE ca_rake_rules(id integer PRIMARY KEY, bbj_min_players_dealt integer, bbj_ineligible_variants text[]);
INSERT INTO ca_rake_rules VALUES (1, 3, ARRAY['ofc']);
CREATE TABLE clubs(id uuid PRIMARY KEY, asset text NOT NULL);
CREATE TABLE tables(id uuid PRIMARY KEY, club_id uuid, tournament_id uuid, small_blind numeric,
  big_blind numeric, game_variant text);
CREATE TABLE hand_history(id uuid PRIMARY KEY, table_id uuid, hand_number bigint, tournament_id uuid,
  rake_amount numeric, created_at timestamptz, game_variant text, community_cards text[]);
CREATE TABLE rake_records(id bigserial PRIMARY KEY, hand_id uuid, table_id uuid, rake_amount numeric,
  bbj_contribution numeric, pot_size numeric, num_players integer, rake_method text,
  player_contributions jsonb, created_at timestamptz, source text, is_tournament boolean, metadata jsonb);
CREATE TABLE bbj_contributions(hand_id uuid, amount numeric);
CREATE TABLE rake_attributions(hand_id uuid, weighted_rake_credit numeric);
CREATE TABLE hand_atomic_commits(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint,
  committed_at timestamptz, post_commit_payload jsonb, post_commit_completed_at timestamptz);
CREATE TABLE ca_diamond_rake_accrual(id bigserial PRIMARY KEY, table_id uuid, hand_number bigint,
  user_id uuid, kind text, amount bigint, created_at timestamptz DEFAULT now());
CREATE FUNCTION fn_effective_bbj_drop(numeric, integer, boolean, uuid, uuid, text, numeric, numeric, numeric)
  RETURNS numeric LANGUAGE sql AS 'SELECT 0::numeric';
"""

CHIPS, DIAMONDS = uuid.UUID(int=1), uuid.UUID(int=2)
# (key, club, rake, rake_records row?, accrual rows as (kind, amount), lost under the fix?)
HANDS = [
    ('chip-banked',              CHIPS,    10, True,  [],                           False),
    ('chip-never-banked',        CHIPS,    10, False, [],                           True),
    ('diamond-accrued-in-full',  DIAMONDS, 30, False, [('rake', 20), ('rake', 10)], False),
    ('diamond-accrual-short',    DIAMONDS, 30, False, [('rake', 20)],               True),
    ('diamond-no-accrual',       DIAMONDS, 15, False, [],                           True),
    ('diamond-accrual-not-rake', DIAMONDS, 30, False, [('bbj', 30)],                True),
]


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


def lit(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def seed():
    sql = ['TRUNCATE clubs, tables, hand_history, rake_records, ca_diamond_rake_accrual, hand_atomic_commits;',
           f"INSERT INTO clubs VALUES ({lit(CHIPS)}, 'chips'), ({lit(DIAMONDS)}, 'diamonds');"]
    for n, (key, club, rake, recorded, accrual, _) in enumerate(HANDS, start=1):
        hid, tid = uuid.UUID(int=n << 16), uuid.UUID(int=900 + n)
        sql.append(f"INSERT INTO tables VALUES ({lit(tid)},{lit(club)},NULL,1,2,'nlh');")
        sql.append(f"INSERT INTO hand_history VALUES ({lit(hid)},{lit(tid)},{n},NULL,{rake},"
                   f"now() - interval '10 minutes','nlh',ARRAY['As','Kd','2c']);")
        # Every hand's envelope completed, so I9 is not what holds it.
        sql.append(f"INSERT INTO hand_atomic_commits VALUES ({lit(hid)},{lit(tid)},{n},"
                   f"now() - interval '10 minutes','{{}}'::jsonb,now() - interval '10 minutes');")
        if recorded:
            sql.append(f"INSERT INTO rake_records(hand_id, table_id, rake_amount, bbj_contribution, pot_size, num_players,"
                       f" rake_method, created_at, source, is_tournament, metadata) VALUES ({lit(hid)},{lit(tid)},{rake},0,"
                       f"200,3,'FLAT',now() - interval '10 minutes','atomic_distribute_rake',false,"
                       f"jsonb_build_object('hand_number','{n}'));")
        for i, (kind, amount) in enumerate(accrual):
            sql.append(f"INSERT INTO ca_diamond_rake_accrual(table_id, hand_number, user_id, kind, amount) "
                       f"VALUES ({lit(tid)},{n},{lit(uuid.UUID(int=(n << 8) + i))},'{kind}',{amount});")
    run('\n'.join(sql))
    return {str(uuid.UUID(int=n << 16)): h[0] for n, h in enumerate(HANDS, start=1)}


def i7(keys):
    row = json.loads(run("SELECT jsonb_build_object('n', violations, 'detail', detail) FROM "
                         "fn_rake_bbj_invariants(2) WHERE check_name = 'I7_raked_hand_never_banked'"))
    return row['n'], sorted(keys[h['hand']] for h in row['detail']['hands'])


def md5():
    return run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")


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
    base = (FIXTURES / 'fn_rake_bbj_invariants.live-20261008.sql').read_text()
    run(base + ';' + GRANTS)
    check('baseline-is-production-preimage', md5() == LIVE_DEF_MD5, md5())
    keys = seed()
    n, hands = i7(keys)
    results['baseline'] = {'I7': n, 'hands': hands}
    check('baseline-reads-the-banked-diamond-hand-as-lost', 'diamond-accrued-in-full' in hands, hands)
    check('baseline-counts-every-unrecorded-hand', n == 5, (n, hands))

    # Candidate: the migration under test, applied as production would.
    migration = one('*_the_rake_audit_reads_a_diamond_hand_s_accrual_as_its_banked_.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', md5() == POST_DEF_MD5, md5())
    keys = seed()
    n, hands = i7(keys)
    results['candidate'] = {'I7': n, 'hands': hands}
    expected = sorted(h[0] for h in HANDS if h[5])
    check('i7-counts-only-the-real-losses', hands == expected and n == len(expected), (n, hands, expected))
    check('i7-no-longer-counts-a-diamond-hand-banked-in-full', 'diamond-accrued-in-full' not in hands, hands)
    check('i7-still-counts-a-short-diamond-accrual', 'diamond-accrual-short' in hands, hands)
    check('i7-still-counts-a-chip-hand-never-banked', 'chip-never-banked' in hands, hands)
    other = json.loads(run("SELECT jsonb_object_agg(check_name, violations) FROM fn_rake_bbj_invariants(2) "
                           "WHERE check_name <> 'I7_raked_hand_never_banked'"))
    check('other-invariants-unchanged', all(v == 0 for v in other.values()), other)
    meta = run(f"SELECT pg_get_userbyid(proowner)||' '||prosecdef::text||' '||provolatile::text||' '||coalesce(proconfig::text,'-')"
               f" FROM pg_proc WHERE oid = '{SIG}'::regprocedure")
    check('owner-security-volatility-and-grants-kept', meta == 'postgres true s {search_path=public}', meta)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT * FROM fn_rake_bbj_invariants(2);',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-run-the-invariants', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', md5() == POST_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
