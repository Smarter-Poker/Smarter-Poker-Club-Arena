-- =============================================================================
-- deep_stack_spins_and_bbj_clean_slate
-- Applied to production via Supabase MCP 2026-09-01 14:59 UTC.
-- Dan: "SPINS TREASURY HAS MORE CHIPS IN IT THEN IT SHOULD, AND SO DOES THE
-- BBJ. THOSE NEED TO BE RESET AND THE TRANSACTIONS / PLAY HISTORY CLEARED."
-- Spin pool back to its 20,000 activation seed; BBJ pool zeroed across all
-- balances and counters; Deep Stack rows cleared from spin_reserve_ledger,
-- bbj_contributions, bbj_daily_user, bbj_qualifying_hands (by pool),
-- bbj_hand_evidence_log (by the club's tables); a baseline row rewritten
-- into spin_reserve_ledger so the pool balance always has a book behind it.
-- =============================================================================
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_pool uuid; v_spin numeric; v_bbj record;
BEGIN
  SELECT id INTO v_pool FROM bbj_pools WHERE club_id=v_club;

  UPDATE spin_bonus_pools SET balance = 20000, updated_at = now()
   WHERE club_id = v_club AND balance <> 20000;
  SELECT balance INTO v_spin FROM spin_bonus_pools WHERE club_id=v_club;
  IF v_spin <> 20000 THEN RAISE EXCEPTION 'spin pool reads %', v_spin; END IF;

  DELETE FROM spin_reserve_ledger WHERE club_id = v_club;
  INSERT INTO spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_club, 'adjustment', 0, 20000,
          'clean-slate baseline: 20,000 activation seed from club chip_treasury (repayable), history cleared on Dan''s order 2026-09-01');

  UPDATE bbj_pools
     SET pool_amount = 0, main_balance = 0, backup_balance = 0, promo_balance = 0,
         hands_contributed = 0, total_contributed = 0, alloc_cum_amount = 0,
         updated_at = now()
   WHERE club_id = v_club;
  SELECT main_balance, backup_balance, promo_balance, hands_contributed
    INTO v_bbj FROM bbj_pools WHERE club_id=v_club;
  IF v_bbj.main_balance <> 0 OR v_bbj.backup_balance <> 0
     OR v_bbj.promo_balance <> 0 OR v_bbj.hands_contributed <> 0 THEN
    RAISE EXCEPTION 'bbj pool not clean after reset';
  END IF;

  DELETE FROM bbj_contributions WHERE club_id = v_club;
  DELETE FROM bbj_daily_user WHERE club_id = v_club;
  IF v_pool IS NOT NULL THEN
    DELETE FROM bbj_qualifying_hands
     WHERE to_jsonb(bbj_qualifying_hands.*) ->> 'pool_id' = v_pool::text;
  END IF;
  DELETE FROM bbj_hand_evidence_log
   WHERE table_id IN (SELECT id FROM tables WHERE club_id = v_club);
END $$;
