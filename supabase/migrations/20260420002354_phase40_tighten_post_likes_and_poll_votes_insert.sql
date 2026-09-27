-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420002354 "phase40_tighten_post_likes_and_poll_votes_insert"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3f222485d855d3df9bbe473b1321b06d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — RLS leaks on post_likes and poll_votes INSERT policies.
-- Same bug class as the RSVP leak: only user_id = auth.uid() was required,
-- allowing any authenticated user to like/vote on private-group content by
-- guessing UUIDs. Tighten to require the user to be able to see the
-- underlying post/poll.
-- ============================================================================

-- (1) post_likes: must be able to see the underlying post
DROP POLICY IF EXISTS home_post_likes_insert ON commander_home_post_likes;
CREATE POLICY home_post_likes_insert ON commander_home_post_likes
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND post_id IN (
    SELECT p.id
    FROM commander_home_posts p
    JOIN commander_home_groups gr ON gr.id = p.group_id
    WHERE
      -- Public group: anyone can like
      (NOT gr.is_private AND p.visible_to = 'public')
      -- Owner always
      OR gr.owner_id = auth.uid()
      -- Approved member
      OR p.group_id IN (
        SELECT m.group_id FROM commander_home_members m
        WHERE m.user_id = auth.uid() AND m.status = 'approved'
      )
  )
);
COMMENT ON POLICY home_post_likes_insert ON commander_home_post_likes IS
  'Phase 40: post_likes INSERT requires visibility of the underlying post. '
  'Prevents non-members from liking private-group posts by guessing UUIDs.';

-- (2) poll_votes: must be able to see the underlying poll
-- Polls are ALWAYS members-only (poll SELECT policy requires owner or approved member),
-- so we require the same for voting.
DROP POLICY IF EXISTS home_poll_votes_insert ON commander_home_poll_votes;
CREATE POLICY home_poll_votes_insert ON commander_home_poll_votes
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND poll_id IN (
    SELECT pl.id
    FROM commander_home_polls pl
    JOIN commander_home_groups gr ON gr.id = pl.group_id
    WHERE
      -- Owner
      gr.owner_id = auth.uid()
      -- Approved member
      OR pl.group_id IN (
        SELECT m.group_id FROM commander_home_members m
        WHERE m.user_id = auth.uid() AND m.status = 'approved'
      )
  )
);
COMMENT ON POLICY home_poll_votes_insert ON commander_home_poll_votes IS
  'Phase 40: poll_votes INSERT requires the user to be owner or approved '
  'member of the poll''s group. Prevents non-member vote spam.';
