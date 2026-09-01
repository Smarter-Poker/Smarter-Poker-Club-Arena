-- =============================================================================
-- deep_stack_opening_baseline_exactly_as_dan_drew_it
-- Applied to production via Supabase MCP 2026-09-01 17:06 UTC.
-- Dan, verbatim: "i should have 2.5 m chips in the club bank, spins should
-- be 20,000 (from 2.5m chips) BBJ should of been seeded with 1000 chips out
-- of club bank leaving 2,479,000 chips and the back up bbj set to zero."
-- 2,500,000 - 20,000 - 1,000 = 2,479,000, pinned in one transaction while
-- the floor was already live (249 spins and 66+ hands within minutes of the
-- green light). Play drifts every number from this baseline, by design.
-- =============================================================================
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_bank numeric; v_spin numeric; v_bbj record;
BEGIN
  UPDATE clubs SET chip_treasury = 2479000.00 WHERE id = v_club;

  UPDATE spin_bonus_pools SET balance = 20000.00, updated_at = now()
   WHERE club_id = v_club;

  UPDATE bbj_pools
     SET main_balance = 1000.00, pool_amount = 1000.00,
         backup_balance = 0, promo_balance = 0, updated_at = now()
   WHERE club_id = v_club;

  INSERT INTO spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_club, 'adjustment', 0, 20000,
          'opening baseline pinned: bank 2,479,000 / spins 20,000 / BBJ seeded 1,000 / backup 0 (Dan 2026-09-01)');

  SELECT chip_treasury INTO v_bank FROM clubs WHERE id=v_club;
  SELECT balance INTO v_spin FROM spin_bonus_pools WHERE club_id=v_club;
  SELECT main_balance, backup_balance, promo_balance INTO v_bbj FROM bbj_pools WHERE club_id=v_club;

  IF v_bank <> 2479000 OR v_spin <> 20000
     OR v_bbj.main_balance <> 1000 OR v_bbj.backup_balance <> 0 OR v_bbj.promo_balance <> 0 THEN
    RAISE EXCEPTION 'baseline wrong: bank=% spin=% bbj=%/%/%',
      v_bank, v_spin, v_bbj.main_balance, v_bbj.backup_balance, v_bbj.promo_balance;
  END IF;
END $$;
