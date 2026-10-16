"""Isolated PostgreSQL regression for migration 20261016172614.

The hourly chip supply meter (fn_ca_supply_snapshot) read a few unexplained
chips whenever its reading landed between the two transactions of a settled
cash hand: the accepted-hand commit moves the seats by inflow - rake - bbj,
and the hand's post-commit obligations post the rake and the jackpot drop (and
resolve the add-on) a few hundred milliseconds later. Between them the rake and
drop are on no store the meter counts, so the reading was short by them and the
next one long (-0.10 and -1.93 on production 2026-10-16, each to the cent the
hands then in flight).

The test loads the exact production definition captured on 2026-10-16 (its
pg_get_functiondef md5 equal to production's), proves the baseline reads the
in-flight rake and drop (and an add-on's inflow) as unexplained, applies the
migration as production would, and proves the candidate reproduces the
postimage derived read-only on production, opens a new basis, reads every
phase of the same hands as exactly zero, still excludes tournament and Diamond
tables, keeps owner, security, settings and grants, declares the guard
redefinition, and refuses a second run. An empty throwaway cluster on a Unix
socket; no network, no production connection.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
from decimal import Decimal

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261016172614_the_supply_meter_counts_a_hand_in_transit.sql'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'supply-meter-hand-in-transit'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/supply-meter-hand-in-transit')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='supply-transit-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55871'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SIG = 'public.fn_ca_supply_snapshot()'
# pg_get_functiondef md5 read on production 2026-10-16, before and after (the
# postimage derived read-only there with replace() on the live text).
PRE = 'c9fa91cece6c07f9ba35b55455d7ce5e'
POST = 'de5f2ec2b0897d91d12689288723b57f'
META = 'postgres true {"search_path=public, pg_temp"} {postgres=X/postgres,service_role=X/postgres}'

CLUB = '00000000-0000-0000-0000-0000000000c1'
DIAMOND_CLUB = '00000000-0000-0000-0000-0000000000d1'
CASH = '00000000-0000-0000-0000-00000000ca51'
TOURNEY_TABLE = '00000000-0000-0000-0000-00000000704e'
DIAMOND_TABLE = '00000000-0000-0000-0000-00000000d1a7'
TOURNEY = '00000000-0000-0000-0000-0000000070aa'

# Only what the meter reads, with production's column names.
SCHEMA = f"""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE clubs(id uuid PRIMARY KEY, is_platform boolean DEFAULT false, asset text NOT NULL DEFAULT 'chips',
  chip_treasury numeric DEFAULT 0, chip_pool numeric DEFAULT 0, promo_balance numeric DEFAULT 0,
  insurance_balance numeric DEFAULT 0);
CREATE TABLE club_members(user_id uuid, club_id uuid, chip_balance numeric DEFAULT 0, promo_balance numeric DEFAULT 0);
CREATE TABLE tables(id uuid PRIMARY KEY, tournament_id uuid, club_id uuid);
CREATE TABLE table_seats(id serial, table_id uuid, stack numeric, left_at timestamptz);
CREATE TABLE table_pending_addons(id serial, table_id uuid, amount numeric, resolved_at timestamptz);
CREATE TABLE club_wallets(chip_balance numeric DEFAULT 0);
CREATE TABLE union_wallets(union_id uuid, chip_balance numeric DEFAULT 0, rake_wallet numeric DEFAULT 0,
  bbj_wallet numeric DEFAULT 0, promo_wallet numeric DEFAULT 0, insurance_wallet numeric DEFAULT 0,
  spin_reserve_wallet numeric DEFAULT 0);
CREATE TABLE agents(agent_wallet_balance numeric DEFAULT 0, promo_wallet_balance numeric DEFAULT 0);
CREATE TABLE bbj_pools(main_balance numeric DEFAULT 0, backup_balance numeric DEFAULT 0, promo_balance numeric DEFAULT 0);
CREATE TABLE spin_bonus_pools(balance numeric DEFAULT 0);
CREATE TABLE tournaments(id uuid PRIMARY KEY, status text, club_id uuid, prize_pool numeric, bounty_pool numeric,
  bounty_pool_paid numeric, total_rake numeric);
