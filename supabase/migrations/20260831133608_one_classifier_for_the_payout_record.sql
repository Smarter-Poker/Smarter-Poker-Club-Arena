-- 2026-08-31 — MTT Phase 3: ONE classifier, used by both writers.
--
-- A tournament credit key is a fixed colon-delimited grammar, and it already
-- carries the two facts the payout record needs beyond the money itself: what
-- KIND of payment this is, and which finishing PLACE it settles.
--
-- The alternative was to pass both down from the engine. That would have meant
-- editing twelve call sites across four TypeScript files — and it would STILL
-- have missed the seven payout paths that live in SQL and cannot be passed a
-- parameter from the engine at all:
--
--   fn_mystery_bounty_pay          fn_mystery_bounty_settle
--   fn_backpay_spin_unpaid_winners fn_backpay_hu_winner_shortfalls
--   fn_tournament_payout_reconcile fn_unregister_from_tournament
--   atomic_cancel_tournament
--
-- Deriving it from the key covers all nineteen paths, plus the twentieth
-- nobody has written yet. And because the live writer and the historical
-- backfill call THIS function rather than each carrying their own copy of the
-- rules, a row recorded today and a row reconstructed from March cannot drift
-- into describing the same kind of payment differently.
--
-- Vocabulary is closed on purpose: an unrecognised key returns source NULL,
-- which the caller records as 'unclassified' rather than guessing.
--
-- (Superseded by 20260831135133, which teaches it the three key namespaces
-- that do not begin 'tourney:'. Kept because it is what was applied.)
--
-- TIER: 2 (new read-only function). ROLLBACK: DROP FUNCTION.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_shape(p_key text)
RETURNS TABLE (source text, place integer)
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  WITH s AS (
    SELECT split_part(p_key, ':', 3) AS kind,
           split_part(p_key, ':', 4) AS seg4,
           split_part(p_key, ':', 5) AS seg5,
           split_part(p_key, ':', 6) AS seg6
     WHERE p_key LIKE 'tourney:%'
  )
  SELECT
    CASE
      WHEN s.kind = 'prize' AND s.seg6 = 'reconcile'    THEN 'reconcile'
      WHEN s.kind = 'prize' AND s.seg5 = 'hu_shortfall' THEN 'hu_shortfall'
      WHEN s.kind = 'prize' AND s.seg4 = 'place'        THEN 'structure'
      WHEN s.kind = 'prize' AND s.seg5 ~ '^[0-9]+$'     THEN 'structure'
      WHEN s.kind = 'bounty'                            THEN 'bounty'
      WHEN s.kind = 'ownbounty'                         THEN 'own_bounty'
      WHEN s.kind = 'prizeadj'                          THEN 'late_reg_adjustment'
      WHEN s.kind = 'clawback'                          THEN 'clawback'
      WHEN s.kind = 'ftd'                               THEN 'final_table_deal'
    END,
    CASE
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
