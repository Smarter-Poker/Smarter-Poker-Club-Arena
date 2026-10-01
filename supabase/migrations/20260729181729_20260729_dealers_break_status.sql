-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260729181729 as "20260729_dealers_break_status"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- Dealer break/return status for commander_dealers
ALTER TABLE public.commander_dealers
  ADD COLUMN IF NOT EXISTS current_status text DEFAULT 'available';

ALTER TABLE public.commander_dealers
  ADD COLUMN IF NOT EXISTS break_started_at timestamptz;
