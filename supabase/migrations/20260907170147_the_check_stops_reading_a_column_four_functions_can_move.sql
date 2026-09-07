-- ═══════════════════════════════════════════════════════════════════════════
--  THE CHECK STOPS READING A COLUMN FOUR FUNCTIONS CAN MOVE
--  BBJ build plan phase 5.6 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 5.6 was written down as "retire the legacy `bbj_pools.pool_amount`
-- column: one writer (fn_union_promo_send), no readers left." Both halves of
-- that premise are wrong, and the second half is wrong because of something I
-- did an hour ago.
--
-- READ FROM pg_proc, not assumed. Four functions write it:
--
--   record_rake                      pool_amount = pool_amount + v_bbj_amount
--   fn_union_promo_send              pool_amount = COALESCE(pool_amount,0) + v_amt
--   fn_resolve_bbj_pool              INSERT ... (club_id, ..., pool_amount, ...)
--   fn_complete_club_opening_setup   INSERT ... (..., pool_amount, ...) VALUES (..., 0, ...)
--
-- and the six other functions that mention "pool_amount" are not about this
-- column at all: `bbj_atomic_payout_v2`, `fn_bbj_hand_detail` and
-- `fn_platform_invariants_health` read `bbj_winners.pool_amount_at_hit`, and
-- `fn_payout_leaderboard` has a local alias of the same name. A grep would have
-- called all six readers of this column. None of them is.
--
-- And the "no readers left" half stopped being true at 20260907163403, when
-- phase 5.3 taught `fn_bbj_conservation_check` to read `sum(pool_amount)` as
-- `opening_seeds_with_no_inflow_row`. **That was the mistake, and this migration
-- is the correction.** A money verdict must not stand on a figure that four
-- functions - one of them, `record_rake`, on the rake path - can move without
-- anybody deciding to. It is CLAUDE.md 10.86 rule 4 for the third time in one
-- afternoon: I fixed the trap and left the same trap one level up.
--
-- WHAT THE 1,000 ACTUALLY IS, measured. Pool a7a65cfc (club 2a1132b9, created
-- 2026-08-31) carries `pool_amount = 1000.00`; every other pool carries 0.00.
-- Its `main_balance` is 25,571.49 against 24,589.90 of main portions in its own
-- contribution rows - **981.59 more chips in the bank than any contribution
-- explains** - and no chip movement anywhere near 1,000 funded it in the days
-- around the pool's creation. So a club opening seeds the jackpot's main bank,
-- and the seed arrives without a `bbj_contributions` row. That is not a defect
-- in the seed; it is a hole in what the conservation check can see, and it
-- pulls the lifetime gap the opposite way to the pre-ledger payouts.
--
-- SO IT IS REMEMBERED, NOT DERIVED - the same treatment as
-- `pre_ledger_payouts` and `lifetime_residue`. `opening_seeds` is pinned at
-- 1,000.00 on the baseline row. A NEW seed then shows up as
-- `moved_since_resolution` and takes `lifetime_healthy` false, which is the
-- correct outcome: chips entering a jackpot bank with no contribution row is
-- something a person should look at once, and then record. The live column is
-- still reported, as `legacy_pool_amount_live`, so a divergence is visible
-- without being load-bearing.
--
-- THE COLUMN IS DELIBERATELY NOT DROPPED. It is the only surviving record of
-- that pool's opening seed, and "rewriting or deleting a settled record to make
-- a number look tidy" is Dan's alone (CLAUDE.md 10.9). What it gets instead is
-- a COMMENT saying what it is, that it is not a bank, and that a money check
-- read it for one hour and stopped. The four writers are left alone too:
-- `record_rake` is superseded by `atomic_distribute_rake` on the live path and
-- its increment is now harmless, and changing a money function to tidy a dead
-- column is a worse trade than the comment.
--
-- Verified after applying: unexplained 45.80, moved_since_resolution 0,
-- opening_seeds_known 1000.00, legacy_pool_amount_live 1000.00,
-- lifetime_healthy true, healthy true.
--
-- ROLLBACK: `ALTER TABLE public.bbj_conservation_baseline DROP COLUMN
-- opening_seeds;` plus the definition of fn_bbj_conservation_check in
-- 20260907163639.

