-- 2026-08-31 — MTT Phase 3: three payout key namespaces do not begin 'tourney:'.
--
-- Found by listing every key prefix in wallet_credit_idempotency rather than by
-- reading the callers — which is the point. The callers are what I would have
-- trusted, and they would have told me there were only 'tourney:' keys.
--
--   mb:{tournament}:{user}                       83  mystery-bounty chest payment
--   mb-residual:{tournament}                     51  chest residual to the champion
--   spin:{tournament}:prize:{u}:unpaid_backpay   42  spin winner drawn, never credited
--
-- All 176 are tournament money. Without this they would still have been
-- recorded — fn_credit_and_log falls back to 'unclassified' rather than
-- dropping a row — but 'unclassified' in a payout record is a question mark
-- where a fact belongs.
--
-- TIER: 2. ROLLBACK: re-apply 20260831133608.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_shape(p_key text)
RETURNS TABLE (source text, place integer)
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  WITH s AS (
    SELECT split_part(p_key, ':', 1) AS ns,
           split_part(p_key, ':', 3) AS kind,
           split_part(p_key, ':', 4) AS seg4,
           split_part(p_key, ':', 5) AS seg5,
           split_part(p_key, ':', 6) AS seg6
     WHERE p_key LIKE 'tourney:%'
        OR p_key LIKE 'mb:%'
        OR p_key LIKE 'mb-residual:%'
        OR p_key LIKE 'spin:%'
  )
  SELECT
    CASE
      WHEN s.ns = 'mb'                                     THEN 'mystery_bounty'
      WHEN s.ns = 'mb-residual'                            THEN 'mystery_bounty_residual'
      WHEN s.ns = 'spin' AND s.seg5 = 'unpaid_backpay'     THEN 'spin_backpay'
      WHEN s.ns <> 'tourney'                               THEN NULL
      WHEN s.kind = 'prize' AND s.seg6 = 'reconcile'       THEN 'reconcile'
      WHEN s.kind = 'prize' AND s.seg5 = 'hu_shortfall'    THEN 'hu_shortfall'
      WHEN s.kind = 'prize' AND s.seg4 = 'place'           THEN 'structure'
      WHEN s.kind = 'prize' AND s.seg5 ~ '^[0-9]+$'        THEN 'structure'
      WHEN s.kind = 'bounty'                               THEN 'bounty'
      WHEN s.kind = 'ownbounty'                            THEN 'own_bounty'
      WHEN s.kind = 'prizeadj'                             THEN 'late_reg_adjustment'
      WHEN s.kind = 'clawback'                             THEN 'clawback'
      WHEN s.kind = 'ftd'                                  THEN 'final_table_deal'
    END,
    CASE
      WHEN s.ns = 'spin' AND s.seg5 = 'unpaid_backpay' THEN 1
      WHEN s.ns <> 'tourney' THEN NULL
      WHEN s.kind IN ('prize','prizeadj','clawback') AND s.seg4 = 'place'
           AND s.seg5 ~ '^[0-9]+$' THEN s.seg5::integer
      WHEN s.kind IN ('prize','prizeadj','clawback')
           AND s.seg5 ~ '^[0-9]+$' THEN s.seg5::integer
    END
  FROM s;
$$;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_shape(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_shape(text) TO service_role;

COMMIT;
