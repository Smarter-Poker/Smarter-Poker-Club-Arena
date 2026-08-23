-- ============================================================================
-- 20260823070000_spin_seat_first_integrity.sql
-- TIER: 3  |  AFFECTS: tournament_players (capacity trigger),
--                      new fn_seat_horse_in_seat_first_game, data repair.
--
-- WHAT DAN SAW
--
-- 2026-08-23, from a seat at a Spin: "I registered, said final table, then I
-- was booted and said i finished 4th somehow".
--
-- All of it was real, and it was one fault with four faces.
--
-- THE FAULT
--
-- A seat-first game (Spin, heads-up) starts when every SEAT is sold. The
-- past-start top-up filled short games by calling
-- fn_register_horse_for_tournament, which writes tournament_players and
-- NOTHING ELSE - correct for an MTT, useless here. So a topped-up Spin reached
-- "3 registered / 0 seated", and from there:
--
--   * it could never start, because no seat had been sold;
--   * it kept advertising three EMPTY seats on the lobby;
--   * fn_register_for_tournament's capacity check reads the DENORMALISED
--     tournaments.current_players, which those inserts left stale, so the
--     human who sat down was admitted as a FOURTH entrant to a 3-max event;
--   * the elimination path then computed his place over a field of four and
--     told him he finished 4th - in a game that cannot have a 4th place.
--
-- Measured before the repair: 12 of 24 open Spins were in that state, stuck
-- between 9 and 25 hours. One human had walked into one. He was charged 10
-- chips, eliminated 15 seconds later and never refunded (put right in
-- 20260823080000).
--
-- WHAT THIS MIGRATION DOES
--
--   1. trg_enforce_tournament_capacity - a BEFORE INSERT trigger on
--      tournament_players that COUNTS ROWS instead of trusting the counter.
--      Both registration RPCs already had a capacity check and both consulted
--      current_players; the rows that filled these games never went through
--      either, so the counter never saw them. Counting is the only check that
--      binds every path, including the next one somebody writes.
--
--   2. fn_seat_horse_in_seat_first_game - puts a horse in an actual seat.
--      Registration and seating are asked as separate questions, in that
--      order: fn_register_horse_for_tournament runs its capacity check BEFORE
--      its duplicate check, so asking it about someone already registered in a
--      full game answers 'tournament_full' rather than 'already_registered'.
--      The first version of this function did ask, and its own assertion
--      caught the resulting failure and rolled the repair back.
--
-- ROLLBACK
--
--   DROP TRIGGER IF EXISTS trg_enforce_tournament_capacity ON public.tournament_players;
--   DROP FUNCTION IF EXISTS public.fn_enforce_tournament_capacity();
--   DROP FUNCTION IF EXISTS public.fn_seat_horse_in_seat_first_game(uuid, uuid);
--
--   Dropping the trigger re-opens the door a human already fell through once.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_tournament_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_max int; v_have int; v_name text;
BEGIN
  SELECT max_players, name INTO v_max, v_name
    FROM public.tournaments WHERE id = NEW.tournament_id;

  IF v_max IS NULL OR v_max <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_have
    FROM public.tournament_players
   WHERE tournament_id = NEW.tournament_id;

  IF v_have >= v_max THEN
    RAISE EXCEPTION
      'tournament_full: % already has % of % entrants',
      COALESCE(v_name, NEW.tournament_id::text), v_have, v_max
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_tournament_capacity ON public.tournament_players;
CREATE TRIGGER trg_enforce_tournament_capacity
  BEFORE INSERT ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_tournament_capacity();

-- fn_seat_horse_in_seat_first_game is applied as its own migration
-- (horses_take_seats_in_seat_first_games / seat_horse_skip_register_when_already_in)
-- and its final source lives there.

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournament_players'::regclass
       AND tgname = 'trg_enforce_tournament_capacity' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_enforce_tournament_capacity was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_seat_horse_in_seat_first_game'
  ) THEN
    RAISE EXCEPTION 'fn_seat_horse_in_seat_first_game is missing';
  END IF;
END $$;

-- ============================================================================
-- APPLY HISTORY
--
-- Applied to production 2026-08-23 across four steps:
--   no_more_entrants_than_seats
--   horses_take_seats_in_seat_first_games
--   seat_horse_skip_register_when_already_in   (corrects the one above)
--   close_the_played_spins_and_seat_the_stalled_ones
--
-- Verified against production afterwards:
--   a 4th entrant into a full 3-max Spin -> REFUSED (capacity), in a
--     rolled-back probe
--   open Spins 24 -> 15, of which 0 deadlocked, 13 genuinely open
--   players anywhere holding a place beyond the field size: 0
-- ============================================================================
