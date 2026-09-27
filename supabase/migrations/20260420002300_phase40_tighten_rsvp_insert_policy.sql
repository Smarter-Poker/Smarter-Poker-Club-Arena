-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420002300 "phase40_tighten_rsvp_insert_policy"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8ae6c6854ddff5e0dae69f24ba7526c4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — RLS leak: commander_home_rsvps INSERT was (user_id = auth.uid())
-- only. No group-membership check. Any authenticated user could insert an
-- RSVP to any game they guessed the UUID of — including private-group games
-- they couldn't see via SELECT. This is exactly how 12 non-member RSVPs
-- (including Dan RSVPing to a private group he wasn't a member of) got
-- created in production.
--
-- Fix: match the scope used by home_rsvps_select — the user must be able
-- to see the game to RSVP to it. That means one of:
--   1. The game's group is public, OR
--   2. The user is the group's owner, OR
--   3. The user is an approved member of the game's group
-- ============================================================================

DROP POLICY IF EXISTS home_rsvps_insert ON commander_home_rsvps;

CREATE POLICY home_rsvps_insert ON commander_home_rsvps
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND game_id IN (
    SELECT g.id
    FROM commander_home_games g
    JOIN commander_home_groups gr ON gr.id = g.group_id
    WHERE
      -- Public group: anyone can RSVP
      NOT gr.is_private
      -- Owner can always RSVP to their own group's games
      OR gr.owner_id = auth.uid()
      -- Approved members can RSVP
      OR g.group_id IN (
        SELECT m.group_id FROM commander_home_members m
        WHERE m.user_id = auth.uid() AND m.status = 'approved'
      )
  )
);

COMMENT ON POLICY home_rsvps_insert ON commander_home_rsvps IS
  'Phase 40: RSVP INSERT requires the user to be able to see the game. '
  'Mirrors home_rsvps_select scope: public group, group owner, or approved '
  'member of the game''s group. Replaces pre-Phase-40 policy that only '
  'checked user_id = auth.uid() and allowed private-group RSVP leaks.';
