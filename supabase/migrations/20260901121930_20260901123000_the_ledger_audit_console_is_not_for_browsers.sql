-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901121930; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_ca_unledgered_insert_paths is an operator audit: it enumerates every
-- table whose insert path is NOT covered by a ledger trigger. That is a map of
-- where money can move without being written down, and it was SECURITY DEFINER,
-- took no identity argument, and executable by anon and authenticated -- so any
-- logged-in browser, and any visitor at all, could read it.
--
-- It appeared in production between 11:33 and 12:17 UTC on 2026-09-01 and the
-- Telemetry Exposure gate caught it on the next branch that ran, correctly and
-- immediately. Nothing in the browser calls it; the engine and operator tooling
-- reach it as service_role.

REVOKE ALL ON FUNCTION public.fn_ca_unledgered_insert_paths() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_unledgered_insert_paths() TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_ca_unledgered_insert_paths()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_unledgered_insert_paths()', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_unledgered_insert_paths is still reachable from a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_unledgered_insert_paths()', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_unledgered_insert_paths is no longer reachable by service_role';
  END IF;
END $$;
