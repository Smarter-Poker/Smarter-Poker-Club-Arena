-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901184912; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Declarative only: verified already true in production before applying.
-- GRANT/REVOKE do not fire pgrst_ddl_watch, so this costs no schema reload.
-- Keeps the repository file and the live catalogue saying the same thing.

REVOKE ALL ON FUNCTION public.fn_ca_auto_reconcile_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_auto_reconcile_tick() TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_ca_auto_reconcile_tick()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_auto_reconcile_tick()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can still execute the auto-reconciler';
  END IF;
END $$;

