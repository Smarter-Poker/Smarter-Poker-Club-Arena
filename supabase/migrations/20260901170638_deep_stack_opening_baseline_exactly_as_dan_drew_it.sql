-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901170638; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =============================================================================
-- deep_stack_opening_baseline_exactly_as_dan_drew_it
--
-- Dan, 2026-09-01, verbatim: "i should have 2.5 m chips in the club bank,
-- spins should be 20,000 (from 2.5m chips) BBJ should of been seeded with
-- 1000 chips out of club bank leaving 2,479,000 chips and the back up bbj
-- set to zero."
--
-- The arithmetic: 2,500,000 - 20,000 (spin seed) - 1,000 (BBJ seed)
-- = 2,479,000 in the bank. One atomic snapshot sets exactly that baseline.
--
-- Context for the numbers on his screen: the floor went live at the green
-- light and had already played 249 spins (+873.20 pool margin) and dealt
-- 66+ hands (BBJ accruing per hand) by the time he looked — every figure
-- was moving with real play. This migration pins the opening baseline in
-- one transaction; play drifts it from here, which is the point.
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
