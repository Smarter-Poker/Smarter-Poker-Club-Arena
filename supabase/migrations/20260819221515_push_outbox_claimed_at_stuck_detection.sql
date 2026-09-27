-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819221515 "push_outbox_claimed_at_stuck_detection"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6aba01f2934981c4cbc5471cf35f9af2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- PUSH OUTBOX — correct stuck-row detection                        Tier 2
-- ============================================================================
-- requeue_stuck_push_outbox() decided a row was "stuck in processing" using
-- created_at, which is when the row was ENQUEUED, not when it was claimed:
--
--   WHERE status='processing' AND sent_at IS NULL
--     AND created_at < now() - make_interval(mins => p_stale_minutes)
--
-- A row enqueued 20 minutes ago and claimed 30 seconds ago already satisfies
-- that. push-dispatch is serial over up to 100 rows, each doing several round
-- trips plus a network push per device, so a run can outlive its 5-minute slot.
-- The next slot then calls requeue FIRST, flips the in-flight rows back to
-- 'pending', and re-claims them -- the user gets the same notification twice.
-- The (job, slot) dedupe cannot prevent this, because a genuine 5-minutes-later
-- fire legitimately owns a different slot.
--
-- Fix: record when the row was actually claimed and key the predicate on that.
-- ============================================================================

ALTER TABLE public.push_outbox
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Existing in-flight rows: treat "claimed" as "created" once, so the new
-- predicate has a value to compare and cannot strand them forever.
UPDATE public.push_outbox
   SET claimed_at = COALESCE(claimed_at, created_at)
 WHERE status = 'processing' AND claimed_at IS NULL;

CREATE INDEX IF NOT EXISTS push_outbox_processing_claimed_idx
  ON public.push_outbox(claimed_at) WHERE status = 'processing';

-- Stamp claimed_at at claim time.
CREATE OR REPLACE FUNCTION public.claim_push_outbox_batch(
  p_limit int DEFAULT 100,
  p_max_attempts int DEFAULT 5
)
RETURNS SETOF public.push_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN QUERY
  UPDATE public.push_outbox
     SET status = 'processing',
         attempts = attempts + 1,
         claimed_at = now()
   WHERE id IN (
     SELECT id FROM public.push_outbox
      WHERE status = 'pending'
        AND attempts < p_max_attempts
      ORDER BY created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
END;
$fn$;

-- Requeue only rows whose CLAIM is stale.
CREATE OR REPLACE FUNCTION public.requeue_stuck_push_outbox(
  p_stale_minutes int DEFAULT 15
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_count int;
BEGIN
  UPDATE public.push_outbox
     SET status = 'pending'
   WHERE status = 'processing'
     AND sent_at IS NULL
     AND COALESCE(claimed_at, created_at) < now() - make_interval(mins => p_stale_minutes);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_push_outbox_batch(int, int) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.requeue_stuck_push_outbox(int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_push_outbox_batch(int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_stuck_push_outbox(int) TO service_role;

-- POST-APPLY ASSERTIONS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='push_outbox' AND column_name='claimed_at'
  ) THEN
    RAISE EXCEPTION 'claimed_at was not created';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.push_outbox WHERE status='processing' AND claimed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'processing rows still have NULL claimed_at';
  END IF;
  IF pg_get_functiondef('public.requeue_stuck_push_outbox(int)'::regprocedure) NOT LIKE '%claimed_at%' THEN
    RAISE EXCEPTION 'requeue still keys on created_at';
  END IF;
END $$;

-- ROLLBACK
-- ALTER TABLE public.push_outbox DROP COLUMN IF EXISTS claimed_at;
-- (restore prior function bodies from 20260819120000_webpush_vapid_stack.sql)
