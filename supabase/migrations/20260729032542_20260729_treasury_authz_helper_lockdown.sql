-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260729032542 "20260729_treasury_authz_helper_lockdown"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 73c7aac628369e0438ec6c38a907626a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

REVOKE ALL ON FUNCTION public.fn_actor_can_manage_club_treasury(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_actor_can_manage_club_treasury(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_actor_can_manage_club_treasury(uuid) TO authenticated;
