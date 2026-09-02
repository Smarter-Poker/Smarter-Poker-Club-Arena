-- check-definer-authorization refused the previous migration, correctly.
--
-- 20260902013000 re-declared fn_tournament_management_readiness with
-- CREATE OR REPLACE. That preserves existing grants, so PRODUCTION was never
-- opened up -- verified: service_role only. But a migration file is also a
-- REPLAY script, and replayed into a fresh database that file would create the
-- function with PUBLIC's default EXECUTE and hand every club's treasury
-- balance, floor and live exposure to anonymous callers. The file has to say
-- who may run it, not rely on what production happened to hold already.
--
-- Nothing calls it but its own trigger, which runs as the definer:
-- grep across src/, server/ and pages/ finds no caller at all.
--
-- fn_safe_jsonb_array is tightened in the same breath. It is a pure text
-- parser with no data access, so it is not a disclosure risk, but a brand-new
-- function carries EXECUTE for PUBLIC by default and the house rule is that a
-- migration states its grants rather than leaving the default to speak.

REVOKE ALL ON FUNCTION public.fn_tournament_management_readiness(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_management_readiness(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_safe_jsonb_array(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_safe_jsonb_array(text) TO service_role, authenticated;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_tournament_management_readiness(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_tournament_management_readiness(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the readiness guard is still reachable from a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_tournament_management_readiness(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the readiness guard is no longer reachable by service_role';
  END IF;
  IF has_function_privilege('anon', 'public.fn_safe_jsonb_array(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_safe_jsonb_array is still reachable by anon';
  END IF;
END $$;;