CREATE TABLE tournament_escrow(tournament_id uuid, prize_balance numeric, bounty_balance numeric, fee_balance numeric);
CREATE TABLE club_opening_setups(leaderboard_seed_remaining numeric);
CREATE TABLE chip_escrow(amount numeric, released_at timestamptz);
CREATE TABLE chip_ledger(id bigserial PRIMARY KEY, amount numeric, from_type text, to_type text, category text,
  metadata jsonb DEFAULT '{{}}', created_at timestamptz DEFAULT now());
CREATE TABLE hand_atomic_commits(table_id uuid, hand_number bigint PRIMARY KEY, hand_id uuid DEFAULT gen_random_uuid(),
  stack_result jsonb, committed_at timestamptz DEFAULT now(), post_commit_payload jsonb,
  post_commit_completed_at timestamptz);
CREATE INDEX idx_hand_atomic_commits_post_commit_pending ON hand_atomic_commits(table_id, hand_number)
  WHERE post_commit_payload IS NOT NULL AND post_commit_completed_at IS NULL;
CREATE TABLE ca_supply_snapshots(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  taken_at timestamptz DEFAULT now(), member_wallets numeric, member_promo numeric, felt numeric, treasuries numeric,
  chip_pools numeric, club_wallets numeric, union_wallets numeric, agent_wallets numeric, bbj_pools numeric,
  spin_pools numeric, total numeric, mint_since_prev numeric, burn_since_prev numeric, delta_vs_prev numeric,
  unexplained numeric, tournament_liability numeric, leaderboard_liability numeric, cert_wallets numeric,
  club_promo numeric, club_insurance numeric, agent_promo numeric, basis_version text, ticket_escrow numeric,
  pending_addons numeric, late_mint numeric, late_burn numeric, restated_mint numeric, restated_burn numeric,
  restated_at timestamptz, cashout_escrow numeric);
CREATE TABLE ca_guard_defs(proname text PRIMARY KEY, def_hash text, updated_at timestamptz DEFAULT now(),
  declared_ref text, declared_at timestamptz);
CREATE TABLE ca_guard_def_history(id bigserial PRIMARY KEY, proname text, def_hash text, def_text text,
  captured_at timestamptz DEFAULT now(), UNIQUE (proname, def_hash));
CREATE TABLE incidents_raised(at timestamptz DEFAULT clock_timestamp(), discrepancy numeric);

CREATE FUNCTION fn_ca_noncirculating_chip_stores() RETURNS text[] LANGUAGE sql IMMUTABLE
  AS $$ SELECT ARRAY['system_mint','system_burn','issuance_reserve','chip_retirement'] $$;
CREATE FUNCTION fn_ca_ticket_escrow_float() RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT 0::numeric $$;
CREATE FUNCTION fn_ca_is_cert_account(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION fn_ca_kill_switch_trip(text, numeric, text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text, p_dedupe_key text,
  p_discrepancy numeric, p_expected numeric, p_actual numeric, p_layer text, p_entity_type text, p_entity_id uuid,
  p_club_id uuid, p_union_id uuid, p_table_id uuid, p_tournament_id uuid, p_hand_id uuid, p_settlement_id text,
  p_wallet_ids uuid[], p_transaction_ids uuid[], p_suspected_cause text, p_ledger_balanced boolean, p_metadata jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN INSERT INTO incidents_raised(discrepancy) VALUES (p_discrepancy); RETURN gen_random_uuid(); END $$;
CREATE FUNCTION fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['fn_ca_supply_snapshot'] $$;
CREATE FUNCTION public.fn_ca_declare_guard_redefinition(p_proname text, p_ref text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_hash text; v_def text;
BEGIN
  IF COALESCE(btrim(p_ref), '') = '' THEN
    RAISE EXCEPTION 'a guard redefinition must name the migration that made it';
  END IF;
  IF NOT (p_proname = ANY (public.fn_ca_guard_watchlist())) THEN
    RAISE EXCEPTION 'fn_ca_declare_guard_redefinition called for %, which is not on the guard watchlist', p_proname;
  END IF;
  SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)),
         string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)
    INTO v_hash, v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_proname;
  INSERT INTO public.ca_guard_def_history (proname, def_hash, def_text) VALUES (p_proname, v_hash, v_def)
  ON CONFLICT (proname, def_hash) DO NOTHING;
  INSERT INTO public.ca_guard_defs (proname, def_hash, declared_ref, declared_at)
  VALUES (p_proname, v_hash, p_ref, now())
  ON CONFLICT (proname) DO UPDATE SET def_hash = EXCLUDED.def_hash, declared_ref = EXCLUDED.declared_ref,
    declared_at = EXCLUDED.declared_at, updated_at = now();
  RETURN v_hash;
