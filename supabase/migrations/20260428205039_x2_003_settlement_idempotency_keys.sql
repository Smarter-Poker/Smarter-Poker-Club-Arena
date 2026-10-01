-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260428205039 as "x2_003_settlement_idempotency_keys"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
CREATE TABLE IF NOT EXISTS public.settlement_idempotency_keys (
  table_id UUID NOT NULL,
  hand_id  UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_flight'
    CHECK (status IN ('in_flight','succeeded','failed')),
  result JSONB,
  error  TEXT,
  attempt_count INT NOT NULL DEFAULT 1,
  first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  PRIMARY KEY (table_id, hand_id)
);

CREATE INDEX IF NOT EXISTS idx_settlement_idem_status_age
  ON public.settlement_idempotency_keys (status, last_attempt_at DESC)
  WHERE status = 'in_flight';

ALTER TABLE public.settlement_idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.settlement_idempotency_keys;
CREATE POLICY "service_role full access"
  ON public.settlement_idempotency_keys FOR ALL TO service_role
  USING (true) WITH CHECK (true);
