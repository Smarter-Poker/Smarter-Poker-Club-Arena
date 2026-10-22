"""Isolated PostgreSQL qualification: the hourly audits read less, and say the same.

Migration 20261022062934 changes how five integrity reads find their rows, not
what they answer. This loads the exact production definitions captured on
2026-10-22 (each pg_get_functiondef md5 equals production's), builds fixtures
that exercise every branch, records each function's answer, applies the
migration, and proves:

  * fn_rake_attribution_drift returns the same rows (in and out of the window,
    allocated, over- and under-allocated, a hand with no attributions);
  * fn_bbj_promo_bank_check returns the same document, including the
    pre-triple-bank era and union join closures;
  * fn_union_integrity_sweep returns the same co-seating pairs (human with
    human, human with horse, horse with horse excluded, outside the union,
    outside the window, the >= 8 tables threshold, the 20 row limit and its
    order) and every other signal unchanged;
  * fn_club_table_daily_catchup rebuilds a complete day the first time, does
    not rebuild it again while nothing moved, rebuilds it when a fact, a raked
    hand or an attribution moves, rebuilds once more twelve hours after the
    day closed, still refreshes today, and still runs the ledger check;
  * fn_bbj_reconcile carries plan_cache_mode = force_generic_plan and nothing
    else of it changed;
  * postimage md5s equal the migration's pins, grants and owners unchanged,
    union-integrity-sweep moves to :33 with its command unchanged, and a
    second install is refused by the pins.

An empty throwaway cluster on a Unix socket; no network, no production
connection. Runs as the runner user, or as postgres under root.
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
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261022062934_the_hourly_audits_read_only_what_changed_since_they_last_loo.sql'
FIX = ROOT / 'scripts' / 'ci' / 'fixtures' / 'hourly-audits-hot-tables'
RECONCILE = ROOT / 'scripts' / 'ci' / 'fixtures' / 'bbj-audit-reads' / 'cumulative-function-after.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/hourly-audits-hot-tables')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='hourly-audits-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = os.environ.get('HOURLY_AUDITS_PORT', '55833')
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

PRE = {
    'public.fn_rake_attribution_drift(integer)': 'a0aa202661e9e9ec1b80ef893ec4f6e3',
    'public.fn_bbj_promo_bank_check()': '94b115192b2b6c2196808b614917fd12',
    'public.fn_club_table_daily_catchup(integer)': 'a33a8f453c08478ce314625649e2b42f',
    'public.fn_union_integrity_sweep(uuid,integer)': 'b3adb49ea93ac361b16c3c7ed19a865d',
    'public.fn_bbj_reconcile(uuid)': '48bb2fe0db2df27ffb0776970dc528b6',
    'public.fn_ca_payout_rows_without_money(integer)': 'f5cf519b32f61707d283d634c39190f2',
}
UNION = 'fade0000-0000-0000-0000-000000000001'
CLUB = 'a0000000-0000-0000-0000-000000000001'
OTHER_UNION = 'fade0000-0000-0000-0000-000000000002'


def uid(n):
    return '00000000-0000-0000-0000-' + str(n).zfill(12)


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


def md5_of(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def proc_state(sig):
    return run(f"SELECT concat_ws('|', proacl::text, pg_get_userbyid(proowner), prosecdef, provolatile)"
               f" FROM pg_proc WHERE oid = '{sig}'::regprocedure")


SCHEMA = f"""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION public.fn_is_union_overseer(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean);
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job SET schedule = COALESCE(alter_job.schedule, cron.job.schedule),
                      command = COALESCE(alter_job.command, cron.job.command)
   WHERE jobid = job_id $$;
INSERT INTO cron.job VALUES (123, 'union-integrity-sweep', '35 * * * *',
 $c$SET statement_timeout = '300s'; DO $job$ BEGIN IF pg_try_advisory_lock(hashtext('union-integrity-sweep')) THEN   PERFORM set_config('statement_timeout', '120s', true);   PERFORM public.fn_union_integrity_sweep_all(); ELSE   RAISE NOTICE 'skipped: previous run still in progress'; END IF; END $job$;$c$, true);

CREATE TABLE union_clubs(union_id uuid, club_id uuid);
CREATE TABLE clubs(id uuid PRIMARY KEY, is_union boolean);
CREATE TABLE club_members(club_id uuid, user_id uuid, agent_id uuid);
CREATE TABLE profiles(id uuid PRIMARY KEY, is_horse boolean);
CREATE TABLE wallet_transactions(user_id uuid, type text, category text, amount numeric,
  created_at timestamptz, table_id uuid, related_entity_id uuid, description text);
