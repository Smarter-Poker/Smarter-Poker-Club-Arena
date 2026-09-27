-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417193634 "phase22_stale_game_janitor_revoke_public"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 62a08509fbf11604606eb0bf7fd6d763 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Revoke the Postgres default PUBLIC grant on the janitor so only
-- service_role can invoke it (intended as cron-only).
REVOKE EXECUTE ON FUNCTION public.fn_cleanup_stale_scheduled_home_games(int)
    FROM PUBLIC;
-- Re-grant only to service_role
GRANT EXECUTE ON FUNCTION public.fn_cleanup_stale_scheduled_home_games(int)
    TO service_role;
