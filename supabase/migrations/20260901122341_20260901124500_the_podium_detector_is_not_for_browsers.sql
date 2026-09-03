-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901122341; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_detect_results_without_a_hand landed at 12:22 UTC on 2026-09-01 with
-- GRANT EXECUTE ... TO service_role and no REVOKE, so PUBLIC kept the default
-- grant every new function is created with and `authenticated` inherited it.
-- Granting the role you want does not take it away from everyone else.
--
-- Only the engine calls it (GameServer, as service_role). No browser path
-- exists, so nothing is lost by closing it.

REVOKE ALL ON FUNCTION public.fn_detect_results_without_a_hand(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_detect_results_without_a_hand(integer) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_detect_results_without_a_hand(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_detect_results_without_a_hand(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_detect_results_without_a_hand is still reachable from a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_detect_results_without_a_hand(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_detect_results_without_a_hand is no longer reachable by service_role';
  END IF;
END $$;