CREATE TABLE tables(id uuid PRIMARY KEY, union_id uuid, club_id uuid, tournament_id uuid);
CREATE TABLE tournaments(id uuid PRIMARY KEY, union_id uuid, club_id uuid, name text);
CREATE TABLE tournament_payouts(id bigserial PRIMARY KEY, tournament_id uuid, user_id uuid, position integer,
  source text, amount numeric(15,2), paid_at timestamptz, idempotency_key text);
CREATE TABLE wallet_credit_idempotency(key text PRIMARY KEY, created_at timestamptz);
CREATE TABLE rake_records(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hand_id uuid, rake_amount numeric,
  rake_method text, player_contributions jsonb, created_at timestamptz,
  table_id uuid, tournament_id uuid, club_id uuid, is_tournament boolean);
CREATE TABLE rake_attributions(id bigserial PRIMARY KEY, hand_id uuid, club_id uuid, player_id uuid,
  weighted_rake_credit numeric, rake_amount numeric, created_at timestamptz);
CREATE INDEX ON rake_attributions(hand_id);
CREATE TABLE chip_transactions(club_id uuid, from_user_id uuid, to_user_id uuid, amount numeric,
  transaction_type text, metadata jsonb, created_at timestamptz);
CREATE TABLE agents(user_id uuid, club_id uuid);
CREATE TABLE table_seats(id bigserial PRIMARY KEY, table_id uuid NOT NULL, user_id uuid REFERENCES profiles(id), joined_at timestamptz);
CREATE INDEX idx_table_seats_user ON table_seats(user_id);
CREATE INDEX idx_table_seats_table ON table_seats(table_id);
CREATE TABLE financial_alerts(severity text, source text, message text, context jsonb,
  created_at timestamptz DEFAULT now());
CREATE TABLE bbj_contributions(id bigserial PRIMARY KEY, amount numeric, main_portion numeric,
  backup_portion numeric, promo_portion numeric);
CREATE TABLE union_wallet_transactions(tx_type text, amount numeric);
CREATE TABLE bbj_pools(id uuid PRIMARY KEY, main_balance numeric, backup_balance numeric, promo_balance numeric);
CREATE TABLE club_table_daily(club_id uuid, table_id uuid, stat_date date, source_rows integer);
CREATE TABLE ca_club_data_fact(club_id uuid, stat_date date, kind text, game_id uuid, user_id uuid,
  fee numeric, buyins numeric, cashouts numeric, winnings numeric, last_at timestamptz,
  PRIMARY KEY (club_id, stat_date, game_id, user_id));
CREATE TABLE ca_club_rake_daily(club_id uuid, stat_date date, rake numeric);
CREATE TABLE refresh_log(day date, at timestamptz DEFAULT clock_timestamp());
CREATE TABLE rebuild_log(day date);
CREATE FUNCTION public.fn_club_table_daily_refresh_day(p_day date) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  IF p_day = (now() AT TIME ZONE 'UTC')::date THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'live_day_is_kept_by_triggers');
  END IF;
  INSERT INTO refresh_log(day) VALUES (p_day);
  RETURN jsonb_build_object('success', true);
END $$;
CREATE FUNCTION public.fn_ca_club_rake_daily_ledger_total(p_day date) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(r.rake_amount), 0) FROM rake_records r
   WHERE r.created_at >= (p_day::timestamp AT TIME ZONE 'UTC')
     AND r.created_at < ((p_day + 1)::timestamp AT TIME ZONE 'UTC') $$;
CREATE FUNCTION public.fn_ca_club_rake_daily_rebuild_range(p_start date, p_end date, p_include_today boolean DEFAULT false)
RETURNS integer LANGUAGE sql AS $$ INSERT INTO rebuild_log VALUES (p_start) RETURNING 1 $$;

CREATE TABLE ca_bbj_pool_snapshots(id bigserial PRIMARY KEY, pool_id uuid NOT NULL, taken_at timestamptz NOT NULL,
  is_baseline boolean NOT NULL DEFAULT false, prev_id bigint, main numeric NOT NULL, backup numeric NOT NULL,
  promo numeric NOT NULL, journal_main numeric NOT NULL DEFAULT 0, journal_backup numeric NOT NULL DEFAULT 0,
  journal_promo numeric NOT NULL DEFAULT 0, drops_since numeric NOT NULL DEFAULT 0,
  payouts_since numeric NOT NULL DEFAULT 0, sweeps_since numeric NOT NULL DEFAULT 0,
  funding_since numeric NOT NULL DEFAULT 0, moves_since numeric NOT NULL DEFAULT 0,
  write_failures integer NOT NULL DEFAULT 0, unexplained_main numeric NOT NULL DEFAULT 0,
  unexplained_backup numeric NOT NULL DEFAULT 0, unexplained_promo numeric NOT NULL DEFAULT 0,
  note text, basis_version text);
