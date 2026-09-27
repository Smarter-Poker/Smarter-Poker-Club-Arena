-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260425234844 "20260425220000_hg_host_can_select_reports_on_own_group_content"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 309db7586352c92cc8bc24649d28de00 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX: pre-emptive. The Moderation tab API route (about to be built
-- by AG) needs to look up pending reports on a post by post_id from the
-- host's authenticated session. Existing SELECT policy on
-- commander_home_content_reports is reporter-only:
--   home_reports_self_select  USING (reporter_id = auth.uid())
-- A host needs to see reports on their group's content, even if the
-- report was filed by someone else. Without this policy the route's
-- lookup query returns 0 rows for legitimate hide actions, and the
-- Moderation tab's Hide button silently 404s.
--
-- This policy adds host visibility for content authored in their group.
-- The reported_type discriminates which content table to join through:
--   post     → commander_home_posts.group_id
--   comment  → commander_home_post_comments → posts.group_id
--   review   → commander_home_game_reviews → games.group_id
--   game     → commander_home_games.group_id
--   member   → commander_home_members.group_id
--
-- Mirror the exact same group/staff check as fn_home_is_group_staff,
-- which is what the host RPCs already use.

CREATE POLICY home_reports_host_sees_group_content
  ON public.commander_home_content_reports
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IS NOT NULL
    AND public.fn_home_is_group_staff(
      auth.uid(),
      CASE reported_type
        WHEN 'post' THEN
          (SELECT group_id FROM public.commander_home_posts WHERE id = reported_id)
        WHEN 'comment' THEN
          (SELECT p.group_id FROM public.commander_home_post_comments c
            JOIN public.commander_home_posts p ON p.id = c.post_id
           WHERE c.id = reported_id)
        WHEN 'review' THEN
          (SELECT g.group_id FROM public.commander_home_game_reviews r
            JOIN public.commander_home_games g ON g.id = r.game_id
           WHERE r.id = reported_id)
        WHEN 'game' THEN
          (SELECT group_id FROM public.commander_home_games WHERE id = reported_id)
        WHEN 'member' THEN
          (SELECT group_id FROM public.commander_home_members WHERE id = reported_id)
        ELSE NULL
      END
    )
  );

NOTIFY pgrst, 'reload schema';
