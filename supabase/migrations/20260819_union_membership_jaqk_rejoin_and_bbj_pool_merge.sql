-- ═══════════════════════════════════════════════════════════════════════════
-- APPLIED TO PRODUCTION: 2026-08-19 via Supabase MCP apply_migration
-- (name union_membership_jaqk_rejoin_and_bbj_pool_merge). Mirror only.
-- ═══════════════════════════════════════════════════════════════════════════
-- Dan's spec (2026-08-19): ALL rake is held by the union wallet under the Rake
-- Treasury (cash hands + tournament registrations); BBJ fees split 50/25/25 into
-- the union's main BBJ / backup BBJ / promo wallet.
--
-- Club JAQK is a Midway Union member per union_clubs (joined 2026-02-28) but
-- clubs.union_id was NULL, so the engine routed its cash rake to its own
-- chip_treasury (standalone path) and its BBJ fees into a separate club-level
-- bbj_pools row instead of the shared union pool. Tournament buy-in rake
-- (fn added 2026-08-19) also routes by clubs.union_id, so JAQK's tournament
-- rake would likewise have bypassed the union treasury.
--
-- This migration:
--   1. Sets clubs.union_id for JAQK (aligning with union_clubs membership) —
--      from the next hand, JAQK rake credits union_wallets.rake_wallet and its
--      BBJ fees credit the union pool.
--   2. Merges the JAQK club-level BBJ pool balances + lifetime counters into
--      the union pool and retires the club pool (status='retired', zeroed).
--      Merged at execution time: main 4,722.72 / backup 2,691.02 / promo 0.59.
--   3. Fixes unions.settings.bbj_split metadata 40/30/30 -> 50/25/25 (the
--      engine's actual sub-100k-pivot split, and the specified one).
--
-- NOTE ON HISTORY: JAQK's pre-migration cash rake (~1.5M lifetime) settled into
-- its own chip_treasury under the standalone path and was subsequently spent
-- (horse funding etc.) — it never reached the union wallet, so it is NOT part
-- of any union rakeback basis. Weekly 90/10 rakeback (see
-- 20260819_fn_union_weekly_rakeback_close.sql) uses union_wallet_transactions
-- rake credits, i.e. only chips that actually entered the treasury.

UPDATE public.clubs
   SET union_id = 'fade0000-0000-0000-0000-000000000001', updated_at = now()
 WHERE id = 'a0000000-0000-0000-0000-000000000001'
   AND union_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001';

DO $$
DECLARE
  v_union_pool uuid;
  v_club_pool  public.bbj_pools%ROWTYPE;
BEGIN
  SELECT id INTO v_union_pool FROM public.bbj_pools
   WHERE union_id = 'fade0000-0000-0000-0000-000000000001' FOR UPDATE;
  SELECT * INTO v_club_pool FROM public.bbj_pools
   WHERE id = '0867a7fd-58d9-4768-9919-06532afe79f3' FOR UPDATE;

  IF v_union_pool IS NULL THEN
    RAISE EXCEPTION 'union BBJ pool not found — aborting merge';
  END IF;
  IF v_club_pool.id IS NULL THEN
    RAISE EXCEPTION 'JAQK club BBJ pool not found — aborting merge';
  END IF;

  UPDATE public.bbj_pools SET
    main_balance      = main_balance      + v_club_pool.main_balance,
    backup_balance    = backup_balance    + v_club_pool.backup_balance,
    promo_balance     = promo_balance     + v_club_pool.promo_balance,
    total_contributed = total_contributed + v_club_pool.total_contributed,
    total_paid_out    = total_paid_out    + v_club_pool.total_paid_out,
    hit_count         = COALESCE(hit_count,0)         + COALESCE(v_club_pool.hit_count,0),
    hands_contributed = COALESCE(hands_contributed,0) + COALESCE(v_club_pool.hands_contributed,0),
    updated_at        = now()
  WHERE id = v_union_pool;

  UPDATE public.bbj_pools
     SET main_balance = 0, backup_balance = 0, promo_balance = 0,
         status = 'retired', updated_at = now()
   WHERE id = v_club_pool.id;
END $$;

UPDATE public.unions
   SET settings = jsonb_set(settings, '{bbj_split}', '{"main": 50, "backup": 25, "promo": 25}'::jsonb),
       updated_at = now()
 WHERE id = 'fade0000-0000-0000-0000-000000000001';
