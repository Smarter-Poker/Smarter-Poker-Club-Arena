-- ═══════════════════════════════════════════════════════════════════════════
--  A "PRE-LEDGER" BUCKET MUST NOT BE ABLE TO GROW
--  BBJ build plan phase 5.3, second half (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CLAUDE.md 10.86 rule 4: "a fix that leaves the same trap one level up has not
-- landed. When you fix something, ask what the next person will reach for, and
-- check that it works."
--
-- 20260907163403 explained 71,749.31 of the lifetime gap as jackpots the union
-- pool paid before `bbj_payouts` existed, and reported it as
-- `paid_before_the_payout_table`. Read the arithmetic of a FUTURE payout that
-- bumps `bbj_pools.total_paid_out` and writes no row:
--
--   balances fall by the payout          -> gap RISES by it
--   bbj_payouts unchanged                -> outflow flat
--   drift_from_baseline                  -> rises by it
--   paid_before_the_payout_table         -> rises by exactly the same amount
--   unexplained = drift - pre_table      -> UNCHANGED
--
-- So the bucket built to explain a historical blind spot would quietly absorb a
-- live one, and `lifetime_healthy` would stay green while chips left a pool
-- with nothing recording where they went. That is the same shape as the defect
-- it was written to describe, one level up.
--
-- THE FIX. The 71,749.31 is history: it is bounded by 2026-07-22 and it can
-- never legitimately grow again, because every payout since has written a row.
-- So it is REMEMBERED, exactly like the 45.80 residue, and the check now
-- reports what it has done since:
--
--   paid_without_a_payout_row_since  =  paid_before_the_payout_table
--                                        - pre_ledger_payouts (71,749.31)
--
-- A cent of that is a payout the ledger did not see, and `lifetime_healthy`
-- now requires it to be zero. The epoch journal (phase 4.2) would also catch
-- it as `unexplained_main` on the next snapshot; two readers for a money path
-- is the right number.
--
-- Measured at the moment of writing: paid_before_the_payout_table 71,749.31,
-- pre_ledger_payouts 71,749.31, paid_without_a_payout_row_since 0.00.
--
-- ROLLBACK: `ALTER TABLE public.bbj_conservation_baseline
--              DROP COLUMN pre_ledger_payouts;` plus the previous definition of
-- fn_bbj_conservation_check in 20260907163403.

BEGIN;

ALTER TABLE public.bbj_conservation_baseline
  ADD COLUMN IF NOT EXISTS pre_ledger_payouts numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.bbj_conservation_baseline.pre_ledger_payouts IS
  'Jackpots paid before bbj_payouts existed (first row 2026-07-22), read from bbj_pools.total_paid_out on the root pools: 71,749.31 over 40 union-pool hits, measured 2026-09-07. A CLOSED historical figure. Anything above it is a payout made since that wrote no ledger row, and fn_bbj_conservation_check goes red on the first cent of it.';

UPDATE public.bbj_conservation_baseline
   SET pre_ledger_payouts = 71749.31
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
  v_unrecorded_since numeric;
  v_seeds numeric; v_drift numeric; v_unexplained numeric; v_tol numeric;
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
  v_tol := COALESCE(v_base.tolerance, 1.00);
  v_drift := round(v_gap - COALESCE(v_base.baseline_gap, 0), 2);

  -- THE EPOCH (Phase 4.2): since the opening balances, the journal identity per
  -- pool per bank. This is what `healthy` means; the lifetime figures stay.
  SELECT min(taken_at) INTO v_epoch_at FROM public.ca_bbj_pool_snapshots WHERE is_baseline;
  SELECT COALESCE(sum(unexplained_main + unexplained_backup + unexplained_promo), 0), count(*)
    INTO v_epoch_unexp, v_epoch_runs
    FROM public.ca_bbj_pool_snapshots WHERE NOT is_baseline;

  /* THE LIFETIME DECOMPOSITION (phase 5.3). Two ledgers with different start
     dates, named rather than reported as a deficit.

     ROOT pools only: a merge folds the retired pool's counters into its
     destination, so summing every pool would count the club pool's 74,301.10
     twice. */
  SELECT COALESCE(sum(total_paid_out),0) INTO v_counters_paid
    FROM bbj_pools WHERE merged_into_pool_id IS NULL;
  SELECT COALESCE(sum(total_amount),0) INTO v_payout_rows FROM bbj_payouts;
  v_pre_table := round(v_counters_paid - v_payout_rows, 2);

  /* The historical figure is CLOSED at 71,749.31. Anything beyond it is a
     payout made since bbj_payouts existed that wrote no row - a live blind
     spot wearing a historical explanation's clothes. */
  v_unrecorded_since := round(v_pre_table - COALESCE(v_base.pre_ledger_payouts, 0), 2);

  /* Opening seeds pull the OTHER way: balance with no inflow row behind it. */
  SELECT COALESCE(sum(pool_amount),0) INTO v_seeds FROM bbj_pools;

  v_unexplained := round(v_drift - v_pre_table + v_seeds, 2);

  RETURN jsonb_build_object(
    'inflow', round(v_in,2), 'outflow', round(v_out,2), 'balances', round(v_bal,2),
    'gap', v_gap,
    'baseline_gap', COALESCE(v_base.baseline_gap, 0),
    'drift_from_baseline', v_drift,
    'tolerance', v_tol,
    'lifetime', jsonb_build_object(
      'drift_from_baseline', v_drift,
      'paid_before_the_payout_table', v_pre_table,
      'pre_ledger_payouts_known', COALESCE(v_base.pre_ledger_payouts, 0),
      'paid_without_a_payout_row_since', v_unrecorded_since,
      'opening_seeds_with_no_inflow_row', round(v_seeds,2),
      'unexplained', v_unexplained,
      'known_residue', COALESCE(v_base.lifetime_residue, 0),
      'moved_since_resolution', round(v_unexplained - COALESCE(v_base.lifetime_residue,0), 2),
      'note', 'The gap is two ledgers with different start dates, not missing chips. bbj_contributions begins 2026-03-03; bbj_payouts begins 2026-07-22. The union pool paid forty jackpots in between (71,749.31), and bbj_pools.total_paid_out is the witness that was there. That figure is CLOSED: `paid_without_a_payout_row_since` is a payout the ledger did not see and must stay at zero. `unexplained` is the only other figure here that should ever raise anything.'),
    'lifetime_healthy',
          abs(v_unexplained - COALESCE(v_base.lifetime_residue, 0)) <= v_tol
      AND abs(v_unrecorded_since) <= 0.01,
    'epoch', jsonb_build_object(
      'opened_at', v_epoch_at,
      'snapshots', v_epoch_runs,
      'unexplained_since_opening', round(v_epoch_unexp, 2)),
    'healthy', v_epoch_at IS NOT NULL AND abs(v_epoch_unexp) <= v_tol);
END;
$function$;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.fn_bbj_conservation_check();

  IF (v->'lifetime'->>'paid_without_a_payout_row_since')::numeric <> 0 THEN
    RAISE EXCEPTION 'a payout with no ledger row exists right now: %', v->'lifetime';
  END IF;
  IF NOT (v->>'lifetime_healthy')::boolean THEN
    RAISE EXCEPTION 'the lifetime block is not healthy after this change: %', v->'lifetime';
  END IF;
  IF (v->>'baseline_gap')::numeric <> 2572.59 THEN
    RAISE EXCEPTION 'the baseline was changed - it must not be: %', v;
  END IF;
  IF NOT (v->>'healthy')::boolean THEN
    RAISE EXCEPTION 'the epoch identity broke while this was applied: %', v;
  END IF;
END $$;

COMMIT;
