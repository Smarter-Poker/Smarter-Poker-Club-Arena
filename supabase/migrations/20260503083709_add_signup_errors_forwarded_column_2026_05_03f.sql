-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503083709 "add_signup_errors_forwarded_column_2026_05_03f"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 20e917390bba6745a1284e18dffa49a7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Add forwarded_to_sentry tracking on signup_errors
-- ─────────────────────────────────────────────────────────────────────────
-- The /api/cron/sentry-signup-bridge cron polls signup_errors and pushes
-- new rows to Sentry. We need a way to mark "this row is already in
-- Sentry, don't double-send." A nullable timestamp column does both jobs
-- (NULL = pending, value = forwarded at this time).
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.signup_errors
  ADD COLUMN IF NOT EXISTS forwarded_to_sentry timestamptz;

CREATE INDEX IF NOT EXISTS signup_errors_pending_forward_idx
  ON public.signup_errors (occurred_at)
  WHERE forwarded_to_sentry IS NULL;

COMMENT ON COLUMN public.signup_errors.forwarded_to_sentry IS
  'When this row was pushed to Sentry by /api/cron/sentry-signup-bridge. NULL = pending. Set to NOW() the moment captureMessage succeeds. Indexed (partial) for fast "what is pending?" queries.';
