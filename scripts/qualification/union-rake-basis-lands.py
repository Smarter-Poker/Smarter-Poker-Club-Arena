#!/usr/bin/env python3
"""The open-week rake basis lands, or says so once: proved on an isolated PostgreSQL 17 cluster, before
and after 20261020010133_the_open_week_rake_basis_lands_or_says_so.

    su pgtest -c 'python3 scripts/qualification/union-rake-basis-lands.py \
        --work <short empty dir> --pg-bin /usr/lib/postgresql/17/bin [--out result.json]'

It builds its OWN cluster (unix socket in a private directory, no TCP listener, autovacuum off so the
statistics stay as stale as production's are for the newest window), loads the accounting fixture
scripts/ci/fixtures/launch-reset/accounting/floor-admission-qualification.sql and production's three
open-week bodies from union-rake-basis-lands-live.sql, and refuses to measure unless all six functions
the path runs are production's text (md5s in PRODUCTION below, read on 2026-10-20).

Harness, and nothing else: the week the sweep reads is a fixed past week (fn_union_week_start reads
harness_clock), so a run does not depend on the wall clock; the six money controls the sweep calls
first are stubs, one of which can sleep to spend the statement's budget exactly as the real ones do;
fn_ca_break_window_refuses_migrations answers NULL. Production's range indexes for the window's
tables are created. The data is real-shaped: every hand has its bank row, rake record, accrual batch,
bank receipt and four sources (three agreement sources, one union-house source) that pass all six
proofs of the earned plan.

Scenarios, each in a 'before' database (production's bodies) and an 'after' database (the migration
file executed whole over the same state):
  timeout - the statement timeout fires inside the first union's refresh. BEFORE: the loop ends and the
            next union is never told. AFTER: every union holds one out_of_time warning, closed by a landing.
  budget  - the money controls spend the 120 s budget. BEFORE: the refresh answers in_progress having
            proved nothing, the sweep counts it as skipped and raises nothing, hour after hour.
            AFTER: each hour proves a window and holds ONE open not_landed warning; it lands and closes.
  answers - the refresh answers success = false (no accrual cursor), then raises (a refused insert).
            BEFORE: silent, then one new 'failed' row per hour, never closed by a landing.
            AFTER: one warning per kind, repeats counted, all closed by the landing.
  order   - PR #7090's held migration installed first: this one still lands on the same postimages and
            reuses the windows saved under PR #7090's stamp.
  churn   - a club outside the union is created (a release certification does this). BEFORE: every
            window is proved again. AFTER: none is, including windows saved under the old stamp; a
            union club joining the union still re-proves them all. The basis is identical.
  plan    - a 5,000-hand window read under statistics from before it existed. BEFORE: nested loops
            rescan the CTEs; AFTER: hash joins. Every window's output (value, ids, md5s) is identical,
            and tour_keys returns identical rows over recognitions inside and outside the window.
"""
import argparse, hashlib, json, os, pathlib, re, subprocess, threading, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURE = ROOT / 'scripts/ci/fixtures/launch-reset/accounting/floor-admission-qualification.sql'
LIVE = HERE / 'union-rake-basis-lands-live.sql'
MIGRATION = ROOT / 'supabase/migrations/20261020010133_the_open_week_rake_basis_lands_or_says_so.sql'
# PR #7090's held migration (20261016104931), verbatim: the same windowed preimage, its digest only.
PR7090 = HERE / 'union-rake-basis-lands-pr7090.sql'

PRODUCTION = {
    'fn_accounting_union_earned_plan_window': '102e5be492a144a705a2882d91675069',
    'fn_union_rake_basis_windowed': '2c2bbb252ef5d119bc6e9813bcc9354b',
    'fn_union_rake_basis_refresh': '9fdc0af3d23759ab843ce122ecaefb03',
    'fn_union_integrity_sweep_all': '12861fc647dd2b033ecc875f7b5fa3f7',
    'fn_accounting_close_windows': '349f940293dfe6175faae2787840ede1',
    'fn_accounting_clubs_scope_digest': 'a03f99fbe26eb65d7f7b8e6b1730bca0',
}
AFTER = {
    'fn_accounting_union_earned_plan_window': 'e51d7009c49519a43ffc23c223c2d7ef',
    'fn_union_rake_basis_windowed': '4d70fdc60dd94d338d4437443716844f',
    'fn_union_rake_basis_refresh': '9fdc0af3d23759ab843ce122ecaefb03',
    'fn_union_integrity_sweep_all': 'bda41da129572e2b09fadb10090d9dad',
    'fn_accounting_close_windows': '349f940293dfe6175faae2787840ede1',
    'fn_accounting_clubs_scope_digest': 'a03f99fbe26eb65d7f7b8e6b1730bca0',
}
U = 'a0a0a0a0-0000-4000-8000-000000000001'   # the union (and its union club)
C = 'c1c1c1c1-0000-4000-8000-000000000001'   # a member club of the union
U2 = 'a0a0a0a0-0000-4000-8000-000000000002'  # a second union, tournament recognitions only
WEEK = '2026-10-12 07:00:00+00'
CURSOR = "timestamptz '%s' + interval '10 hours 30 minutes'" % WEEK  # 5 closed windows + a 30 min tail

