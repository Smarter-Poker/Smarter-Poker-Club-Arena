-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819221918 "tmp_lb_dump_helper"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 dd268a9a092b41482114826d8cafb7e6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Temporary helper used to mirror the applied leaderboard SQL back into the
-- repo byte-for-byte. Dropped immediately after use in the same session.
CREATE OR REPLACE FUNCTION _lb_dump_defs()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT string_agg(d, E';\n\n' ORDER BY o)
  FROM (
    SELECT 1 o, pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_fold_hand_winnings'
    UNION ALL SELECT 2, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_snapshot_player_stats'
    UNION ALL SELECT 3, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_club_leaderboard_period_v2'
    UNION ALL SELECT 4, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_global_leaderboard_period'
  ) t;
$$;
GRANT EXECUTE ON FUNCTION _lb_dump_defs() TO authenticated;
