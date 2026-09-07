-- 20260907161937_the_promo_bank_check_can_say_explained.sql
--
-- Named for the version the Supabase MCP recorded when it applied this.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE PROMO BANK CHECK CAN SAY "EXPLAINED"
--  BBJ build plan phase 5.3 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT IT HAS BEEN SAYING, hourly, into a warning alert:
--
--     {"over_swept": 6705.21, "reconciles": false}
--
-- "over_swept" on a money surface reads as chips having left a bank that never
-- entered it. NO CHIPS ARE MISSING, and the check's own note already suspected
-- why. This settles it with arithmetic instead of suspicion.
--
-- MEASURED, and every number below is read from rows:
--
--     the uncounted era        2026-03-03 .. 2026-03-07  (five days)
--     rows with NULL portions  49,714
--     their contributions      41,096.65
--     promo rate on rows that DO record it   25.4667%
--     promo that era must have carried       10,465.96
--     the "unexplained" gap                   6,705.21
--     headroom                                3,760.75
--
-- The gap is 6,705.21 and the era it cannot see carried 10,465.96. So the gap
-- is FULLY covered, with room to spare, and in the safe direction: LESS was
-- swept than was actually contributed. The promo bank did not over-pay. The
-- COUNTER under-counts what entered, because 49,714 rows from a five-day window
-- in March predate the columns it reads.
--
-- WHAT IS NOT DONE HERE, deliberately. The obvious "fix" is to backfill
-- `promo_portion` on those 49,714 rows using today's rate. That would be
-- writing numbers nobody ever recorded and calling them history (CLAUDE.md
-- 10.9 - never edit history quiet). The money is right; the ledger of that era
-- is simply thinner than the one we keep now, and it should stay honest about
-- that.
--
-- SO THE FIX IS TO THE SIGNAL (10.11: fix the cause; 10.86: a signal must be
-- able to say what it does not know). The check now distinguishes three
-- outcomes where it had two:
--
--     reconciles                    the books balance
--     explained_by_pre_triple_bank  the gap is inside an era whose portions
--                                   were never recorded - not a defect
--     unexplained                   chips actually left that did not enter,
--                                   which is the alarm worth having
--
-- `reconciles` is true when `unexplained` is zero, so the hourly warning stops
-- firing on a non-defect - and starts meaning something again the day it does
-- fire. An alarm that is always on is an alarm that gets muted (10.84).
--
-- ROLLBACK: the previous definition is in
--   20260825221458_bbj_promo_bank_conservation_check.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_bbj_promo_bank_check()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH t AS (
    SELECT
      (SELECT COALESCE(sum(promo_portion),0) FROM bbj_contributions)                             AS contributed,
      (SELECT COALESCE(sum(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_promo_sweep') AS swept_to_union,
      (SELECT COALESCE(sum(amount),0) FROM chip_transactions WHERE transaction_type='bbj_promo_sweep') AS swept_to_club,
      (SELECT COALESCE(sum(promo_balance),0) FROM bbj_pools)                                     AS still_held,
      (SELECT COALESCE(sum(amount),0) FROM bbj_contributions
        WHERE main_portion IS NULL AND backup_portion IS NULL AND promo_portion IS NULL)         AS pre_triple_bank,
      /* The promo rate the rows that DO record their split actually show. Not
         a constant from config: the rate has varied by stakes tier and over
         time, and what matters here is what this pool really banked. */
      (SELECT CASE WHEN COALESCE(sum(amount),0) > 0
                   THEN COALESCE(sum(promo_portion),0) / sum(amount) ELSE 0 END
         FROM bbj_contributions WHERE promo_portion IS NOT NULL)                                 AS observed_rate
  ), g AS (
    SELECT t.*,
           round(swept_to_union + swept_to_club + still_held - contributed, 2) AS gap,
           round(pre_triple_bank * observed_rate, 2)                           AS era_promo
      FROM t
  )
  SELECT jsonb_build_object(
    'promo_contributed', round(contributed,2),
    'swept_to_union',    round(swept_to_union,2),
    'swept_to_club',     round(swept_to_club,2),
    'still_held',        round(still_held,2),
    'over_swept',        gap,
    'pre_triple_bank_contributions', round(pre_triple_bank,2),
    'pre_triple_bank_promo_at_observed_rate', era_promo,
    'observed_promo_rate', round(observed_rate * 100, 4),
    'explained_by_pre_triple_bank', (gap > 0.01 AND gap <= era_promo),
    'unexplained',       GREATEST(round(gap - era_promo, 2), 0),
    'reconciles',        (GREATEST(round(gap - era_promo, 2), 0) <= 0.01),
    'note', 'The promo bank balances once the pre-triple-bank era is accounted for. 49,714 contribution rows from 2026-03-03..07 carry NULL portions - the columns did not exist yet - so their promo money is real but counts as zero on the "entered" side. `unexplained` is the number that matters: chips that left the promo bank and cannot be traced to any contribution, counted or uncounted. Only that should ever raise an alarm. The portions are deliberately NOT backfilled: inventing a split nobody recorded would be editing history.'
  ) FROM g;
$function$;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.fn_bbj_promo_bank_check();
  IF (v->>'unexplained')::numeric > 0.01 THEN
    RAISE EXCEPTION 'the promo bank has genuinely unexplained movement: %', v;
  END IF;
  IF NOT (v->>'reconciles')::boolean THEN
    RAISE EXCEPTION 'the check still does not reconcile after accounting for the uncounted era: %', v;
  END IF;
END $$;

COMMIT;
