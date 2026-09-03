-- =============================================================================
-- deep_stack_club_bank_back_to_designed_reserve
-- Applied to production via Supabase MCP 2026-09-01 12:37 UTC.
--
-- Dan, 2026-09-01: the club was created with 100k, then funded 10,000,000 —
-- 7.5M disbursed down the hierarchy (4.16M player wallets + 3.34M agent
-- banks) and 2.5M retained in the club bank.
--
-- The teardown retired the bank's reserve to chip_retirement in two
-- auto-ledgered corrections: -2,401,347.13 (11:00:37 UTC) and -8.35
-- (11:03:24 UTC), total 2,401,355.48, leaving the bank at ~97.8k. This
-- reverses exactly those two rows — not a hand-picked round number, so the
-- ledger reconciles to the penny. The residual gap from a flat 2,500,000 is
-- live play (rake earned, horse funding spent) and stays untouched.
-- clubs.chip_treasury carries its own autoledger, which records the arrival.
-- =============================================================================
DO $$
DECLARE v_before numeric; v_after numeric; v_ledger int;
BEGIN
  SELECT chip_treasury INTO v_before FROM clubs WHERE id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  IF v_before > 1000000 THEN
    RAISE EXCEPTION 'treasury already reads % — refusing to double-restore', v_before;
  END IF;

  UPDATE clubs SET chip_treasury = chip_treasury + 2401355.48
   WHERE id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';

  SELECT chip_treasury INTO v_after FROM clubs WHERE id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  IF v_after <> v_before + 2401355.48 THEN
    RAISE EXCEPTION 'treasury restore wrong: before=% after=%', v_before, v_after;
  END IF;

  SELECT count(*) INTO v_ledger FROM chip_ledger
   WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
     AND to_type='club_treasury' AND amount=2401355.48
     AND created_at > now() - interval '1 minute';
  IF v_ledger <> 1 THEN
    RAISE EXCEPTION 'autoledger did not record the treasury arrival (found % rows)', v_ledger;
  END IF;
END $$;
