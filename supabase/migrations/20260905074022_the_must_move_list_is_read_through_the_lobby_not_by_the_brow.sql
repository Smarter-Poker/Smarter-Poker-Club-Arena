-- 20260905074022_the_must_move_list_is_read_through_the_lobby_not_by_the_brow.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- The Telemetry Exposure check (scripts/ci/check-telemetry-exposure.mjs) has
-- been red on every pull request since #3055 landed: fn_cash_game_must_move_list
-- is SECURITY DEFINER, takes no identity argument, never looks at who is
-- calling, and was granted to `authenticated`. Nothing in the client calls
-- it - the in-table lobby reads fn_cash_game_lobby (src/services/
-- cashGameLobby.ts), which is itself SECURITY DEFINER and calls
-- fn_cash_game_must_move_list internally as the owner. So the grant to the
-- browser bought nothing and opened a list a browser had no business asking
-- for directly. Revoked; the lobby keeps working because a definer runs as
-- its owner, not as the caller.
--
-- Grants only. GRANT/REVOKE do not fire the schema-cache reload.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.fn_cash_game_must_move_list(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_game_must_move_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_must_move_list(uuid) TO service_role;

COMMIT;
