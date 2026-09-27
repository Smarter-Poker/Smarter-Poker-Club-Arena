-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819235941 "tmp_dump_helper_v3"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 250ab362ee766b65ff37830890db888a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION _lb_dump3()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT string_agg(d, E';\n\n' ORDER BY o) FROM (
    SELECT 1 o, pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_fold_hand_winnings'
    UNION ALL SELECT 2, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_snapshot_player_stats'
    UNION ALL SELECT 3, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_leaderboard_snapshot_gaps'
    UNION ALL SELECT 4, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_club_leaderboard_period_v2'
    UNION ALL SELECT 5, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_global_leaderboard_period'
    UNION ALL SELECT 6, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='update_player_hand_stats'
  ) t;
$$;
GRANT EXECUTE ON FUNCTION _lb_dump3() TO authenticated;
