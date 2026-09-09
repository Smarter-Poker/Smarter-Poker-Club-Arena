/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FOUR-GAME CAP IS AT THE DOOR, NOT AT THE CHAIR
 *  2026-09-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This supersedes ca_a_chair_change_is_not_a_fifth_game, which exempted a
 * chair CHANGE. Measuring the rest of the damage showed the exemption was
 * drawn too small, and the reason is structural rather than a matter of
 * degree.
 *
 * TWO GATES THAT CONTRADICT EACH OTHER. fn_enforce_booking_game_cap owns the
 * cap before an event starts and says so in its own comment: "once under way,
 * entrants are counted by their SEATS and the seat trigger owns the rule." So
 * a player is measured at REGISTRATION, admitted, and then measured AGAIN by
 * this trigger when the field is seated - at a different moment, against a
 * different load. Anything they picked up in between turns the second reading
 * into a refusal, and what it refuses is a chair in an event that already
 * took them in.
 *
 * MEASURED 2026-09-09, after the stranded players were returned to the felt:
 * 212,500 chips of the remaining drift belonged to registrants who had never
 * been seated at all. Thirteen of them were still active. Probing their seat
 * writes returned FOUR TABLE LIMIT every time, and three were already
 * "committed to 5 games" - so the reading that refuses them is not even a
 * reading the cap itself managed to hold.
 *
 * A registrant who is never dealt in is worse than a refused entry in every
 * way. The event counts them, the conservation check counts their starting
 * stack, the prize pool holds their buy-in, and no hand can ever reach them.
 *
 * WHY THIS BRANCH COULD ONLY EVER DO HARM. A live tournament seat already
 * requires an active roster row - trg_lock_and_validate_tournament_live_seat
 * raises TOURNAMENT_SEAT_ROSTER_REQUIRED without one, and it is a BEFORE ROW
 * trigger, so the roster row always exists first. Every tournament seat this
 * cap has ever examined therefore belonged to somebody the door had already
 * admitted. It could never prevent a commitment. It could only refuse to
 * honour one.
 *
 * SO THE RULE IS ONE GATE PER COMMITMENT:
 *   - a cash chair is a commitment       -> this trigger, unchanged;
 *   - a tournament entry is a commitment -> fn_enforce_booking_game_cap;
 *   - a tournament chair is the entry being honoured -> never refused here.
 *
 * The non-entrant branch is kept as defence in depth: if a seat for somebody
 * with no roster row ever reaches this far, it is still counted and still
 * capped.
 *
 * NOTHING ELSE IS LOOSENED. trg_one_live_seat_per_tournament still refuses a
 * second live seat in one event, ab_refuse_live_seat_on_closed_tournament_
 * table still refuses a chair at a closed table, and trg_ca_guard_seat_
 * creation still requires the engine or a declared money path to put chips on
 * a chair.
 */

CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live       int;
  v_is_closed  boolean;
  v_tournament uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A MOVE WITHIN ONE GAME IS NOT A FIFTH GAME (2026-09-05). Only the cluster
  -- executor sets this, for the one transaction in which a player changes
  -- chairs inside a game they are already in. It replaces the 041000 rule
  -- ("holds another live seat in this cluster"), which also let a player buy
  -- a second seat into a game they were already sitting in.
  IF current_setting('app.cash_seat_move', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT (t.status = 'closed'), t.tournament_id
    INTO v_is_closed, v_tournament
    FROM public.tables t
   WHERE t.id = NEW.table_id;
  IF COALESCE(v_is_closed, false) THEN
    RETURN NEW;
  END IF;

  /* THE ENTRY WAS ALREADY APPROVED AT THE DOOR (2026-09-09). An active
     entrant taking a chair in their own event is that entry being honoured,
     whether it is their first chair or their fifth move. The cap on entering
     lives in fn_enforce_booking_game_cap, which is the gate that can still
     say no while saying no is free. */
  IF v_tournament IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_live := public.fn_concurrent_game_load(NEW.user_id, NEW.id, NEW.table_id, v_tournament);

  IF v_live >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not take another',
      NEW.user_id, v_live
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before joining another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike. A chair in an event you are already entered in is the entry being honoured and is never refused here.';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_enforce_four_table_limit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_enforce_four_table_limit() FROM anon;
REVOKE ALL ON FUNCTION public.fn_enforce_four_table_limit() FROM authenticated;
