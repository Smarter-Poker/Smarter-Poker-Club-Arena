-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260806164803 "20260804_commander_day_closes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 19bdfba66ab61d568e14eef864a48650 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- End-of-day close records for the Commander "Close Day" flow (was a UI-only stub).
CREATE TABLE IF NOT EXISTS public.commander_day_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id integer NOT NULL,
  close_date date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  closed_by uuid,
  closed_by_name text,
  report_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shift_notes text,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, close_date)
);

ALTER TABLE public.commander_day_closes ENABLE ROW LEVEL SECURITY;

-- Service-role only (all Commander API routes use the service key); no anon/auth policy,
-- matching the deny-by-default posture of other staff-only commander tables.
DROP POLICY IF EXISTS commander_day_closes_service ON public.commander_day_closes;
CREATE POLICY commander_day_closes_service ON public.commander_day_closes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_commander_day_closes_venue_date
  ON public.commander_day_closes (venue_id, close_date DESC);
