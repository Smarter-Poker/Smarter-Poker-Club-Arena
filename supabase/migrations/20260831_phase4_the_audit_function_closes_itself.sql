-- ══════════════════════════════════════════════════════════════════════════
--  THE NEW GATE'S FIRST CATCH WAS THE MIGRATION THAT SHIPPED IT
-- ══════════════════════════════════════════════════════════════════════════
--
-- check-definer-authorization.mjs learned today to fail a NEW SECURITY DEFINER
-- function that a caller with no account can execute. Run against the branch
-- that added it, it flagged
-- 20260831_phase4_the_daily_sweep_learns_to_see_readers.sql -- for declaring
-- fn_definer_exposure_audit() with no GRANT or REVOKE beside it.
--
-- ON PRODUCTION THAT IS A FALSE ALARM: the function already existed with anon
-- and authenticated revoked, and CREATE OR REPLACE PRESERVES EXISTING GRANTS,
-- so nothing opened. Verified after applying: anon=false, authenticated=false,
-- service_role=true.
--
-- ON A FRESH DATABASE IT IS NOT. Replay these migrations into an empty project
-- and CREATE FUNCTION takes the Postgres default, which is EXECUTE to PUBLIC --
-- and every browser role inherits PUBLIC. The security audit itself, the
-- function that enumerates every SECURITY DEFINER function in the schema and
-- every RLS-disabled writable table, would answer anybody who asked.
--
-- That is the whole argument for `silence means open`. A migration that relies
-- on the grants a previous migration happened to leave behind is only correct
-- in the one database that has that history.
--
-- So the grant becomes explicit and the migration becomes self-contained. It is
-- a no-op here and load-bearing anywhere else.

REVOKE ALL ON FUNCTION public.fn_definer_exposure_audit()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_definer_exposure_audit()
  TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_definer_exposure_audit()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_definer_exposure_audit()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the exposure audit is still reachable from a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_definer_exposure_audit()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the exposure audit lost service_role - the daily sweep is broken';
  END IF;
END $$;
