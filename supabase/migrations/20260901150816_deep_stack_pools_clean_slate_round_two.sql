-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901150816; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =============================================================================
-- deep_stack_pools_clean_slate_round_two
--
-- Dan, 2026-09-01: "NONE OF THE BALANCES CHANGED FOR BBJ RAKE OR SPINS OR
-- BBJ BACK UP WALLET."
--
-- Round one DID reset bbj_pools and the spin pool -- and then the 15:00:03
-- UTC engine settlement sweep drained the backlog of PRE-FREEZE spins onto
-- the fresh slate (spin_reserve_ledger: 'buy-ins less fixed rake'
-- contributions + jackpot draws), repainting BBJ to 8.40, backup to 4.61,
-- and the spin pool to 20,115.20. Round one also missed club_wallets
-- entirely, which is what the sidebar's "Rake Treasury" (293.44) actually
-- reads. Verified before this run: 0 unsettled spins, 0 settlements in the
-- last 20 minutes -- the backlog is spent, so this reset sticks.
--
-- Resets, all asserted: bbj_pools zeroed; spin pool back to its exact
-- 20,000 repayable seed with the reserve book rebaselined; club_wallets
-- rake/bbj counters and rake-wallet chips zeroed (their source play history
-- was wiped on Dan's order).
-- =============================================================================
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_spin numeric; v_bbj record; v_cw record;
BEGIN
  UPDATE spin_bonus_pools SET balance = 20000, updated_at = now()
   WHERE club_id = v_club AND balance <> 20000;
  SELECT balance INTO v_spin FROM spin_bonus_pools WHERE club_id=v_club;
  IF v_spin <> 20000 THEN RAISE EXCEPTION 'spin pool reads %', v_spin; END IF;

  DELETE FROM spin_reserve_ledger WHERE club_id = v_club;
  INSERT INTO spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_club, 'adjustment', 0, 20000,
          'clean-slate baseline round two: 20,000 activation seed (repayable); pre-freeze settlement residue cleared on Dan''s order 2026-09-01');

  UPDATE bbj_pools
     SET pool_amount = 0, main_balance = 0, backup_balance = 0, promo_balance = 0,
         hands_contributed = 0, total_contributed = 0, alloc_cum_amount = 0,
         updated_at = now()
   WHERE club_id = v_club;
  SELECT main_balance, backup_balance, promo_balance INTO v_bbj
    FROM bbj_pools WHERE club_id=v_club;
  IF v_bbj.main_balance <> 0 OR v_bbj.backup_balance <> 0 OR v_bbj.promo_balance <> 0 THEN
    RAISE EXCEPTION 'bbj not clean';
  END IF;

  UPDATE club_wallets
     SET chip_balance = 0,
         period_rake_collected = 0, period_commission_paid = 0,
         period_bbj_contribution = 0,
         lifetime_rake_collected = 0, lifetime_commission_paid = 0,
         lifetime_bbj_contribution = 0,
         updated_at = now()
   WHERE club_id = v_club;
  SELECT chip_balance, period_rake_collected INTO v_cw
    FROM club_wallets WHERE club_id=v_club;
  IF v_cw.chip_balance <> 0 OR v_cw.period_rake_collected <> 0 THEN
    RAISE EXCEPTION 'club_wallets not clean';
  END IF;

  DELETE FROM bbj_contributions WHERE club_id = v_club;
  DELETE FROM bbj_daily_user WHERE club_id = v_club;
END $$;
