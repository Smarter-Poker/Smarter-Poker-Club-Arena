-- ═══════════════════════════════════════════════════════════════════════════════
-- Bible V8 §2.6 (Club Treasury) + Tier C (CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION)
-- Phase X2 — closes P0-G2
-- Migration: 20260428000004_club_wallets.sql
--
-- Purpose:
--   Per-club treasury balance + ledger.
--   Distinct from public.wallets (per-user). Tracks:
--     - club's owner-funded chip pool (mint by owner, clawback by owner/agent)
--     - rake collected this period
--     - commission paid out to agents
--     - BBJ contribution accruing
--     - inter-club transfers via union routing
--
--   Pre-existing migration 20260314_fn_union_send_chips_to_club.sql references
--   this table opportunistically ("UPDATE club_wallets … if exists"), but the
--   table itself was never created. This closes that loop.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.club_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL UNIQUE REFERENCES public.clubs(id) ON DELETE CASCADE,

  -- Balances (in CHIPS — clubs are chip-denominated, not USD)
  chip_balance NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (chip_balance >= 0),

  -- Period accumulators (reset by close-settlement-period RPC)
  period_rake_collected   NUMERIC(20,4) NOT NULL DEFAULT 0,
  period_commission_paid  NUMERIC(20,4) NOT NULL DEFAULT 0,
  period_bbj_contribution NUMERIC(20,4) NOT NULL DEFAULT 0,
  period_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Lifetime totals (informational; never reset)
  lifetime_rake_collected   NUMERIC(20,4) NOT NULL DEFAULT 0,
  lifetime_commission_paid  NUMERIC(20,4) NOT NULL DEFAULT 0,
  lifetime_bbj_contribution NUMERIC(20,4) NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_club_wallets_club_id ON public.club_wallets (club_id);

CREATE OR REPLACE FUNCTION public.touch_club_wallets()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_club_wallets_updated ON public.club_wallets;
CREATE TRIGGER trg_club_wallets_updated
  BEFORE UPDATE ON public.club_wallets
  FOR EACH ROW EXECUTE FUNCTION public.touch_club_wallets();

ALTER TABLE public.club_wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.club_wallets;
CREATE POLICY "service_role full access"
  ON public.club_wallets FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "club owners read own club wallet" ON public.club_wallets;
CREATE POLICY "club owners read own club wallet"
  ON public.club_wallets FOR SELECT TO authenticated
  USING (
    club_id IN (
      SELECT id FROM public.clubs c WHERE c.owner_id = auth.uid()
    )
  );

-- ─── Companion ledger: club_wallet_transactions ───────────────────────────
CREATE TABLE IF NOT EXISTS public.club_wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,

  type TEXT NOT NULL CHECK (type IN
    ('mint','clawback','rake_in','commission_out','bbj_contribution','union_in','union_out',
     'agent_settlement','correction','other')),
  amount NUMERIC(20,4) NOT NULL,         -- signed: +inflow / -outflow
  balance_after NUMERIC(20,4) NOT NULL,  -- club_wallets.chip_balance after this row

  related_id UUID,                       -- e.g. rakeback_period_id, agent_commission_id, hand_id
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_club_wallet_tx_club_created
  ON public.club_wallet_transactions (club_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_club_wallet_tx_type
  ON public.club_wallet_transactions (type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_club_wallet_tx_related
  ON public.club_wallet_transactions (related_id);

ALTER TABLE public.club_wallet_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.club_wallet_transactions;
CREATE POLICY "service_role full access"
  ON public.club_wallet_transactions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "club owners read own club ledger" ON public.club_wallet_transactions;
CREATE POLICY "club owners read own club ledger"
  ON public.club_wallet_transactions FOR SELECT TO authenticated
  USING (
    club_id IN (
      SELECT id FROM public.clubs c WHERE c.owner_id = auth.uid()
    )
  );

-- Backfill: create a club_wallet row for every existing club so ops API
-- can always SELECT … FOR UPDATE without a NOT FOUND branch.
INSERT INTO public.club_wallets (club_id)
SELECT id FROM public.clubs
ON CONFLICT (club_id) DO NOTHING;

COMMENT ON TABLE public.club_wallets IS
  'Per-club treasury balance + period accumulators. Closes P0-G2.';
COMMENT ON TABLE public.club_wallet_transactions IS
  'Append-only ledger of club treasury mutations. Every UPDATE on club_wallets '
  'must INSERT a corresponding row here in the same transaction.';
