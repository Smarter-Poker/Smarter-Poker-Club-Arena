"""Isolated PostgreSQL regression for the payout watches on Diamond events.

fn_payout_guarantee_check (earner_not_paid) and
fn_ca_tournament_settlement_mismatch (the tournament_underpaid_48h ratchet)
measured a tournament's payouts from wallet_transactions only. A Diamond event
pays its prizes and bounties from its own custody and records them in
poker_diamond_tournament_ledger, so every completed Diamond event read as
"paid 0": 32 open earner_not_paid alerts and 11 underpaid mismatches on
2026-10-08, every one a Diamond MTT paid in full.

The test rebuilds the exact production definitions (their pg_get_functiondef
md5 equals production's), proves they raise those false alarms, applies the
candidate migration (a pinned-text substitution), and proves:
  * a Diamond event paid in full through its ledger raises nothing, and an
    open alert against it clears;
  * a Diamond event whose earner really was not paid still alarms in both;
  * a chip event reads exactly as before, short or paid;
  * the result reproduces production's derived postimage md5 exactly, grants
    do not move, and a second run is refused.
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
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/diamond-payout-watches')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='diamond-payout-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

GUARANTEE = 'public.fn_payout_guarantee_check(integer)'
MISMATCH = 'public.fn_ca_tournament_settlement_mismatch(interval)'
# pg_get_functiondef md5 read on production 2026-10-08, before the candidate,
# and after it (derived read-only on production with replace()).
LIVE_GUARANTEE_MD5 = '7c57c1a27ae394f67010bf5f54cdab27'
LIVE_MISMATCH_MD5 = '7900253b783a7e6ce94b9f3b6ff92598'
POST_GUARANTEE_MD5 = '790179466df6948eccbf0eca42d739ba'
POST_MISMATCH_MD5 = '06d38e190581c381f4ddfe2fb991f594'
# The text before Diamond phase 9 edited the guarantee check in place.
PRE_PHASE9_GUARANTEE_MD5 = '60c5ab70c7a51d9de9d9177a760eef74'
# Production's grants on both (proacl {postgres=X/postgres,service_role=X/postgres}).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_payout_guarantee_check(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payout_guarantee_check(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_settlement_mismatch(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_settlement_mismatch(interval) TO service_role;
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


def definition(path, name):
    source = path.read_text()
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1;', source, re.S)
    if not m:
        raise ValueError('missing definition: ' + name + ' in ' + path.name)
    return m.group(0)


def section(path, start, end):
    source = path.read_text()
    i, j = source.index(start), source.index(end)
    return source[i:j]


def md5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE clubs(id uuid PRIMARY KEY, asset text);
CREATE TABLE tournaments(id uuid PRIMARY KEY, name text, club_id uuid, tournament_type text,
  status text, ended_at timestamptz, prize_pool numeric, guaranteed_prize numeric,
  bounty_pool numeric, satellite_seats integer, variant text, payout_structure jsonb);
CREATE TABLE tournament_players(tournament_id uuid, user_id uuid, position integer);
CREATE TABLE wallet_transactions(id bigserial, user_id uuid, related_entity_id uuid,
  type text, category text, amount numeric);
CREATE TABLE tournament_payouts(tournament_id uuid, amount numeric, source text);
CREATE TABLE financial_alerts(id bigserial PRIMARY KEY, severity text, source text, message text,
  context jsonb, resolved boolean DEFAULT false, resolved_at timestamptz, resolution text,
  created_at timestamptz DEFAULT now());
CREATE TABLE poker_diamond_tournament_ledger(id bigserial PRIMARY KEY, tournament_id uuid, user_id uuid,
  kind text, amount bigint, prize_part bigint DEFAULT 0, bounty_part bigint DEFAULT 0, fee_part bigint DEFAULT 0);
"""

T = {  # tournament ids
    'diamond_paid': '00000000-0000-0000-0000-00000000d001',
    'diamond_short': '00000000-0000-0000-0000-00000000d002',
    'chip_paid': '00000000-0000-0000-0000-00000000c001',
    'chip_short': '00000000-0000-0000-0000-00000000c002',
}


def u(n):
    return f'00000000-0000-0000-0000-0000000{n:05d}'


