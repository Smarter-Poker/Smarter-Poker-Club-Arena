-- ═══════════════════════════════════════════════════════════════════════════
--  MY OWN REGRESSION: A RUNNING SPIN TOOK A FOURTH AND FIFTH ENTRANT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260902011500 changed fn_enforce_tournament_capacity to count only LIVE
-- entrants. That fixed a real deadlock - a REGISTERING board whose horse left
-- kept a dead `eliminated` row, read 3 of 3 forever, and could never refill.
--
-- It also opened a hole I did not see. Once a Spin is RUNNING and players start
-- busting, their rows go terminal and stop counting, so capacity frees up and a
-- late registration is accepted into a game that is already being played.
--
-- MEASURED before fixing, over the 965 seat-first games created since that
-- migration: 2 over-subscribed, 3 extra entrants, and 40.00 of excess prize
-- pool. The worked example:
--
--   "20 Chip Spin PLO5"  buy-in 20, multiplier 2  -> prize should be 40.00
--   entrants 5 on a 3-handed board
--   prize_pool written as 80.00, and the winner was credited 80.00
--   the reserve pool correctly drew only 40.00
--
-- So the player was overpaid 40.00 and the extra 40.00 did not come out of the
-- Spin treasury. That is exactly the divergence this whole body of work exists
-- to make impossible, and I caused it.
--
-- THE RULE, STATED PROPERLY. Both halves are needed and neither alone is right:
--
--   1. While a seat-first board is still open, capacity counts LIVE entrants,
--      so a departed horse frees its seat and the board can refill. This is
--      what 20260902011500 got right and must be kept.
--   2. Once the board is no longer joinable, it takes NOBODY, whatever the
--      live count says. A Spin is three seats sold once; it is not a field
--      that back-fills as players bust.
--
-- Non-seat-first formats are untouched: an MTT with late registration or
-- re-entry legitimately admits players after it starts, and this guard leaves
-- that behaviour exactly as it was.
--
-- ROLLBACK: re-apply 20260902011500_a_busted_player_does_not_keep_holding_a_seat.sql
-- (but read the note above first - that version is what let a running Spin
-- take five entrants).

CREATE OR REPLACE FUNCTION public.fn_enforce_tournament_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_max int;
  v_have int;
  v_name text;
  v_status text;
  v_variant text;
  v_seat_first boolean;
BEGIN
  SELECT max_players, name, status, COALESCE(variant, '')
    INTO v_max, v_name, v_status, v_variant
    FROM public.tournaments WHERE id = NEW.tournament_id;

  -- No declared capacity means no capacity to exceed (open MTTs).
  IF v_max IS NULL OR v_max <= 0 THEN
    RETURN NEW;
  END IF;

  v_seat_first := (v_variant = 'spin' OR v_max <= 2);

  -- A seat-first board sells its seats once. After it stops being joinable it
  -- admits nobody, however many of its entrants have since busted.
  IF v_seat_first
     AND upper(COALESCE(v_status, '')) NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RAISE EXCEPTION
      'tournament_full: % is % and takes no further entrants',
      COALESCE(v_name, NEW.tournament_id::text), lower(v_status)
      USING ERRCODE = '23514';
  END IF;

  -- LIVE entrants only. A player who busted, was knocked out or already won is
  -- not sitting at the table and must not hold a seat against the next one.
  SELECT count(*) INTO v_have
    FROM public.tournament_players
   WHERE tournament_id = NEW.tournament_id
     AND COALESCE(status, 'registered') NOT IN
         ('eliminated', 'winner', 'left', 'withdrawn', 'cancelled', 'refunded', 'busted');

  IF v_have >= v_max THEN
    RAISE EXCEPTION
      'tournament_full: % already has % of % entrants', COALESCE(v_name, NEW.tournament_id::text), v_have, v_max
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DO $$
DECLARE v_src text; v_over int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_enforce_tournament_capacity';

  -- Both halves must be present. Either alone is a bug already seen.
  IF position('NOT IN' in v_src) = 0 THEN
    RAISE EXCEPTION 'the live-entrant filter is gone; a departed horse will deadlock the board again';
  END IF;
  IF position('takes no further entrants' in v_src) = 0 THEN
    RAISE EXCEPTION 'the started-board guard is gone; a running Spin can take a fourth entrant again';
  END IF;

  -- Nothing currently open may already be over its cap.
  SELECT count(*) INTO v_over
  FROM public.tournaments t
  WHERE (COALESCE(t.variant,'') = 'spin' OR COALESCE(t.max_players,0) <= 2)
    AND upper(COALESCE(t.status,'')) IN ('ANNOUNCED','REGISTERING')
    AND (SELECT count(*) FROM public.tournament_players tp
          WHERE tp.tournament_id = t.id
            AND COALESCE(tp.status,'registered') NOT IN
                ('eliminated','winner','left','withdrawn','cancelled','refunded','busted')) > t.max_players;
  IF v_over > 0 THEN
    RAISE WARNING '% open seat-first board(s) are already over capacity', v_over;
  END IF;
END $$;;
