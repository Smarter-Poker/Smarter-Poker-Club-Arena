-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417203906 "phase22_function_grant_hygiene"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b8d2526c9099ff257d2655c5099db023 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Function grant hygiene
--  -----------------------------------------------------------------------
--  Closes two grant issues left open after the Phase 22 RPC + helper work:
--
--  1. fn_cleanup_stale_scheduled_home_games still had anon/authenticated
--     EXECUTE from my earlier exploratory grants. Janitor should be
--     service_role-only (cron path).
--
--  2. revive_home_group had the default PUBLIC EXECUTE grant, which means
--     anonymous web traffic could call it. The function has its own
--     owner-identity re-check on p_caller_user_id so the blast radius is
--     "anonymous callers can pass their own UUID and get rejected", but
--     it's hygienically wrong. Tighten to authenticated + service_role.
--
--  Also applies the same hygiene pattern to the RPCs that SHOULD be anon-
--  callable (explicit GRANT after revoking PUBLIC) so their ACLs look
--  identical and intent is obvious from the migration history.
-- =========================================================================

-- ── 1. Janitor: service_role only ──────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.fn_cleanup_stale_scheduled_home_games(int)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cleanup_stale_scheduled_home_games(int)
    TO service_role;

-- ── 2. revive_home_group: authenticated + service_role only ────────────
REVOKE EXECUTE ON FUNCTION public.revive_home_group(uuid, uuid)
    FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.revive_home_group(uuid, uuid)
    TO authenticated, service_role;

-- ── 3. Read-only RPCs: explicit anon + authenticated + service_role ───
--      (clears the implicit PUBLIC grant and re-states intent)
REVOKE EXECUTE ON FUNCTION public.get_home_game_tournaments_for_date(date, text, int)
    FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_home_game_tournaments_for_date(date, text, int)
    TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_home_group_visibility_status(uuid, int)
    FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_home_group_visibility_status(uuid, int)
    TO authenticated, service_role;
