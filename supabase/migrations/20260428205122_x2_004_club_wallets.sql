-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260428205122 as "x2_004_club_wallets"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
CREATE TABLE IF NOT EXISTS public.club_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL UNIQUE REFERENCES public.clubs(id) ON DELETE CASCADE,
  chip_balance NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (chip_balance >= 0),
  period_rake_collected   NUMERIC(20,4) NOT NULL DEFAULT 0,
  period_commission_paid  NUMERIC(20,4) NOT NULL DEFAULT 0,
  period_bbj_contribution NUMERIC(20,4) NOT NULL DEFAULT 0,
  period_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  USING (club_id IN (SELECT id FROM public.clubs c WHERE c.owner_id = auth.uid()));

CREATE TABLE IF NOT EXISTS public.club_wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN
    ('mint','clawback','rake_in','commission_out','bbj_contribution','union_in','union_out',
     'agent_settlement','correction','other')),
  amount NUMERIC(20,4) NOT NULL,
  balance_after NUMERIC(20,4) NOT NULL,
  related_id UUID,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_club_wallet_tx_club_created ON public.club_wallet_transactions (club_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_club_wallet_tx_type        ON public.club_wallet_transactions (type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_club_wallet_tx_related     ON public.club_wallet_transactions (related_id);

ALTER TABLE public.club_wallet_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.club_wallet_transactions;
CREATE POLICY "service_role full access"
  ON public.club_wallet_transactions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "club owners read own club ledger" ON public.club_wallet_transactions;
CREATE POLICY "club owners read own club ledger"
  ON public.club_wallet_transactions FOR SELECT TO authenticated
  USING (club_id IN (SELECT id FROM public.clubs c WHERE c.owner_id = auth.uid()));

INSERT INTO public.club_wallets (club_id)
SELECT id FROM public.clubs
ON CONFLICT (club_id) DO NOTHING;
