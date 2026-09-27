-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819225322 "tmp_union_dump_helper"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 369aa02f48b5222b6d3e72b47dfc9137 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION _lb_dump_union()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_union_leaderboard_period_v2';
$$;
GRANT EXECUTE ON FUNCTION _lb_dump_union() TO authenticated;
