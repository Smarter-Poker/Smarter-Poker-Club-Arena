-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4.2 - THE JACKPOT HAS AN OPENING BALANCE IT CAN PROVE
-- (chip standard, 2026-09-04). Read from production 20:40-21:20 UTC.
--
-- What was true. The BBJ was the one pot with no opening balance: its
-- conservation check (fn_bbj_conservation_check) compared LIFETIME inflow,
-- outflow and balances and read a gap of 73,367.70 against a baseline of
-- 2,572.59 measured on 2026-08-25 - unhealthy every hour since 2026-08-31,
-- and, being lifetime, unable to say whether a chip went missing today or in
-- March. The previous investigation (bbj_conservation_baseline.note, kept
-- untouched here as evidence) established that 41,096.65 of the gap is
-- 49,714 contribution rows from 2026-03-03..07 whose bucket portions are
-- short of their amount - phantom inflow, no chips ever missing - and left
-- ~32k on the payout side unexplained: total_paid_out on the pool rows
-- exceeds the bbj_payouts rows, from before the payout table was kept. Since
-- journalling began on 2026-08-31 the union pool's identity has held to the
-- cent and the club pool's to 0.50.
--
-- What this does, the same way the supply meter and the Mint register were
-- given theirs: an OPENING BALANCE per bank per pool, taken now, labelled as
-- a baseline and not as a movement, with the lifetime gap and its
-- decomposition written into the baseline row so the history is carried,
-- not erased. From this instant the identity is the journal's: for each pool
-- and each bank, balance_now - balance_prev = sum of the chip_ledger legs
-- labelled bbj_pools.<bank> in between (every write to bbj_pools is
-- auto-ledgered, every door declares itself since Phase 4.3), and anything
-- else is `unexplained`, per bank, per hour. fn_bbj_reconcile(pool) writes
-- the snapshot; fn_bbj_reconcile_all() runs it for every active pool from
-- the hourly rake/BBJ invariant audit that already exists (no new cron) and
-- files a bbj_error incident when the trailing two snapshots disagree by
-- more than a cent. The business flows (drops, payouts, sweeps, funding,
-- bank moves) are carried on the snapshot as information, read from the leg
-- categories. fn_bbj_conservation_check keeps its lifetime figures and adds
-- the epoch's: `healthy` now means the journal identity has held since the
-- baseline, which is the question worth an alarm.
--
-- The 73,367.70 is not written off, credited or moved: nobody is owed it (a
-- contribution is taken from a pot that has already been raked; a payout is
-- already in a wallet), and the money the pools hold is exactly what the
-- opening balances record. Dan's standing rule is that an epoch reset is an
-- epoch, not an erase; the lifetime figure stays readable and the pre-journal
-- residue is named in the baseline for the reset gate to rule on with the
-- other historic write-offs.
--
-- One transaction. Probed rolled-back first. Every number asserted.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ca_bbj_pool_snapshots (
  id                bigserial PRIMARY KEY,
  pool_id           uuid NOT NULL,
  taken_at          timestamptz NOT NULL DEFAULT now(),
  is_baseline       boolean NOT NULL DEFAULT false,
  prev_id           bigint,
  main              numeric NOT NULL,
  backup            numeric NOT NULL,
  promo             numeric NOT NULL,
  journal_main      numeric NOT NULL DEFAULT 0,
  journal_backup    numeric NOT NULL DEFAULT 0,
  journal_promo     numeric NOT NULL DEFAULT 0,
  drops_since       numeric NOT NULL DEFAULT 0,
  payouts_since     numeric NOT NULL DEFAULT 0,
  sweeps_since      numeric NOT NULL DEFAULT 0,
  funding_since     numeric NOT NULL DEFAULT 0,
  moves_since       numeric NOT NULL DEFAULT 0,
  write_failures    integer NOT NULL DEFAULT 0,
  unexplained_main  numeric NOT NULL DEFAULT 0,
  unexplained_backup numeric NOT NULL DEFAULT 0,
  unexplained_promo numeric NOT NULL DEFAULT 0,
  note              text,
  UNIQUE (pool_id, taken_at)
);
CREATE INDEX IF NOT EXISTS ca_bbj_pool_snapshots_pool_idx ON public.ca_bbj_pool_snapshots (pool_id, taken_at DESC);
ALTER TABLE public.ca_bbj_pool_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_bbj_pool_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_bbj_pool_snapshots TO service_role;
COMMENT ON TABLE public.ca_bbj_pool_snapshots IS
  'The BBJ meter (chip standard Phase 4.2): one row per pool per run. main/backup/promo are the banks as read; journal_* the chip_ledger legs labelled bbj_pools.<bank> since prev; unexplained_* the difference. The is_baseline row is the opening balance - not a movement.';

