"""Isolated PostgreSQL regression: the payout sweep never reads a cash paid ticket as pool money.

20261015100003 (PR #6941, installed) taught fn_tournament_conservation_delta
and fn_tournament_conservation_deltas that a direct satellite ticket paid to
its holder in cash on its target's close (fn_ca_pay_closed_target_ticket_in_cash:
issued -> redeemed, escrow -> wallet leg keyed ticket:<id>:closed-target-cash)
never arrived at the target. fn_pay_backed_payout_shortfalls carries the same
seat_income term inline and was left behind: it still reads every such target
as holding the cash-paid value, so it would select the event as funded for a
reconciler top-up it never held (migration 20261015170338).

The test loads the exact production definitions captured on 2026-10-15
(pg_get_functiondef md5 equal to production's: the payer c9e67c9c, the scalar
61f61430 derived from the main fixture diamond-book-scalar.sql, the set read
e6d4be90), proves the baseline payer selects a target whose only "money" is a
cash-paid ticket, applies the candidate migration and proves:
  * the cash-paid target is no longer read as holding money, so a reported
    top-up there is never paid from the ticket's value, and when its pool
    really is short the payer raises its withheld alert instead;
  * a target whose admitted ticket arrived and which really holds money still
    pays its top-up, so the fix cannot hide a real shortfall payment;
  * the payer now selects exactly the events the corrected scalar reads above
    0.01, so the payer and the scalar agree on every event;
  * the postimage md5 is production's derived one; grants, owner, SECURITY
    DEFINER and config did not move; the scalar and set read are untouched;
  * the migration refuses when the scalar does not carry the gate, and a
    second run refuses.
An empty throwaway cluster on a Unix socket; no network, no production connection.
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
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'ticket-cash-conservation-v2'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/ticket-cash-conservation-v2')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ticket-cash-v2-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55824'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

PAYER = 'public.fn_pay_backed_payout_shortfalls(boolean,integer)'
SCALAR = 'public.fn_tournament_conservation_delta(uuid)'
SET = 'public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'
# pg_get_functiondef md5, read on production 2026-10-15 17:05 UTC, and the
# payer's postimage derived read-only there with replace().
LIVE_PAYER_MD5 = 'c9e67c9c7e42028543e39b18d29f02d3'
LIVE_SCALAR_MD5 = '61f614307807f21710b51c8a881f91da'
LIVE_SET_MD5 = 'e6d4be907acdfc8b9e013d4b65a16f1f'
POST_PAYER_MD5 = '8a6a20c6856b200dfa0ff7a1550044e4'
SIGS = (PAYER, SCALAR, SET)
OLD_GATE = "AND (k.id IS NULL OR k.status = 'redeemed')"
NEW_GATE = ("AND (k.id IS NULL OR (k.status = 'redeemed' AND NOT EXISTS (SELECT 1 FROM public.chip_ledger cl "
            "WHERE cl.idempotency_key = 'ticket:' || k.id::text || ':closed-target-cash' AND cl.category = 'ticket_redeem')))")
# The live scalar is the 20261009151510 postimage already on main as a fixture,
# with the one gate 20261015100003 (PR #6941) replaced; its md5 is checked below.
PRE_6941_SCALAR = (ROOT / 'scripts/ci/fixtures/backed-payout-scan/diamond-book-scalar.sql').read_text()
LIVE_SCALAR = PRE_6941_SCALAR.replace(OLD_GATE, NEW_GATE)
GRANTS = ''.join(f'REVOKE ALL ON FUNCTION {s} FROM PUBLIC, anon, authenticated;\n'
                 f'GRANT EXECUTE ON FUNCTION {s} TO service_role;\n' for s in SIGS)

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE clubs(id uuid PRIMARY KEY, asset text, is_platform boolean, union_id uuid);
CREATE TABLE tournaments(id uuid PRIMARY KEY, name text, variant text, tournament_type text, satellite_target_id uuid,
  status text, ended_at timestamptz, club_id uuid, union_id uuid, buy_in_amount numeric, buy_in_fee numeric, prize_pool numeric);
CREATE TABLE wallet_transactions(id bigserial, related_entity_id uuid, user_id uuid, type text, category text, amount numeric);
CREATE TABLE rake_records(id bigserial, tournament_id uuid, rake_amount numeric, is_tournament boolean);
CREATE TABLE chip_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid, category text,
  from_type text, from_entity_id uuid, to_type text, to_entity_id uuid, amount numeric, metadata jsonb, idempotency_key text);
CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON chip_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE tournament_guarantee_overlays(tournament_id uuid, amount numeric);
CREATE TABLE tournament_conservation_baseline(tournament_id uuid, amount numeric);
CREATE TABLE tournament_payouts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid, user_id uuid,
  position integer, amount numeric, source text, metadata jsonb);
CREATE TABLE tournament_satellite_awards(tournament_id uuid, place integer, ticket_id uuid, delivery_kind text);
CREATE TABLE tournament_tickets(id uuid PRIMARY KEY, holder_id uuid, value numeric, status text, source_tournament_id uuid);
CREATE TABLE financial_alerts(id uuid DEFAULT gen_random_uuid(), severity text, source text, message text, context jsonb,
  resolved boolean DEFAULT false, created_at timestamptz DEFAULT clock_timestamp(), resolved_at timestamptz);
CREATE TABLE tournament_payout_backfill_log(tournament_id uuid PRIMARY KEY, top_up numeric, delta_before numeric, delta_after numeric);
CREATE FUNCTION fn_poker_diamond_tournament_escrow(uuid)
  RETURNS TABLE(prize_balance numeric, bounty_balance numeric, fee_balance numeric)
  LANGUAGE sql AS $$ SELECT 0::numeric, 0::numeric, 0::numeric $$;
-- The reconciler is the unchanged dependency: a finite adapter that reports
-- the fixture's top-up per event, records every call (the payer asks only for
-- events it reads above 0.01), and on apply settles through a prize credit.
CREATE TABLE fixture_topups(tournament_id uuid PRIMARY KEY, top_up numeric);
CREATE TABLE fixture_reconcile_calls(n bigserial, tournament_id uuid, apply boolean);
CREATE FUNCTION fn_tournament_payout_reconcile(p_id uuid, p_apply boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v numeric := COALESCE((SELECT top_up FROM fixture_topups WHERE tournament_id = p_id), 0);
BEGIN
  INSERT INTO fixture_reconcile_calls(tournament_id, apply) VALUES (p_id, p_apply);
  IF p_apply AND v > 0 THEN
    INSERT INTO wallet_transactions(related_entity_id,user_id,type,category,amount)
      VALUES (p_id, '00000000-0000-0000-0000-0000000000ff', 'credit', 'prize', v);
    RETURN jsonb_build_object('total_top_up', v, 'total_settled', v);
  END IF;
  RETURN jsonb_build_object('total_top_up', v);
END $$;
"""

