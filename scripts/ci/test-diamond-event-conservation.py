"""Isolated PostgreSQL regression: a Diamond event is conserved by its custody.

fn_tournament_conservation_delta and fn_tournament_conservation_deltas read
the chip books only (wallet_transactions, rake_records, chip_ledger,
tournament_payouts). A Diamond Arena event moves its money through
poker_diamond_custody and the Diamond journal, so the chip arithmetic reads a
Diamond satellite's seats as money paid out of nothing (three open
fn_tournament_money_conservation alerts on 2026-10-08) and its target's
redeemed seats as money kept.

The test loads the exact production definitions (the repo bodies in
20261003034305 and 20261003095111 hash to production's pg_get_functiondef
md5), proves they misread the Diamond events, then applies the candidate
migration and proves:
  * a Diamond satellite and its Diamond target read their remaining entry
    custody: 0 once closed, the held amount while custody is still open;
  * every chip event reads exactly what it read before (balanced, unfunded,
    retained, a chip satellite paying a seat);
  * the set function equals the scalar for every event in its window, before
    and after;
  * both results reproduce production's derived postimage md5, keep owner,
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
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/diamond-event-conservation')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='diamond-conservation-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SCALAR = 'public.fn_tournament_conservation_delta(uuid)'
SET = 'public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'
# pg_get_functiondef md5 read on production 2026-10-08, before and after the
# candidate (the postimages derived read-only on production with replace()).
LIVE = {SCALAR: 'bfbb3e617d7c8290ac8916e21bf0c2a4', SET: '365e9948c804059253d73cd35ed6e3d4'}
POST = {SCALAR: '4944504d426d4c34fd7a577c7b4bdd3a', SET: 'a202f925eea2157bb33dd7fda141b9f7'}
# Production's grants on both (proacl {postgres=X/postgres,service_role=X/postgres}).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_conservation_deltas(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_deltas(timestamptz, timestamptz) TO service_role;
'''
# fn_poker_diamond_tournament_custody, word for word as production serves it.
CUSTODY = '''
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_custody(p_tournament_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(sum(balance),0)::bigint FROM public.poker_diamond_custody
   WHERE purpose = 'tournament_entry' AND target_id = p_tournament_id AND state <> 'released';
$function$;
'''

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE clubs(id uuid PRIMARY KEY, asset text);
CREATE TABLE tournaments(id uuid PRIMARY KEY, club_id uuid, name text, variant text, status text,
  ended_at timestamptz, buy_in_amount numeric, buy_in_fee numeric);
CREATE TABLE wallet_transactions(related_entity_id uuid, user_id uuid, type text, category text, amount numeric);
CREATE TABLE rake_records(tournament_id uuid, rake_amount numeric, is_tournament boolean);
CREATE TABLE chip_ledger(tournament_id uuid, category text, from_type text, to_type text,
  from_entity_id uuid, amount numeric, metadata jsonb DEFAULT '{}');
CREATE TABLE tournament_guarantee_overlays(tournament_id uuid, amount numeric);
CREATE TABLE tournament_conservation_baseline(tournament_id uuid, amount numeric);
CREATE TABLE tournament_payouts(tournament_id uuid, user_id uuid, source text, position integer,
  amount numeric, metadata jsonb DEFAULT '{}');
CREATE TABLE tournament_satellite_awards(tournament_id uuid, place integer, ticket_id uuid, delivery_kind text);
CREATE TABLE tournament_tickets(id uuid PRIMARY KEY, status text);
CREATE TABLE poker_diamond_custody(purpose text, target_id uuid, state text, balance bigint);
"""

DIAMOND_CLUB = '00000000-0000-0000-0000-00000000a000'
CHIP_CLUB = '00000000-0000-0000-0000-00000000c000'


def t(n):
    return f'00000000-0000-0000-0000-{n:012d}'


D_SAT, D_TARGET, D_OPEN, C_OK, C_UNFUNDED, C_KEPT, C_SAT, C_TARGET = (t(i) for i in range(1, 9))
U1, U2 = t(101), t(102)