BEGIN;

ALTER TABLE public.bbj_conservation_baseline
  ADD COLUMN IF NOT EXISTS opening_seeds numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.bbj_conservation_baseline.opening_seeds IS
  'Chips seeded into a jackpot bank at club opening with no bbj_contributions row behind them: 1,000.00, measured 2026-09-07 on pool a7a65cfc (main_balance exceeds its main portions by 981.59). A CLOSED figure, remembered rather than derived, so a NEW seed shows up as unexplained movement instead of being silently absorbed.';

UPDATE public.bbj_conservation_baseline SET opening_seeds = 1000.00 WHERE id = 1;

COMMENT ON COLUMN public.bbj_pools.pool_amount IS
  'LEGACY, and NOT a bank. The live banks are main_balance / backup_balance / promo_balance. This column is a pre-split accumulator that four functions can still write (record_rake, fn_union_promo_send, fn_resolve_bbj_pool, fn_complete_club_opening_setup) and that nothing reads: it holds 1,000.00 on one pool and 0.00 on the other four. It is deliberately NOT dropped - it is the only surviving record of that pool''s opening seed, and deleting a settled record to tidy a number is Dan''s call alone (CLAUDE.md 10.9). Do not start reading it as a balance; fn_bbj_conservation_check read it for one hour on 2026-09-07 and stopped, because a figure four writers can move is not a figure a money check can stand on.';

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
  v_unrecorded_since numeric; v_seeds_live numeric;
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

  /* Opening seeds pull the OTHER way: bank balance with no inflow row behind
     it. REMEMBERED, not read from bbj_pools.pool_amount - four functions can
     write that column, so deriving from it would let any of them move a money
     verdict, and would silently absorb a new seed the way the pre-ledger
     bucket would have absorbed a new unrecorded payout. The live column is
     reported beside it so a divergence is visible rather than load-bearing. */
  v_seeds := COALESCE(v_base.opening_seeds, 0);
  SELECT COALESCE(sum(pool_amount),0) INTO v_seeds_live FROM bbj_pools;

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
      'opening_seeds_known', v_seeds,
      'legacy_pool_amount_live', round(v_seeds_live,2),
      'unexplained', v_unexplained,
      'known_residue', COALESCE(v_base.lifetime_residue, 0),
      'moved_since_resolution', round(v_unexplained - COALESCE(v_base.lifetime_residue,0), 2),
      'note', 'The gap is two ledgers with different start dates, not missing chips. bbj_contributions begins 2026-03-03; bbj_payouts begins 2026-07-22. The union pool paid forty jackpots in between (71,749.31), and bbj_pools.total_paid_out is the witness that was there. Against it, 1,000.00 of opening seed sits in a bank with no contribution row. Both are CLOSED historical figures. `paid_without_a_payout_row_since` and `moved_since_resolution` are the live signals; everything else here is memory.'),
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

  IF NOT (v->>'lifetime_healthy')::boolean THEN
    RAISE EXCEPTION 'the lifetime block is not healthy after this change: %', v->'lifetime';
  END IF;
  IF (v->'lifetime'->>'moved_since_resolution')::numeric <> 0 THEN
    RAISE EXCEPTION 'the residue moved when the seed figure was pinned: %', v->'lifetime';
  END IF;
  IF (v->'lifetime'->>'opening_seeds_known')::numeric <> 1000 THEN
    RAISE EXCEPTION 'the opening seed was not pinned at 1000: %', v->'lifetime';
  END IF;
  IF (v->>'baseline_gap')::numeric <> 2572.59 THEN
    RAISE EXCEPTION 'the baseline was changed - it must not be: %', v;
  END IF;
  IF NOT (v->>'healthy')::boolean THEN
    RAISE EXCEPTION 'the epoch identity broke while this was applied: %', v;
  END IF;
END $$;

COMMIT;