def seed():
    run(f"""
TRUNCATE clubs, tournaments, tournament_players, wallet_transactions, tournament_payouts,
         financial_alerts, poker_diamond_tournament_ledger RESTART IDENTITY;
INSERT INTO clubs VALUES ('00000000-0000-0000-0000-0000000000dd','diamonds'),
                         ('00000000-0000-0000-0000-0000000000cc','chips');
INSERT INTO tournaments VALUES
 -- Paid in full in whole Diamonds (33/33/34 against a flat 33.33/33.33/33.34),
 -- plus a bounty: no wallet row anywhere.
 ('{T['diamond_paid']}','Diamond Paid','00000000-0000-0000-0000-0000000000dd','MTT','COMPLETED',
  now() - interval '1 hour', 100, 0, 30, 0, NULL,
  '[{{"place":1,"percentage":33.33}},{{"place":2,"percentage":33.33}},{{"place":3,"percentage":33.34}}]'),
 -- A real defect: second place never paid; the pool still holds it.
 ('{T['diamond_short']}','Diamond Short','00000000-0000-0000-0000-0000000000dd','MTT','COMPLETED',
  now() - interval '1 hour', 200, 0, 0, 0, NULL,
  '[{{"place":1,"percentage":60}},{{"place":2,"percentage":40}}]'),
 ('{T['chip_paid']}','Chip Paid','00000000-0000-0000-0000-0000000000cc','MTT','COMPLETED',
  now() - interval '1 hour', 100, 0, 0, 0, NULL, '[{{"place":1,"percentage":100}}]'),
 ('{T['chip_short']}','Chip Short','00000000-0000-0000-0000-0000000000cc','MTT','COMPLETED',
  now() - interval '1 hour', 100, 150, 0, 0, NULL, '[{{"place":1,"percentage":100}}]');
INSERT INTO tournament_players VALUES
 ('{T['diamond_paid']}','{u(1)}',1),('{T['diamond_paid']}','{u(2)}',2),('{T['diamond_paid']}','{u(3)}',3),
 ('{T['diamond_short']}','{u(4)}',1),('{T['diamond_short']}','{u(5)}',2),
 ('{T['chip_paid']}','{u(6)}',1),('{T['chip_short']}','{u(7)}',1);
INSERT INTO poker_diamond_tournament_ledger(tournament_id,user_id,kind,amount,prize_part,bounty_part) VALUES
 ('{T['diamond_paid']}','{u(1)}','entry',45,35,10),('{T['diamond_paid']}','{u(2)}','entry',45,35,10),
 ('{T['diamond_paid']}','{u(3)}','entry',40,30,10),
 ('{T['diamond_paid']}','{u(1)}','prize',33,33,0),('{T['diamond_paid']}','{u(2)}','prize',33,33,0),
 ('{T['diamond_paid']}','{u(3)}','prize',34,34,0),
 ('{T['diamond_paid']}','{u(1)}','bounty',30,0,30),
 ('{T['diamond_short']}','{u(4)}','prize',120,120,0);
INSERT INTO wallet_transactions(user_id,related_entity_id,type,category,amount) VALUES
 ('{u(6)}','{T['chip_paid']}','credit','prize',100),
 ('{u(7)}','{T['chip_short']}','credit','prize',50);
-- Open alerts as production holds them: one against the paid Diamond event
-- (false), one against the short chip event (true).
INSERT INTO financial_alerts(severity,source,message,context) VALUES
 ('critical','fn_payout_guarantee_check','seeded',
  jsonb_build_object('kind','earner_not_paid','tournament_id','{T['diamond_paid']}','user_id','{u(1)}','place_worth',33.33)),
 ('critical','fn_payout_guarantee_check','seeded',
  jsonb_build_object('kind','earner_not_paid','tournament_id','{T['chip_short']}','user_id','{u(7)}','place_worth',100));
""")


def observe():
    g = json.loads(run('SELECT fn_payout_guarantee_check(7)'))
    open_alerts = json.loads(run("""
SELECT COALESCE(jsonb_agg(jsonb_build_object('t', context->>'tournament_id', 'u', context->>'user_id',
         'credited', context->'credited', 'short', context->'short') ORDER BY context->>'tournament_id', context->>'user_id'), '[]')
  FROM financial_alerts WHERE source='fn_payout_guarantee_check' AND resolved IS NOT TRUE
   AND context->>'kind'='earner_not_paid'"""))
    m = json.loads(run("""
SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 't', tournament_id, 'paid', paid, 'delta', delta)
         ORDER BY tournament_id), '[]') FROM fn_ca_tournament_settlement_mismatch('48 hours')"""))
    return g, open_alerts, m


