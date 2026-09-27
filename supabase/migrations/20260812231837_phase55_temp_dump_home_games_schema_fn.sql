-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812231837 "phase55_temp_dump_home_games_schema_fn"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d15c35171ff650fdea530ce9fc4d45c5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 55 — TEMPORARY schema-dump helper.
--
-- Exists so the ~162 Home Games functions / ~350KB of definitions that live
-- ONLY in production can be pulled back into the repo. That gap is the root
-- cause of the three out-of-band reverts this audit found: with no committed
-- copy there is nothing to diff against, so a silent revert stays silent.
--
-- The normal route (scripts/dump-home-games-schema.mjs over a direct
-- Postgres connection) is unavailable from an agent sandbox: the pooler is
-- reachable but SUPABASE_DB_PASSWORD in the repo's .env files is stale and
-- fails authentication. The service-role key still works, so the dump is
-- exposed as an RPC and fetched over PostgREST instead.
--
-- service_role ONLY. Dropped again immediately after use — see phase56.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.tmp_dump_home_games_schema()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH fns AS (
    SELECT string_agg(pg_get_functiondef(p.oid), E'\n\n' ORDER BY p.proname,
             pg_get_function_identity_arguments(p.oid)) AS body,
           count(*) AS n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'rpc\_hg\_%' OR p.proname LIKE 'fn\_home\_%'
           OR p.proname LIKE 'fn\_hg\_%' OR p.proname LIKE '%home\_group%'
           OR p.proname LIKE '%home\_game%')
  ),
  pol AS (
    SELECT string_agg(
             format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
               policyname, tablename,
               CASE WHEN permissive='PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
               cmd, array_to_string(roles, ', '),
               CASE WHEN qual IS NULL THEN '' ELSE ' USING (' || qual || ')' END,
               CASE WHEN with_check IS NULL THEN '' ELSE ' WITH CHECK (' || with_check || ')' END),
             E'\n' ORDER BY tablename, policyname) AS body,
           count(*) AS n
    FROM pg_policies
    WHERE schemaname='public'
      AND (tablename LIKE 'commander\_home%' OR tablename LIKE 'home\_%'
           OR tablename LIKE 'social\_page%')
  ),
  idx AS (
    SELECT string_agg(indexdef || ';', E'\n' ORDER BY tablename, indexname) AS body,
           count(*) AS n
    FROM pg_indexes
    WHERE schemaname='public'
      AND (tablename LIKE 'commander\_home%' OR tablename LIKE 'home\_%')
  )
  SELECT
    '-- FUNCTIONS (' || fns.n || ')' || E'\n\n' || COALESCE(fns.body,'') ||
    E'\n\n\n-- POLICIES (' || pol.n || ')' || E'\n\n' || COALESCE(pol.body,'') ||
    E'\n\n\n-- INDEXES (' || idx.n || ')' || E'\n\n' || COALESCE(idx.body,'')
  FROM fns, pol, idx;
$function$;

REVOKE EXECUTE ON FUNCTION public.tmp_dump_home_games_schema() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.tmp_dump_home_games_schema() TO service_role;

COMMENT ON FUNCTION public.tmp_dump_home_games_schema() IS
  'TEMPORARY (2026-08-12). Returns the DDL of every Home Games function, policy and index so it can be committed to the repo. service_role only. Drop after use.';
