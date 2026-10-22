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
      /* A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY (2026-10-12): it closes
         main, backup and promo in one bbj_promo_sweep row. */
      (SELECT COALESCE(sum(CASE WHEN metadata->>'reason'='union_join'
                                THEN COALESCE((metadata->>'bbj_promo')::numeric,0) ELSE amount END),0)
         FROM chip_transactions WHERE transaction_type='bbj_promo_sweep') AS swept_to_club,
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
$function$
