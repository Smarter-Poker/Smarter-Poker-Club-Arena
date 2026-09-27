-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821040552 "revoke_anon_execute_fn_create_tournament"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 51e409e3753354d38df7663ba00ad334 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- fn_create_tournament is SECURITY DEFINER and creates games that move money.
-- It was executable by `anon`. The body refuses immediately when auth.uid() is
-- NULL, so this was not an open door - but the repo's own standing rule
-- (supabase/migrations/20260816_revoke_anon_execute_on_definer_functions.sql)
-- is that no definer function is reachable by anon, and a rewrite of this
-- function on 2026-08-20 left the default PUBLIC grant in place.
--
-- Depending on a single in-body check for a function anonymous callers can
-- reach is one refactor away from being wrong. Close it at the grant.

REVOKE ALL ON FUNCTION public.fn_create_tournament(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_create_tournament(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_create_tournament(uuid, jsonb) TO authenticated;

DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.fn_create_tournament(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute fn_create_tournament';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_create_tournament(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost execute on fn_create_tournament - tournament creation would break';
  END IF;
END
$post$;
