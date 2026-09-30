-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260804184807 as "20260804_financial_missing_columns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- PR #24 (merged): time-billing session + W-2G tax columns the routes already write/read.
ALTER TABLE public.commander_table_sessions
  ADD COLUMN IF NOT EXISTS rate_per_hour    numeric,
  ADD COLUMN IF NOT EXISTS total_charge     numeric,
  ADD COLUMN IF NOT EXISTS duration_minutes integer,
  ADD COLUMN IF NOT EXISTS started_by       text;

ALTER TABLE public.commander_tax_events
  ADD COLUMN IF NOT EXISTS event_date          date,
  ADD COLUMN IF NOT EXISTS withholding_rate    numeric,
  ADD COLUMN IF NOT EXISTS w2g_document_url    text,
  ADD COLUMN IF NOT EXISTS player_acknowledged boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS acknowledged_at     timestamptz,
  ADD COLUMN IF NOT EXISTS notes               text;
