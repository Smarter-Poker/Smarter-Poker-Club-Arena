-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901140811; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The pre-push definer gate refused the mirror of
-- a_guard_notice_you_can_actually_review because it re-declares
-- fn_ca_guard_defs_watch, a SECURITY DEFINER function that writes and never
-- asks who is calling.
--
-- Checked against production before answering it: anon and authenticated
-- already have NO execute here and service_role has it, and CREATE OR REPLACE
-- does not touch grants, so nothing was exposed and the migration changed
-- nothing. The gate reads the migration text rather than the live catalogue,
-- and it is right to - a migration that declares a definer writer should say
-- who may call it. This states the end state that already holds.

REVOKE ALL ON FUNCTION public.fn_ca_guard_defs_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_defs_watch() TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_ca_guard_defs_watch()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_guard_defs_watch()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can still execute the guard watcher';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_guard_defs_watch()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost execute on the guard watcher';
  END IF;
END $$;
