-- Applied to production 2026-09-01 as schema_migrations version 20260901122257
-- (registered name: 20260901_guard_rls_initplan_regression).
--
-- Phase 4 / 4: stop the auth_rls_initplan lint coming back for an eighth time.
--
-- WHY THIS EXISTS. Before today, seven migrations had already "fixed" this lint:
--   20260520000002_security_advisor_rls_and_initplan_fixes
--   20260622143935_mlb_hr_bets_rls_initplan_optimization
--   20260721184857_db_hygiene_fk_indexes_rls_initplan_agents_policy_20260721
--   20260808222940_perf_wrap_auth_calls_in_rls_initplan
--   20260824193111_rls_initplan_and_duplicate_indexes
--   20260827000323_rake_rls_initplan_optimisation
--   20260830213957_rls_initplan_auth_uid_wrapped      <- yesterday
-- And this morning 15 policies across 13 tables still called auth.uid() bare.
--
-- The sweep is not what fails. Nothing stops the NEXT policy being written with a
-- bare auth.uid(), so the count climbs back between sweeps. That is the same shape
-- as the Phase 3 definer finding: Postgres grants EXECUTE to PUBLIC on every new
-- function, so a sweep of grants was re-dirty within the hour, and the fix was a
-- guard rather than a ninth sweep.
--
-- This reports; it does not rewrite anybody's policy. A CI check reading it turns
-- a regression into a failed pull request instead of a lint nobody reads.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.fn_rls_policies_with_unhoisted_auth();

CREATE OR REPLACE FUNCTION public.fn_rls_policies_with_unhoisted_auth()
RETURNS TABLE (
  table_name  text,
  policy_name text,
  cmd         text,
  roles       text,
  bare_calls  int
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT p.tablename::text,
         p.policyname::text,
         p.cmd::text,
         p.roles::text,
         (regexp_count(lower(coalesce(p.qual,'') || ' || ' || coalesce(p.with_check,'')),
                       'auth\.(uid|role|jwt|email)\(\)')
          - regexp_count(lower(coalesce(p.qual,'') || ' || ' || coalesce(p.with_check,'')),
                       'select auth\.(uid|role|jwt|email)\(\)'))::int
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND regexp_count(lower(coalesce(p.qual,'') || ' || ' || coalesce(p.with_check,'')),
                     'auth\.(uid|role|jwt|email)\(\)')
      > regexp_count(lower(coalesce(p.qual,'') || ' || ' || coalesce(p.with_check,'')),
                     'select auth\.(uid|role|jwt|email)\(\)')
  ORDER BY p.tablename, p.policyname;
$$;

COMMENT ON FUNCTION public.fn_rls_policies_with_unhoisted_auth() IS
  'RLS policies that call auth.uid()/auth.role()/auth.jwt()/auth.email() bare rather '
  'than as (SELECT auth.uid()). A bare call is re-evaluated once per row; wrapped it '
  'becomes an InitPlan evaluated once per query. Must return zero rows. Reports only. '
  'Added 2026-09-01 after the seventh sweep of this same lint failed to hold.';

-- Phase 3 law: write the REVOKE, or Postgres leaves it executable by PUBLIC.
-- This one enumerates the exact shape of every RLS policy on the platform.
REVOKE ALL ON FUNCTION public.fn_rls_policies_with_unhoisted_auth() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_rls_policies_with_unhoisted_auth() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rls_policies_with_unhoisted_auth() TO service_role;

DO $$
DECLARE v_n int; v_anon boolean; v_auth boolean;
BEGIN
  SELECT count(*) INTO v_n FROM public.fn_rls_policies_with_unhoisted_auth();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'guard reports % policies still calling auth.* bare; expected 0', v_n;
  END IF;

  SELECT has_function_privilege('anon',          'public.fn_rls_policies_with_unhoisted_auth()', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.fn_rls_policies_with_unhoisted_auth()', 'EXECUTE')
    INTO v_anon, v_auth;
  IF v_anon OR v_auth THEN
    RAISE EXCEPTION 'fn_rls_policies_with_unhoisted_auth is browser-reachable (anon=%, authenticated=%)',
      v_anon, v_auth;
  END IF;
END $$;
