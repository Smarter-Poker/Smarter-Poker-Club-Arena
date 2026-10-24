-- The promo bank check counts chips moved into promo from the other banks.
--
-- fn_bbj_promo_bank_check balances the promo bank as
--   swept_to_union + swept_to_club + still_held - promo_contributed
-- and pages when that gap exceeds what the pre-triple-bank era explains.
-- It only knew one way into a promo bank: a contribution's promo_portion.
-- There is a second, recorded one: fn_bbj_move_between_banks, journalled in
-- ca_bbj_bucket_moves. On 2026-10-23 02:39 UTC Dan moved 20,000.00 from the
-- Midway Union main jackpot to its promo bank (op_id
-- dan-2026-10-22-union-main-to-promo-20000); the 02:40 sweep carried it to the
-- union promo wallet (union_wallet_transactions 4e2a4feb, 20,016.08), and from
-- the 02:52 sweep on the check reported 15,699.36 "unexplained" every hour and
-- kept drift incident afe68d86 open. Those chips are explained: they are the
-- owner's recorded move. The 2026-09-04 pivot correction (4,245.25 main->promo)
-- had been hiding inside the era slack the same way.
--
-- Fix: the "entered" side is contributions plus the net of recorded bucket
-- moves into promo (moves out of promo subtract). Nothing else changes: the
-- same keys, the same era rule, the same threshold. Measured read-only
-- 2026-10-23 12:37 UTC: gap 26,805.21 - moved 24,245.25 = 2,559.96, within the
-- era's 11,116.51, so unexplained = 0 and reconciles = true.
--
-- Preflight: the live body must be the one this replaces (md5 1373b71d...).

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_bbj_promo_bank_check()'::regprocedure)
     <> '1373b71d74b3c73595cd485f1f2f6035' THEN
    RAISE EXCEPTION 'fn_bbj_promo_bank_check changed since this migration was written; re-read it';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_bbj_promo_bank_check()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  /* ONE READ OF THE CONTRIBUTIONS (2026-10-22). The three contribution
     figures were three full scans of bbj_contributions (3.4M rows, 12-25 s
     inside the hourly conservation sweep). They are one scan now; each figure
     is the same aggregate over the same rows it was before. */
  WITH c AS (
    SELECT COALESCE(sum(promo_portion),0) AS contributed,
           COALESCE(sum(amount) FILTER (WHERE main_portion IS NULL AND backup_portion IS NULL
                                          AND promo_portion IS NULL),0) AS pre_triple_bank,
           COALESCE(sum(amount) FILTER (WHERE promo_portion IS NOT NULL),0) AS rated_amount,
           COALESCE(sum(promo_portion) FILTER (WHERE promo_portion IS NOT NULL),0) AS rated_promo
      FROM bbj_contributions
  ), t AS (
    SELECT
      (SELECT c.contributed FROM c)                                                             AS contributed,
      /* RECORDED MOVES BETWEEN BANKS (2026-10-23). fn_bbj_move_between_banks
         is the other way chips enter (or leave) a promo bank; each move is a
         ca_bbj_bucket_moves row. Net into promo counts on the entered side. */
      (SELECT COALESCE(sum(amount) FILTER (WHERE to_bank = 'promo'),0)
            - COALESCE(sum(amount) FILTER (WHERE from_bank = 'promo'),0)
         FROM ca_bbj_bucket_moves)                                                              AS moved_in,
      (SELECT COALESCE(sum(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_promo_sweep') AS swept_to_union,
      /* A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY (2026-10-12): it closes
         main, backup and promo in one bbj_promo_sweep row. */
      (SELECT COALESCE(sum(CASE WHEN metadata->>'reason'='union_join'
                                THEN COALESCE((metadata->>'bbj_promo')::numeric,0) ELSE amount END),0)
         FROM chip_transactions WHERE transaction_type='bbj_promo_sweep') AS swept_to_club,
      (SELECT COALESCE(sum(promo_balance),0) FROM bbj_pools)                                     AS still_held,
      (SELECT c.pre_triple_bank FROM c)                                                         AS pre_triple_bank,
      /* The promo rate the rows that DO record their split actually show. Not
         a constant from config: the rate has varied by stakes tier and over
         time, and what matters here is what this pool really banked. */
      (SELECT CASE WHEN c.rated_amount > 0
                   THEN c.rated_promo / c.rated_amount ELSE 0 END
         FROM c)                                                                                AS observed_rate
  ), g AS (
    SELECT t.*,
           round(swept_to_union + swept_to_club + still_held - contributed - moved_in, 2) AS gap,
           round(pre_triple_bank * observed_rate, 2)                                      AS era_promo
      FROM t
  )
  SELECT jsonb_build_object(
    'promo_contributed', round(contributed,2),
    'moved_into_promo',  round(moved_in,2),
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
    'note', 'The promo bank balances once the pre-triple-bank era and the recorded moves between banks are accounted for. 49,714 contribution rows from 2026-03-03..07 carry NULL portions - the columns did not exist yet - so their promo money is real but counts as zero on the "entered" side. Chips moved into promo by fn_bbj_move_between_banks (ca_bbj_bucket_moves) count as entered. `unexplained` is the number that matters: chips that left the promo bank and cannot be traced to any contribution or recorded move. Only that should ever raise an alarm. The portions are deliberately NOT backfilled: inventing a split nobody recorded would be editing history.'
  ) FROM g;
$function$;

-- Operator telemetry: the conservation sweep (service role) reads it, nobody else.
-- Production already held exactly this ACL before and after the replace.
REVOKE ALL ON FUNCTION public.fn_bbj_promo_bank_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_promo_bank_check() TO service_role;

-- Postflight: the owner's recorded 20,000 move no longer reads as unexplained.
DO $$
DECLARE r jsonb := public.fn_bbj_promo_bank_check();
BEGIN
  IF (r->>'moved_into_promo')::numeric < 24245.25 THEN
    RAISE EXCEPTION 'moved_into_promo is %, expected at least 24245.25', r->>'moved_into_promo';
  END IF;
  IF NOT (r->>'reconciles')::boolean THEN
    RAISE EXCEPTION 'promo bank still does not reconcile after counting bucket moves: %', r;
  END IF;
END $$;
