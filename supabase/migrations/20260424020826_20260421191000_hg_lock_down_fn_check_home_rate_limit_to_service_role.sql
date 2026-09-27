-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424020826 "20260421191000_hg_lock_down_fn_check_home_rate_limit_to_service_role"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e3f2defb47e49e380e64614815603517 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Internal helper called only from BEFORE-INSERT triggers. Authenticated
-- users shouldn't be able to probe other users' recent activity counts
-- via PostgREST-direct call. Lock to service_role (triggers run as
-- fn-owner = postgres which bypasses grants).

REVOKE EXECUTE ON FUNCTION public.fn_check_home_rate_limit(uuid, text, integer) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_check_home_rate_limit(uuid, text, integer) TO service_role;
