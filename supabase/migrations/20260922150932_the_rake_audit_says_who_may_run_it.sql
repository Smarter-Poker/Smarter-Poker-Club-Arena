-- 20260922150932_the_rake_audit_says_who_may_run_it
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 15:09:32 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- 20260922142525 (recorded as 20260922150512) replaced fn_rake_bbj_invariants
-- with CREATE OR REPLACE. That keeps the function's existing grants, and its
-- own verify block proved the ACL is still exactly
-- {postgres=X/postgres,service_role=X/postgres}. But the file never SAYS so,
-- and scripts/ci/check-definer-authorization.mjs judges a SECURITY DEFINER
-- declaration by the grants written in the branch: with none written, it
-- reads the function as open to anon, which is what a brand-new function
-- would be. The pre-push gate refused the branch on exactly that.
--
-- WHAT THIS CHANGES
--
-- Nothing in the live ACL. It writes the grant down beside the declaration:
-- revoke from PUBLIC, anon and authenticated, grant EXECUTE to service_role
-- (its only caller is fn_rake_bbj_audit, on the service-role cron path), and
-- proves the ACL is still exactly what it was. fn_rake_bbj_invariants is not
-- an RLS policy helper; the first block below refuses if any policy names it.
--
-- @live-proof: (SELECT p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_rake_bbj_invariants')
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $policy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy
              WHERE pg_get_expr(polqual, polrelid) ~ 'fn_rake_bbj_invariants'
                 OR pg_get_expr(polwithcheck, polrelid) ~ 'fn_rake_bbj_invariants') THEN
    RAISE EXCEPTION 'failed: fn_rake_bbj_invariants backs an RLS policy; revoking would deny its table';
  END IF;
END $policy$;

REVOKE ALL ON FUNCTION public.fn_rake_bbj_invariants(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_bbj_invariants(integer) TO service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_rake_bbj_invariants'
                    AND p.prosecdef
                    AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'failed: fn_rake_bbj_invariants grants are not exactly postgres and service_role';
  END IF;
  IF has_function_privilege('anon', 'public.fn_rake_bbj_invariants(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_rake_bbj_invariants(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: a browser role can run the rake audit';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_rake_bbj_invariants(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: the audit path can no longer run the rake audit';
  END IF;
END $verify$;

COMMIT;
