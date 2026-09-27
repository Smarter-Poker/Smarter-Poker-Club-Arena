-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419221844 "phase35_home_game_grant_corrections"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3436213dfceed2a90d546a2830a1e337 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 35 — HOME GAMES GRANT CORRECTIONS
-- 
-- Two trigger-only functions are exposed as callable. Triggers bypass
-- EXECUTE grants anyway — no legitimate reason for anon/authenticated to
-- call these directly. Revoke.
-- 
-- Two analytics trackers are intended for frontend use (view + share click
-- counters on public group pages) but are currently service-role-only.
-- Grant to anon + authenticated so the frontend can increment.
-- ══════════════════════════════════════════════════════════════════════════

-- Trigger-only functions → revoke
REVOKE EXECUTE ON FUNCTION public.update_home_game_rsvp_counts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_home_group_member_count() FROM PUBLIC, anon, authenticated;

-- Frontend analytics trackers → public
GRANT EXECUTE ON FUNCTION public.track_home_group_view(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.track_home_group_share_click(uuid, uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.update_home_game_rsvp_counts() IS 
  'Trigger function — invoked by home_rsvp_count_trigger on commander_home_rsvps. Not intended for direct invocation.';
COMMENT ON FUNCTION public.update_home_group_member_count() IS 
  'Trigger function — invoked by home_member_count_trigger on commander_home_members. Not intended for direct invocation.';
COMMENT ON FUNCTION public.track_home_group_view(uuid) IS 
  'Frontend analytics tracker — anyone can call to increment view_count on public group pages.';
COMMENT ON FUNCTION public.track_home_group_share_click(uuid, uuid) IS 
  'Frontend analytics tracker — increments share_click_count and optionally the invite token click_count.';
