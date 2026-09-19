-- 20260919173446_the_definer_recreated_inherits_default_privileges
--
-- Applied to production as version 20260919173340 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- 20260919172244 recreated public.fn_ca_cron_health(interval) with DROP and
-- CREATE, because RETURNS TABLE gained two columns. It restored the grant it
-- knew about:
--
--   REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION ... TO service_role;
--
-- That is not sufficient on this project. ALTER DEFAULT PRIVILEGES grants
-- EXECUTE on newly created functions in schema public to anon, authenticated
-- and service_role. Those arrive as EXPLICIT role grants on the new function,
-- not as anything PUBLIC holds, so revoking PUBLIC does not remove them.
--
-- MEASURED. Before:
--   postgres=X/postgres | service_role=X/postgres
-- After 20260919172244:
--   postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres
--
-- has_function_privilege('anon', ..., 'EXECUTE') returned true. A SECURITY
-- DEFINER function that reads cron.job and cron.job_run_details, and which no
-- browser role had ever been able to call, became callable by an
-- unauthenticated PostgREST caller. It is read-only and exposes scheduled job
-- names, schedules and error text rather than player data, which is why this
-- is a permission regression and not an incident, but it is still a door that
-- was shut and is now open.
--
-- The pre-push hook check-definer-authorization refused the push and named
-- exactly this: "SECURITY DEFINER, anon can execute it, and it never calls
-- auth.uid()". Its remedy text says to name PUBLIC AND the roles, because
-- naming one of them reads as a fix and does nothing. The guard was right and
-- the migration that tripped it was mine. The guard is the reason this was
-- caught before the push rather than after it.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- The revoke names PUBLIC, anon and authenticated explicitly, restoring the
-- pre-20260919172244 reachability exactly: postgres and service_role only.
--
-- 20260919172421 (the repo file for 20260919172244) has been corrected to the
-- same explicit form, so a fresh rebuild never opens the door and this
-- migration is a no-op there. It is kept because production took two steps and
-- every applied migration must have a file.
--
-- This is the general hazard for every DROP and CREATE of a SECURITY DEFINER
-- function in this project, not a detail of this one. A CREATE OR REPLACE
-- keeps the existing ACL and is unaffected; a DROP discards it and the
-- recreate then picks up default privileges. Any future recreate must revoke
-- from the named roles, not from PUBLIC alone.
--
-- @live-proof: (SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_cron_health')
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

REVOKE ALL ON FUNCTION public.fn_ca_cron_health(interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_cron_health(interval) TO service_role;

DO $verify$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_cron_health';

  -- The door is shut.
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: anon can still execute fn_ca_cron_health';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: authenticated can still execute fn_ca_cron_health';
  END IF;

  -- Both directions (the 7.2 rule): revoking from everybody would also pass
  -- the two assertions above, and would silently break CI's cron health read.
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: service_role lost EXECUTE, which is the caller CI uses';
  END IF;

  RAISE NOTICE 'fn_ca_cron_health reachability restored to service_role only';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
