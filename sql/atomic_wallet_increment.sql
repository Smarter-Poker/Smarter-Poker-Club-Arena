-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Atomic wallet balance increment functions
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Purpose: Eliminates read-then-write race conditions in wallet balance updates.
-- Previously, logRakeCollection and atomicCashout read the current balance,
-- added an amount in application code, and wrote it back. Under concurrent
-- hands, two reads could see the same balance and one write would be lost.
--
-- These RPC functions use SQL `SET balance = balance + $amount` which is
-- atomic within a single UPDATE statement — no race possible.
--
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Atomic increment for union_wallets.chip_balance
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_union_wallet(
  p_union_id UUID,
  p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.union_wallets
  SET chip_balance = COALESCE(chip_balance, 0) + p_amount,
      updated_at = NOW()
  WHERE union_id = p_union_id;

  -- If no row was updated, insert a new one
  IF NOT FOUND THEN
    INSERT INTO public.union_wallets (union_id, chip_balance, updated_at)
    VALUES (p_union_id, p_amount, NOW())
    ON CONFLICT (union_id) DO UPDATE
    SET chip_balance = COALESCE(public.union_wallets.chip_balance, 0) + p_amount,
        updated_at = NOW();
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Atomic increment for club_wallets.chip_balance
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_club_wallet(
  p_club_id UUID,
  p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.club_wallets
  SET chip_balance = COALESCE(chip_balance, 0) + p_amount
  WHERE club_id = p_club_id;

  IF NOT FOUND THEN
    INSERT INTO public.club_wallets (club_id, chip_balance)
    VALUES (p_club_id, p_amount)
    ON CONFLICT (club_id) DO UPDATE
    SET chip_balance = COALESCE(public.club_wallets.chip_balance, 0) + p_amount;
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Atomic increment for clubs.chip_pool (fallback for clubs without club_wallets row)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_club_chip_pool(
  p_club_id UUID,
  p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.clubs
  SET chip_pool = COALESCE(chip_pool, 0) + p_amount
  WHERE id = p_club_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Atomic increment for wallets.balance (player cashout)
--    Upserts: creates PLAYER wallet if none exists.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_player_wallet(
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.wallets
  SET balance = COALESCE(balance, 0) + p_amount,
      updated_at = NOW()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

  IF NOT FOUND THEN
    INSERT INTO public.wallets (user_id, wallet_type, balance, updated_at)
    VALUES (p_user_id, 'PLAYER', p_amount, NOW())
    ON CONFLICT (user_id, wallet_type) DO UPDATE
    SET balance = COALESCE(public.wallets.balance, 0) + p_amount,
        updated_at = NOW();
  END IF;
END;
$$;
