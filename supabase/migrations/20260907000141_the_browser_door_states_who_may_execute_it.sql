-- THE BROWSER DOOR STATES WHO MAY EXECUTE IT.
--
-- 20260906233722 replaced `atomic_tournament_register` to give it the capacity
-- test and the row lock it never had. The replacement was correct and the
-- grant that came with it was not: this database carries an [autorevoke] event
-- trigger that strips PUBLIC and anon EXECUTE from any function as it is
-- created, and this function had been reachable ONLY through the Postgres
-- default - EXECUTE held by PUBLIC, never revoked, never granted to anybody by
-- name. Measured immediately after that migration:
--
--   atomic_tournament_register   authenticated=false anon=false service_role=false
--
-- which is nobody at all. It is called from the browser
-- (`src/services/TournamentService.ts`, `AgentManagementPage.tsx`), so for the
-- minutes between the two migrations a player pressing Register got a
-- permission error. That is my regression, it was found by reading the
-- catalogue rather than by a player reporting it, and this is the correction.
--
-- IT IS ALSO THE LESSON 20260906153725 ALREADY WROTE DOWN, arriving from the
-- other direction. That migration stated the grants for three functions whose
-- ACLs happened to be correct, because a file that says nothing about who may
-- execute a function is a file that does not mean what it says. Here the ACL
-- was NOT already correct - it was the bare default - and the same event
-- trigger that has been quietly protecting new functions took it away the
-- moment the function was rewritten. A permission nobody has written down is a
-- permission that survives only until the next CREATE OR REPLACE.
--
-- WHO GETS IT, and why this is not a widening. `atomic_tournament_register` is
-- SECURITY INVOKER: it runs as the caller, under RLS, exactly as it did when
-- PUBLIC held the grant. Naming `authenticated` restores the reachability the
-- browser has always had and no more - `anon` is not named, so a signed-out
-- visitor cannot reach it, which the old PUBLIC grant did allow. The engine
-- gets it too because the service role calls the registration paths.
--
-- GRANT and REVOKE do not fire pgrst_ddl_watch (production DDL policy, rule
-- 5), so this costs no schema reload.

BEGIN;

REVOKE ALL ON FUNCTION public.atomic_tournament_register(uuid, uuid, text, numeric, numeric, numeric, boolean, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_tournament_register(uuid, uuid, text, numeric, numeric, numeric, boolean, uuid)
  TO authenticated, service_role;

DO $verify$
DECLARE v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'atomic_tournament_register';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'ABORT: atomic_tournament_register is not there to grant';
  END IF;

  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the browser still cannot register for a tournament';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the engine cannot execute the registration door';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a signed-out visitor can execute the registration door';
  END IF;

  RAISE NOTICE 'BROWSER_DOOR_GRANTED authenticated and service_role hold EXECUTE; anon does not';
END $verify$;

COMMIT;
