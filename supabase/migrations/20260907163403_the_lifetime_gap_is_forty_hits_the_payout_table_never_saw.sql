-- ═══════════════════════════════════════════════════════════════════════════
--  THE LIFETIME GAP IS FORTY HITS THE PAYOUT TABLE NEVER SAW
--  BBJ build plan phase 5.3 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT HAS BEEN OPEN SINCE 2026-08-25, and what it turns out to be.
--
-- `fn_bbj_conservation_check` reports a lifetime gap of 73,367.70 against a
-- baseline of 2,572.59 - a drift of 70,795.11 that has stood, investigated and
-- unexplained, for thirteen days. A GLOBAL_SETTLEMENT_FREEZE was placed on all
-- three clubs for it. The baseline row's own note says closing it "means
-- crediting or writing off ~74k of real player money on an inference".
--
-- IT IS NOT AN INFERENCE AND NOTHING IS WRITTEN OFF. Measured, per pool, from
-- rows, twice four seconds apart under live play with both reads identical:
--
--   pool                      contributions - payouts - sweeps - balances
--   ────────────────────────────────────────────────────────────────────
--   0867a7fd (retired club)   159,981.85 - 74,301.10 - 28,742.48
--                                        - 56,938.27 restored out =    0.00
--   a7a65cfc (active club)     49,186.79 -      0.00 - 12,284.12
--                                        - 37,860.15 held        =  -957.48
--   f9806a7f (union)                                             = 74,323.80
--
-- The retired club pool balances TO THE CENT once the 56,938.27 restoration is
-- counted as its outflow. The active club pool is short by its own opening
-- seed. **The whole gap is the union pool, and the union pool has an answer.**
--
-- THE ANSWER. The check measures inflow from `bbj_contributions`, whose first
-- row is 2026-03-03. It measures outflow from `bbj_payouts`, whose first row is
-- **2026-07-22**. The union pool has been paying jackpots since March. Its own
-- counter says it has paid 172,740.21 (including the 74,301.10 folded in from
-- the club pool at the merge); the payout table can see 100,990.90 of that.
--
--   bbj_pools.total_paid_out, root pools     172,740.21
--   sum(bbj_payouts.total_amount)            100,990.90
--   ───────────────────────────────────────────────────
--   paid before the payout table existed      71,749.31   over 40 hits
--                                                         (hit_count 45, rows 5)
--
-- Forty jackpots, real chips, real winners, recorded by the counter that WAS
-- there and by nothing the check reads. This is 10.9's own doctrine: prefer the
-- witness that was there. The counter watched each payment leave; the table did
-- not exist to watch.
--
-- And the opposite sign, from the same class of defect: `bbj_pools.pool_amount`
-- holds 1,000.00 of opening seed on the club pool created 2026-08-31. That is
-- balance with no inflow row behind it, so it makes the gap SMALLER by 1,000.
-- (It is also why the drift moved from ~71.7k on 08-31 to 70,795.11 - a number
-- that changed for a reason nobody had named.)
--
--   drift from baseline                       70,795.11
--   less paid before the payout table       - 71,749.31
--   plus the opening seed                   +  1,000.00
--   ───────────────────────────────────────────────────
--   UNEXPLAINED                                   45.80
--
-- 45.80. Nine hundredths of one percent of the drift, on 474,414.68 of inflow
-- across 1.07 million contribution rows. Stable across reads.
--
-- WHAT THIS MIGRATION DOES, and deliberately does not do.
--
--   - It does NOT rebaseline. The baseline row says "DO NOT REBASELINE" after
--     an agent did exactly that on 2026-08-31 and had to revert it, and the
--     lifetime figures are the memory of this investigation. `gap`,
--     `baseline_gap` and `drift_from_baseline` are untouched and still read
--     73,367.70 / 2,572.59 / 70,795.11.
--   - It does NOT credit or write off a chip. No wallet is touched. The forty
--     hits were paid at the time, to the players who won them; there is nothing
--     to settle.
--   - It teaches the SIGNAL to say what it now knows (10.86 rule 1: "I could
--     not tell" is a distinct outcome and must have its own name). The check
--     gains a `lifetime` block that names each explained component and reports
--     `unexplained` separately - the same treatment `fn_bbj_promo_bank_check`
--     received in 20260907161937, and for the same reason: a number reported as
--     a deficit when it is a ledger start-date is an alarm that gets muted.
--   - `lifetime_residue` remembers the 45.80 rather than absorbing it, against
--     the tolerance the row already carries (1.00), so any real movement in the
--     residue goes red at once. The 45.80 stays visible and stays owed an
--     explanation; it is simply no longer hiding 71,749.31 of paid jackpots.
--
-- ROLLBACK: previous definition in the 2026-09-04 phase 4.2 epoch migration;
-- `ALTER TABLE public.bbj_conservation_baseline DROP COLUMN lifetime_residue;`

BEGIN;

ALTER TABLE public.bbj_conservation_baseline
  ADD COLUMN IF NOT EXISTS lifetime_residue numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.bbj_conservation_baseline.lifetime_residue IS
  'The lifetime gap that survives every named explanation. Measured 45.80 on 2026-09-07 (drift 70,795.11 less 71,749.31 paid before bbj_payouts existed plus a 1,000.00 opening seed). Remembered, not absorbed: fn_bbj_conservation_check goes red if it moves by more than `tolerance`.';

UPDATE public.bbj_conservation_baseline
   SET lifetime_residue = 45.80,
       note = note || E'\n\nRESOLVED 2026-09-07 (BBJ phase 5.3), WITHOUT REBASELINING. The drift is not missing money. (b) - "the remaining ~33k is on the payout/balance side and is NOT yet explained" - is 71,749.31 of jackpots the union pool paid across 40 hits BEFORE bbj_payouts existed (first row 2026-07-22; the pool has been live since March). bbj_pools.total_paid_out on the root pools reads 172,740.21 and the payout table can see 100,990.90. Netting the 1,000.00 opening seed in bbj_pools.pool_amount, which is balance with no inflow row and pulls the other way, leaves 45.80 genuinely unexplained - now carried in lifetime_residue and pinned to this row''s 1.00 tolerance. (a), the 41,096.65 in 49,714 March rows with null bank portions, is a RECORD gap and not an inflow gap: the check sums bbj_contributions.amount, not the portions, so those rows never entered this arithmetic. Per-pool proof: the retired club pool balances to 0.00 exactly once the 56,938.27 restoration is counted as its outflow; the active club pool to -957.48, its own seed; the entire remainder is the union pool. Nothing was credited, written off or rebaselined. This note is still the memory of the investigation - append to it, never replace it.'
 WHERE id = 1;

CREATE OR REPLACE FUNCTION public.fn_bbj_conservation_check()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_in numeric; v_out numeric; v_bal numeric; v_gap numeric; v_base record;
  v_epoch_at timestamptz; v_epoch_unexp numeric; v_epoch_runs int;
  v_counters_paid numeric; v_payout_rows numeric; v_pre_table numeric;
  v_seeds numeric; v_drift numeric; v_unexplained numeric;
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
  v_drift := round(v_gap - COALESCE(v_base.baseline_gap, 0), 2);

  -- THE EPOCH (Phase 4.2): since the opening balances, the journal identity per
  -- pool per bank. This is what `healthy` means; the lifetime figures stay.
  SELECT min(taken_at) INTO v_epoch_at FROM public.ca_bbj_pool_snapshots WHERE is_baseline;
  SELECT COALESCE(sum(unexplained_main + unexplained_backup + unexplained_promo), 0), count(*)
    INTO v_epoch_unexp, v_epoch_runs
    FROM public.ca_bbj_pool_snapshots WHERE NOT is_baseline;

  /* THE LIFETIME DECOMPOSITION (phase 5.3). Two ledgers with different start
     dates, named rather than reported as a deficit.

     `paid_before_the_payout_table` reads the ROOT pools only: a merge folds the
     retired pool's counters into its destination, so summing every pool would
     count the club pool's 74,301.10 twice. */
  SELECT COALESCE(sum(total_paid_out),0) INTO v_counters_paid
    FROM bbj_pools WHERE merged_into_pool_id IS NULL;
  SELECT COALESCE(sum(total_amount),0) INTO v_payout_rows FROM bbj_payouts;
  v_pre_table := round(v_counters_paid - v_payout_rows, 2);

  /* Opening seeds pull the OTHER way: balance with no inflow row behind it. */
  SELECT COALESCE(sum(pool_amount),0) INTO v_seeds FROM bbj_pools;

  v_unexplained := round(v_drift - v_pre_table + v_seeds, 2);

  RETURN jsonb_build_object(
    'inflow', round(v_in,2), 'outflow', round(v_out,2), 'balances', round(v_bal,2),
    'gap', v_gap,
    'baseline_gap', COALESCE(v_base.baseline_gap, 0),
    'drift_from_baseline', v_drift,
    'tolerance', COALESCE(v_base.tolerance, 1.00),
    'lifetime', jsonb_build_object(
      'drift_from_baseline', v_drift,
      'paid_before_the_payout_table', v_pre_table,
      'opening_seeds_with_no_inflow_row', round(v_seeds,2),
      'unexplained', v_unexplained,
      'known_residue', COALESCE(v_base.lifetime_residue, 0),
      'moved_since_resolution', round(v_unexplained - COALESCE(v_base.lifetime_residue,0), 2),
      'note', 'The gap is two ledgers with different start dates, not missing chips. bbj_contributions begins 2026-03-03; bbj_payouts begins 2026-07-22. The union pool paid forty jackpots in between, and bbj_pools.total_paid_out is the witness that was there. `unexplained` is the only figure here that should ever raise anything.'),
    'lifetime_healthy',
      abs(v_unexplained - COALESCE(v_base.lifetime_residue, 0)) <= COALESCE(v_base.tolerance, 1.00),
    'epoch', jsonb_build_object(
      'opened_at', v_epoch_at,
      'snapshots', v_epoch_runs,
      'unexplained_since_opening', round(v_epoch_unexp, 2)),
    'healthy', v_epoch_at IS NOT NULL AND abs(v_epoch_unexp) <= COALESCE(v_base.tolerance, 1.00));
END;
$function$;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.fn_bbj_conservation_check();

  IF NOT (v->>'lifetime_healthy')::boolean THEN
    RAISE EXCEPTION 'the lifetime residue is not where it was measured: %', v->'lifetime';
  END IF;

  /* The figures this investigation is the memory of must not have moved. */
  IF (v->>'baseline_gap')::numeric <> 2572.59 THEN
    RAISE EXCEPTION 'the baseline was changed by this migration - it must not be: %', v;
  END IF;
  IF abs((v->'lifetime'->>'paid_before_the_payout_table')::numeric - 71749.31) > 1 THEN
    RAISE EXCEPTION 'paid-before-the-payout-table is not the 71,749.31 measured: %', v->'lifetime';
  END IF;
  IF NOT (v->>'healthy')::boolean THEN
    RAISE EXCEPTION 'the epoch identity broke while this was applied: %', v;
  END IF;
END $$;

COMMIT;
