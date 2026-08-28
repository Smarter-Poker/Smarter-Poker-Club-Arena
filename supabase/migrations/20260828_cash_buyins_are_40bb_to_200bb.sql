-- ═══════════════════════════════════════════════════════════════════════════
-- CASH BUY-INS ARE 40BB-200BB (Dan 2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
-- Dan: "Higher buy in games, 10-25 and 25-50 buyins should be 40BB-200BB and
-- currently you can only buy in for 2-4 BB max."
--
-- The broken surface: `NLH 25/50 INSURANCE TEST` carried min_buy_in 100 /
-- max_buy_in 200 — a 2BB/4BB band — inserted by an ad-hoc service-role script,
-- not by any product creation path (every live creator already writes
-- bb*40 / bb*200). Five more rows deviated below the band (100BB caps and a
-- 20BB floor on E2E rows). atomic_table_buyin enforces these columns, so the
-- lobby, the buy-in modal and the enforcement all correct together.
--
-- Tournament rows (tournament_id IS NOT NULL) are untouched: their 0/0 is
-- legitimate. The vestigial *_bb columns are resynced so the two column
-- families cannot disagree.
--
-- APPLIED TO PRODUCTION 2026-08-28 via Supabase MCP apply_migration
-- (migration name: cash_buyins_are_40bb_to_200bb). 6 rows corrected.
--
-- Companion code changes in the same commit:
--   - TableConfigPage.tsx: default maxBuyInBB 100 -> 200; min-buy-in slider
--     floor 2BB -> 40BB (the UI could author exactly this broken shape).
--   - server HorseFleetManager.ts: the reuse/reactivate branch now resyncs
--     min_buy_in/max_buy_in alongside the blinds, so a blind bump can never
--     strand a stale chip band again.

UPDATE public.tables
   SET min_buy_in    = big_blind * 40,
       max_buy_in    = big_blind * 200,
       min_buy_in_bb = 40,
       max_buy_in_bb = 200
 WHERE tournament_id IS NULL
   AND COALESCE(big_blind, 0) > 0
   AND (min_buy_in IS DISTINCT FROM big_blind * 40
     OR max_buy_in IS DISTINCT FROM big_blind * 200);

-- Assert: no cash row deviates from the band any more.
DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tables
   WHERE tournament_id IS NULL
     AND COALESCE(big_blind, 0) > 0
     AND (min_buy_in IS DISTINCT FROM big_blind * 40
       OR max_buy_in IS DISTINCT FROM big_blind * 200);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'cash buy-in normalisation left % deviating rows', v_bad;
  END IF;
END $$;
