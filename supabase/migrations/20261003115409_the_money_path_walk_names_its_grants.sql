-- 20261003115409_the_money_path_walk_names_its_grants.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE MONEY PATH WALK NAMES ITS GRANTS (phase 5 of 9). Companion to
-- 20261003103506_the_money_path_walk_stops_at_the_first_door, which replaced
-- the body of fn_money_path_reaches_club_scope with CREATE OR REPLACE and so
-- kept its live grants, {postgres=X/postgres,service_role=X/postgres}.
-- scripts/ci/check-definer-authorization.mjs reads migration text, not the
-- catalogue, and rightly reads a SECURITY DEFINER declaration that names no
-- grants as open to anon. This restates the grants the function already has,
-- so the file says what the database holds. GRANT and REVOKE do not reload
-- PostgREST. Nothing else changes.
--
-- @live-proof: (SELECT (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_money_path_reaches_club_scope(text,integer)'::regprocedure) = '{postgres=X/postgres,service_role=X/postgres}')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_money_path_reaches_club_scope(text,integer)'::regprocedure)) IS DISTINCT FROM 'f9f43589929fdfd1cc356eaa67943785' THEN
    RAISE EXCEPTION 'MONEY_PATH_GRANTS_PREIMAGE_CHANGED';
  END IF;
END
$pre$;

REVOKE ALL ON FUNCTION public.fn_money_path_reaches_club_scope(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_money_path_reaches_club_scope(text, integer) TO service_role;

DO $post$
BEGIN
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_money_path_reaches_club_scope(text,integer)'::regprocedure)
       IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'MONEY_PATH_GRANTS_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