HARNESS = r"""
CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
CREATE TABLE public.harness_clock (week_start timestamptz NOT NULL);
INSERT INTO public.harness_clock VALUES ('%(week)s');
CREATE OR REPLACE FUNCTION public.fn_union_week_start(p_at timestamptz DEFAULT now()) RETURNS timestamptz
  LANGUAGE sql STABLE AS $$ SELECT week_start FROM public.harness_clock $$;
CREATE TABLE public.harness_money (sleep_s float8 NOT NULL);
INSERT INTO public.harness_money VALUES (0);
CREATE FUNCTION public.fn_union_integrity_sweep(p_union_id uuid, p_hours integer) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_sleep((SELECT sleep_s FROM public.harness_money)); RETURN jsonb_build_object('signals', 0); END $$;
CREATE FUNCTION public.fn_union_age_invoices(p_union_id uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION public.fn_union_enforce_stop_loss(p_union_id uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.expire_settlement_locks() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION public.fn_settlement_lock_hygiene() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION public.fn_close_due_settlement_periods() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
-- production's range indexes for the tables the window reads
CREATE INDEX idx_uwt_rake_credit_basis ON public.union_wallet_transactions USING btree (union_id, created_at)
  WHERE ((wallet = 'rake_wallet'::text) AND (direction = 'credit'::text) AND (tx_type = 'rake'::text));
CREATE INDEX accounting_cash_bank_receipts_union_period ON public.accounting_cash_bank_receipts USING btree (union_id, banked_at);
CREATE INDEX accounting_cash_accrual_batches_earned_record ON public.accounting_cash_accrual_batches USING btree (earned_at, rake_record_id);
CREATE INDEX accounting_cash_rake_sources_bank_period ON public.accounting_cash_rake_sources USING btree (union_id, earned_at) WHERE (union_id IS NOT NULL);
CREATE INDEX rake_records_cash_positive_created ON public.rake_records USING btree (created_at, id)
  WHERE ((rake_amount > (0)::numeric) AND (is_tournament IS NOT TRUE) AND (tournament_id IS NULL));
CREATE INDEX accounting_tournament_fee_recognitions_week ON public.accounting_tournament_fee_recognitions USING btree (recognized_at) INCLUDE (tournament_id);
CREATE INDEX accounting_tournament_recognized_sources_week ON public.accounting_tournament_recognized_sources USING btree (recognized_at, tournament_id);

INSERT INTO public.unions (id, name, owner_id, slug) VALUES
  ('%(u)s', 'Harness Union', gen_random_uuid(), 'harness-union'),
  ('%(u2)s', 'Harness Union Two', gen_random_uuid(), 'harness-union-two');
INSERT INTO public.clubs (id, name, is_union, union_id) VALUES
  ('%(u)s', 'Harness Union Club', true, '%(u)s'), ('%(c)s', 'Harness Member Club', false, '%(u)s');
INSERT INTO public.accounting_cash_accrual_cutover (singleton, starts_at) VALUES (true, '2026-09-01 00:00:00+00');
INSERT INTO public.daemon_state (daemon, high_water_mark) VALUES ('rakeback_settler', %(cursor)s);
INSERT INTO public.accounting_agreement_history (id, entity_type, entity_key, club_id, event_type, observed_at, after_terms)
OVERRIDING SYSTEM VALUE VALUES (1, 'union_clubs', 'harness-agreement', '%(c)s', 'baseline', '2026-10-01 00:00:00+00',
        jsonb_build_object('id', 'harness-agreement', 'club_id', '%(c)s', 'union_id', '%(u)s', 'rate_cash', '0.3'));

-- n hands in [p_from, p_to): each with its bank row, rake record, accrual batch, bank receipt and four
-- sources (three under the union agreement, one union-house) that pass every proof of the earned plan.
CREATE FUNCTION public.harness_seed(p_from timestamptz, p_to timestamptz, p_hands int, p_tag text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE terms jsonb := (SELECT after_terms FROM public.accounting_agreement_history WHERE id = 1);
BEGIN
  CREATE TEMP TABLE hh ON COMMIT DROP AS
    SELECT i, p_from + (p_to - p_from) * (i::float8 / p_hands) AS t,
           md5(p_tag || i || 'r')::uuid AS r, md5(p_tag || i || 'x')::uuid AS x, md5(p_tag || i || 'h')::uuid AS hand
      FROM generate_series(0, p_hands - 1) i;
  INSERT INTO public.union_wallet_transactions (id, union_id, wallet, direction, amount, tx_type, club_id, created_at)
    SELECT x, '%(u)s', 'rake_wallet', 'credit', 1.10, 'rake', '%(c)s', t FROM hh;
  INSERT INTO public.rake_records (id, club_id, rake_amount, created_at, is_tournament) SELECT r, '%(c)s', 1.10, t, false FROM hh;
  INSERT INTO public.accounting_cash_accrual_batches (rake_record_id, hand_id, earned_at, source_fingerprint, status, plan)
    SELECT r, hand, t, 'h', 'accrued', '{}'::jsonb FROM hh;
  INSERT INTO public.accounting_cash_bank_receipts (rake_record_id, union_id, club_id, union_transaction_id, banked_at, amount)
    SELECT r, '%(u)s', '%(c)s', x, t, 1.10 FROM hh;
  INSERT INTO public.accounting_cash_rake_sources (rake_record_id, player_id, club_id, union_id, coordinator_union_id, earned_at, rake_credit, contract)
    SELECT hh.r, p.player, p.club, '%(u)s', '%(u)s', hh.t, p.credit,
           jsonb_build_object('club_id', p.club, 'player_id', p.player, 'union_id', '%(u)s', 'rake_credit', p.credit,
             'terms_at', hh.t, 'is_union_house', p.house,
             'union_agreement', CASE WHEN p.house THEN 'null'::jsonb
               ELSE jsonb_build_object('history_id', 1, 'observed_at', timestamptz '2026-10-01 00:00:00+00', 'terms', terms) END)
      FROM hh CROSS JOIN LATERAL (VALUES
        (md5(p_tag || hh.i || 'p1')::uuid, '%(c)s'::uuid, 0.50, false),
        (md5(p_tag || hh.i || 'p2')::uuid, '%(c)s'::uuid, 0.25, false),
        (md5(p_tag || hh.i || 'p3')::uuid, '%(c)s'::uuid, 0.25, false),
        (md5(p_tag || hh.i || 'p4')::uuid, '%(u)s'::uuid, 0.10, true)) p(player, club, credit, house);
  RETURN p_hands;
END $$;
""" % {'week': WEEK, 'u': U, 'u2': U2, 'c': C, 'cursor': CURSOR}

