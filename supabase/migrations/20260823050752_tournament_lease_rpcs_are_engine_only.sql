-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823050752 "tournament_lease_rpcs_are_engine_only"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 24e7098d67445ff2425dfe7be88d615e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The three engine tournament-lease RPCs were SECURITY DEFINER, writable, and
-- EXECUTE-able by anon and authenticated with no auth.uid() check - so any
-- unauthenticated caller could claim, heartbeat or release a tournament lease
-- and stall or disrupt tournament processing. They arrived that way because
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public
-- function to anon/authenticated/service_role, exactly like the
-- CREATE-TABLE-inherits-grants hazard recorded on 2026-08-22; a REVOKE FROM
-- PUBLIC in the creating migration would not have removed those explicit
-- grants either.
--
-- They also failed the required economy invariant
-- `anon_mutating_definer_functions_check_auth_uid`, which reads the LIVE
-- catalog - so it lands on every open pull request in the estate and belongs
-- to nobody's diff. CHECK 10 was red for everyone until this.
--
-- Nothing in either repository calls them: they are engine coordination,
-- invoked from Hetzner with SUPABASE_SERVICE_ROLE_KEY. service_role and
-- postgres keep EXECUTE, so the engine is untouched; only the browser roles
-- lose an ability they never used.
REVOKE EXECUTE ON FUNCTION public.claim_tournament_lease(uuid, text, text, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.heartbeat_tournament_leases(text, uuid[]) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_tournament_leases(text, uuid[]) FROM anon, authenticated;

DO $$
DECLARE v_bad int; v_svc int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('claim_tournament_lease','heartbeat_tournament_leases','release_tournament_leases')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'lease RPCs still reachable by a browser role (% of 3)', v_bad;
  END IF;

  -- The engine must not lose them.
  SELECT count(*) INTO v_svc
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('claim_tournament_lease','heartbeat_tournament_leases','release_tournament_leases')
    AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_svc <> 3 THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on a lease RPC (% of 3 remain)', v_svc;
  END IF;
END $$;