def tourneys(rows):
    return sorted({r['t'] for r in rows})


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # -- Baseline: the exact production definitions before this change ------
    # The guarantee check is its 2026-09-07 text plus the Diamond phase 9
    # in-place edit (bounty pool reads the ledger); the mismatch read is
    # unchanged since 2026-09-02.
    run(definition(one('20260907163820_*.sql'), 'fn_payout_guarantee_check'))
    check('guarantee-2026-09-07-text-is-the-phase-9-preimage', md5(GUARANTEE) == PRE_PHASE9_GUARANTEE_MD5, md5(GUARANTEE))
    run(section(one('20260914111709_*.sql'), '-- 6d. fn_payout_guarantee_check', '-- 6e.'))
    run(definition(one('20260902010204_*.sql'), 'fn_ca_tournament_settlement_mismatch') + GRANTS)
    check('baseline-guarantee-is-production-preimage', md5(GUARANTEE) == LIVE_GUARANTEE_MD5, md5(GUARANTEE))
    check('baseline-mismatch-is-production-preimage', md5(MISMATCH) == LIVE_MISMATCH_MD5, md5(MISMATCH))

    seed()
    g, alerts, m = observe()
    results['baseline'] = {'guarantee': g, 'open_earner_not_paid': alerts, 'mismatch': m}
    # The defect: a Diamond event paid in full reads as paid nothing.
    check('baseline-alarms-on-every-diamond-earner', g['earners_not_paid'] == 5 + 1, g)
    check('baseline-cannot-clear-the-false-diamond-alert', g['alerts_cleared'] == 0, g)
    check('baseline-holds-the-paid-diamond-event-open', T['diamond_paid'] in tourneys(alerts), alerts)
    underpaid = {r['t']: r for r in m if r['kind'] == 'underpaid'}
    check('baseline-reads-the-paid-diamond-event-as-underpaid',
          T['diamond_paid'] in underpaid and float(underpaid[T['diamond_paid']]['paid']) == 0, m)
    baseline_chip = {'alerts': [a for a in alerts if a['t'].endswith('c002') or a['t'].endswith('c001')],
                     'mismatch': [r for r in m if r['t'] in (T['chip_paid'], T['chip_short'])]}

    # -- Candidate: the migration under test, applied as production would ---
    migration = one('*_the_payout_watches_read_a_diamond_event_s_own_ledger.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    acl_before = run("SELECT string_agg(p.oid::regprocedure || '=' || p.proacl::text || p.prosecdef || p.proconfig::text, ';' ORDER BY 1) "
                     "FROM pg_proc p WHERE p.proname IN ('fn_payout_guarantee_check','fn_ca_tournament_settlement_mismatch')")
    run(migration)
    check('candidate-reproduces-production-derived-guarantee-postimage', md5(GUARANTEE) == POST_GUARANTEE_MD5, md5(GUARANTEE))
    check('candidate-reproduces-production-derived-mismatch-postimage', md5(MISMATCH) == POST_MISMATCH_MD5, md5(MISMATCH))
    check('grants-security-and-settings-unchanged', run(
        "SELECT string_agg(p.oid::regprocedure || '=' || p.proacl::text || p.prosecdef || p.proconfig::text, ';' ORDER BY 1) "
        "FROM pg_proc p WHERE p.proname IN ('fn_payout_guarantee_check','fn_ca_tournament_settlement_mismatch')") == acl_before)

    seed()
    g, alerts, m = observe()
    results['candidate'] = {'guarantee': g, 'open_earner_not_paid': alerts, 'mismatch': m}
    check('paid-diamond-event-raises-no-earner-alert', T['diamond_paid'] not in tourneys(alerts), alerts)
    check('false-diamond-alert-clears-itself', g['alerts_cleared'] == 1, g)
    check('whole-diamond-rounding-is-counted-not-alarmed', g['short_of_structure_but_pool_distributed'] == 1, g)
    short = [a for a in alerts if a['t'] == T['diamond_short']]
    check('real-diamond-shortfall-still-alarms',
          len(short) == 1 and short[0]['u'] == u(5) and float(short[0]['short']) == 80, alerts)
    check('earners-not-paid-are-only-the-real-ones', g['earners_not_paid'] == 2, g)
    underpaid = {r['t']: r for r in m if r['kind'] == 'underpaid'}
    check('paid-diamond-event-is-not-underpaid', T['diamond_paid'] not in underpaid, m)
    check('real-diamond-underpayment-still-reads',
          T['diamond_short'] in underpaid and float(underpaid[T['diamond_short']]['paid']) == 120
          and float(underpaid[T['diamond_short']]['delta']) == 80, m)
    check('diamond-bounty-pool-reads-as-before', g['bounty_pool_retained_events'] == 0, g)
    candidate_chip = {'alerts': [a for a in alerts if a['t'].endswith('c002') or a['t'].endswith('c001')],
                      'mismatch': [r for r in m if r['t'] in (T['chip_paid'], T['chip_short'])]}
    check('chip-events-read-exactly-as-before', candidate_chip == baseline_chip,
          {'before': baseline_chip, 'after': candidate_chip})
    check('chip-shortfall-still-alarms', len(candidate_chip['alerts']) == 1 and len(candidate_chip['mismatch']) == 1,
          candidate_chip)

    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f"SET ROLE {role}; SELECT fn_ca_tournament_settlement_mismatch('48 hours');",
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-read-the-mismatch', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage',
          md5(GUARANTEE) == POST_GUARANTEE_MD5 and md5(MISMATCH) == POST_MISMATCH_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'output': str(out / 'RESULTS.json')}))
