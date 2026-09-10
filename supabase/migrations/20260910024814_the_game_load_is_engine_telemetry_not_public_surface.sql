-- the_game_load_is_engine_telemetry_not_public_surface
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS DOES (2026-09-10): states the grant fn_concurrent_game_load already
-- carries. 20260910022325 redefined the function (CREATE OR REPLACE preserves
-- the ACL, and the live ACL is {postgres, service_role} - no PUBLIC, no anon,
-- no authenticated), but check-definer-authorization reads grants from the
-- migration files of a branch, and a SECURITY DEFINER function that never
-- asks who is calling must say in the repo that a browser cannot reach it.
-- The cap triggers and the money paths that read it run as their owner, so
-- nothing a player does goes through this grant. GRANT/REVOKE are not in
-- pgrst_ddl_watch: no schema-cache reload, no player-facing cost.

BEGIN;
REVOKE ALL ON FUNCTION public.fn_concurrent_game_load(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_concurrent_game_load(uuid, uuid, uuid, uuid) TO service_role;
COMMIT;