END $function$;

INSERT INTO clubs(id, chip_treasury) VALUES ('{CLUB}', 1000);
INSERT INTO clubs(id, asset, chip_treasury) VALUES ('{DIAMOND_CLUB}', 'diamonds', 0);
INSERT INTO club_members(user_id, club_id, chip_balance) VALUES (gen_random_uuid(), '{CLUB}', 500);
INSERT INTO tables VALUES ('{CASH}', NULL, '{CLUB}'), ('{TOURNEY_TABLE}', '{TOURNEY}', '{CLUB}'),
                          ('{DIAMOND_TABLE}', NULL, '{DIAMOND_CLUB}');
INSERT INTO table_seats(table_id, stack) VALUES ('{CASH}', 100), ('{CASH}', 100), ('{TOURNEY_TABLE}', 50),
                                                ('{DIAMOND_TABLE}', 70);
INSERT INTO union_wallets(union_id) VALUES (gen_random_uuid());
INSERT INTO bbj_pools DEFAULT VALUES;
"""

hand_no = iter(range(1, 1000))


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def md5():
    return run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")


def num(v):
    return 'NULL' if v == 'NULL' else str(Decimal(v).normalize() + 0)


def reading():
    """One hourly reading: (unexplained, posthand_transit, basis), numbers normalised."""
    run(f'SELECT {SIG.replace("public.", "")}')
    row = run("SELECT coalesce(unexplained::text,'NULL')||'|'||"
              "coalesce((to_jsonb(s)->>'posthand_transit'),'NULL')||'|'||basis_version "
              "FROM ca_supply_snapshots s ORDER BY id DESC LIMIT 1").split('|')
    return num(row[0]), num(row[1]), row[2]


def accept(table, rake, bbj, inflow=0, seat_delta=None):
    """The accepted-hand commit: the seats move by inflow - rake - bbj, the
    hand's obligations are recorded and not yet posted."""
    n = next(hand_no)
    delta = inflow - rake - bbj if seat_delta is None else seat_delta
    run(f"UPDATE table_seats SET stack = stack + {delta} WHERE id = (SELECT min(id) FROM table_seats "
        f"WHERE table_id = '{table}');"
        f"INSERT INTO hand_atomic_commits(table_id, hand_number, stack_result, post_commit_payload) "
        f"VALUES ('{table}', {n}, jsonb_build_object('rake',{rake},'bbj',{bbj},'inflow',{inflow},'mode','delta'), "
        f"'{{}}'::jsonb)")
    return n


def obligations(n, rake, bbj, addon=False):
    """The next transaction: rake and drop posted with their legs, the add-on
    resolved, the hand stamped complete."""
    sql = ['BEGIN;',
           f'UPDATE union_wallets SET rake_wallet = rake_wallet + {rake};',
           f'UPDATE bbj_pools SET main_balance = main_balance + {bbj};',
           f"INSERT INTO chip_ledger(amount, from_type, to_type, category) VALUES "
           f"({rake}, 'table_stack', 'union_wallet', 'rake'), ({bbj}, 'table_stack', 'bbj_pool', 'bbj_contribution');"]
    if addon:
        sql.append('UPDATE table_pending_addons SET resolved_at = now() WHERE resolved_at IS NULL;')
    sql.append(f'UPDATE hand_atomic_commits SET post_commit_completed_at = now() WHERE hand_number = {n};')
    sql.append('COMMIT;')
    run('\n'.join(sql))


