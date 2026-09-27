-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424014238 "20260421180000_hg_drop_dead_stub_increment_home_game_stats"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e0913348ec85735131fb2ee225a6ab7a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bug hunt: drop dead stub. increment_home_game_stats has an empty body
-- ("-- stub") and zero callers (no RPC, no trigger). Remove to keep
-- surface clean and prevent accidental wiring.
DROP FUNCTION IF EXISTS public.increment_home_game_stats(uuid);