CREATE TABLE chip_ledger(id bigserial PRIMARY KEY, category text, amount numeric(15,2), from_type text, to_type text,
  from_entity_id uuid, to_entity_id uuid, from_label text, to_label text, created_at timestamptz);
CREATE TABLE ca_ledger_write_failures(id bigserial PRIMARY KEY, occurred_at timestamptz, message text);
"""

GRANTS = """
REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_union_integrity_sweep(uuid, integer) TO service_role, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_attribution_drift(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_rake_attribution_drift(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_promo_bank_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_bbj_promo_bank_check() TO service_role;
REVOKE ALL ON FUNCTION public.fn_club_table_daily_catchup(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_table_daily_catchup(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_payout_rows_without_money(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_payout_rows_without_money(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_reconcile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_bbj_reconcile(uuid) TO service_role;
"""

HORSES = [uid(100 + i) for i in range(30)]
HUMANS = [uid(200 + i) for i in range(30)]


def seed_seats():
    """Co-seating fixtures: pairs above and below the 8-table threshold, every
    pair shape, plus more than 20 qualifying pairs so the limit and order bite."""
    rows = []
    tables = []
    n = 0

    def table(union):
        nonlocal n
        n += 1
        t = uid(5000 + n)
        tables.append(f"('{t}','{union}','{CLUB}',NULL)")
        return t

    def seat(t, u, age='1 hour'):
        rows.append(f"('{t}','{u}', now() - interval '{age}')")

    # Human A with human B on 9 tables, human A with horse 0 on 10, horse0+horse1 on 12 (excluded).
    for _ in range(9):
        t = table(UNION); seat(t, HUMANS[0]); seat(t, HUMANS[1])
    for _ in range(10):
        t = table(UNION); seat(t, HUMANS[0]); seat(t, HORSES[0])
    for _ in range(12):
        t = table(UNION); seat(t, HORSES[0]); seat(t, HORSES[1])
    # Below threshold: 7 tables.
    for _ in range(7):
        t = table(UNION); seat(t, HUMANS[2]); seat(t, HORSES[2])
    # Other union and outside the window do not count.
    for _ in range(9):
        t = table(OTHER_UNION); seat(t, HUMANS[3]); seat(t, HORSES[3])
    for _ in range(9):
        t = table(UNION); seat(t, HUMANS[4]); seat(t, HORSES[4], '30 hours')
    # 24 more qualifying human-horse pairs with distinct counts 8..31 so LIMIT 20 bites.
    for k in range(24):
        for _ in range(8 + k):
            t = table(UNION); seat(t, HUMANS[5 + k % 20], f'{1 + k % 5} hours'); seat(t, HORSES[5 + k], '2 hours')
    # The same human twice at one table is still one table.
    t = table(UNION); seat(t, HUMANS[0]); seat(t, HUMANS[1]); seat(t, HUMANS[1])
    return ('INSERT INTO tables VALUES ' + ','.join(tables) + ';'
            + 'INSERT INTO table_seats(table_id,user_id,joined_at) VALUES ' + ','.join(rows) + ';')


def coseat():
    return run(f"SELECT (fn_union_integrity_sweep('{UNION}', 24))->'co_seating'")


def sweep_all():
    r = json.loads(run(f"SELECT fn_union_integrity_sweep('{UNION}', 24)"))
    return r


def drift_rows():
    return run("SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.hand_id), '[]') FROM fn_rake_attribution_drift(2) d")


def payout_rows():
    return run("SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]') FROM fn_ca_payout_rows_without_money(3) x")


def promo_doc():
    return run('SELECT fn_bbj_promo_bank_check()')


def refreshed():
    return [r for r in run('SELECT string_agg(day::text, \',\' ORDER BY at) FROM refresh_log').split(',') if r]


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=32MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    for f in ('fn_rake_attribution_drift', 'fn_bbj_promo_bank_check', 'fn_club_table_daily_catchup',
              'fn_union_integrity_sweep', 'fn_ca_payout_rows_without_money'):
        run((FIX / f'{f}.live-20261022.sql').read_text() + ';')
    run(RECONCILE.read_text() + ';')
    run(GRANTS)
    for sig, m in PRE.items():
        check(f'preimage {sig}', md5_of(sig) == m, md5_of(sig))
    before_state = {sig: proc_state(sig) for sig in PRE}

    # ---------- fixtures ----------
    run(f"INSERT INTO clubs VALUES ('{UNION}', true), ('{CLUB}', false), ('{OTHER_UNION}', true);"
        f"INSERT INTO union_clubs VALUES ('{UNION}', '{CLUB}');"
        + 'INSERT INTO profiles VALUES ' + ','.join([f"('{h}', true)" for h in HORSES] + [f"('{h}', false)" for h in HUMANS]) + ';')
    run(seed_seats())
    # Drift: in-window balanced, over, under, no attributions, outside window, non-weighted.
    run("""
      INSERT INTO rake_records(hand_id, rake_amount, rake_method, player_contributions, created_at) VALUES
        ('11111111-0000-0000-0000-000000000001', 3.00, 'WEIGHTED_CONTRIBUTED', '{"a":1}', now() - interval '10 minutes'),
        ('11111111-0000-0000-0000-000000000002', 2.00, 'WEIGHTED_CONTRIBUTED', '{"a":1}', now() - interval '20 minutes'),
        ('11111111-0000-0000-0000-000000000003', 5.00, 'WEIGHTED_CONTRIBUTED', '{"a":1}', now() - interval '30 minutes'),
        ('11111111-0000-0000-0000-000000000004', 1.25, 'WEIGHTED_CONTRIBUTED', '{"a":1}', now() - interval '40 minutes'),
        ('11111111-0000-0000-0000-000000000005', 9.00, 'WEIGHTED_CONTRIBUTED', '{"a":1}', now() - interval '3 hours'),
        ('11111111-0000-0000-0000-000000000006', 4.00, 'FLAT', '{"a":1}', now() - interval '5 minutes'),
        ('11111111-0000-0000-0000-000000000007', 4.00, 'WEIGHTED_CONTRIBUTED', NULL, now() - interval '5 minutes'),
        ('11111111-0000-0000-0000-000000000008', 0.004, 'WEIGHTED_CONTRIBUTED', '{"a":1}', now() - interval '5 minutes');
      INSERT INTO rake_attributions(hand_id, weighted_rake_credit, created_at) VALUES
        ('11111111-0000-0000-0000-000000000001', 1.50, now()), ('11111111-0000-0000-0000-000000000001', 1.50, now()),
        ('11111111-0000-0000-0000-000000000002', 2.50, now()),
        ('11111111-0000-0000-0000-000000000003', 4.995, now()),
        ('11111111-0000-0000-0000-000000000005', 1.00, now());
    """)
    # Promo bank: pre-triple rows, rated rows, sweeps, union join closure.
    run("""
      INSERT INTO bbj_contributions(amount, main_portion, backup_portion, promo_portion) VALUES
        (10, NULL, NULL, NULL), (20, NULL, NULL, NULL), (100, 70, 20, 10), (50, 35, 10, 5), (7, 7, NULL, NULL);
      INSERT INTO union_wallet_transactions VALUES ('bbj_promo_sweep', 4), ('rake', 99);
      INSERT INTO chip_transactions(transaction_type, amount, metadata) VALUES
        ('bbj_promo_sweep', 3, '{}'), ('bbj_promo_sweep', 50, '{"reason":"union_join","bbj_promo":2.5}'),
        ('bbj_promo_sweep', 40, '{"reason":"union_join"}');
      INSERT INTO bbj_pools VALUES ('22222222-0000-0000-0000-000000000001', 1, 1, 6.25);
    """)

    # Payout rows: paid with money, paid without, outside the window, before the
    # idempotency table began, a source the detector does not read, zero amounts.
    run("""
      INSERT INTO tournaments(id, name) VALUES ('33333333-0000-0000-0000-000000000001', 'Freeroll'),
                                              ('33333333-0000-0000-0000-000000000002', 'PKO');
      INSERT INTO wallet_credit_idempotency VALUES ('paid-1', now() - interval '20 days'), ('paid-2', now() - interval '1 day');
      INSERT INTO tournament_payouts(tournament_id, user_id, position, source, amount, paid_at, idempotency_key) VALUES
        ('33333333-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201', 1, 'structure', 50, now() - interval '1 hour', 'paid-1'),
        ('33333333-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000202', 2, 'structure', 30, now() - interval '2 hours', 'never-credited'),
        ('33333333-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000100', 1, 'reconcile', 12, now() - interval '3 hours', NULL),
        ('33333333-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000101', 2, 'structure', 9, now() - interval '5 days', 'old'),
        ('33333333-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000102', 3, 'bounty', 9, now() - interval '1 hour', 'x'),
        ('33333333-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000103', 4, 'structure', 0, now() - interval '1 hour', 'y'),
        ('33333333-0000-0000-0000-000000000002', NULL, 5, 'structure', 3, now() - interval '1 hour', 'z'),
        ('33333333-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000104', 6, 'hu_shortfall', 4, now() - interval '30 minutes', 'paid-2');
    """)
    old = {'payout': payout_rows(), 'drift': drift_rows(), 'promo': promo_doc(), 'coseat': coseat(), 'sweep': sweep_all()}
    check('baseline-drift-finds-over-and-under-allocation', len(json.loads(old['drift'])) == 3, old['drift'])
    check('baseline-coseat-has-the-limit', len(json.loads(old['coseat'])) == 20, old['coseat'])

    # ---------- install ----------
    body = MIGRATION.read_text()
    proof = re.search(r'^-- @live-proof: (.+)$', body, re.M).group(1)
    check('live-proof-is-false-before', run('SELECT ' + proof) == 'f')
    for stmt in re.findall(r'^CREATE INDEX CONCURRENTLY IF NOT EXISTS [^;]+;', body, re.M):
        run(stmt)
    body = body[body.index('BEGIN;'):]
    run(body.replace('COMMIT;', 'ROLLBACK;'))
    check('a-rolled-back-install-leaves-every-preimage', all(md5_of(s) == m for s, m in PRE.items()))
    run(body)
    check('live-proof-is-true-after', run('SELECT ' + proof) == 't')
    after_state = {sig: proc_state(sig) for sig in PRE}
    # The drift function moves from sql to plpgsql but stays STABLE; owner,
    # security and grants are the comparison here.
    check('owners-security-grants-and-volatility-unchanged', after_state == before_state,
          {'before': before_state, 'after': after_state})
    check('reconcile-carries-only-the-plan-setting',
          run("SELECT proconfig::text FROM pg_proc WHERE oid='public.fn_bbj_reconcile(uuid)'::regprocedure")
          == '{search_path=public,plan_cache_mode=force_generic_plan}')
    expected_reconcile = RECONCILE.read_text().replace(
        " SET search_path TO 'public'\nAS $function$",
        " SET search_path TO 'public'\n SET plan_cache_mode TO 'force_generic_plan'\nAS $function$")
    check('reconcile-body-is-byte-identical',
          run("SELECT pg_get_functiondef('public.fn_bbj_reconcile(uuid)'::regprocedure)") + '\n'
          == expected_reconcile.rstrip('\n') + '\n')
    check('drift-plans-with-its-window',
          run("SELECT proconfig::text FROM pg_proc WHERE oid='public.fn_rake_attribution_drift(integer)'::regprocedure")
          == '{search_path=public,plan_cache_mode=force_custom_plan}')
    check('union-integrity-sweep-at-33-same-command',
          run("SELECT schedule || '|' || md5(command) FROM cron.job WHERE jobid = 123")
          == '33 * * * *|fad2554bd572612f594c24b809dad49c')

    new = {'payout': payout_rows(), 'drift': drift_rows(), 'promo': promo_doc(), 'coseat': coseat(), 'sweep': sweep_all()}
    check('payout-rows-same', new['payout'] == old['payout'] and len(json.loads(old['payout'])) == 2,
          {'old': old['payout'], 'new': new['payout']})
    check('payout-plans-with-its-window',
          run("SELECT proconfig::text FROM pg_proc WHERE oid='public.fn_ca_payout_rows_without_money(integer)'::regprocedure")
          == '{"search_path=public, pg_temp",plan_cache_mode=force_custom_plan}')
    check('drift-same-rows', new['drift'] == old['drift'], {'old': old['drift'], 'new': new['drift']})
    check('promo-same-document', new['promo'] == old['promo'], {'old': old['promo'], 'new': new['promo']})
    check('coseat-same-pairs-counts-order-limit', new['coseat'] == old['coseat'],
          {'old': old['coseat'], 'new': new['coseat']})
    check('sweep-every-other-signal-same',
          {k: v for k, v in new['sweep'].items() if k != 'co_seating'}
          == {k: v for k, v in old['sweep'].items() if k != 'co_seating'})
    # A horse-with-horse pair stays excluded; a human-with-human pair is found.
    pairs = {(p['player_a'], p['player_b']) for p in json.loads(new['coseat'])}
    check('horse-pair-excluded', (HORSES[0], HORSES[1]) not in pairs)
    # Without the limit, the full pair set agrees with the original form.
    run("DELETE FROM table_seats WHERE user_id = ANY (ARRAY[" + ','.join(f"'{h}'::uuid" for h in HORSES[5:]) + "])")
    small_new = coseat()
    run((FIX / 'fn_union_integrity_sweep.live-20261022.sql').read_text() + ';')
    small_old = coseat()
    check('coseat-unlimited-set-same', small_new == small_old and len(json.loads(small_new)) == 2,
          {'old': small_old, 'new': small_new})

    # ---------- catchup ----------
    today = run("SELECT (now() AT TIME ZONE 'UTC')::date")
    yday = run("SELECT (now() AT TIME ZONE 'UTC')::date - 1")
    g = uid(9001)
    run(f"""INSERT INTO ca_club_data_fact VALUES ('{CLUB}', '{yday}', 'CASH', '{g}', '{HUMANS[0]}', 1, 10, 5, -5, '{yday} 12:00Z');
            INSERT INTO rake_records(hand_id, rake_amount, created_at) VALUES (NULL, 1.5, '{yday} 12:00Z');
            INSERT INTO rake_attributions(club_id, rake_amount, created_at) VALUES ('{CLUB}', 1.5, '{yday} 12:00Z');""")
    run('TRUNCATE refresh_log, rebuild_log')
    r1 = json.loads(run('SELECT fn_club_table_daily_catchup(2)'))
    check('first-run-rebuilds-yesterday', refreshed() == [yday], refreshed())
    check('ledger-check-still-runs', run('SELECT count(*) FROM rebuild_log') == '1', r1)
    run('TRUNCATE refresh_log')
    run('SELECT fn_club_table_daily_catchup(2)')
    check('unchanged-day-not-rebuilt-again', refreshed() == [], refreshed())
    for label, sql in [
        ('a-fact', f"UPDATE ca_club_data_fact SET fee = fee + 1, last_at = '{yday} 13:00Z'"),
        ('a-raked-hand', f"INSERT INTO rake_records(hand_id, rake_amount, created_at) VALUES (NULL, 0.5, '{yday} 14:00Z')"),
        ('an-attribution', f"INSERT INTO rake_attributions(club_id, rake_amount, created_at) VALUES ('{CLUB}', 0.25, '{yday} 15:00Z')"),
    ]:
        run('TRUNCATE refresh_log'); run(sql)
        run('SELECT fn_club_table_daily_catchup(2)')
        check(f'{label}-moving-rebuilds-the-day', refreshed() == [yday], refreshed())
    # Twelve hours after the day closed, it is rebuilt once more, then left alone.
    run("UPDATE club_table_daily_refresh_marks SET refreshed_at = refreshed_at - interval '2 days'")
    run('TRUNCATE refresh_log')
    run(f"SELECT fn_club_table_daily_catchup(2) WHERE now() >= ('{yday}'::date + 1)::timestamp AT TIME ZONE 'UTC' + interval '12 hours'")
    late = run(f"SELECT now() >= ('{yday}'::date + 1)::timestamp AT TIME ZONE 'UTC' + interval '12 hours'") == 't'
    if late:
        check('rebuilt-once-after-the-day-settles', refreshed() == [yday], refreshed())
        run('TRUNCATE refresh_log'); run('SELECT fn_club_table_daily_catchup(2)')
        check('then-left-alone', refreshed() == [], refreshed())
    else:
        run('SELECT fn_club_table_daily_catchup(2)')
        check('before-twelve-hours-an-unchanged-day-is-left-alone', refreshed() == [], refreshed())
    # Today is still handed to the refresh (which skips it), never marked.
    check('today-never-marked', run(f"SELECT count(*) FROM club_table_daily_refresh_marks WHERE stat_date = '{today}'") == '0')
    check('marks-table-has-rls', run("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.club_table_daily_refresh_marks'::regclass") == 't')

    # ---------- re-install refused ----------
    try:
        run(body)
        check('reinstall-is-refused', False, 'second install succeeded')
    except RuntimeError as e:
        check('reinstall-is-refused', 'already exists' in str(e) or 'is not the pinned text' in str(e), str(e)[:200])
    results['passed'] = True
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps(results, indent=2))