def one_cycle():
    """The production shapes, read between and after each half."""
    seen = {}
    # A: rake 1.65 + drop 0.25 in flight (hand 8eb28ce6, 17:05 on 2026-10-16),
    # beside a tournament hand and a Diamond hand that are not on the chip felt.
    a = accept(CASH, 1.65, 0.25)
    t = accept(TOURNEY_TABLE, 3.00, 0, seat_delta=0)
    d = accept(DIAMOND_TABLE, 2.00, 0, seat_delta=0)
    seen['rake_in_flight'] = reading()
    obligations(a, 1.65, 0.25)
    run(f'UPDATE hand_atomic_commits SET post_commit_completed_at = now() WHERE hand_number IN ({t},{d})')
    seen['rake_posted'] = reading()
    # B: a mid-hand add-on of 10.00 paid into the felt at commit, rake 0.50,
    # resolved by the obligations.
    run(f"BEGIN; UPDATE club_members SET chip_balance = chip_balance - 10; "
        f"INSERT INTO table_pending_addons(table_id, amount) VALUES ('{CASH}', 10); COMMIT;")
    seen['addon_bought'] = reading()
    b = accept(CASH, 0.50, 0, inflow=10)
    seen['addon_in_flight'] = reading()
    obligations(b, 0.50, 0, addon=True)
    seen['addon_posted'] = reading()
    return seen


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=32MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Baseline: the exact production definition before this change.
    run((FIXTURES / 'fn_ca_supply_snapshot.live-20261016.sql').read_text()
        + f'\nREVOKE ALL ON FUNCTION {SIG} FROM PUBLIC; GRANT EXECUTE ON FUNCTION {SIG} TO service_role;\n')
    check('baseline-is-production-preimage', md5() == PRE, md5())
    reading()
    first = reading()
    check('baseline-reads-a-quiet-hour-as-zero', first[0] == '0', first)
    base = one_cycle()
    results['baseline'] = base
    check('baseline-reads-the-rake-in-flight-as-missing', base['rake_in_flight'][0] == '-1.9', base)
    check('baseline-reads-it-back-as-found', base['rake_posted'][0] == '1.9', base)
    check('baseline-reads-an-unresolved-addon-once', base['addon_bought'][0] == '0', base)
    check('baseline-double-counts-the-addon-in-flight', base['addon_in_flight'][0] == '9.5', base)
    check('baseline-reads-it-back', base['addon_posted'][0] == '-9.5', base)

    # Candidate: the migration under test, applied as production would.
    migration = MIGRATION.read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-sets-lock-timeout', 'SET LOCAL lock_timeout' in migration)
    proof = re.search(r'^-- @live-proof: (.+)$', migration, re.M)
    check('candidate-carries-a-live-proof', proof is not None)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', md5() == POST, md5())
    check('live-proof-reads-true-after-install', run(proof.group(1)) == 't')
    declared = run("SELECT declared_ref FROM ca_guard_defs WHERE proname = 'fn_ca_supply_snapshot'")
    check('guard-redefinition-is-declared-by-name', '20261016172614' in declared, declared)
    hist = run("SELECT def_hash = md5(def_text) FROM ca_guard_def_history WHERE proname = 'fn_ca_supply_snapshot'")
    check('guard-baseline-is-the-new-text', hist == 't', hist)
    check('historical-readings-carry-no-transit-figure',
          run('SELECT count(*) FROM ca_supply_snapshots WHERE posthand_transit IS NOT NULL') == '0')

    opening = reading()
    results['candidate_opening'] = opening
    check('the-first-reading-opens-a-new-basis-and-compares-nothing',
          opening == ('NULL', '0', 'posthand-transit-v6'), opening)
    cand = one_cycle()
    results['candidate'] = cand
    for phase, row in cand.items():
        check(f'candidate-reads-{phase.replace("_", "-")}-as-zero', row[0] == '0', cand)
    check('the-rake-in-flight-is-on-the-meter', cand['rake_in_flight'][1] == '1.9', cand)
    check('the-tournament-and-diamond-hands-are-not', cand['rake_in_flight'][1] == '1.9', cand)
    check('the-addon-in-flight-is-netted', cand['addon_in_flight'][1] == '-9.5', cand)
    check('nothing-is-in-flight-once-posted',
          cand['rake_posted'][1] == '0' and cand['addon_posted'][1] == '0', cand)
    check('no-incident-was-raised', run('SELECT count(*) FROM incidents_raised') == '0')

    meta = run(f"SELECT pg_get_userbyid(proowner)||' '||prosecdef::text||' '||coalesce(proconfig::text,'-')"
               f"||' '||coalesce(proacl::text,'-') FROM pg_proc WHERE oid = '{SIG}'::regprocedure")
    check('owner-security-settings-and-grants-kept', meta == META, meta)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT fn_ca_supply_snapshot();',
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-take-a-reading', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run', replay.returncode != 0, replay.stderr[-300:])
    check('second-run-left-the-postimage', md5() == POST)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'output': str(out / 'RESULTS.json')}))
