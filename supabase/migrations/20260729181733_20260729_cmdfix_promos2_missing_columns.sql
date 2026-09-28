-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260729181733 as "20260729_cmdfix_promos2_missing_columns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- 2026-07-29 schema wiring fix: promotions / high-hands / responsible-gaming / notifications
-- Add columns the endpoints depend on. All statements idempotent.

ALTER TABLE public.commander_high_hands
  ADD COLUMN IF NOT EXISTS player_name text,
  ADD COLUMN IF NOT EXISTS table_number integer;

ALTER TABLE public.commander_spending_limits
  ADD COLUMN IF NOT EXISTS session_limit numeric,
  ADD COLUMN IF NOT EXISTS time_limit_hours numeric,
  ADD COLUMN IF NOT EXISTS enabled boolean DEFAULT false;

ALTER TABLE public.commander_push_subscriptions
  ADD COLUMN IF NOT EXISTS endpoint text,
  ADD COLUMN IF NOT EXISTS subscription_data jsonb,
  ADD COLUMN IF NOT EXISTS platform text,
  ADD COLUMN IF NOT EXISTS device_id text,
  ADD COLUMN IF NOT EXISTS venue_id integer,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