# One satellite issues four tickets of 20.00, one per target. Each target has
# one paying entrant (20.00) and a 40.00 advertised pool.
#   t-cash     its ticket was paid in cash when the target closed; the target
#              paid its one entrant 20.00 and holds nothing. The reconciler
#              reports a 20.00 top-up (an unrecorded place).
#   t-admitted its ticket was admitted; it paid 40.00 and holds nothing.
#   t-short    its ticket was admitted; it paid 25.00 of 40.00, so it really
#              holds 15.00, and the reconciler reports a 15.00 top-up.
#   t-issued   its ticket is still issued (never used); it paid 20.00.
SEED = """
INSERT INTO clubs VALUES ('00000000-0000-0000-0000-00000000c1ab','chips',false,NULL);
INSERT INTO tournaments(id,name,variant,status,ended_at,club_id,buy_in_amount,buy_in_fee,prize_pool) VALUES
  ('00000000-0000-0000-0000-0000000005a7','sat','satellite','COMPLETED',now()-interval '3 days','00000000-0000-0000-0000-00000000c1ab',18,2,80),
  ('00000000-0000-0000-0000-0000000000c1','t-cash','freezeout','COMPLETED',now()-interval '2 days','00000000-0000-0000-0000-00000000c1ab',18,2,40),
  ('00000000-0000-0000-0000-0000000000a1','t-admitted','freezeout','COMPLETED',now()-interval '2 days','00000000-0000-0000-0000-00000000c1ab',18,2,40),
  ('00000000-0000-0000-0000-0000000000d1','t-short','freezeout','COMPLETED',now()-interval '2 days','00000000-0000-0000-0000-00000000c1ab',18,2,40),
  ('00000000-0000-0000-0000-0000000000b1','t-issued','freezeout','COMPLETED',now()-interval '2 days','00000000-0000-0000-0000-00000000c1ab',18,2,40);
INSERT INTO wallet_transactions(related_entity_id,user_id,type,category,amount)
  SELECT '00000000-0000-0000-0000-0000000005a7', gen_random_uuid(), 'debit','tournament_buyin', 20 FROM generate_series(1,4);
INSERT INTO tournament_tickets VALUES
  ('00000000-0000-0000-0000-00000000f0c1','00000000-0000-0000-0000-0000000000e1',20,'redeemed','00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-00000000f0a1','00000000-0000-0000-0000-0000000000e2',20,'redeemed','00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000f0d1','00000000-0000-0000-0000-0000000000e4',20,'redeemed','00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-00000000f0b1','00000000-0000-0000-0000-0000000000e3',20,'issued','00000000-0000-0000-0000-0000000000b1');
INSERT INTO tournament_satellite_awards VALUES
  ('00000000-0000-0000-0000-0000000005a7',1,'00000000-0000-0000-0000-00000000f0c1','ticket'),
  ('00000000-0000-0000-0000-0000000005a7',2,'00000000-0000-0000-0000-00000000f0a1','ticket'),
  ('00000000-0000-0000-0000-0000000005a7',3,'00000000-0000-0000-0000-00000000f0d1','ticket'),
  ('00000000-0000-0000-0000-0000000005a7',4,'00000000-0000-0000-0000-00000000f0b1','ticket');
INSERT INTO tournament_payouts(tournament_id,user_id,position,amount,source,metadata) VALUES
  ('00000000-0000-0000-0000-0000000005a7','00000000-0000-0000-0000-0000000000e1',1,20,'satellite_ticket',
    '{"satellite_target_id":"00000000-0000-0000-0000-0000000000c1","ticket_id":"00000000-0000-0000-0000-00000000f0c1"}'),
  ('00000000-0000-0000-0000-0000000005a7','00000000-0000-0000-0000-0000000000e2',2,20,'satellite_ticket',
    '{"satellite_target_id":"00000000-0000-0000-0000-0000000000a1","ticket_id":"00000000-0000-0000-0000-00000000f0a1"}'),
  ('00000000-0000-0000-0000-0000000005a7','00000000-0000-0000-0000-0000000000e4',3,20,'satellite_ticket',
    '{"satellite_target_id":"00000000-0000-0000-0000-0000000000d1","ticket_id":"00000000-0000-0000-0000-00000000f0d1"}'),
  ('00000000-0000-0000-0000-0000000005a7','00000000-0000-0000-0000-0000000000e3',4,20,'satellite_ticket',
    '{"satellite_target_id":"00000000-0000-0000-0000-0000000000b1","ticket_id":"00000000-0000-0000-0000-00000000f0b1"}');
-- the cash door: escrow -> wallet, keyed on the leg itself, naming no tournament
INSERT INTO chip_ledger(tournament_id,category,from_type,from_entity_id,to_type,to_entity_id,amount,metadata,idempotency_key) VALUES
  (NULL,'ticket_redeem','escrow','00000000-0000-0000-0000-00000000f0c1','player_wallet','00000000-0000-0000-0000-0000000000e1',20,
   '{"kind":"closed_target_ticket_cash"}','ticket:00000000-0000-0000-0000-00000000f0c1:closed-target-cash');
INSERT INTO wallet_transactions(related_entity_id,user_id,type,category,amount) VALUES
  (NULL,'00000000-0000-0000-0000-0000000000e1','credit','transfer',20);
-- the admission door: escrow -> prize_liability naming the target
INSERT INTO chip_ledger(tournament_id,category,from_type,from_entity_id,to_type,amount) VALUES
  ('00000000-0000-0000-0000-0000000000a1','ticket_redeem','escrow','00000000-0000-0000-0000-00000000f0a1','prize_liability',20),
  ('00000000-0000-0000-0000-0000000000d1','ticket_redeem','escrow','00000000-0000-0000-0000-00000000f0d1','prize_liability',20);
INSERT INTO wallet_transactions(related_entity_id,user_id,type,category,amount)
  SELECT id, gen_random_uuid(), 'debit','tournament_buyin', 20 FROM tournaments WHERE name LIKE 't-%';
INSERT INTO wallet_transactions(related_entity_id,user_id,type,category,amount) VALUES
  ('00000000-0000-0000-0000-0000000000c1',gen_random_uuid(),'credit','prize',20),
  ('00000000-0000-0000-0000-0000000000a1',gen_random_uuid(),'credit','prize',40),
  ('00000000-0000-0000-0000-0000000000d1',gen_random_uuid(),'credit','prize',25),
  ('00000000-0000-0000-0000-0000000000b1',gen_random_uuid(),'credit','prize',20);
INSERT INTO fixture_topups VALUES
  ('00000000-0000-0000-0000-0000000000c1',20), ('00000000-0000-0000-0000-0000000000d1',15);
"""


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def attempt(sql):
    return subprocess.run(list(map(str, psql)), input=sql, text=True, capture_output=True, env=env, timeout=60)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def md5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def sweep(apply):
    """Run the payer in a rolled-back transaction; return its result, the
    events it asked the reconciler about, the alerts it raised and the log."""
    rows = run(f"""BEGIN;
      SELECT fn_pay_backed_payout_shortfalls({apply}, 500)::text;
      SELECT jsonb_build_object(
        'asked', (SELECT COALESCE(jsonb_agg(t.name ORDER BY t.name), '[]') FROM
                   (SELECT DISTINCT tournament_id FROM fixture_reconcile_calls WHERE NOT apply) c
                   JOIN tournaments t ON t.id = c.tournament_id),
        'settled', (SELECT COALESCE(jsonb_agg(t.name ORDER BY t.name), '[]') FROM fixture_reconcile_calls c
                   JOIN tournaments t ON t.id = c.tournament_id WHERE c.apply),
        'alerts', (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', context->>'kind', 'event', t.name)
                   ORDER BY t.name), '[]') FROM financial_alerts a
                   JOIN tournaments t ON t.id::text = a.context->>'tournament_id'
                   WHERE a.source = 'fn_pay_backed_payout_shortfalls'))::text;
      ROLLBACK;""").splitlines()
    return json.loads(rows[0]), json.loads(rows[1])


