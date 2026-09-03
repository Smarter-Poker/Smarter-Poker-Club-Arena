-- ═══════════════════════════════════════════════════════════════════════════════
-- Bible V8 §1.9 step 12 (Settlement: Rakeback Credit) + §2.7 (Rakeback Schema)
-- Phase X2 — closes P0-G4
-- Migration: 20260428000005_rakeback_period_payouts.sql
--
-- Purpose:
--   Per-user receipt of rakeback paid out at the close of a settlement period.
--   rakeback_periods is the period header (one row per club per period);
--   this is the line-item table (one row per (period, user) pair).
--
--   Today rakeback_periods has 0 rows because the cron handler never runs.
--   When the new rakeback-settle worker (Phase X4) does run, it will write:
--     1 row to rakeback_periods (period summary)
--     N rows to rakeback_period_payouts (one per eligible user)
--     N transactions to wallet_transactions (the credit)
--
--   Wrapping all three in one SQL transaction is what makes settlement atomic.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.rakeback_period_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  rakeback_period_id UUID NOT NULL REFERENCES public.rakeback_periods(id) ON DELETE CASCADE,
  club_id UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Inputs to the payout calculation
  user_rake_contribution NUMERIC(20,4) NOT NULL CHECK (user_rake_contribution >= 0),
  rakeback_pct           NUMERIC(5,2)  NOT NULL CHECK (rakeback_pct BETWEEN 0 AND 100),

  -- Output
  payout_amount NUMERIC(20,4) NOT NULL CHECK (payout_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'CHIPS',

  -- Wallet credit linkage (so we can prove "rakeback paid" → "wallet credited")
  wallet_transaction_id UUID,

  -- Status
  status TEXT NOT NULL DEFAULT 'paid'
    CHECK (status IN ('pending','paid','clawed_back','failed')),
  paid_at TIMESTAMPTZ,
  failure_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One payout row per (period, user) pair — second insert is idempotent no-op
  UNIQUE (rakeback_period_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rakeback_payouts_user ON public.rakeback_period_payouts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rakeback_payouts_club_status
  ON public.rakeback_period_payouts (club_id, status);

ALTER TABLE public.rakeback_period_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.rakeback_period_payouts;
CREATE POLICY "service_role full access"
  ON public.rakeback_period_payouts FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "users read own rakeback receipts" ON public.rakeback_period_payouts;
CREATE POLICY "users read own rakeback receipts"
  ON public.rakeback_period_payouts FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "club owners read own club rakeback" ON public.rakeback_period_payouts;
CREATE POLICY "club owners read own club rakeback"
  ON public.rakeback_period_payouts FOR SELECT TO authenticated
  USING (
    club_id IN (
      SELECT id FROM public.clubs c WHERE c.owner_id = auth.uid()
    )
  );

COMMENT ON TABLE public.rakeback_period_payouts IS
  'Per-(period, user) rakeback receipt. Closes P0-G4. Written atomically by '
  'rakeback-settle cron + RakebackSettler RPC alongside wallet_transactions credit.';
