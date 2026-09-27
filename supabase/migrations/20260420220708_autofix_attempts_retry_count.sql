-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420220708 "autofix_attempts_retry_count"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3f26feb3fa5e9f5c4a80fa90cb456f33 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Add retry tracking to autofix_attempts so the poller can automatically retry rejected/errored attempts with exponential cooldown.
ALTER TABLE public.autofix_attempts
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NULL;

-- Query planner speed for the poller's "find retryable" lookup.
CREATE INDEX IF NOT EXISTS autofix_attempts_issue_created_idx
  ON public.autofix_attempts (sentry_issue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS autofix_attempts_status_next_retry_idx
  ON public.autofix_attempts (status, next_retry_at)
  WHERE status IN ('rejected','errored');

COMMENT ON COLUMN public.autofix_attempts.retry_count IS
  'Number of previous rejected/errored attempts for this Sentry issue. Poller uses this to cap retries and set next_retry_at.';
COMMENT ON COLUMN public.autofix_attempts.next_retry_at IS
  'If status in (rejected,errored), earliest wall-clock time the poller is allowed to re-dispatch. NULL = never retry.';