def scalar_above():
    return json.loads(run("""SELECT COALESCE(jsonb_agg(name ORDER BY name), '[]') FROM tournaments
      WHERE status = 'COMPLETED' AND variant <> 'satellite' AND fn_tournament_conservation_delta(id) > 0.01"""))


CATALOG = f"""SELECT jsonb_agg(jsonb_build_object('acl',proacl::text,'owner',proowner,'definer',prosecdef,
  'config',proconfig,'volatility',provolatile) ORDER BY oid) FROM pg_proc
  WHERE oid IN ({','.join(f"'{s}'::regprocedure" for s in SIGS)})"""

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
    run(LIVE_SCALAR + ';\n'
        + (FIXTURES / 'fn_tournament_conservation_deltas.live-20261015.sql').read_text() + ';\n'
        + (FIXTURES / 'fn_pay_backed_payout_shortfalls.live-20261015.sql').read_text() + ';\n' + GRANTS)
    check('baseline-payer-is-production-preimage', md5(PAYER) == LIVE_PAYER_MD5, md5(PAYER))
    check('baseline-scalar-is-production-live-text', md5(SCALAR) == LIVE_SCALAR_MD5, md5(SCALAR))
    check('baseline-set-is-production-live-text', md5(SET) == LIVE_SET_MD5, md5(SET))
    run(SEED)
    check('the-corrected-scalar-reads-only-the-real-holding', scalar_above() == ['t-short'], scalar_above())
    res, seen = sweep('false')
    results['baseline_dry'] = {'result': res, 'seen': seen}
    check('baseline-payer-reads-the-cash-ticket-as-pool-money', seen['asked'] == ['t-cash', 't-short'], seen)
    check('baseline-payer-counts-the-cash-target-payable',
          res['events_paid'] == 2 and float(res['chips_paid']) == 35 and res['events_withheld_unfunded_pool'] == 0, res)
    check('baseline-payer-disagrees-with-the-scalar', seen['asked'] != scalar_above(), seen)
    r = attempt("BEGIN; SELECT fn_pay_backed_payout_shortfalls(true, 500); ROLLBACK;")
    results['baseline_apply_error'] = r.stderr[-300:]
    check('baseline-apply-pays-the-cash-target-then-trips-its-own-refusal',
          r.returncode != 0 and 'would leave conservation at' in r.stderr, r.stderr[-300:])

    # Candidate: the migration under test, applied as production would.
    migration = sorted(MIGRATIONS.glob('*_the_payout_sweep_never_reads_a_cash_paid_ticket_as_pool_mone.sql'))
    check('candidate-exists-once', len(migration) == 1, [p.name for p in migration])
    text = migration[0].read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', text, re.M)) == 1 and len(re.findall(r'^COMMIT;', text, re.M)) == 1)
    check('candidate-writes-no-money-or-alert-row',
          not re.search(r'\b(INSERT|UPDATE|DELETE)\b', text.split('BEGIN;', 1)[1]))

    # It refuses while the scalar does not yet carry the gate (installed out of step).
    r = attempt('BEGIN;\n' + PRE_6941_SCALAR + ';\n' + text.split('BEGIN;', 1)[1].replace('COMMIT;', 'ROLLBACK;'))
    check('candidate-refuses-ahead-of-the-scalar',
          r.returncode != 0 and 'carries the cash-paid ticket gate 0 times' in r.stderr, r.stderr[-300:])
    check('refusal-left-everything-in-place',
          md5(PAYER) == LIVE_PAYER_MD5 and md5(SCALAR) == LIVE_SCALAR_MD5 and md5(SET) == LIVE_SET_MD5)

    before_catalog = run(CATALOG)
    run(text)
    check('candidate-reproduces-production-derived-payer-postimage', md5(PAYER) == POST_PAYER_MD5, md5(PAYER))
    check('candidate-keeps-grants-owner-security-config', run(CATALOG) == before_catalog)
    check('candidate-leaves-the-scalar-and-set-alone', md5(SCALAR) == LIVE_SCALAR_MD5 and md5(SET) == LIVE_SET_MD5)

    res, seen = sweep('false')
    results['candidate_dry'] = {'result': res, 'seen': seen}
    check('payer-no-longer-reads-the-cash-ticket-as-pool-money', seen['asked'] == ['t-short'], seen)
    check('payer-agrees-with-the-scalar-on-every-event', seen['asked'] == scalar_above(), seen)
    check('real-shortfall-still-payable', res['events_paid'] == 1 and float(res['chips_paid']) == 15, res)

    res, seen = sweep('true')
    results['candidate_apply'] = {'result': res, 'seen': seen}
    check('apply-pays-only-the-event-that-holds-the-money',
          res['events_paid'] == 1 and seen['settled'] == ['t-short'] and seen['alerts'] == [], {'res': res, 'seen': seen})

    # A cash target whose pool really is short is withheld and alerted, not paid
    # out of the cash-paid ticket's value.
    run("UPDATE wallet_transactions SET amount = 10 WHERE related_entity_id = '00000000-0000-0000-0000-0000000000c1' AND category = 'prize';")
    res, seen = sweep('false')
    results['candidate_cash_target_short'] = {'result': res, 'seen': seen}
    check('cash-target-short-by-10-is-withheld-not-paid-from-the-ticket',
          seen['asked'] == ['t-cash', 't-short'] and res['events_withheld_unfunded_pool'] == 1
          and {'kind': 'withheld_unfunded_pool', 'event': 't-cash'} in seen['alerts'], {'res': res, 'seen': seen})
    run("UPDATE wallet_transactions SET amount = 20 WHERE related_entity_id = '00000000-0000-0000-0000-0000000000c1' AND category = 'prize';")

    for role in ('anon', 'authenticated'):
        r = attempt(f"SET ROLE {role}; SELECT fn_pay_backed_payout_shortfalls(false, 1);")
        check(role + '-cannot-run-the-payer', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = attempt(text)
    check('migration-refuses-a-second-run', replay.returncode != 0 and 'is not the pinned text' in replay.stderr,
          replay.stderr[-300:])
    check('second-run-left-the-postimage', md5(PAYER) == POST_PAYER_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'output': str(out / 'RESULTS.json')}))
