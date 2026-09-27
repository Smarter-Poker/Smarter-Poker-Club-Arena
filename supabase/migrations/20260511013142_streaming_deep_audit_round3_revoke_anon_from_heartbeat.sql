-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511013142 "streaming_deep_audit_round3_revoke_anon_from_heartbeat"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 55bd082881d213946b08a8a159740902 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Defensive: REVOKE EXECUTE on fn_heartbeat_live_viewer FROM anon. Default
-- Supabase grants give anon EXECUTE on every public function, which the
-- internal auth.uid()=null check inside the function already neutralizes
-- (it returns success=false reason=unauthenticated). But explicit REVOKE
-- defends against a future regression where someone adds a non-auth code
-- path to this function.
REVOKE EXECUTE ON FUNCTION public.fn_heartbeat_live_viewer(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_cleanup_stale_viewers(integer) FROM anon;

-- Same for round-2 functions where we used "REVOKE ALL ... FROM PUBLIC"
-- but anon retained default EXECUTE.
REVOKE EXECUTE ON FUNCTION public.fn_get_my_guest_invite_code(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_cleanup_stale_scheduled_lives() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_mark_feed_post_ended(uuid) FROM anon;
