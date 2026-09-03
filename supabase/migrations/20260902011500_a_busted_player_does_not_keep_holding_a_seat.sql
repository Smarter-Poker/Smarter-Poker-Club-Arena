-- ═══════════════════════════════════════════════════════════════════════════
--  A PLAYER WHO IS OUT DOES NOT GO ON OCCUPYING THE TABLE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_enforce_tournament_capacity counted EVERY tournament_players row:
--
--     SELECT count(*) INTO v_have
--       FROM public.tournament_players
--      WHERE tournament_id = NEW.tournament_id;      -- no status filter
--
-- so a row that reached 'eliminated' or 'winner' kept its place in the count
-- forever. On a three-handed Spin that is fatal rather than untidy: one horse
-- leaving a REGISTERING board makes the board read 3 of 3 while only two seats
-- are live, the top-up is refused with `tournament_full`, the third seat can
-- never be sold, and the game can never reach the three paid seats it starts
-- on. The board is stuck open permanently.
--
-- MEASURED ON PRODUCTION before this ran: 2,059 `tournament_full` refusals in
-- sixty minutes, against boards whose live seat count was two.
--
-- Capacity means how many players are IN the game, which is what every other
-- part of the platform means by it: the seat count, the start gate
-- (`paidSeats >= max_players`), the lobby tile, and fn_sync_seat_first_player_
-- count all read live rows. This trigger was the only place that counted the
-- dead, and that disagreement is the bug.
--
-- Terminal statuses are excluded explicitly rather than by listing the live
-- ones, so a status added later is counted by default. Being too STRICT here
-- refuses a legitimate entrant; being too loose only allows one the seat map
-- would then refuse anyway.
--
-- ROLLBACK:
--   Restore the previous body by removing the status predicate from the
--   count -- but read the note above first: that is the outage.

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
BEGIN
  SELECT max_players, name INTO v_max, v_name
    FROM public.tournaments WHERE id = NEW.tournament_id;

  -- No declared capacity means no capacity to exceed (open MTTs).
  IF v_max IS NULL OR v_max <= 0 THEN
    RETURN NEW;
  END IF;

  -- LIVE entrants only. A player who busted, was knocked out or already won
  -- is not sitting at the table and must not hold a seat against the next one.
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
DECLARE v_src text; v_locked int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_enforce_tournament_capacity';
  IF position('NOT IN' in v_src) = 0 THEN
    RAISE EXCEPTION 'the capacity count still has no status filter';
  END IF;

  -- Nothing should now be full-on-paper while short of live seats.
  SELECT count(*) INTO v_locked
  FROM public.tournaments t
  WHERE t.status = 'REGISTERING'
    AND (COALESCE(t.variant,'') = 'spin' OR COALESCE(t.max_players,0) <= 2)
    AND (SELECT count(*) FROM public.tournament_players tp
          WHERE tp.tournament_id = t.id
            AND COALESCE(tp.status,'registered') NOT IN
                ('eliminated','winner','left','withdrawn','cancelled','refunded','busted')) >= t.max_players
    AND (SELECT count(*) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id AND s.left_at IS NULL) < t.max_players;
  RAISE NOTICE 'seat-first boards still full-on-paper but short of seats: %', v_locked;
END $$;;
