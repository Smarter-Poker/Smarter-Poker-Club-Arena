-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419224529 "phase37_fix_host_private_note_column_grant"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ce369b46564486eb9439401aed9195e7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- H1 (fixed): Actually block host_private_note from anon/authenticated reads.
-- ============================================================================
-- Previous migration revoked column-level SELECT, but Postgres column revokes
-- are no-ops when the role has table-level SELECT (which Supabase grants by
-- default). Correct pattern: REVOKE table-level SELECT, then re-GRANT all
-- columns EXCEPT host_private_note at the column level.
-- ============================================================================

REVOKE SELECT ON TABLE public.commander_home_members FROM anon, authenticated, PUBLIC;

GRANT SELECT (
    id, group_id, user_id, role, status, games_attended, games_hosted,
    last_attended, can_host, notifications_enabled, notify_announcements,
    notify_new_games, notify_game_reminders, notify_rsvp_updates, invited_by,
    joined_at, created_at, pending_nudge_sent_at, last_read_posts_at,
    is_regular, flake_strikes, probation_until
    -- host_private_note DELIBERATELY EXCLUDED
) ON public.commander_home_members TO anon, authenticated;

-- Confirm service_role retains full access
GRANT SELECT ON TABLE public.commander_home_members TO service_role;

COMMENT ON COLUMN public.commander_home_members.host_private_note IS
    'Owner/admin-only notes about members. Table-level SELECT revoked from '
    'anon/authenticated (Phase 37); re-granted for every column except this '
    'one. Access only via SECURITY DEFINER fns like '
    'get_home_group_member_engagement which gate on owner/admin role.';
