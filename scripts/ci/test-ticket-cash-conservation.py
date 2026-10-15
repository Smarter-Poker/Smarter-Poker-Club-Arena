"""Isolated PostgreSQL regression: a ticket paid in cash never arrived at its target.

fn_tournament_conservation_delta (the scalar) and fn_tournament_conservation_deltas
(the one-pass set read) count a direct satellite ticket as money arriving at
its target when the ticket's status is 'redeemed'. Since 2026-10-12 a ticket
whose target closed before it was used is paid to its holder in cash by
fn_ca_pay_closed_target_ticket_in_cash, which also moves it issued -> redeemed
and keys its escrow -> wallet leg ticket:<id>:closed-target-cash. On
2026-10-15 the deep conservation pass read 56 such targets as "retained money
it never paid out" (migration 20261015072547).

The test loads the exact production definitions captured on 2026-10-15
(pg_get_functiondef md5 equal to production's) and the live scan
(fn_tournament_money_conservation, reproduced from the 2026-10-03 fixture and
its pinned replacement), proves the baseline flags a target whose ticket was
paid in cash, applies the candidate migration, and proves:
  * the cash-paid target reads 0.00 and its open alert is auto-resolved;
  * a target whose ticket was ADMITTED still counts the ticket as income
    (0.00), and an unredeemed ticket still does not;
  * a target whose admitted ticket arrived but which really kept money still
    flags, so the fix cannot hide a real retention;
  * the satellite that issued the tickets is unchanged;
  * set and scalar agree on every event; the postimage md5s are production's
    derived ones; grants, owner, SECURITY DEFINER and config did not move;
  * a second run refuses.
An empty throwaway cluster on a Unix socket; no network, no production connection.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'ticket-cash-conservation'
SCAN_FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'backed-payout-scan'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/ticket-cash-conservation')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ticket-cash-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SCALAR = 'public.fn_tournament_conservation_delta(uuid)'
SET = 'public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'
SCAN = 'public.fn_tournament_money_conservation(integer,numeric,integer)'
# pg_get_functiondef md5, read on production 2026-10-15, and the postimages
# derived read-only there with replace().
LIVE_SCALAR_MD5 = '17ae3dfd32d3cb1d2673a86c0d8d9426'
LIVE_SET_MD5 = '118b1c0bbf6f959809efe6b385d92bf9'
LIVE_SCAN_MD5 = '1a0bc1bd70d39192e13fa7fb946a7103'
POST_SCALAR_MD5 = '34e1f8a48e1ba37b8009e3d64c5ed626'
POST_SET_MD5 = '4bc2c77d5e02abe38a535367bade00e8'
GRANTS = f'''
REVOKE ALL ON FUNCTION {SCALAR} FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION {SCALAR} TO service_role;
REVOKE ALL ON FUNCTION {SET} FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION {SET} TO service_role;
REVOKE ALL ON FUNCTION {SCAN} FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION {SCAN} TO service_role;
'''

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE clubs(id uuid PRIMARY KEY, asset text, is_platform boolean, union_id uuid);
CREATE TABLE tournaments(id uuid PRIMARY KEY, name text, variant text, status text, ended_at timestamptz,
  club_id uuid, union_id uuid, buy_in_amount numeric, buy_in_fee numeric);
CREATE TABLE wallet_transactions(id bigserial, related_entity_id uuid, user_id uuid, type text, category text, amount numeric);
CREATE TABLE rake_records(id bigserial, tournament_id uuid, rake_amount numeric, is_tournament boolean);
CREATE TABLE chip_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid, category text,
  from_type text, from_entity_id uuid, to_type text, to_entity_id uuid, amount numeric, metadata jsonb);
CREATE TABLE chip_ledger_idem(idempotency_key text PRIMARY KEY, leg_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE tournament_guarantee_overlays(tournament_id uuid, amount numeric);
CREATE TABLE tournament_conservation_baseline(tournament_id uuid, amount numeric);
CREATE TABLE tournament_payouts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid, user_id uuid,
  position integer, amount numeric, source text, metadata jsonb);
CREATE TABLE tournament_satellite_awards(tournament_id uuid, place integer, ticket_id uuid, delivery_kind text);
CREATE TABLE tournament_tickets(id uuid PRIMARY KEY, holder_id uuid, value numeric, status text, source_tournament_id uuid);
CREATE TABLE financial_alerts(id uuid DEFAULT gen_random_uuid(), severity text, source text, message text, context jsonb,
  resolved boolean DEFAULT false, created_at timestamptz DEFAULT clock_timestamp(), resolved_at timestamptz);
CREATE FUNCTION fn_poker_diamond_tournament_escrow(uuid)
  RETURNS TABLE(prize_balance numeric, bounty_balance numeric, fee_balance numeric)
  LANGUAGE sql AS $$ SELECT 0::numeric, 0::numeric, 0::numeric $$;
"""

