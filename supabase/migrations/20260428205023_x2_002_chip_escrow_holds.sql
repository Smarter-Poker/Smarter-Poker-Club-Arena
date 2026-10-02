-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260428205023 as "x2_002_chip_escrow_holds"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
CREATE TABLE IF NOT EXISTS public.chip_escrow_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES public.wallets(id) ON DELETE RESTRICT,
  user_id   UUID NOT NULL REFERENCES auth.users(id)     ON DELETE RESTRICT,
  club_id   UUID REFERENCES public.clubs(id)            ON DELETE SET NULL,
  hold_type TEXT NOT NULL CHECK (hold_type IN
    ('tournament_register','cashout_pending','inter_club_transfer','bomb_pot_ante','rebuy_pending','other')),
  related_id UUID,
  amount NUMERIC(20,4) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'CHIPS',
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','captured','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  released_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escrow_user_status   ON public.chip_escrow_holds (user_id, status);
CREATE INDEX IF NOT EXISTS idx_escrow_club_type     ON public.chip_escrow_holds (club_id, hold_type);
CREATE INDEX IF NOT EXISTS idx_escrow_related       ON public.chip_escrow_holds (related_id);
CREATE INDEX IF NOT EXISTS idx_escrow_expires_open  ON public.chip_escrow_holds (expires_at) WHERE status = 'held';

CREATE OR REPLACE FUNCTION public.touch_chip_escrow_holds()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_chip_escrow_holds_updated ON public.chip_escrow_holds;
CREATE TRIGGER trg_chip_escrow_holds_updated
  BEFORE UPDATE ON public.chip_escrow_holds
  FOR EACH ROW EXECUTE FUNCTION public.touch_chip_escrow_holds();

ALTER TABLE public.chip_escrow_holds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.chip_escrow_holds;
CREATE POLICY "service_role full access"
  ON public.chip_escrow_holds FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "users read own holds" ON public.chip_escrow_holds;
CREATE POLICY "users read own holds"
  ON public.chip_escrow_holds FOR SELECT TO authenticated
  USING (user_id = auth.uid());
