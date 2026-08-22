-- ═══════════════════════════════════════════════════════════════════════════
-- REPAIR: active tournaments whose legacy rake split exceeds the 10% cap
-- 2026-08-22, Cowork session 11
--
-- WHY: 20260821_tournament_rake_cap.sql added tournaments_rake_within_10_pct
-- as NOT VALID, which (correctly) skips validating existing rows — but the
-- check still fires on every UPDATE, because an update writes a new row
-- version. Two tournaments created 2026-08-21 18:02-18:03 UTC by the
-- pre-floor-fix engine (Prime Time Main Event 22+3, Evening Mystery Bounty
-- 13+2) were mid-flight when the constraint landed. Every engine write to
-- them since has been rejected: both sat RUNNING for 29 hours with
-- updated_at frozen at created_at, and postgres logged the violation
-- hundreds of times per hour as the engine kept retrying.
--
-- FIX: re-cut the fee out of the SAME total the players already paid
-- (fee = floor(total * 0.1), prize = total - fee — identical arithmetic to
-- splitBuyIn in server/src/config/buyIn.ts and the CHECK itself). The
-- player-paid total is unchanged; the house's cut drops to the legal cap,
-- which is the direction Dan's 2026-08-21 ruling requires. The engine's
-- next tick can then update, finish and settle these tournaments normally.
--
-- Scope: only rows that are still active (not COMPLETED/CANCELLED) and in
-- violation. Completed history keeps its true, over-cap record — rewriting
-- settled money would falsify the books. Idempotent: a second run matches
-- zero rows.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE tournaments
SET
  buy_in_fee = floor(
    (COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0)) * 0.1 + 0.000000001
  ),
  buy_in_amount = (COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0)) - floor(
    (COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0)) * 0.1 + 0.000000001
  ),
  updated_at = now()
WHERE
  status NOT IN ('COMPLETED', 'CANCELLED')
  AND COALESCE(buy_in_fee, 0) > floor(
    (COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0)) * 0.1 + 0.000000001
  );

-- POST-APPLY ASSERTIONS ─────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer;
BEGIN
  -- 1. No active row may remain in violation.
  SELECT count(*) INTO v_bad
  FROM tournaments
  WHERE status NOT IN ('COMPLETED', 'CANCELLED')
    AND COALESCE(buy_in_fee, 0) > floor(
      (COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0)) * 0.1 + 0.000000001
    );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'repair failed: % active tournament(s) still violate the 10%% rake cap', v_bad;
  END IF;

  -- 2. The two known casualties, if still active, must now accept updates
  --    (buy-in totals preserved: 25 stays 25, 15 stays 15).
  SELECT count(*) INTO v_bad
  FROM tournaments
  WHERE id IN ('b8cd017b-b607-493e-892c-d0da7d12a554', '4720a973-02cf-4a33-81d2-748907a3a9a4')
    AND status NOT IN ('COMPLETED', 'CANCELLED')
    AND COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0) NOT IN (25, 15);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'repair failed: a repaired tournament total changed';
  END IF;
END $$;
