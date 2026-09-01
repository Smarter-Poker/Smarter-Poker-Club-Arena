-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901015506; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

REVOKE ALL ON FUNCTION public.cleanup_rate_limits() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_rate_limits() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_rate_limits() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits() TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.cleanup_rate_limits()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute the rate-limit cleanup';
  END IF;
  IF has_function_privilege('authenticated', 'public.cleanup_rate_limits()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still execute the rate-limit cleanup';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.cleanup_rate_limits()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost execute on the rate-limit cleanup';
  END IF;
END $$;