# One satellite pays three tickets of 20.00 into each of four targets.
# Each target: one paying entrant (20.00), the prize pool paid out in full.
#   t-cash      ticket paid in cash on close (redeemed + closed-target-cash leg)
#   t-admitted  ticket admitted (redeemed, escrow -> prize_liability leg)
#   t-issued    ticket never redeemed and still issued (target paid only the cash entrant)
#   t-retained  ticket admitted, but 15.00 of the pool was never paid out
SEED = """
INSERT INTO clubs VALUES ('00000000-0000-0000-0000-00000000c1ab','chips',false,NULL);
INSERT INTO tournaments VALUES
  ('00000000-0000-0000-0000-0000000005a7','sat','freezeout','COMPLETED',now()-interval '3 days','00000000-0000-0000-0000-00000000c1ab',NULL,18,2),
  ('00000000-0000-0000-0000-0000000000c1','t-cash','freezeout','COMPLETED',now()-interval '2 days','00000000-0000-0000-0000-00000000c1ab',NULL,18,2),
  ('00000000-0000-0000-0000-0000000000a1','t-admitted','freezeout','COMPLETED',now()-interval '2 days','00000000-0000-0000-0000-00000000c1ab',NULL,18,2),
  ('00000000-0000-0000-0000-0000000000b1','t-issued','freezeout','COMPLETED',now()-interval '2 days','00000000-0000-0000-0000-00000000c1ab',NULL,18,2),
  ('00000000-0000-0000-0000-0000000000d1','t-retained','freezeout','COMPLETED',now()-interval '2 days','00000000-0000-0000-0000-00000000c1ab',NULL,18,2);
-- satellite: four entrants at 20.00, 0 rake, four ticket places of 20.00
INSERT INTO wallet_transactions(related_entity_id,user_id,type,category,amount)
  SELECT '00000000-0000-0000-0000-0000000005a7', gen_random_uuid(), 'debit','tournament_buyin', 20 FROM generate_series(1,4);
INSERT INTO tournament_tickets VALUES
  ('00000000-0000-0000-0000-00000000f0c1','00000000-0000-0000-0000-0000000000e1',20,'redeemed','00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-00000000f0a1','00000000-0000-0000-0000-0000000000e2',20,'redeemed','00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000f0b1','00000000-0000-0000-0000-0000000000e3',20,'issued','00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-00000000f0d1','00000000-0000-0000-0000-0000000000e4',20,'redeemed','00000000-0000-0000-0000-0000000000d1');
INSERT INTO tournament_satellite_awards VALUES
  ('00000000-0000-0000-0000-0000000005a7',1,'00000000-0000-0000-0000-00000000f0c1','ticket'),
  ('00000000-0000-0000-0000-0000000005a7',2,'00000000-0000-0000-0000-00000000f0a1','ticket'),
  ('00000000-0000-0000-0000-0000000005a7',3,'00000000-0000-0000-0000-00000000f0b1','ticket'),
  ('00000000-0000-0000-0000-0000000005a7',4,'00000000-0000-0000-0000-00000000f0d1','ticket');
INSERT INTO tournament_payouts(tournament_id,user_id,position,amount,source,metadata) VALUES
  ('00000000-0000-0000-0000-0000000005a7','00000000-0000-0000-0000-0000000000e1',1,20,'satellite_ticket',
    '{"satellite_target_id":"00000000-0000-0000-0000-0000000000c1","ticket_id":"00000000-0000-0000-0000-00000000f0c1"}'),
  ('00000000-0000-0000-0000-0000000005a7','00000000-0000-0000-0000-0000000000e2',2,20,'satellite_ticket',
    '{"satellite_target_id":"00000000-0000-0000-0000-0000000000a1","ticket_id":"00000000-0000-0000-0000-00000000f0a1"}'),
  ('00000000-0000-0000-0000-0000000005a7','00000000-0000-0000-0000-0000000000e3',3,20,'satellite_ticket',
    '{"satellite_target_id":"00000000-0000-0000-0000-0000000000b1","ticket_id":"00000000-0000-0000-0000-00000000f0b1"}'),
  ('00000000-0000-0000-0000-0000000005a7','00000000-0000-0000-0000-0000000000e4',4,20,'satellite_ticket',
    '{"satellite_target_id":"00000000-0000-0000-0000-0000000000d1","ticket_id":"00000000-0000-0000-0000-00000000f0d1"}');
-- the cash door: escrow -> wallet, keyed, naming no tournament; the holder's credit is a transfer
INSERT INTO chip_ledger(id,tournament_id,category,from_type,from_entity_id,to_type,to_entity_id,amount,metadata) VALUES
  ('00000000-0000-0000-0000-0000000ca5c1',NULL,'ticket_redeem','escrow','00000000-0000-0000-0000-00000000f0c1','player_wallet',
   '00000000-0000-0000-0000-0000000000e1',20,'{"kind":"closed_target_ticket_cash"}');
INSERT INTO chip_ledger_idem VALUES ('ticket:00000000-0000-0000-0000-00000000f0c1:closed-target-cash','00000000-0000-0000-0000-0000000ca5c1');
INSERT INTO wallet_transactions(related_entity_id,user_id,type,category,amount) VALUES
  (NULL,'00000000-0000-0000-0000-0000000000e1','credit','transfer',20);
-- the admission door: escrow -> prize_liability naming the target
INSERT INTO chip_ledger(tournament_id,category,from_type,from_entity_id,to_type,amount) VALUES
  ('00000000-0000-0000-0000-0000000000a1','ticket_redeem','escrow','00000000-0000-0000-0000-00000000f0a1','prize_liability',20),
  ('00000000-0000-0000-0000-0000000000d1','ticket_redeem','escrow','00000000-0000-0000-0000-00000000f0d1','prize_liability',20);
-- targets: one paying entrant each; t-cash and t-issued pay out 20 (the entrant only),
-- t-admitted pays 40 (entrant + ticket), t-retained pays 25 of its 40
INSERT INTO wallet_transactions(related_entity_id,user_id,type,category,amount)
  SELECT id, gen_random_uuid(), 'debit','tournament_buyin', 20 FROM tournaments WHERE name LIKE 't-%';
INSERT INTO wallet_transactions(related_entity_id,user_id,type,category,amount) VALUES
  ('00000000-0000-0000-0000-0000000000c1',gen_random_uuid(),'credit','prize',20),
  ('00000000-0000-0000-0000-0000000000a1',gen_random_uuid(),'credit','prize',40),
  ('00000000-0000-0000-0000-0000000000b1',gen_random_uuid(),'credit','prize',20),
  ('00000000-0000-0000-0000-0000000000d1',gen_random_uuid(),'credit','prize',25);
-- the alert the deep pass raised for the cash target on production
INSERT INTO financial_alerts(severity,source,message,context) VALUES
  ('warning','fn_tournament_money_conservation','Tournament retained money it never paid out: t-cash',
   '{"tournament_id":"00000000-0000-0000-0000-0000000000c1","variant":"freezeout","delta":20.00}');
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


def deltas():
    rows = run("SELECT name || '=' || delta FROM fn_tournament_conservation_deltas('-infinity','infinity') ORDER BY name")
    return dict(r.split('=') for r in rows.splitlines())


def scalar_parity():
    return run("SELECT count(*) FROM fn_tournament_conservation_deltas('-infinity','infinity') d "
               "WHERE d.delta IS DISTINCT FROM fn_tournament_conservation_delta(d.id)")


def live_scan_text():
    pins = json.loads((SCAN_FIXTURES / 'conservation-set-expectations.json').read_text())
    before = (SCAN_FIXTURES / 'conservation-scan-before.sql').read_text()
    rep = pins['replacement']
    after = before.replace(rep['old'], rep['new'])
    if hashlib.md5(after.encode()).hexdigest() != LIVE_SCAN_MD5:
        raise RuntimeError('the reproduced scan is not the live text')
    return after


CATALOG = f"""SELECT jsonb_agg(jsonb_build_object('acl',proacl::text,'owner',proowner,'definer',prosecdef,
  'config',proconfig,'volatility',provolatile) ORDER BY oid) FROM pg_proc
  WHERE oid IN ('{SCALAR}'::regprocedure,'{SET}'::regprocedure)"""

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
    run((FIXTURES / 'fn_tournament_conservation_delta.live-20261015.sql').read_text() + ';\n'
        + (FIXTURES / 'fn_tournament_conservation_deltas.live-20261015.sql').read_text() + ';\n'
        + live_scan_text() + ';\n' + GRANTS)
    check('baseline-scalar-is-production-preimage', md5(SCALAR) == LIVE_SCALAR_MD5)
    check('baseline-set-is-production-preimage', md5(SET) == LIVE_SET_MD5)
    check('baseline-scan-is-production-live-text', md5(SCAN) == LIVE_SCAN_MD5)
    run(SEED)
    d = deltas()
    results['baseline'] = d
    check('baseline-reads-the-cash-ticket-as-retained-money', d['t-cash'] == '20.00', d)
    check('baseline-admitted-ticket-balances', d['t-admitted'] == '0.00', d)
    check('baseline-issued-ticket-balances', d['t-issued'] == '0.00', d)
    check('baseline-real-retention-flags', d['t-retained'] == '15.00', d)
    check('baseline-satellite-balances', d['sat'] == '0.00', d)
    check('baseline-set-equals-scalar', scalar_parity() == '0')
    scan = json.loads(run("BEGIN; SELECT fn_tournament_money_conservation(45, 1.0, 500); ROLLBACK;"))
    check('baseline-scan-flags-cash-and-retained', scan['flagged'] == 2 and scan['auto_resolved'] == 0, scan)

    # Candidate: the migration under test, applied as production would.
    migration = sorted(MIGRATIONS.glob('*_a_ticket_paid_in_cash_never_arrived_at_its_target.sql'))
    check('candidate-exists-once', len(migration) == 1, [p.name for p in migration])
    text = migration[0].read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', text, re.M)) == 1 and len(re.findall(r'^COMMIT;', text, re.M)) == 1)
    check('candidate-writes-no-money-or-alert-row',
          not re.search(r'\b(INSERT|UPDATE|DELETE)\b', text.split('BEGIN;', 1)[1].replace('ca_conservation_subst', '')))
    before_catalog = run(CATALOG)
    run(text)
    check('candidate-reproduces-production-derived-scalar-postimage', md5(SCALAR) == POST_SCALAR_MD5, md5(SCALAR))
    check('candidate-reproduces-production-derived-set-postimage', md5(SET) == POST_SET_MD5, md5(SET))
    check('candidate-keeps-grants-owner-security-config', run(CATALOG) == before_catalog)
    check('candidate-leaves-the-scan-alone', md5(SCAN) == LIVE_SCAN_MD5)
    d = deltas()
    results['candidate'] = d
    check('cash-paid-ticket-is-not-target-income', d['t-cash'] == '0.00', d)
    check('admitted-ticket-is-still-target-income', d['t-admitted'] == '0.00', d)
    check('issued-ticket-is-still-not-income', d['t-issued'] == '0.00', d)
    check('real-retention-still-flags', d['t-retained'] == '15.00', d)
    check('satellite-unchanged', d['sat'] == '0.00', d)
    check('set-equals-scalar', scalar_parity() == '0')
    scan = json.loads(run("SELECT fn_tournament_money_conservation(45, 1.0, 500);"))
    results['candidate_scan'] = scan
    check('scan-closes-the-cash-target-alert-and-flags-only-the-real-one',
          scan['auto_resolved'] == 1 and scan['flagged'] == 1 and scan['retained_chips'] == 15, scan)
    open_alerts = run("SELECT string_agg(message, '|' ORDER BY message) FROM financial_alerts WHERE resolved IS NOT TRUE")
    check('only-the-real-retention-stays-open', open_alerts == 'Tournament retained money it never paid out: t-retained', open_alerts)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f"SET ROLE {role}; SELECT fn_tournament_conservation_delta(gen_random_uuid());",
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-read-the-scalar', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=text, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run', replay.returncode != 0 and 'is not the pinned text' in replay.stderr,
          replay.stderr[-300:])
    check('second-run-left-the-postimage', md5(SCALAR) == POST_SCALAR_MD5 and md5(SET) == POST_SET_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
