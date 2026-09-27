-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424143017 "20260421196000_hg_integration_rpcs_tighten_grants_complete"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 dc46c6b3c680821a9722ce35003b45c3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Defense-in-depth: ensure all 3 integration RPCs have grants tightened.
-- fn_get_home_group_dashboard was missing explicit REVOKE (body gates it,
-- but PostgREST surface should not even list it for anon).
REVOKE EXECUTE ON FUNCTION public.fn_get_home_group_dashboard(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_get_home_group_dashboard(uuid, uuid) TO authenticated, service_role;

-- Also re-apply to the other two for idempotent safety.
REVOKE EXECUTE ON FUNCTION public.fn_list_my_home_memberships(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_my_home_memberships(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fn_list_my_post_targets(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_my_post_targets(uuid) TO authenticated, service_role;
