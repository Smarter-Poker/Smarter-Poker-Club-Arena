-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511220112 "phantom_rpcs_r5_drop_report_live_game_uuid_overload"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 009b8f82087e109e6bc1592886102250 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The phantom_rpcs.sql shipped report_live_game with p_venue_id uuid,
-- but live_games.venue_id is integer and clients send parseInt. The
-- uuid overload is the stub from 20260314; my R5 migration added the
-- correct integer overload but left this dead stub in place.
DROP FUNCTION IF EXISTS public.report_live_game(uuid, uuid, text, text, integer, integer, integer, text, text);

-- Final verification: confirm only the real (integer, uuid, ...) overload remains
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  pg_get_function_result(p.oid) AS returns,
  length(p.prosrc) AS body_len
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'report_live_game';
