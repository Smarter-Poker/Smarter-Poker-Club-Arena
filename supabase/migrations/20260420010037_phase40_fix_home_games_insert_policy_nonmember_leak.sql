-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420010037 "phase40_fix_home_games_insert_policy_nonmember_leak"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 950f41c71e0c621186b896e24db217f0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 31: commander_home_games INSERT policy lets non-members
-- create games in groups they don't belong to, as long as they set
-- host_id = auth.uid(). The first disjunct only checks host_id and doesn't
-- verify group membership.
--
-- Exploit: attacker INSERTs a game with (group_id=victim_public_group,
-- host_id=attacker) and becomes the "host" of a ghost game in someone
-- else's group. This enables:
--   - Polluting a group's game calendar with spam
--   - Potentially gaining host-level visibility into RSVPs/photos/reviews
--     on that ghost game (host RLS paths key off host_id = auth.uid())
--   - Breaking the group's event feed
--
-- Fix: require the caller to be a member of the group. Staff can set any
-- host_id; regular approved members can only set themselves as host.
-- ============================================================================

DROP POLICY IF EXISTS home_games_insert ON commander_home_games;

CREATE POLICY home_games_insert ON commander_home_games
FOR INSERT
WITH CHECK (
  -- The caller must be in the group in some capacity
  (
    fn_home_is_group_staff(auth.uid(), group_id)
    OR EXISTS (
      SELECT 1 FROM commander_home_members m
       WHERE m.group_id = commander_home_games.group_id
         AND m.user_id = auth.uid()
         AND m.status = 'approved'
    )
  )
  AND
  -- And either the caller is staff (can delegate host_id to anyone)
  -- OR the caller is setting themselves as the host
  (
    fn_home_is_group_staff(auth.uid(), group_id)
    OR host_id = auth.uid()
  )
);

COMMENT ON POLICY home_games_insert ON commander_home_games IS
  'Phase 40: caller must be a member (approved) or staff of the group. '
  'Staff may set any host_id (for delegation); non-staff must set themselves '
  'as host. Previously, any user could INSERT a game into any group as long '
  'as they set host_id = auth.uid() — a privilege escalation vector.';
