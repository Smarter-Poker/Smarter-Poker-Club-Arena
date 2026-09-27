-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724034807 "club_join_rpcs_revoke_anon"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bcaeda36dc441fa5eaa5edb20c623727 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Revoke the default PUBLIC/anon EXECUTE grant on the join/approval RPCs so only
-- signed-in (authenticated) users can call them. The functions already reject
-- anon (auth.uid() IS NULL) but this satisfies the security advisor and matches
-- the intended grant surface.
REVOKE EXECUTE ON FUNCTION public.fn_join_club(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_review_join_request(uuid, uuid, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_list_pending_members(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_join_club(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_review_join_request(uuid, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_list_pending_members(uuid) TO authenticated;
