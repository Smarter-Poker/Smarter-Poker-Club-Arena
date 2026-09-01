-- Applied to production under this name; the same two statements are also
-- appended to 20260901180325_resolution_law_closes_the_auto_repair_door.sql,
-- which is where the pre-push definer gate reads them. Kept so the production
-- migration list and the repository reconcile one to one.
--
-- Declarative only: verified already true in production before applying.
-- GRANT/REVOKE do not fire pgrst_ddl_watch, so this costs no schema reload.

REVOKE ALL ON FUNCTION public.fn_ca_auto_reconcile_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_auto_reconcile_tick() TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_ca_auto_reconcile_tick()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_auto_reconcile_tick()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can still execute the auto-reconciler';
  END IF;
END $$;
