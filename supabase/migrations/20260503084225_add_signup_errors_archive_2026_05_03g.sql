-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503084225 "add_signup_errors_archive_2026_05_03g"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cb996640f4b77b08df34039437dab5ef of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- BUILD 6: signup_errors long-term archival
-- ─────────────────────────────────────────────────────────────────────────
-- Adds public.signup_errors_archive (same schema as signup_errors plus
-- archived_at) + an RPC that moves rows older than 30 days from the live
-- table to the archive. Cron should call the RPC nightly.
--
-- Why archive instead of just keeping everything in signup_errors?
-- The live table is queried by signup_health_view + dashboards. Keeping
-- a year of errors there bloats the index. Archive keeps forensics
-- without performance cost.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.signup_errors_archive (
  id           bigserial PRIMARY KEY,
  original_id  bigint NOT NULL,
  user_id      uuid,
  email        text,
  trigger_name text NOT NULL,
  error_code   text,
  error_msg    text,
  raw_meta     jsonb,
  occurred_at  timestamptz NOT NULL,
  forwarded_to_sentry timestamptz,
  archived_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_errors_archive_occurred_idx
  ON public.signup_errors_archive (occurred_at DESC);
CREATE INDEX IF NOT EXISTS signup_errors_archive_email_idx
  ON public.signup_errors_archive (email);

ALTER TABLE public.signup_errors_archive ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signup_errors_archive_service_only ON public.signup_errors_archive;
CREATE POLICY signup_errors_archive_service_only
  ON public.signup_errors_archive FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── RPC: archive_signup_errors() — moves rows >30 days old ────────────────
CREATE OR REPLACE FUNCTION public.archive_signup_errors(older_than_days int DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    moved_count int := 0;
    cutoff timestamptz := now() - (older_than_days || ' days')::interval;
BEGIN
    -- Idempotent: skip rows we've already archived
    WITH moved AS (
        INSERT INTO public.signup_errors_archive
            (original_id, user_id, email, trigger_name, error_code, error_msg,
             raw_meta, occurred_at, forwarded_to_sentry)
        SELECT id, user_id, email, trigger_name, error_code, error_msg,
               raw_meta, occurred_at, forwarded_to_sentry
        FROM public.signup_errors
        WHERE occurred_at < cutoff
          AND NOT EXISTS (
              SELECT 1 FROM public.signup_errors_archive a
              WHERE a.original_id = signup_errors.id
          )
        RETURNING original_id
    )
    DELETE FROM public.signup_errors WHERE id IN (SELECT original_id FROM moved);

    GET DIAGNOSTICS moved_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'moved', moved_count,
        'cutoff', cutoff,
        'older_than_days', older_than_days
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.archive_signup_errors(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_signup_errors(int) TO service_role;

COMMENT ON FUNCTION public.archive_signup_errors(int) IS
  'Moves signup_errors rows older than N days (default 30) to signup_errors_archive. Idempotent — safe to run repeatedly. Returns jsonb with count moved.';
