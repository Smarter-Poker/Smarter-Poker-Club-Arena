-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260428205157 as "x2_005_rakeback_period_payouts"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
CREATE TABLE IF NOT EXISTS public.rakeback_period_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rakeback_period_id UUID NOT NULL REFERENCES public.rakeback_periods(id) ON DELETE CASCADE,
  club_id UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_rake_contribution NUMERIC(20,4) NOT NULL CHECK (user_rake_contribution >= 0),
  rakeback_pct           NUMERIC(5,2)  NOT NULL CHECK (rakeback_pct BETWEEN 0 AND 100),
  payout_amount NUMERIC(20,4) NOT NULL CHECK (payout_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'CHIPS',
  wallet_transaction_id UUID,
  status TEXT NOT NULL DEFAULT 'paid'
    CHECK (status IN ('pending','paid','clawed_back','failed')),
  paid_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  USING (club_id IN (SELECT id FROM public.clubs c WHERE c.owner_id = auth.uid()));
