-- SEATING A HORSE TAKES THE MISSIONS LOCK BEFORE THE GAME ROW.
--
-- ROOT CAUSE, from the Postgres log for the 24 hours to 2026-09-06 15:15 UTC:
-- 12 deadlocks between fn_seat_horse_in_seat_first_game and a plain
-- hand_history INSERT, on "SELECT pg_advisory_xact_lock(hashtextextended(
-- 'daily-missions-user:' || ...))" inside fn_daily_missions_tournament_
-- registered_updated. The seating function holds the game row (FOR UPDATE),
-- the seat, and the player's tournament_players row, and only THEN - through
-- the statement trigger on tournament_players - asks for the player's Daily
-- Missions lock. The hand the same horse is finishing at another table takes
-- that lock first (fn_enqueue_hand_daily_missions -> enqueue_daily_challenge_
-- event -> fn_lock_daily_mission_user, which also locks the profiles row) and
-- then waits on something the seating holds. Rows-then-lock against
-- lock-then-rows. The victim was whichever Postgres chose; when it was the
-- hand, its history row went to the engine's retry queue.
--
-- THE FIX IS THE ORDER. The seating function takes
-- fn_lock_daily_mission_user(p_user_id) as its first lock, before the game
-- row, so both paths go lock-then-rows. Advisory transaction locks re-enter,
-- so the trigger's later acquisition costs nothing. Everything else in the
-- function is unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t       record;
  v_table   record;
  v_seat    int;
  v_reg     jsonb;
  v_taken   int;
  v_already boolean;
  v_seated  int;
  v_stack   numeric;
BEGIN
  PERFORM set_config('app.money_path', 'fn_seat_horse_in_seat_first_game', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)

  /* THE PLAYER'S MISSIONS LOCK BEFORE THE GAME ROW (20260906). Seating ends
     with UPDATE tournament_players ... status = 'playing', whose statement
     trigger fn_daily_missions_tournament_registered_updated takes the
     per-player advisory lock 'daily-missions-user:<id>' and the player's
     profiles row. A hand this horse is playing elsewhere writes hand_history
     at the same moment and its trigger takes that same lock FIRST, then waits
     on a row this function holds. Rows-then-lock here, lock-then-rows there:
     12 deadlocks a day, and the victim on the other side was the hand
     record. Take the lock first, in the same order as the hand path; the
     trigger re-takes it later at no cost (advisory xact locks re-enter). */
  PERFORM public.fn_lock_daily_mission_user(p_user_id);

  SELECT id, status, variant, max_players, starting_chips, name
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF NOT (COALESCE(v_t.variant,'') = 'spin' OR COALESCE(v_t.max_players,0) <= 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_seat_first_game');
  END IF;

  -- Identical to the human seat. See CLAUDE.md 10.5.
  v_stack := COALESCE(v_t.starting_chips, 0);

  SELECT id, max_players INTO v_table
    FROM public.tables
   WHERE id = public.fn_tournament_primary_table(p_tournament_id);
  IF v_table.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_table');
  END IF;

  IF EXISTS (SELECT 1 FROM public.table_seats
              WHERE table_id = v_table.id AND user_id = p_user_id AND left_at IS NULL) THEN
    RETURN jsonb_build_object('ok', true, 'already_seated', true);
  END IF;

  SELECT s INTO v_seat
    FROM generate_series(1, COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3)) s
   WHERE NOT EXISTS (
     SELECT 1 FROM public.table_seats ts
      WHERE ts.table_id = v_table.id AND ts.seat_number = s AND ts.left_at IS NULL
   )
   ORDER BY s LIMIT 1;

  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_full');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.tournament_players
                  WHERE tournament_id = p_tournament_id AND user_id = p_user_id)
    INTO v_already;

  IF NOT v_already THEN
    v_reg := public.fn_register_horse_for_tournament(p_tournament_id, p_user_id);
    IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
       AND COALESCE(v_reg->>'reason','') <> 'already_registered' THEN
      RETURN jsonb_build_object('ok', false, 'reason', COALESCE(v_reg->>'reason','register_failed'));
    END IF;
  END IF;

  UPDATE public.table_seats
     SET user_id   = p_user_id,
         left_at   = NULL,
         stack     = v_stack,
         joined_at = now()
   WHERE table_id = v_table.id
     AND seat_number = v_seat
     AND left_at IS NOT NULL;
  GET DIAGNOSTICS v_seated = ROW_COUNT;

  IF v_seated = 0 THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
      VALUES (v_table.id, p_user_id, v_seat, v_stack);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
    END;
  END IF;

  UPDATE public.tournament_players
     SET status = 'playing', chips = v_stack, table_id = v_table.id, seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  v_taken := COALESCE(public.fn_sync_seat_first_player_count(p_tournament_id), 0);

  RETURN jsonb_build_object('ok', true, 'table_id', v_table.id, 'seat_number', v_seat,
    'stack', v_stack,
    'seats_taken', v_taken, 'reused_registration', v_already, 'reused_seat', v_seated > 0,
    'seats', COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3));
END;
$function$;

DO $verify$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_seat_horse_in_seat_first_game' AND pronamespace = 'public'::regnamespace;
  IF position('public.fn_lock_daily_mission_user(p_user_id)' in v_src) = 0
     OR position('public.fn_lock_daily_mission_user(p_user_id)' in v_src)
        > position('FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE' in v_src) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the missions lock is not taken before the game row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_lock_daily_mission_user'
                    AND pronamespace = 'public'::regnamespace AND prosrc ~ 'daily-missions-user:') THEN
    RAISE EXCEPTION 'VERIFY FAILED: fn_lock_daily_mission_user no longer takes the daily-missions-user lock; re-derive';
  END IF;
  RAISE NOTICE 'SEAT_HORSE_ORDER missions lock -> game row -> seat -> player';
END $verify$;

COMMIT;
