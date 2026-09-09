/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CHAIR CHANGE INSIDE A GAME YOU ARE ALREADY IN IS NOT A FIFTH GAME
 *  2026-09-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE DRIFT. Fourteen RUNNING tournaments were short 1,962,900 play chips.
 * The chips were not lost: 1,673,900 of them were sitting in `table_seats`
 * rows that had been stamped `left_at`, belonging to players whose
 * `tournament_players` row still said `playing`. They held chips, they were
 * still in the event, and they were seated at no table - so they could not be
 * dealt a hand, and every reader that counts open seats read straight past
 * their stacks.
 *
 * HOW THEY GOT THERE, measured on production 2026-09-09:
 *
 *   1. The balancer moves a player between tables inside ONE tournament. It
 *      stamps `left_at` on the source seat first, then writes the destination
 *      seat (TournamentManager.executePlayerMoves).
 *
 *   2. Between those two writes the player holds NO live seat in that
 *      tournament. `fn_concurrent_game_load` clause (1) therefore stops
 *      counting the event they are actually playing, and clause (2) starts
 *      counting their OTHER bookings. A horse registered for four imminent
 *      events reads as a load of 4 while it is mid-move.
 *
 *   3. This trigger refuses the destination write: FOUR TABLE LIMIT. Proven
 *      on the live rows - user ecd88691 (Prime Time Main Event, 370,000 chips
 *      stranded) has 0 live seats and 4 bookings.
 *
 *   4. The engine's compensating restore - UPDATE ... SET left_at = NULL on
 *      the source seat - is then refused too, by
 *      ab_refuse_live_seat_on_closed_tournament_table, because a broken
 *      table is closed by the time the restore runs. Neither refusal is
 *      error-checked in the engine, so both are silent.
 *
 *   5. The one repair that exists, absorbOrphanedSeats, reads
 *      `left_at IS NULL`. It is structurally blind to a player who holds no
 *      live seat at all, so nothing ever brings them back.
 *
 * THE RULE THIS RESTORES. The four-table limit exists to stop a player
 * COMMITTING to a fifth game; its own hint says so ("Leave a table or
 * unregister before joining another"). It was never meant to evict someone
 * from a game they are already in. The cash floor learned this on 2026-09-05
 * and got an exemption - `app.cash_seat_move` - but that is a GUC the caller
 * has to remember to set, and the tournament mover never knew about it.
 *
 * So this exemption is derived from the DATA rather than announced by the
 * caller: if you are an active entrant in this event and you already have a
 * chair history in it, the chair you are taking is a continuation and not an
 * acquisition. No caller can forget to say so, because nobody has to say it.
 *
 * WHAT STILL HOLDS. This loosens nothing else, because nothing else is this
 * trigger's job:
 *   - trg_one_live_seat_per_tournament still refuses a SECOND live seat in
 *     the same event, so this cannot be used to sit twice;
 *   - ab_refuse_live_seat_on_closed_tournament_table still refuses a live
 *     seat on a closed table;
 *   - trg_lock_and_validate_tournament_live_seat and
 *     tournament_live_seat_has_active_roster still require an active roster;
 *   - trg_ca_guard_seat_creation still requires the engine or a declared
 *     money path to put chips on a chair.
 *
 * INITIAL SEATING IS UNCHANGED. A player with no prior chair in the event is
 * evaluated exactly as before, so the cap still applies to joining.
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
  v_continues  boolean := false;
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

  /* THE SAME RULE FOR TOURNAMENTS, DERIVED RATHER THAN DECLARED (2026-09-09).
     An active entrant who already has a chair history in THIS event is
     changing chairs, not taking a new game. Covers both shapes the mover
     produces: a fresh row at the destination table while the source row is
     already stamped left_at, and the reuse of the player's own vacated row. */
  IF v_tournament IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    v_continues :=
      (TG_OP = 'UPDATE' AND OLD.user_id = NEW.user_id AND OLD.left_at IS NOT NULL)
      OR EXISTS (
        SELECT 1
          FROM public.table_seats prior
          JOIN public.tables pt ON pt.id = prior.table_id
         WHERE prior.user_id = NEW.user_id
           AND pt.tournament_id = v_tournament
           AND prior.id IS DISTINCT FROM NEW.id
      );
    IF v_continues THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_live := public.fn_concurrent_game_load(NEW.user_id, NEW.id, NEW.table_id, v_tournament);

  IF v_live >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not take another',
      NEW.user_id, v_live
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before joining another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike. A chair change inside a game you are already in is exempt.';
  END IF;

  RETURN NEW;
END;
$function$;

-- Self-contained ACL: a trigger function is not a browser routine.
REVOKE ALL ON FUNCTION public.fn_enforce_four_table_limit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_enforce_four_table_limit() FROM anon;
REVOKE ALL ON FUNCTION public.fn_enforce_four_table_limit() FROM authenticated;
