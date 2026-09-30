-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820002803 "tmp_dump4"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0a2bd0c776d102dcf5cf7100f61509fb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION _lb_dump4()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT string_agg(d, E';\n\n' ORDER BY o) FROM (
    SELECT 1 o, pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_snapshot_player_stats_if_missing'
    UNION ALL SELECT 2, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_snapshot_health'
    UNION ALL SELECT 3, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_club_member_daily_profit_exact'
    UNION ALL SELECT 4, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_club_profit_drift'
  ) t;
$$;
GRANT EXECUTE ON FUNCTION _lb_dump4() TO authenticated;