# Tournament recognitions of the second union, for tour_keys: matching, recognized three hours after
# its sources (outside their window), cancelled, refunded. The first union has none of them.
TOURNAMENTS = r"""
INSERT INTO public.accounting_tournament_fee_recognitions (tournament_id, recognized_at, status, net_rake, union_id, bank_club_id,
  union_wallet_transaction_id, source_fingerprint, plan)
SELECT md5('t' || i)::uuid, timestamptz '%(week)s' + (i * interval '37 minutes') + CASE WHEN i %% 7 = 3 THEN interval '3 hours' ELSE interval '0' END,
       CASE WHEN i %% 11 = 5 THEN 'cancelled' ELSE 'recognized' END, 2.00,
       '%(u2)s'::uuid, '%(c)s', md5('tx' || i)::uuid, 'h', '{}'::jsonb
  FROM generate_series(0, 15) i;
INSERT INTO public.accounting_tournament_recognized_sources (source_id, tournament_id, recognized_at, disposition, rake_credit)
SELECT md5('s' || i || '-' || k)::uuid, md5('t' || i)::uuid, timestamptz '%(week)s' + (i * interval '37 minutes'),
       CASE WHEN k = 2 AND i %% 5 = 1 THEN 'refunded' ELSE 'earned' END, 1.00
  FROM generate_series(0, 15) i CROSS JOIN generate_series(1, 2) k;
""" % {'week': WEEK, 'u': U, 'u2': U2, 'c': C}


