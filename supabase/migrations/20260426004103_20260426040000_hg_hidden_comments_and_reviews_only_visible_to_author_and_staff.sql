-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260426004103 "20260426040000_hg_hidden_comments_and_reviews_only_visible_to_author_and_staff"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a37557f8a78842c72397991f454021a0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX: same defense-in-depth issue as posts, applied to comments + reviews.
--
-- resolve_home_report_as_host with action=hide_content can hide:
--   - posts    → fixed in 20260426030000
--   - comments → THIS migration
--   - reviews  → THIS migration
--
-- All three follow the same pattern: is_hidden=true UPDATE without RLS-level
-- visibility filter. Frontend has to remember the filter everywhere.

-- ─── Comments ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS home_post_comments_select ON public.commander_home_post_comments;

CREATE POLICY home_post_comments_select
  ON public.commander_home_post_comments
  FOR SELECT
  USING (
    -- Base visibility: comment on a post the viewer can see
    post_id IN (
      SELECT p.id FROM commander_home_posts p
      JOIN commander_home_groups g ON g.id = p.group_id
      WHERE g.owner_id = auth.uid()
         OR NOT g.is_private
         OR p.group_id IN (
              SELECT group_id FROM commander_home_members
              WHERE user_id = auth.uid() AND status = 'approved'
            )
    )
    AND
    -- Hidden comments visible only to author + staff
    (
      COALESCE(is_hidden, false) = false
      OR author_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM commander_home_posts p
        WHERE p.id = post_id
          AND public.fn_home_is_group_staff(auth.uid(), p.group_id)
      )
    )
  );

-- ─── Reviews ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS home_game_reviews_select ON public.commander_home_game_reviews;

CREATE POLICY home_game_reviews_select
  ON public.commander_home_game_reviews
  FOR SELECT
  USING (
    -- Base visibility: reviewer, game host, group owner, or approved member
    (
      reviewer_id = auth.uid()
      OR game_id IN (SELECT id FROM commander_home_games WHERE host_id = auth.uid())
      OR game_id IN (
           SELECT hg.id FROM commander_home_games hg
           JOIN commander_home_groups g ON g.id = hg.group_id
           WHERE g.owner_id = auth.uid()
         )
      OR game_id IN (
           SELECT hg.id FROM commander_home_games hg
           JOIN commander_home_members m ON m.group_id = hg.group_id
           WHERE m.user_id = auth.uid() AND m.status = 'approved'
         )
    )
    AND
    -- Hidden reviews visible only to reviewer + staff
    (
      COALESCE(is_hidden, false) = false
      OR reviewer_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM commander_home_games hg
        WHERE hg.id = game_id
          AND public.fn_home_is_group_staff(auth.uid(), hg.group_id)
      )
    )
  );