SEED = f"""
INSERT INTO clubs VALUES ('{DIAMOND_CLUB}','diamonds'), ('{CHIP_CLUB}','chips');
INSERT INTO tournaments VALUES
  ('{D_SAT}','{DIAMOND_CLUB}','Diamond satellite','satellite','COMPLETED', now() - interval '2 hours', 23, 2),
  ('{D_TARGET}','{DIAMOND_CLUB}','Diamond target','freezeout','COMPLETED', now() - interval '2 hours', 180, 20),
  ('{D_OPEN}','{DIAMOND_CLUB}','Diamond with custody held','freezeout','COMPLETED', now() - interval '2 hours', 50, 5),
  ('{C_OK}','{CHIP_CLUB}','Chip balanced','freezeout','COMPLETED', now() - interval '2 hours', 100, 10),
  ('{C_UNFUNDED}','{CHIP_CLUB}','Chip unfunded','freezeout','COMPLETED', now() - interval '2 hours', 100, 10),
  ('{C_KEPT}','{CHIP_CLUB}','Chip retained','freezeout','COMPLETED', now() - interval '2 hours', 100, 10),
  ('{C_SAT}','{CHIP_CLUB}','Chip satellite','satellite','COMPLETED', now() - interval '2 hours', 50, 5),
  ('{C_TARGET}','{CHIP_CLUB}','Chip target','freezeout','RUNNING', NULL, 200, 20);
-- Diamond satellite: two 200 seats into the Diamond target, no chip money,
-- custody released (closed exactly).
INSERT INTO tournament_payouts VALUES
  ('{D_SAT}','{U1}','satellite_seat',1,200,'{{"satellite_target_id":"{D_TARGET}"}}'),
  ('{D_SAT}','{U2}','satellite_seat',2,200,'{{"satellite_target_id":"{D_TARGET}"}}');
INSERT INTO poker_diamond_custody VALUES ('tournament_entry','{D_SAT}','released',0),
  ('tournament_entry','{D_TARGET}','released',0),
  ('tournament_entry','{D_OPEN}','held',75), ('tournament_entry','{D_OPEN}','released',0);
-- Chip balanced: 110 in, 10 rake, 100 prize.
INSERT INTO wallet_transactions VALUES ('{C_OK}','{U1}','debit','tournament_buyin',110),
  ('{C_OK}','{U1}','credit','prize',100);
INSERT INTO rake_records VALUES ('{C_OK}',10,true);
-- Chip unfunded: a 50 prize with nothing collected.
INSERT INTO wallet_transactions VALUES ('{C_UNFUNDED}','{U1}','credit','prize',50);
-- Chip retained: 110 in, 10 rake, nothing paid.
INSERT INTO wallet_transactions VALUES ('{C_KEPT}','{U1}','debit','tournament_buyin',110);
INSERT INTO rake_records VALUES ('{C_KEPT}',10,true);
-- Chip satellite: 110 in, 10 rake, one 100 seat into a chip target.
INSERT INTO wallet_transactions VALUES ('{C_SAT}','{U1}','debit','tournament_buyin',55),
  ('{C_SAT}','{U2}','debit','tournament_buyin',55);
INSERT INTO rake_records VALUES ('{C_SAT}',10,true);
INSERT INTO tournament_payouts VALUES
  ('{C_SAT}','{U1}','satellite_seat',1,100,'{{"satellite_target_id":"{C_TARGET}"}}');
"""

# event -> (delta before, delta after)
EXPECT = {
    D_SAT: ('-400.00', '0'),
    D_TARGET: ('400.00', '0'),
    D_OPEN: ('0.00', '75'),
    C_OK: ('0.00', '0.00'),
    C_UNFUNDED: ('-50.00', '-50.00'),
    C_KEPT: ('100.00', '100.00'),
    C_SAT: ('0.00', '0.00'),
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


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


def definition(path, name):
    source = path.read_text()
    m = list(re.finditer(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1', source, re.S))
    if not m:
        raise ValueError('missing definition: ' + name + ' in ' + path.name)
    return m[-1].group(0) + ';\n'


def md5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def shape(sig):
    return run(f"""SELECT p.proacl::text || '|' || pg_get_userbyid(p.proowner) || '|' || p.prosecdef
                         || '|' || array_to_string(p.proconfig, ',') || '|' || p.provolatile::text
                    FROM pg_proc p WHERE p.oid = '{sig}'::regprocedure""")


def scalar():
    return {k: run(f"SELECT public.fn_tournament_conservation_delta('{k}')") for k in EXPECT}


def window():
    rows = run("SELECT id || '=' || delta FROM public.fn_tournament_conservation_deltas(now() - interval '1 day', now())")
    return dict(r.split('=') for r in rows.splitlines() if r)


def numeric_equal(a, b):
    return float(a) == float(b)


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Baseline: production's exact definitions, read from the repo migrations
    # that installed them (their md5 equals production's pg_get_functiondef).
    run(definition(one('20261003034305_*.sql'), 'fn_tournament_conservation_delta')
        + definition(one('20261003095111_*.sql'), 'fn_tournament_conservation_deltas')
        + CUSTODY + GRANTS)
    for sig in (SCALAR, SET):
        check('baseline-is-production-preimage ' + sig, md5(sig) == LIVE[sig], md5(sig))
    before_shape = {sig: shape(sig) for sig in (SCALAR, SET)}
    run(SEED)
    s, w = scalar(), window()
    results['baseline'] = s
    for k, (before, _) in EXPECT.items():
        check('baseline-scalar ' + k, s[k] == before, (s[k], before))
        check('baseline-set-equals-scalar ' + k, numeric_equal(w[k], s[k]), (w[k], s[k]))

    # Candidate: the migration under test, applied as production would.
    migration = one('*_a_diamond_event_is_conserved_by_its_diamond_custody.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    for sig in (SCALAR, SET):
        check('candidate-reproduces-production-derived-postimage ' + sig, md5(sig) == POST[sig], md5(sig))
        check('owner-security-settings-grants-volatility-unchanged ' + sig, shape(sig) == before_shape[sig],
              [before_shape[sig], shape(sig)])
    s, w = scalar(), window()
    results['candidate'] = s
    for k, (_, after) in EXPECT.items():
        check('candidate-scalar ' + k, numeric_equal(s[k], after), (s[k], after))
        check('candidate-set-equals-scalar ' + k, numeric_equal(w[k], s[k]), (w[k], s[k]))
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f"SET ROLE {role}; SELECT public.fn_tournament_conservation_delta('{C_OK}');",
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-execute', r.returncode != 0 and 'permission denied' in r.stderr, r.stderr[-200:])
    check('service-role-executes',
          run(f"SET ROLE service_role; SELECT public.fn_tournament_conservation_delta('{D_SAT}') = 0") == 't')
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run', replay.returncode != 0 and 'is not the pinned text' in replay.stderr,
          replay.stderr[-300:])
    check('second-run-left-the-postimages', md5(SCALAR) == POST[SCALAR] and md5(SET) == POST[SET])
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
