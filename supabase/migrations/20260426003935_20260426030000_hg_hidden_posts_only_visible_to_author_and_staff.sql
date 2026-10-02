-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260426003935 "20260426030000_hg_hidden_posts_only_visible_to_author_and_staff"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2b9a837d5fdebc0fe45414ee6edac393 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX: hidden posts had no RLS protection.
--
-- When host runs resolve_home_report_as_host with action=hide_content:
--   UPDATE commander_home_posts SET is_hidden=true ...
--
-- But the SELECT policy `home_posts_select` does NOT filter is_hidden.
-- A hidden post stays visible to ANY viewer who could see the group's posts:
--   - All approved members of the group
--   - Anonymous viewers if the group is public
--   - The post author themselves
--
-- This means: every frontend query that lists posts MUST remember
-- .eq('is_hidden', false). Forgetting once anywhere = hidden content leaks.
--
-- Defense-in-depth fix: add is_hidden filter to the SELECT policy itself.
-- Hidden posts remain visible ONLY to:
--   1. The author (so they see "your post was hidden" UI)
--   2. Group staff (so hosts can review what they hid)
-- Everyone else loses visibility automatically.

DROP POLICY IF EXISTS home_posts_select ON public.commander_home_posts;

CREATE POLICY home_posts_select
  ON public.commander_home_posts
  FOR SELECT
  USING (
    -- Base visibility: owner of group OR not-private OR approved member of group
    (
      group_id IN (
        SELECT id FROM commander_home_groups
        WHERE owner_id = auth.uid() OR NOT is_private
      )
      OR group_id IN (
        SELECT group_id FROM commander_home_members
        WHERE user_id = auth.uid() AND status = 'approved'
      )
    )
    AND
    -- Hidden posts only visible to author or staff
    (
      COALESCE(is_hidden, false) = false
      OR author_id = auth.uid()
      OR public.fn_home_is_group_staff(auth.uid(), group_id)
    )
  );
