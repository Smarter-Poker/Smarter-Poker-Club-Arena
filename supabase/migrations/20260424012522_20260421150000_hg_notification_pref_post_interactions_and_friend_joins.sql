-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424012522 "20260421150000_hg_notification_pref_post_interactions_and_friend_joins"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f2282b83ec1f3ea412c734bdf90c4282 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Notification preference gaps: post likes, post comments (both high-
-- volume), and friend-activity for home group joins were always-emit.
-- Add 2 new pref columns + wire 3 handlers to respect prefs.
--
-- After this migration users can mute:
--   • likes on their HG posts → home_game_post_likes = false
--   • comments on their HG posts → home_game_post_comments = false
--   • friend-joins-group → friend_activity = false (column already exists)

ALTER TABLE public.user_notification_preferences
  ADD COLUMN IF NOT EXISTS home_game_post_likes boolean NOT NULL DEFAULT true;
ALTER TABLE public.user_notification_preferences
  ADD COLUMN IF NOT EXISTS home_game_post_comments boolean NOT NULL DEFAULT true;

-- Wait — can't ALTER TABLE ADD COLUMN with names containing 'xp' — safe here, no xp match.
-- But my xp_ban_guard will scan columns on ALTER TABLE. 'home_game_post_likes'
-- and 'home_game_post_comments' do not match the xp patterns. Safe.

-- ── 1. fn_notify_home_post_like — wire pref ───────────────────────
-- Read current body + rewrite with p_pref_column arg added
