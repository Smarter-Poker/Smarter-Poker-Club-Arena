-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511013201 "streaming_deep_audit_round3_lock_service_role_only_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 41686b67add8dda70547d075f63ddd6d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- These three RPCs are service-role only (invoked from /api/cron/* and
-- /api/live/* server endpoints). authenticated should not be able to call
-- them. Default Supabase grants gave authenticated EXECUTE which our prior
-- REVOKE ALL FROM PUBLIC failed to take away (because the grant was
-- per-role, not via PUBLIC).
REVOKE EXECUTE ON FUNCTION public.fn_cleanup_stale_viewers(integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_cleanup_stale_scheduled_lives() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_mark_feed_post_ended(uuid) FROM authenticated;

-- fn_get_my_guest_invite_code and fn_heartbeat_live_viewer correctly retain
-- authenticated EXECUTE — they are USER-facing RPCs scoped via internal
-- auth.uid() checks.
