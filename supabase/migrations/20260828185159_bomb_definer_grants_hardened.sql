-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828185159; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

REVOKE ALL ON FUNCTION public.fn_clone_table_row(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_clone_table_row(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.fn_request_manual_bomb_pot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_request_manual_bomb_pot(uuid) TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_clone_table_row'
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'assertion failed: a browser role can still execute fn_clone_table_row';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_request_manual_bomb_pot'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'assertion failed: anon can still execute fn_request_manual_bomb_pot';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_request_manual_bomb_pot'
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'assertion failed: authenticated lost EXECUTE on fn_request_manual_bomb_pot';
  END IF;
END $$;
