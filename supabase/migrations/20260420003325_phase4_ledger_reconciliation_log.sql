-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420003325 "phase4_ledger_reconciliation_log"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 49c14b8243298db8f4a8f79013846973 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Phase 4.1.2 — Nightly ledger reconciliation log
CREATE TABLE IF NOT EXISTS public.ledger_reconcile_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  run_ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('player_wallet','club_treasury','agent_wallet')),
  entity_id        UUID NOT NULL,
  ledger_balance   NUMERIC(18,2) NOT NULL,
  stored_balance   NUMERIC(18,2) NOT NULL,
  drift            NUMERIC(18,2) GENERATED ALWAYS AS (stored_balance - ledger_balance) STORED,
  severity         TEXT NOT NULL CHECK (severity IN ('ok','warn','critical')),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconcile_run_date    ON public.ledger_reconcile_log(run_date DESC);
CREATE INDEX IF NOT EXISTS idx_reconcile_severity    ON public.ledger_reconcile_log(severity, run_date DESC);
CREATE INDEX IF NOT EXISTS idx_reconcile_entity      ON public.ledger_reconcile_log(entity_type, entity_id);

ALTER TABLE public.ledger_reconcile_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reconcile_service_write" ON public.ledger_reconcile_log;
DROP POLICY IF EXISTS "reconcile_admin_read"    ON public.ledger_reconcile_log;

CREATE POLICY "reconcile_service_write"
  ON public.ledger_reconcile_log FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "reconcile_admin_read"
  ON public.ledger_reconcile_log FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin','owner','super_agent')
    )
  );

COMMENT ON TABLE public.ledger_reconcile_log
  IS 'Nightly ledger reconciliation findings. Drift > 0 = stored balance higher than ledger (chips created out of thin air). Drift < 0 = stored balance lower (chips lost). (Plan § 7.1.2)';