class Cluster:
    def __init__(self, work, pg_bin, port):
        self.work, self.bin, self.port = work, pathlib.Path(pg_bin), port
        self.sock = work / 's'
        self.data = work / 'd'

    def run(self, cmd, timeout=900):
        r = subprocess.run([str(x) for x in cmd], text=True, capture_output=True, timeout=timeout,
                           env=dict(os.environ, PGHOST=str(self.sock), PGPORT=self.port, PGUSER='postgres'))
        if r.returncode:
            raise RuntimeError(r.stderr + r.stdout)
        return r.stdout

    def start(self):
        self.sock.mkdir(mode=0o700)
        self.run([self.bin / 'initdb', '-D', self.data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale'])
        with (self.data / 'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses=''\nunix_socket_directories='%s'\nport=%s\nautovacuum=off\nshared_buffers=256MB\n"
                    "work_mem=16MB\nmax_parallel_workers_per_gather=0\n" % (self.sock, self.port))
        self.run([self.bin / 'pg_ctl', '-D', self.data, '-l', self.work / 'server.log', '-w', 'start'])

    def stop(self):
        self.run([self.bin / 'pg_ctl', '-D', self.data, '-m', 'fast', '-w', 'stop'])

    def q(self, db, sql):
        return self.run([self.bin / 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]).strip()

    def f(self, db, path):
        return self.run([self.bin / 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', str(path)])

    def copy(self, src, dst):
        self.q('postgres', 'CREATE DATABASE %s TEMPLATE %s' % (dst, src))


def md5s(cl, db):
    return dict(line.split('|') for line in cl.q(db,
        "SELECT p.proname, md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = 'public' AND p.proname IN (%s)" % ','.join("'%s'" % k for k in PRODUCTION)).splitlines())


def sweep(cl, db):
    out = json.loads(cl.q(db, "SELECT public.fn_union_integrity_sweep_all()"))
    return out['rake_basis']


def state(cl, db):
    """What a reader of the snapshot and of financial_alerts can see for the union."""
    return json.loads(cl.q(db, """
      SELECT jsonb_build_object(
        'snapshot_through', (SELECT to_char(s.through AT TIME ZONE 'UTC', 'HH24:MI') FROM public.union_rake_basis_snapshot s
                              WHERE s.union_id = '%(u)s'),
        'windows_saved', (SELECT count(*) FROM public.union_rake_basis_windows w WHERE w.union_id = '%(u)s'),
        'open_alerts', (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', COALESCE(a.context->>'kind', 'failed'),
                             'reason', a.context->>'reason', 'repeats', (a.context->>'repeats')::int) ORDER BY a.created_at), '[]')
                          FROM public.financial_alerts a WHERE a.source = 'fn_union_rake_basis_refresh' AND NOT a.resolved
                           AND a.context->>'union_id' = '%(u)s'),
        'resolved_alerts', (SELECT count(*) FROM public.financial_alerts a WHERE a.source = 'fn_union_rake_basis_refresh'
                             AND a.resolved AND a.context->>'union_id' = '%(u)s'))""" % {'u': U}))


def windowed(cl, db):
    out = json.loads(cl.q(db, "SELECT public.fn_union_rake_basis_windowed('%s', '%s', %s)" % (U, WEEK, CURSOR)))
    return {k: out.get(k) for k in ('status', 'windows', 'reused', 'computed')}, out.get('basis_detail')


def snapshot_detail(cl, db):
    return cl.q(db, "SELECT detail::text FROM public.union_rake_basis_snapshot WHERE union_id = '%s'" % U)


def scenario_budget(cl, db, out):
    """The money controls spend the statement's 120 s budget before the refresh starts."""
    r = {}
    cl.q(db, 'UPDATE public.harness_money SET sleep_s = 121')
    for n in (1, 2):
        r['hour_%d_budget_spent' % n] = {'sweep': sweep(cl, db), **state(cl, db)}
    cl.q(db, 'UPDATE public.harness_money SET sleep_s = 0')
    r['hour_3_budget_free'] = {'sweep': sweep(cl, db), **state(cl, db)}
    out[db] = r


def scenario_answers(cl, db):
    r = {}
    cl.q(db, "DELETE FROM public.daemon_state WHERE daemon = 'rakeback_settler'")
    for n in (1, 2):
        r['hour_%d_no_accrual_cursor' % n] = {'sweep': sweep(cl, db), **state(cl, db)}
    cl.q(db, "INSERT INTO public.daemon_state (daemon, high_water_mark) VALUES ('rakeback_settler', %s)" % CURSOR)
    # A refresh that raises: the snapshot refuses the row (a stand-in for any error inside the refresh).
    cl.q(db, 'ALTER TABLE public.union_rake_basis_snapshot ADD CONSTRAINT harness_refuses CHECK (false) NOT VALID')
    for n in (3, 4):
        r['hour_%d_refresh_raises' % n] = {'sweep': sweep(cl, db), **state(cl, db)}
    cl.q(db, 'ALTER TABLE public.union_rake_basis_snapshot DROP CONSTRAINT harness_refuses')
    r['hour_5_lands'] = {'sweep': sweep(cl, db), **state(cl, db)}
    return r


def alerts_of(cl, db, union):
    return json.loads(cl.q(db, """
      SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', COALESCE(a.context->>'kind', 'failed'),
               'not_attempted', COALESCE((a.context->>'not_attempted')::boolean, false),
               'repeats', (a.context->>'repeats')::int) ORDER BY a.created_at), '[]')
        FROM public.financial_alerts a WHERE a.source = 'fn_union_rake_basis_refresh' AND NOT a.resolved
         AND a.context->>'union_id' = '%s'""" % union))


def scenario_timeout(cl, db):
    """The statement timeout fires inside the first union's refresh (a saved window that stalls)."""
    cl.q(db, "CREATE FUNCTION public.harness_stall() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$;"
             "CREATE TRIGGER harness_stall BEFORE INSERT ON public.union_rake_basis_windows FOR EACH ROW EXECUTE FUNCTION public.harness_stall()")
    r = {}
    for n in (1, 2):
        out = json.loads(cl.q(db, "SET statement_timeout = '1500ms'; SELECT public.fn_union_integrity_sweep_all()").splitlines()[-1])
        r['hour_%d_timed_out' % n] = {'sweep': out['rake_basis'], 'union': alerts_of(cl, db, U), 'second_union': alerts_of(cl, db, U2)}
    cl.q(db, 'DROP TRIGGER harness_stall ON public.union_rake_basis_windows')
    out = sweep(cl, db)
    r['hour_3_lands'] = {'sweep': out, 'union': alerts_of(cl, db, U), 'second_union': alerts_of(cl, db, U2)}
    return r


def scenario_order(cl, db):
    """PR #7090 installed first: this migration still lands on its postimages and reuses its windows."""
    cl.f(db, PR7090)
    r = {'pr7090_windowed_md5': md5s(cl, db)['fn_union_rake_basis_windowed']}
    r['hour_1_lands_under_pr7090'] = {'sweep': sweep(cl, db), **state(cl, db)}
    cl.f(db, MIGRATION)
    r['md5_after_migration'] = md5s(cl, db) == AFTER
    r['windows_saved_under_pr7090'], _ = windowed(cl, db)
    return r


def scenario_churn(cl, db, migrate):
    r = {'hour_1_lands': {'sweep': sweep(cl, db), **state(cl, db)}}
    if migrate:
        cl.f(db, MIGRATION)
        r['md5_after_migration'] = md5s(cl, db) == AFTER
        r['windows_saved_under_the_old_stamp'], _ = windowed(cl, db)
    cl.q(db, "INSERT INTO public.clubs (id, name) VALUES ('c2c2c2c2-0000-4000-8000-000000000002', 'Crest Cert Template harness')")
    r['club_outside_the_union_created'], basis_outside = windowed(cl, db)
    r['basis_unchanged'] = None
    if migrate:
        cl.q(db, "INSERT INTO public.clubs (id, name, is_union, union_id) VALUES "
                 "('c3c3c3c3-0000-4000-8000-000000000003', 'Harness Second Union Club', true, '%s')" % U)
        r['union_club_joins_the_union'], basis_joined = windowed(cl, db)
        r['basis_unchanged'] = basis_outside == basis_joined
    r['basis'] = basis_outside
    return r


def window_rows(cl, db, windows):
    """Every window's full output (value, ids, md5s) and the time the function took."""
    rows = {}
    for ws in windows:
        t0 = time.monotonic()
        got = cl.q(db, "SELECT COALESCE(md5(string_agg(f::text, '|')), 'no row'), count(*) "
                       "FROM public.fn_accounting_union_earned_plan_window('%s', '%s', timestamptz '%s' + interval '2 hours') f"
                       % (U, ws, ws))
        rows[ws] = {'output_md5': got.split('|')[0], 'rows': int(got.split('|')[1]), 'seconds': round(time.monotonic() - t0, 2)}
    return rows


EXPLAIN = r"""
DO $p$
DECLARE d text; q text; l text; acc text := ''; cfg text;
BEGIN
  d := pg_get_functiondef('public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure);
  FOREACH cfg IN ARRAY (SELECT proconfig FROM pg_proc WHERE oid = 'public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure) LOOP
    PERFORM set_config(split_part(cfg, '=', 1), split_part(cfg, '=', 2), true);
  END LOOP;
  q := split_part(d, '$q$', 2);
  FOR l IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ' || q USING '%(u)s'::uuid, timestamptz '%(ws)s', timestamptz '%(ws)s' + interval '2 hours' LOOP
    acc := acc || l || E'\n';
  END LOOP;
  RAISE NOTICE '%%', acc;
END $p$;
"""


def cte_rescans(cl, db, ws):
    """Plan nodes that scan a materialized CTE more than once (the nested-loop rescans)."""
    r = subprocess.run([str(cl.bin / 'psql'), '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', EXPLAIN % {'u': U, 'ws': ws}],
                       text=True, capture_output=True, env=dict(os.environ, PGHOST=str(cl.sock), PGPORT=cl.port, PGUSER='postgres'))
    if r.returncode:
        raise RuntimeError(r.stderr)
    plan = r.stderr
    rescans = re.findall(r'CTE Scan on (\w+)[^\n]*\(actual rows=\d+ loops=(\d+)\)', plan)
    return sorted({'%s x%s' % (name, loops) for name, loops in rescans if int(loops) > 1}), 'Nested Loop' in plan


def tour_keys(cl, db, body_db):
    """tour_keys of the installed window body, run alone, for both unions and every window of the week."""
    d = cl.q(body_db, "SELECT pg_get_functiondef('public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure)")
    cte = d[d.index('tour_keys AS MATERIALIZED (') + len('tour_keys AS MATERIALIZED ('):d.index('), raw AS (')]
    out = {}
    for union in (U, U2):
        for i in range(0, 7):
            ws = "timestamptz '%s' + interval '%d hours'" % (WEEK, 2 * i)
            sql = ("PREPARE tk(uuid, timestamptz, timestamptz) AS SELECT COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), 'none'), count(*) "
                   "FROM (%s) x; EXECUTE tk('%s', %s, %s + interval '2 hours');" % (cte, union, ws, ws))
            out['%s@%d' % (union[-1], 2 * i)] = cl.q(db, sql).splitlines()[-1]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
    ap.add_argument('--port', default='55617')
    ap.add_argument('--out')
    a = ap.parse_args()
    work = pathlib.Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    if any(work.iterdir()):
        raise SystemExit('REFUSED: --work must be empty')
    cl = Cluster(work, a.pg_bin, a.port)
    cl.start()
    report = {'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    try:
        report['postgres'] = cl.q('postgres', 'SELECT version()')
        cl.q('postgres', 'CREATE DATABASE base')
        cl.f('base', FIXTURE)
        cl.f('base', LIVE)
        got = md5s(cl, 'base')
        if got != PRODUCTION:
            raise SystemExit("REFUSED: the loaded bodies are not production's: %s" % got)
        report['production_md5_verified'] = got
        hf = work / 'harness.sql'
        hf.write_text(HARNESS)
        cl.f('base', hf)
        cl.q('base', "SELECT public.harness_seed(timestamptz '%s', %s, 300, 'w')" % (WEEK, CURSOR))

        # budget (slow: two hours of a 121 s money-control stub, run side by side)
        for db in ('budget_before', 'budget_after', 'answers_before', 'answers_after', 'churn_before', 'churn_after',
                   'timeout_before', 'timeout_after', 'order_after'):
            cl.copy('base', db)
        for db in ('budget_after', 'answers_after', 'timeout_after'):
            cl.f(db, MIGRATION)
            if md5s(cl, db) != AFTER:
                raise SystemExit('REFUSED: the migration did not land on its postimages in %s' % db)
        budget = {}
        threads = [threading.Thread(target=scenario_budget, args=(cl, db, budget)) for db in ('budget_before', 'budget_after')]
        for t in threads:
            t.start()
        report['answers'] = {'before': scenario_answers(cl, 'answers_before'), 'after': scenario_answers(cl, 'answers_after')}
        report['timeout'] = {'before': scenario_timeout(cl, 'timeout_before'), 'after': scenario_timeout(cl, 'timeout_after')}
        report['order'] = scenario_order(cl, 'order_after')
        report['churn'] = {'before': scenario_churn(cl, 'churn_before', False), 'after': scenario_churn(cl, 'churn_after', True)}

        # plan: four small windows, ANALYZE, then a 5,000-hand window the statistics have never seen.
        cl.q('postgres', 'CREATE DATABASE plan_base TEMPLATE base')
        cl.q('plan_base', "TRUNCATE public.union_wallet_transactions, public.rake_records, public.accounting_cash_accrual_batches, "
                          "public.accounting_cash_bank_receipts, public.accounting_cash_rake_sources")
        tf = work / 'tournaments.sql'
        tf.write_text(TOURNAMENTS)
        cl.f('plan_base', tf)
        cl.q('plan_base', "SELECT public.harness_seed(timestamptz '%s', timestamptz '%s' + interval '8 hours', 200, 'old')" % (WEEK, WEEK))
        cl.q('plan_base', 'ANALYZE')
        cl.q('plan_base', "SELECT public.harness_seed(timestamptz '%s' + interval '8 hours', timestamptz '%s' + interval '10 hours', 5000, 'new')"
             % (WEEK, WEEK))
        cl.copy('plan_base', 'plan_before')
        cl.copy('plan_base', 'plan_after')
        cl.f('plan_after', MIGRATION)
        windows = [cl.q('postgres', "SELECT to_char((timestamptz '%s' + interval '%d hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS+00')"
                        % (WEEK, h)) for h in (0, 2, 4, 6, 8)]
        big = windows[-1]
        plan = {}
        for db in ('plan_before', 'plan_after'):
            rescans, nested = cte_rescans(cl, db, big)
            plan[db] = {'cte_rescans_in_the_new_window': rescans, 'nested_loop_in_plan': nested,
                        'windows': window_rows(cl, db, windows), 'tour_keys': tour_keys(cl, db, db)}
        report['plan'] = plan
        for t in threads:
            t.join()
        report['budget'] = budget
    finally:
        cl.stop()

    b, f = report['budget']['budget_before'], report['budget']['budget_after']
    ab, af = report['answers']['before'], report['answers']['after']
    cb, cf = report['churn']['before'], report['churn']['after']
    pb, pa = report['plan']['plan_before'], report['plan']['plan_after']
    tb, ta = report['timeout']['before'], report['timeout']['after']
    ot = lambda n, na: [{'kind': 'out_of_time', 'not_attempted': na, 'repeats': n}]
    checks = {
        # BEFORE: two hours with the budget spent prove nothing, write nothing and raise nothing.
        'before_budget_silent': all(b[h]['windows_saved'] == 0 and b[h]['open_alerts'] == [] and b[h]['snapshot_through'] is None
                                    and b[h]['sweep']['refreshed'] == 0 and b[h]['sweep']['failed'] == 0 for h in ('hour_1_budget_spent', 'hour_2_budget_spent')),
        # AFTER: each such hour proves a window and holds exactly one open warning; then it lands and closes it.
        'after_budget_progress_and_one_alert': (
            f['hour_1_budget_spent']['windows_saved'] == 1 and f['hour_2_budget_spent']['windows_saved'] == 2
            and f['hour_1_budget_spent']['open_alerts'] == [{'kind': 'not_landed', 'reason': 'windows_in_progress', 'repeats': 0}]
            and f['hour_2_budget_spent']['open_alerts'] == [{'kind': 'not_landed', 'reason': 'windows_in_progress', 'repeats': 1}]
            and f['hour_3_budget_free']['snapshot_through'] == '17:30' and f['hour_3_budget_free']['open_alerts'] == []
            and f['hour_3_budget_free']['resolved_alerts'] == 1),
        'before_answers_silent_then_duplicated': (
            ab['hour_2_no_accrual_cursor']['open_alerts'] == [] and ab['hour_2_no_accrual_cursor']['snapshot_through'] is None
            and len(ab['hour_4_refresh_raises']['open_alerts']) == 2
            and len(ab['hour_5_lands']['open_alerts']) == 2 and ab['hour_5_lands']['snapshot_through'] == '17:30'),
        'after_answers_one_alert_each_closed_on_landing': (
            af['hour_1_no_accrual_cursor']['open_alerts'] == [{'kind': 'not_landed', 'reason': 'accrual_cursor_unknown', 'repeats': 0}]
            and af['hour_2_no_accrual_cursor']['open_alerts'] == [{'kind': 'not_landed', 'reason': 'accrual_cursor_unknown', 'repeats': 1}]
            and [x['kind'] for x in af['hour_4_refresh_raises']['open_alerts']] == ['not_landed', 'failed']
            and af['hour_4_refresh_raises']['open_alerts'][1]['repeats'] == 1
            and af['hour_5_lands']['open_alerts'] == [] and af['hour_5_lands']['resolved_alerts'] == 2
            and af['hour_5_lands']['snapshot_through'] == '17:30'),
        # BEFORE: the timeout ends the loop and the union after it is never told.
        'before_timeout_leaves_a_union_untold': (
            tb['hour_2_timed_out']['sweep']['out_of_time'] is True
            and len(tb['hour_2_timed_out']['union']) == 1 and tb['hour_2_timed_out']['second_union'] == []),
        # AFTER: both unions hold one out_of_time warning (the second as not attempted); a landing closes both.
        'after_timeout_tells_every_union_once': (
            ta['hour_1_timed_out']['union'] == ot(0, False) and ta['hour_1_timed_out']['second_union'] == ot(0, True)
            and ta['hour_2_timed_out']['union'] == ot(1, False) and ta['hour_2_timed_out']['second_union'] == ot(1, True)
            and ta['hour_3_lands']['union'] == [] and ta['hour_3_lands']['second_union'] == []),
        'either_install_order_with_pr7090': (
            report['order']['pr7090_windowed_md5'] == 'a68ecf97f457970970e97518d378e70c'
            and report['order']['hour_1_lands_under_pr7090']['snapshot_through'] == '17:30'
            and report['order']['md5_after_migration'] is True
            and report['order']['windows_saved_under_pr7090'] == {'status': 'ready', 'windows': 6, 'reused': 5, 'computed': 1}),
        'before_churn_reproves_every_window': cb['club_outside_the_union_created'] == {'status': 'ready', 'windows': 6, 'reused': 0, 'computed': 6},
        'after_churn_reproves_none': (
            cf['md5_after_migration'] is True
            and cf['windows_saved_under_the_old_stamp'] == {'status': 'ready', 'windows': 6, 'reused': 5, 'computed': 1}
            and cf['club_outside_the_union_created'] == {'status': 'ready', 'windows': 6, 'reused': 5, 'computed': 1}
            and cf['union_club_joins_the_union'] == {'status': 'ready', 'windows': 6, 'reused': 0, 'computed': 6}
            and cf['basis_unchanged'] is True and cf['basis'] == cb['basis']
            and cb['hour_1_lands']['snapshot_through'] == cf['hour_1_lands']['snapshot_through'] == '17:30'),
        'plan_before_rescans_ctes': bool(pb['cte_rescans_in_the_new_window']),
        'plan_after_no_rescans': pa['cte_rescans_in_the_new_window'] == [],
        'plan_same_output_every_window': all(pb['windows'][w]['output_md5'] == pa['windows'][w]['output_md5']
                                             and pb['windows'][w]['rows'] == pa['windows'][w]['rows'] == 1 for w in pb['windows']),
        'tour_keys_same_rows': pb['tour_keys'] == pa['tour_keys'] and any(not v.startswith('none') for v in pa['tour_keys'].values()),
        'plan_new_window_faster': pa['windows'][big]['seconds'] * 3 < pb['windows'][big]['seconds'],
    }
    report['checks'] = checks
    report['passed'] = all(checks.values())
    report['finished'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    report['migration_sha256'] = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
    print(json.dumps(report, indent=2))
    print('OPEN-WEEK RAKE BASIS: %s' % ('lands or says so once' if report['passed'] else 'NOT AS CLAIMED'))
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(report, indent=2) + '\n')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
