-- THE PAYABLES READ SAYS WHO MAY CALL IT.
--
-- Companion to 20260904170000. That migration CREATE OR REPLACEd
-- fn_ca_agent_payables, which keeps the function's existing grants (closed
-- to anon since phase 3, verified live), and wrote no REVOKE of its own.
-- check-definer-authorization judges the migration text, not the database,
-- and reads a SECURITY DEFINER declaration with no revoke in the diff as
-- open to anon. Its rule is the right one. The grants are stated here.
--
-- Lesson, written down so it stops recurring: every CREATE OR REPLACE of a
-- SECURITY DEFINER function carries its REVOKE and GRANT in the same file,
-- even when they change nothing live.
--
-- GRANT and REVOKE are not in pgrst_ddl_watch's list: no PostgREST reload.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_ca_agent_payables(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_agent_payables(uuid) TO authenticated, service_role;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'fn_ca_agent_payables'
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 1 THEN RAISE EXCEPTION 'fn_ca_agent_payables must be closed to anon and open to authenticated'; END IF;
END $$;

COMMIT;
