-- THE DASHBOARD READS SAY WHO MAY CALL THEM.
--
-- Companion to 20260904100000_the_dashboard_counts_what_is_there. That
-- migration CREATE OR REPLACEd ca_club_dashboard_stats and ca_club_revenue
-- and, because CREATE OR REPLACE keeps a function's existing grants, wrote no
-- REVOKE for either. Live, both were already closed to anon (verified
-- 2026-09-04: anon_exec = false, auth_exec = true for every dashboard
-- function). But scripts/ci/check-definer-authorization.mjs cannot see the
-- live database; it judges the migration text, and a SECURITY DEFINER
-- declaration with no revoke in the branch reads as open. Its rule is the
-- right one - a definer read with no auth call is exactly the shape that
-- leaked schema metadata on 2026-08-31 - so the grants are stated here in
-- full, in the repo, where a rebuild would find them.
--
-- GRANT and REVOKE are not in pgrst_ddl_watch's list: no PostgREST schema
-- reload. Applied as its own migration rather than by editing the applied
-- one, which is not done.

BEGIN;

REVOKE ALL ON FUNCTION public.ca_club_dashboard_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_dashboard_stats(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ca_club_revenue(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_revenue(uuid, integer) TO authenticated, service_role;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('ca_club_dashboard_stats', 'ca_club_revenue')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 2 THEN RAISE EXCEPTION 'expected both dashboard reads closed to anon and open to authenticated, found %', n; END IF;
END $$;

COMMIT;
