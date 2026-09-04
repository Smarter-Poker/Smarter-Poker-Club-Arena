-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3.2 - A BALANCE CANNOT GO NEGATIVE (chip standard, 2026-09-04)
--
-- The standard's "player wallets already have it" was wrong: before this
-- migration the database carried a >= 0 CHECK only on spin_bonus_pools,
-- club_wallets and tournament_obligations. Every other store that the supply
-- meter counts could be driven below zero by a bug and nothing would refuse
-- it. Measured at 18:40 UTC before applying: no negative anywhere (minimum
-- per column read from every row, table_seats included over all 312,296
-- rows), so VALIDATE passes and refuses nothing that exists.
--
-- NOT VALID first, then VALIDATE in the same transaction: the ADD takes the
-- table's exclusive lock for a moment (lock_timeout is the migration's
-- 5 seconds; a busy table refuses rather than queues the platform behind
-- us), the VALIDATE takes only SHARE UPDATE EXCLUSIVE and scans without
-- blocking writers. Every column is nullable-tolerant: a NULL balance passes
-- a CHECK, and the writers COALESCE it to zero anyway.
--
-- Columns, per roadmap 3.2 plus every balance column beside them:
--   clubs:         chip_treasury, chip_pool, promo_balance, insurance_balance
--   club_members:  chip_balance, promo_balance
--   union_wallets: chip_balance, rake_wallet, bbj_wallet, promo_wallet,
--                  insurance_wallet, spin_reserve_wallet
--   agents:        agent_wallet_balance, promo_wallet_balance
--   table_seats:   stack
--   bbj_pools:     main_balance, backup_balance, promo_balance
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_chip_treasury_nonneg CHECK (chip_treasury >= 0) NOT VALID,
  ADD CONSTRAINT clubs_chip_pool_nonneg CHECK (chip_pool >= 0) NOT VALID,
  ADD CONSTRAINT clubs_promo_balance_nonneg CHECK (promo_balance >= 0) NOT VALID,
  ADD CONSTRAINT clubs_insurance_balance_nonneg CHECK (insurance_balance >= 0) NOT VALID;
ALTER TABLE public.club_members
  ADD CONSTRAINT club_members_chip_balance_nonneg CHECK (chip_balance >= 0) NOT VALID,
  ADD CONSTRAINT club_members_promo_balance_nonneg CHECK (promo_balance >= 0) NOT VALID;
ALTER TABLE public.union_wallets
  ADD CONSTRAINT union_wallets_chip_balance_nonneg CHECK (chip_balance >= 0) NOT VALID,
  ADD CONSTRAINT union_wallets_rake_wallet_nonneg CHECK (rake_wallet >= 0) NOT VALID,
  ADD CONSTRAINT union_wallets_bbj_wallet_nonneg CHECK (bbj_wallet >= 0) NOT VALID,
  ADD CONSTRAINT union_wallets_promo_wallet_nonneg CHECK (promo_wallet >= 0) NOT VALID,
  ADD CONSTRAINT union_wallets_insurance_wallet_nonneg CHECK (insurance_wallet >= 0) NOT VALID,
  ADD CONSTRAINT union_wallets_spin_reserve_wallet_nonneg CHECK (spin_reserve_wallet >= 0) NOT VALID;
ALTER TABLE public.agents
  ADD CONSTRAINT agents_agent_wallet_balance_nonneg CHECK (agent_wallet_balance >= 0) NOT VALID,
  ADD CONSTRAINT agents_promo_wallet_balance_nonneg CHECK (promo_wallet_balance >= 0) NOT VALID;
ALTER TABLE public.table_seats
  ADD CONSTRAINT table_seats_stack_nonneg CHECK (stack >= 0) NOT VALID;
ALTER TABLE public.bbj_pools
  ADD CONSTRAINT bbj_pools_main_balance_nonneg CHECK (main_balance >= 0) NOT VALID,
  ADD CONSTRAINT bbj_pools_backup_balance_nonneg CHECK (backup_balance >= 0) NOT VALID,
  ADD CONSTRAINT bbj_pools_promo_balance_nonneg CHECK (promo_balance >= 0) NOT VALID;

ALTER TABLE public.clubs VALIDATE CONSTRAINT clubs_chip_treasury_nonneg, VALIDATE CONSTRAINT clubs_chip_pool_nonneg,
  VALIDATE CONSTRAINT clubs_promo_balance_nonneg, VALIDATE CONSTRAINT clubs_insurance_balance_nonneg;
ALTER TABLE public.club_members VALIDATE CONSTRAINT club_members_chip_balance_nonneg, VALIDATE CONSTRAINT club_members_promo_balance_nonneg;
ALTER TABLE public.union_wallets VALIDATE CONSTRAINT union_wallets_chip_balance_nonneg, VALIDATE CONSTRAINT union_wallets_rake_wallet_nonneg,
  VALIDATE CONSTRAINT union_wallets_bbj_wallet_nonneg, VALIDATE CONSTRAINT union_wallets_promo_wallet_nonneg,
  VALIDATE CONSTRAINT union_wallets_insurance_wallet_nonneg, VALIDATE CONSTRAINT union_wallets_spin_reserve_wallet_nonneg;
ALTER TABLE public.agents VALIDATE CONSTRAINT agents_agent_wallet_balance_nonneg, VALIDATE CONSTRAINT agents_promo_wallet_balance_nonneg;
ALTER TABLE public.table_seats VALIDATE CONSTRAINT table_seats_stack_nonneg;
ALTER TABLE public.bbj_pools VALIDATE CONSTRAINT bbj_pools_main_balance_nonneg, VALIDATE CONSTRAINT bbj_pools_backup_balance_nonneg, VALIDATE CONSTRAINT bbj_pools_promo_balance_nonneg;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_constraint WHERE contype = 'c' AND conname LIKE '%\_nonneg' AND convalidated
     AND conrelid IN ('public.clubs'::regclass, 'public.club_members'::regclass, 'public.union_wallets'::regclass,
                      'public.agents'::regclass, 'public.table_seats'::regclass, 'public.bbj_pools'::regclass);
  IF v_n <> 18 THEN
    RAISE EXCEPTION 'expected 18 validated non-negative constraints, found %', v_n;
  END IF;
END $$;
