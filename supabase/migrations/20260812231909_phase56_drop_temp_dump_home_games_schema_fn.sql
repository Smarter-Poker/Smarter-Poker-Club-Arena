-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812231909 "phase56_drop_temp_dump_home_games_schema_fn"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e7714c2df3b4229bb4dd3aa02c01e880 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 56 — drop the temporary dump helper created in phase55.
--
-- Its only purpose was to move the live Home Games DDL into the repo
-- (committed as supabase/migrations/ZZZZ_snapshot_home_games_schema.sql:
-- 164 functions, 98 policies, 144 indexes). That is done, so the function is
-- removed rather than left behind as standing surface area.
--
-- Regeneration from here on goes through scripts/dump-home-games-schema.mjs
-- over a direct Postgres connection, which needs no server-side helper. Note
-- that SUPABASE_DB_PASSWORD in the repo's .env files is currently STALE and
-- fails authentication — refresh it before relying on that path.

DROP FUNCTION IF EXISTS public.tmp_dump_home_games_schema();

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'tmp_dump_home_games_schema'
    ) THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: tmp_dump_home_games_schema still exists';
    END IF;
    RAISE NOTICE 'phase56 OK: temporary dump helper removed.';
END $$;
