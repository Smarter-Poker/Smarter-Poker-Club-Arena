-- ═══════════════════════════════════════════════════════════════════════════════
-- Bible V8 §1.9 (Settlement Atomicity) + §2.5 (Wallet Holds)
-- Phase X2 — closes P0-G7 / P0-D1 / P0-B3
-- Migration: 20260428000002_chip_escrow_holds.sql
--
-- Purpose:
--   Holds chips in escrow during multi-step flows that must be atomic across
--   wallet + downstream system writes:
--     1. Tournament registration  → hold buy-in until seat assignment confirmed
--     2. Cashout request          → hold withdrawal amount until admin approves/rejects
--     3. Inter-club agent transfer→ hold during union routing
--     4. Bomb pot ante            → hold ante until river resolution
--
--   Replaces the implicit "trust the wallet read between two writes" pattern that
--   left orphan state when a step failed mid-sequence.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.chip_escrow_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Whose chips are held
  wallet_id UUID NOT NULL REFERENCES public.wallets(id) ON DELETE RESTRICT,
  user_id   UUID NOT NULL REFERENCES auth.users(id)     ON DELETE RESTRICT,
  club_id   UUID REFERENCES public.clubs(id)            ON DELETE SET NULL,

  -- What the hold is for
  hold_type TEXT NOT NULL CHECK (hold_type IN
    ('tournament_register','cashout_pending','inter_club_transfer','bomb_pot_ante','rebuy_pending','other')),
  related_id UUID,                       -- e.g. tournaments.id, cashout_requests.id, hands.id

  amount NUMERIC(20,4) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'CHIPS',

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','captured','expired')),
  -- held     = chips moved to escrow; balance reflects it
  -- released = returned to wallet (transaction failed/cancelled)
  -- captured = forwarded to destination (transaction succeeded)
  -- expired  = TTL passed; system released automatically (Sentry alerted)

  expires_at TIMESTAMPTZ NOT NULL,       -- safety TTL — Sentry-alert if breached
  released_at TIMESTAMPTZ,
  released_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escrow_user_status   ON public.chip_escrow_holds (user_id, status);
CREATE INDEX IF NOT EXISTS idx_escrow_club_type     ON public.chip_escrow_holds (club_id, hold_type);
CREATE INDEX IF NOT EXISTS idx_escrow_related       ON public.chip_escrow_holds (related_id);
CREATE INDEX IF NOT EXISTS idx_escrow_expires_open  ON public.chip_escrow_holds (expires_at)
  WHERE status = 'held';

-- updated_at trigger (reuse pattern from user_table_settings migration)
CREATE OR REPLACE FUNCTION public.touch_chip_escrow_holds()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_chip_escrow_holds_updated ON public.chip_escrow_holds;
CREATE TRIGGER trg_chip_escrow_holds_updated
  BEFORE UPDATE ON public.chip_escrow_holds
  FOR EACH ROW EXECUTE FUNCTION public.touch_chip_escrow_holds();

-- RLS: users see own holds; service role writes
ALTER TABLE public.chip_escrow_holds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.chip_escrow_holds;
CREATE POLICY "service_role full access"
  ON public.chip_escrow_holds FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "users read own holds" ON public.chip_escrow_holds;
CREATE POLICY "users read own holds"
  ON public.chip_escrow_holds FOR SELECT TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.chip_escrow_holds IS
  'Atomic chip holds for multi-step flows (tournament register, cashout pending, '
  'inter-club transfer, bomb pot ante). Phase X2 schema gap.';