-- ── The meter ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_bbj_reconcile(p_pool_id uuid)
 RETURNS public.ca_bbj_pool_snapshots
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev public.ca_bbj_pool_snapshots%ROWTYPE;
  v_now timestamptz := clock_timestamp();  -- not now(): two runs in one transaction must not collide
  v_main numeric; v_backup numeric; v_promo numeric;
  jm numeric := 0; jb numeric := 0; jp numeric := 0;
  v_drops numeric := 0; v_pay numeric := 0; v_sweep numeric := 0; v_fund numeric := 0; v_moves numeric := 0;
  v_fail integer := 0;
  v_row public.ca_bbj_pool_snapshots%ROWTYPE;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_reconcile is service only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_prev FROM public.ca_bbj_pool_snapshots WHERE pool_id = p_pool_id ORDER BY taken_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_bbj_reconcile: pool % has no opening balance; write the baseline first', p_pool_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bbj_pools WHERE id = p_pool_id) THEN
    RAISE EXCEPTION 'fn_bbj_reconcile: pool % not found', p_pool_id;
  END IF;

  -- ONE STATEMENT, ONE SNAPSHOT: the banks and the legs are read together so
  -- a write that commits between two reads cannot show in one and not the
  -- other. Every leg the autoledger wrote for this pool's own columns since the
  -- previous snapshot: the labelled side is the pool's bank, its sign is the
  -- side the label sits on (a bank move is two self-legs, one label each).
  -- A leg where the pool is only somebody else's counterparty carries no
  -- bbj_pools label and moves no bank, so it is not counted.
  WITH legs AS (
    SELECT l.category,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END AS signed,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.to_label
                WHEN l.from_label LIKE 'bbj_pools.%' THEN l.from_label END AS lbl,
           l.amount, l.from_type, l.to_type
      FROM public.chip_ledger l
     WHERE ((l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool') OR (l.from_entity_id = p_pool_id AND l.from_type = 'bbj_pool'))
       AND l.created_at > v_prev.taken_at AND l.created_at <= v_now
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
  )
  , banks AS (
    SELECT COALESCE(main_balance, 0) AS m, COALESCE(backup_balance, 0) AS b, COALESCE(promo_balance, 0) AS p
      FROM public.bbj_pools WHERE id = p_pool_id
  )
  SELECT banks.m, banks.b, banks.p,
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.main_balance'), 0),
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.backup_balance'), 0),
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.promo_balance'), 0),
         COALESCE(sum(amount) FILTER (WHERE category = 'bbj_contribution' AND to_type = 'bbj_pool' AND from_type <> 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE category = 'bbj_payout' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE category = 'promo' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE category = 'transfer' AND to_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE from_type = 'bbj_pool' AND to_type = 'bbj_pool'), 0) / 2
    INTO v_main, v_backup, v_promo, jm, jb, jp, v_drops, v_pay, v_sweep, v_fund, v_moves
    FROM banks LEFT JOIN legs ON true
   GROUP BY banks.m, banks.b, banks.p;

  SELECT count(*) INTO v_fail FROM public.ca_ledger_write_failures f
   WHERE f.occurred_at > v_prev.taken_at AND f.occurred_at <= v_now AND f.message ILIKE '%bbj_pools.%';

  INSERT INTO public.ca_bbj_pool_snapshots
    (pool_id, taken_at, is_baseline, prev_id, main, backup, promo,
     journal_main, journal_backup, journal_promo,
     drops_since, payouts_since, sweeps_since, funding_since, moves_since, write_failures,
     unexplained_main, unexplained_backup, unexplained_promo)
  VALUES
    (p_pool_id, v_now, false, v_prev.id, v_main, v_backup, v_promo,
     round(jm, 2), round(jb, 2), round(jp, 2),
     round(v_drops, 2), round(v_pay, 2), round(v_sweep, 2), round(v_fund, 2), round(v_moves, 2), v_fail,
     round((v_main - v_prev.main) - jm, 2),
     round((v_backup - v_prev.backup) - jb, 2),
     round((v_promo - v_prev.promo) - jp, 2))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_reconcile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_reconcile(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_reconcile_all()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p record; s public.ca_bbj_pool_snapshots%ROWTYPE; prev public.ca_bbj_pool_snapshots%ROWTYPE;
  v_out jsonb := '[]'::jsonb; v_two numeric; v_alerts int := 0;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_reconcile_all is service only' USING ERRCODE = '42501';
  END IF;
  FOR p IN SELECT b.id, b.union_id, b.club_id FROM public.bbj_pools b
            WHERE b.status = 'active' AND EXISTS (SELECT 1 FROM public.ca_bbj_pool_snapshots x WHERE x.pool_id = b.id)
  LOOP
    s := public.fn_bbj_reconcile(p.id);
    SELECT * INTO prev FROM public.ca_bbj_pool_snapshots WHERE id = s.prev_id;
    -- Two consecutive snapshots: a leg that commits after a read straddles one
    -- boundary and reverses at the next, so a single-interval swing is noise
    -- and a two-interval sum is a finding.
    v_two := (s.unexplained_main + s.unexplained_backup + s.unexplained_promo)
           + COALESCE(CASE WHEN prev.is_baseline THEN 0 ELSE prev.unexplained_main + prev.unexplained_backup + prev.unexplained_promo END, 0);
    IF abs(v_two) > 0.01 OR s.write_failures > 0 THEN
      v_alerts := v_alerts + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_bbj_reconcile', 'bbj_error', CASE WHEN abs(v_two) >= 100 OR s.write_failures > 0 THEN 'critical' ELSE 'warning' END,
        'bbj-meter:' || p.id::text || ':' || to_char(s.taken_at, 'YYYY-MM-DD-HH24'),
        round(v_two, 2), 0, round(v_two, 2), 'ledger', 'bbj_pools', p.id, p.club_id, p.union_id,
        NULL, NULL, NULL, NULL, NULL, NULL,
        format('BBJ pool banks moved by %s beyond the journal over the last two snapshots (main %s, backup %s, promo %s this interval; %s ledger write failure(s)): a bbj_pools write without a leg, or a leg without a write',
               round(v_two, 2), s.unexplained_main, s.unexplained_backup, s.unexplained_promo, s.write_failures),
        false,
        jsonb_build_object('snapshot_id', s.id, 'pool_id', p.id, 'unexplained_main', s.unexplained_main,
                           'unexplained_backup', s.unexplained_backup, 'unexplained_promo', s.unexplained_promo,
                           'write_failures', s.write_failures));
    END IF;
    v_out := v_out || jsonb_build_object('pool_id', p.id, 'snapshot_id', s.id,
                'main', s.main, 'backup', s.backup, 'promo', s.promo,
                'unexplained', round(s.unexplained_main + s.unexplained_backup + s.unexplained_promo, 2),
                'drops', s.drops_since, 'payouts', s.payouts_since, 'sweeps', s.sweeps_since);
  END LOOP;
  RETURN jsonb_build_object('pools', v_out, 'alerts', v_alerts);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_reconcile_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_reconcile_all() TO service_role;

-- ── The hourly audit that already runs carries the meter (no new cron) ────
CREATE OR REPLACE FUNCTION public.fn_rake_bbj_audit(p_hours integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows jsonb;
  v_total bigint;
  v_money bigint;
  v_meter jsonb;
BEGIN
  SELECT COALESCE(jsonb_object_agg(check_name, jsonb_build_object('n', violations, 'sample', detail)), '{}'::jsonb),
         COALESCE(SUM(violations), 0),
         COALESCE(SUM(violations) FILTER (WHERE check_name IN
           ('I3_deductions_exceed_pot','I5_drop_not_banked_to_pool','I7_raked_hand_never_banked')), 0)
    INTO v_rows, v_total, v_money
    FROM public.fn_rake_bbj_invariants(p_hours);

  IF v_total > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES (CASE WHEN v_money > 0 THEN 'critical' ELSE 'warning' END,
            'fn_rake_bbj_audit',
            'RAKE_BBJ_INVARIANT_VIOLATION: ' || v_total ||
              ' violation(s) in the last ' || p_hours || 'h. The collection law is: drop on every ' ||
              'flop with 3+ dealt; deductions never exceed the pot; every fee banked and attributed.',
            v_rows);
  END IF;

  -- THE BBJ METER (chip standard Phase 4.2): every active pool's banks against
  -- the journal since the last snapshot. Its own failure must not hide the
  -- invariant result above, and vice versa.
  BEGIN
    v_meter := public.fn_bbj_reconcile_all();
  EXCEPTION WHEN OTHERS THEN
    v_meter := jsonb_build_object('error', SQLERRM);
  END;

  RETURN jsonb_build_object('checked_hours', p_hours, 'violations', v_total,
                            'money_violations', v_money, 'detail', v_rows, 'meter', v_meter);
END $function$;

-- ── The lifetime check learns the epoch ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_bbj_conservation_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_in numeric; v_out numeric; v_bal numeric; v_gap numeric; v_base record;
  v_epoch_at timestamptz; v_epoch_unexp numeric; v_epoch_runs int;
BEGIN
  v_in := fn_bbj_contributions_total();
  v_in := v_in + (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_fund');

  v_out := (SELECT COALESCE(SUM(total_amount),0) FROM bbj_payouts)
         + (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_promo_sweep')
         + (SELECT COALESCE(SUM(amount),0) FROM chip_transactions WHERE transaction_type='bbj_promo_sweep')
         + (SELECT COALESCE(SUM(amount),0) FROM wallet_transactions
             WHERE category='promotion' AND description='BBJ promo pool payout');

  SELECT COALESCE(SUM(main_balance+backup_balance+promo_balance),0) INTO v_bal FROM bbj_pools;

  v_gap := round(v_in - v_out - v_bal, 2);
  SELECT * INTO v_base FROM bbj_conservation_baseline WHERE id = 1;

  -- THE EPOCH (Phase 4.2): since the opening balances, the journal identity per
  -- pool per bank. This is what `healthy` means now; the lifetime figures stay.
  SELECT min(taken_at) INTO v_epoch_at FROM public.ca_bbj_pool_snapshots WHERE is_baseline;
  SELECT COALESCE(sum(unexplained_main + unexplained_backup + unexplained_promo), 0), count(*)
    INTO v_epoch_unexp, v_epoch_runs
    FROM public.ca_bbj_pool_snapshots WHERE NOT is_baseline;

  RETURN jsonb_build_object(
    'inflow', round(v_in,2), 'outflow', round(v_out,2), 'balances', round(v_bal,2),
    'gap', v_gap,
    'baseline_gap', COALESCE(v_base.baseline_gap, 0),
    'drift_from_baseline', round(v_gap - COALESCE(v_base.baseline_gap, 0), 2),
    'tolerance', COALESCE(v_base.tolerance, 1.00),
    'lifetime_healthy', abs(v_gap - COALESCE(v_base.baseline_gap, 0)) <= COALESCE(v_base.tolerance, 1.00),
    'epoch', jsonb_build_object(
      'opened_at', v_epoch_at,
      'snapshots', v_epoch_runs,
      'unexplained_since_opening', round(v_epoch_unexp, 2)),
    'healthy', v_epoch_at IS NOT NULL AND abs(v_epoch_unexp) <= COALESCE(v_base.tolerance, 1.00));
END;
$function$;

-- ── The opening balances, with the history written in ─────────────────────
DO $$
DECLARE
  v_check jsonb; v_gap numeric; p record; v_n int := 0; v_note text;
BEGIN
  v_check := public.fn_bbj_conservation_check();
  v_gap := (v_check->>'gap')::numeric;
  IF abs(v_gap - 73367.70) > 100 THEN
    RAISE EXCEPTION 'the lifetime gap reads %, not the 73,367.70 this baseline was written for; re-read before opening the epoch', v_gap;
  END IF;
  v_note := format(
    'OPENING BALANCE, not a movement (chip standard Phase 4.2, 2026-09-04). Lifetime identity at this instant: inflow %s, outflow %s, balances %s, gap %s against the 2026-08-25 baseline of 2,572.59. Of the gap, 41,096.65 is 49,714 contribution rows of 2026-03-03..07 whose bank portions are short of their amount (phantom inflow, no chip missing); the remainder is total_paid_out on the pool rows exceeding the bbj_payouts rows from before that table was kept. Since journalling began on 2026-08-31 the union pool identity held to the cent and the club pool to 0.50. Nothing is written off here; the lifetime figure stays readable in fn_bbj_conservation_check and the pre-journal residue is for the epoch reset gate.',
    v_check->>'inflow', v_check->>'outflow', v_check->>'balances', v_gap);
  FOR p IN SELECT id, main_balance, backup_balance, promo_balance FROM public.bbj_pools WHERE status = 'active' ORDER BY id LOOP
    INSERT INTO public.ca_bbj_pool_snapshots (pool_id, taken_at, is_baseline, main, backup, promo, note)
    VALUES (p.id, now(), true, COALESCE(p.main_balance, 0), COALESCE(p.backup_balance, 0), COALESCE(p.promo_balance, 0), v_note);
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'expected 3 active pools (union, Deep Stack, the empty Midway club row), found %', v_n;
  END IF;
END $$;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_bbj_reconcile', 'approved', 'chip standard Phase 4.2 (2026-09-04): the BBJ meter, one snapshot per pool per run; reads, writes no balance'),
  ('fn_bbj_reconcile_all', 'approved', 'chip standard Phase 4.2 (2026-09-04): runs the meter for every active pool from the hourly rake/BBJ audit; files bbj_error incidents')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

-- ── Assertions ────────────────────────────────────────────────────────────
DO $$
DECLARE v jsonb; s public.ca_bbj_pool_snapshots%ROWTYPE;
BEGIN
  IF (SELECT count(*) FROM public.ca_bbj_pool_snapshots WHERE is_baseline) <> 3 THEN RAISE EXCEPTION 'baseline rows missing'; END IF;
  v := public.fn_bbj_conservation_check();
  IF (v->'epoch'->>'opened_at') IS NULL OR (v->>'healthy')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the epoch did not open cleanly: %', v;
  END IF;
  IF (v->>'lifetime_healthy')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'the lifetime figure should still read unhealthy (it is history, not erased): %', v;
  END IF;
END $$;
