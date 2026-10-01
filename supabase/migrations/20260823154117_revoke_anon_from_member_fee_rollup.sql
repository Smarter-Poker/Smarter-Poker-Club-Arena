-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823154117 "revoke_anon_from_member_fee_rollup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b64a081962ab29a7b1ab1d2456a6f645 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SECURITY: fn_refresh_member_fee_rollup was callable by anon.
-- Found 2026-08-23 by CHECK 10 (anon_mutating_definer_functions_check_auth_uid),
-- which had turned World Hub main red and was blocking every deploy.
-- Postgres grants EXECUTE to PUBLIC on every new function and anon inherits it;
-- 20260823_02_member_fee_rollup.sql created a SECURITY DEFINER function that
-- WRITES and never revoked that default. It is a service-only rollup job with
-- no callers in src/, server/src/ or pages/, so the fix is the grant, not the body.
-- ROLLBACK: grant execute on function public.fn_refresh_member_fee_rollup(integer) to anon; (do not)
revoke all on function public.fn_refresh_member_fee_rollup(integer) from public;
revoke all on function public.fn_refresh_member_fee_rollup(integer) from anon;
grant execute on function public.fn_refresh_member_fee_rollup(integer) to service_role;
do $assert$
begin
  if has_function_privilege('anon', 'public.fn_refresh_member_fee_rollup(integer)', 'EXECUTE') then
    raise exception 'anon can still execute fn_refresh_member_fee_rollup';
  end if;
end $assert$;
