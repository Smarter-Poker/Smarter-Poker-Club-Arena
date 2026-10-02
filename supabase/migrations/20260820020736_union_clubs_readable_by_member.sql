-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820020736 "union_clubs_readable_by_member"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c88f92ddf27847d81e2cc1844e9e0004 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- A PLAYER COULD NOT SEE THEIR OWN UNION (2026-08-19)
--
-- Reported by Dan: "there are ZERO cash games and tournaments running from the
-- Midway Union" — seeing Club JAQK, SHARK CLUB and Midway Union listed as three
-- flat, equal clubs, instead of the union at the top with its clubs beneath.
--
-- ROOT CAUSE. The `union_clubs` read policy admitted only union admins and club
-- OWNERS:
--     EXISTS (union_admins  WHERE union_id = ... AND user_id = auth.uid())
--  OR EXISTS (clubs c WHERE c.id = club_id AND c.owner_id = auth.uid())
--
-- An ordinary member of a member club matches neither. ClubCarouselPage
-- discovers a player's unions three ways, and the one that works for a normal
-- player is "club membership -> union_clubs -> union". That query returned
-- nothing, so `loadedUnions` was empty, so `filterUnionClubs` had nothing to
-- collapse, so every member club rendered as a peer and no union header
-- appeared at all.
--
-- The games were never missing: 36 live cash tables and 10 live tournaments
-- all carry union_id = Midway. The union itself was invisible to its own
-- players.
--
-- FIX. A member of a club may read the row that says which union that club
-- belongs to. That is not sensitive — it is the same fact the union lobby,
-- the shared bad-beat jackpot and cross-club play already expose to them. It
-- does NOT grant sight of other clubs' membership rows: the predicate is
-- scoped to clubs the caller actually belongs to.
-- ============================================================================

DROP POLICY IF EXISTS union_clubs_read ON union_clubs;
CREATE POLICY union_clubs_read ON union_clubs
  FOR SELECT
  USING (
    -- union staff
    EXISTS (SELECT 1 FROM union_admins ua
             WHERE ua.union_id = union_clubs.union_id
               AND ua.user_id = (SELECT auth.uid()))
    -- the club's owner
    OR EXISTS (SELECT 1 FROM clubs c
                WHERE c.id = union_clubs.club_id
                  AND c.owner_id = (SELECT auth.uid()))
    -- NEW: a member of that club may see which union it belongs to
    OR EXISTS (SELECT 1 FROM club_members cm
                WHERE cm.club_id = union_clubs.club_id
                  AND cm.user_id = (SELECT auth.uid()))
  );

DO $$
DECLARE v_expr text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO v_expr
    FROM pg_policy
   WHERE polrelid = 'public.union_clubs'::regclass AND polname = 'union_clubs_read';
  IF v_expr IS NULL OR v_expr NOT LIKE '%club_members%' THEN
    RAISE EXCEPTION 'ASSERTION FAILED: union_clubs is still unreadable by ordinary club members';
  END IF;
END $$;
