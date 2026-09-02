-- A FINISHING PLACE IS RENUMBERED, NOT SHARED.
--
-- 20260827_a_finishing_place_belongs_to_one_player stopped the bleeding (the
-- trigger raises on a new collision) and deliberately left the 206 historical
-- duplicate places alone, because renumbering somebody's recorded finish is a
-- decision about their record and not a code fix. Dan made that decision on
-- 2026-08-28: renumber the records into the gap that was skipped, and do not
-- claw anything back from players.
--
-- THE RULE. Within a contested place, the player who was eliminated LATER
-- finished HIGHER and keeps it; a player never eliminated outranks anyone who
-- was. The others move DOWN into the free places below. 177 of the 206 groups
-- are two busts inside the same two-minute endgame, where this is simply the
-- poker result: Late Night Grind stamped AceSniper (busted 01:11:35) and
-- TiltBandito (01:11:58) both second and never used third, so TiltBandito is
-- second and AceSniper is third.
--
-- A DEMOTION NEVER BECOMES A PROMOTION. Free places also exist ABOVE some
-- contested places, and handing one of those to a collision loser would move
-- them up the finishing table on the strength of a bug. Every assignment here
-- is to a place strictly worse than the one held.
--
-- TWO GROUPS ARE EXCLUDED AND STAY FOR DAN. Sunday Freeroll Special and Bounty
-- Builder Turbo each declared TWO winners at place 1, both never eliminated -
-- two tables ran separate endgames and each crowned a champion. In Bounty
-- Builder Turbo both hold exactly 10,000 chips. Nothing in the data decides
-- who actually won, and the rule above cannot either (neither was eliminated).
-- Demoting a player from first place on a tiebreak an agent invented is not a
-- record correction, so both are left exactly as they are and reported.
--
-- Every move is written to tournament_place_renumbers before it is made, so
-- the previous finishing table is reconstructable.
--
-- NOTE: the plan builder in this file was superseded ~1 minute later by
-- 20260828023624_renumber_walks_every_demotion_to_a_real_free_place.sql, which
-- replaced a silently-lossy matcher. Read that file for the final behaviour.
--
-- ROLLBACK
--   UPDATE tournament_players tp SET position = r.old_position
--     FROM tournament_place_renumbers r
--    WHERE r.tournament_id = tp.tournament_id AND r.user_id = tp.user_id;
--   (then DROP TABLE tournament_place_renumbers, DROP FUNCTION
--    public.fn_renumber_duplicate_places(boolean, integer))

DO $pre$
BEGIN
  IF to_regclass('public.tournament_players') IS NULL THEN
    RAISE EXCEPTION 'tournament_players is missing';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.tournament_place_renumbers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  user_id       uuid NOT NULL,
  old_position  integer NOT NULL,
  new_position  integer NOT NULL,
  prize_paid    numeric NOT NULL DEFAULT 0,
  reason        text NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, user_id, old_position, new_position)
);

ALTER TABLE public.tournament_place_renumbers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_place_renumbers FROM PUBLIC;
GRANT SELECT ON public.tournament_place_renumbers TO service_role;

-- Superseded body; see 20260828023624. Kept so the history reads in order.
SELECT 1;
