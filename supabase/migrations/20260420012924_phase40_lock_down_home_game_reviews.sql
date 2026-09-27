-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420012924 "phase40_lock_down_home_game_reviews"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fc6f8b4f3429533736caf5cbe87695a4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bugs 39 & 40: home game reviews integrity.
--
-- Current INSERT policy let any approved group member review any game,
-- including future games, games they didn't attend, and their own hosted
-- games. Review-fraud vector — pump ratings for friends, sabotage rivals.
--
-- Current DELETE policy lets the game HOST delete reviews about their own
-- game. A host can wipe negative feedback, defeating the entire reputation
-- signal the platform is building.
--
-- Fixes:
--   (a) NOT NULL on reviewer_id, game_id, rating (0 rows in prod).
--   (b) FK reviewer_id → profiles (with CASCADE, matching other user FKs).
--   (c) Strict INSERT policy: only attendees of completed games, excluding
--       the host themselves.
--   (d) DELETE policy: reviewer only. Host can no longer delete.
--       Admin/moderation go through the content-reports flow.
-- ============================================================================

-- (a) Tighten nullability
ALTER TABLE public.commander_home_game_reviews
  ALTER COLUMN reviewer_id SET NOT NULL,
  ALTER COLUMN game_id     SET NOT NULL,
  ALTER COLUMN rating      SET NOT NULL;

-- (b) Add FK to profiles if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname='public' AND cl.relname='commander_home_game_reviews'
      AND c.contype='f'
      AND pg_get_constraintdef(c.oid) ILIKE '%reviewer_id%profiles%'
  ) THEN
    ALTER TABLE public.commander_home_game_reviews
      ADD CONSTRAINT fk_commander_home_game_reviews_reviewer_id_profiles
      FOREIGN KEY (reviewer_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- (c) Replace INSERT policy with strict eligibility
DROP POLICY IF EXISTS home_game_reviews_insert ON public.commander_home_game_reviews;
CREATE POLICY home_game_reviews_insert
ON public.commander_home_game_reviews
FOR INSERT TO authenticated
WITH CHECK (
  reviewer_id = auth.uid()
  -- Game must be completed
  AND EXISTS (
    SELECT 1 FROM commander_home_games g
    WHERE g.id = commander_home_game_reviews.game_id
      AND g.status = 'completed'
      -- Reviewer cannot be the host (no self-review)
      AND g.host_id <> auth.uid()
  )
  -- Reviewer must have actually attended (RSVP yes + checked in)
  AND EXISTS (
    SELECT 1 FROM commander_home_rsvps r
    WHERE r.game_id = commander_home_game_reviews.game_id
      AND r.user_id = auth.uid()
      AND r.response = 'yes'
      AND r.checked_in_at IS NOT NULL
  )
);

-- (d) DELETE policy: reviewer only
DROP POLICY IF EXISTS home_game_reviews_delete ON public.commander_home_game_reviews;
CREATE POLICY home_game_reviews_delete
ON public.commander_home_game_reviews
FOR DELETE TO authenticated
USING (reviewer_id = auth.uid());

-- Role sanity: previously policies were scoped to `public` (effectively every
-- role including anon). Lock both UPDATE and SELECT to authenticated too.
-- SELECT visibility stays the same (reviewer, host, group owner, approved
-- member) but restricted to authenticated sessions.
DROP POLICY IF EXISTS home_game_reviews_select ON public.commander_home_game_reviews;
CREATE POLICY home_game_reviews_select
ON public.commander_home_game_reviews
FOR SELECT TO authenticated
USING (
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
);

DROP POLICY IF EXISTS home_game_reviews_update ON public.commander_home_game_reviews;
CREATE POLICY home_game_reviews_update
ON public.commander_home_game_reviews
FOR UPDATE TO authenticated
USING (reviewer_id = auth.uid())
WITH CHECK (reviewer_id = auth.uid());

COMMENT ON POLICY home_game_reviews_insert ON public.commander_home_game_reviews IS
  'Phase 40: only attendees of completed games can review, and not self-review.';
COMMENT ON POLICY home_game_reviews_delete ON public.commander_home_game_reviews IS
  'Phase 40: reviewer-only. Host can no longer delete reviews of their game; '
  'moderation goes through the content-reports flow.';
