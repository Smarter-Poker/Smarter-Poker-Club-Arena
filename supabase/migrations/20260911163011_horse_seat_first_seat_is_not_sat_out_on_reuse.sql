-- A reused seat row is handed to a horse the way it is handed to a person
--
-- Lane D of the horse audit, 2026-09-11. The body below is production's own
-- definition (pg_get_functiondef, read the same day) with ONE column added to
-- the seat-revival UPDATE and the comment that says why. Nothing else in it
-- moved. The function is reachable only through its maintenance-gate wrapper;
-- anon, authenticated and service_role all hold no EXECUTE on it today and
-- this migration does not grant any.
--
-- CLAUDE.md section 2: one transaction, applied once, outside :50-:03 UTC.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
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
  /* is_sitting_out = false: THE ONE LINE THAT DIFFERED FROM THE HUMAN DOOR
     (2026-09-11). fn_take_seat_and_buy_in revives a vacated seat row with
     is_sitting_out = false; this door revived it without touching the column,
     so a horse handed a chair that a sitting-out player vacated started its
     game sat out. CLAUDE.md 10.5: identical, not equivalent. Zero live
     occurrences when it was found (seat-first tables are fresh per game and
     rarely re-seat a vacated row), so this is the mirror, not an incident. */
     SET user_id        = p_user_id,
         left_at        = NULL,
         stack          = v_stack,
         joined_at      = now(),
         is_sitting_out = false
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


-- THE GRANTS, STATED (2026-09-11). Production holds {postgres=X/postgres} on
-- this function and nothing else: it is reachable only through its own
-- maintenance-gate wrapper. CREATE FUNCTION grants PUBLIC EXECUTE by default,
-- so a rebuild from this file would otherwise open a SECURITY DEFINER writer
-- to anon. PUBLIC is named as well as the roles, because anon inherits
-- whatever PUBLIC holds.
REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $check$
BEGIN
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid,uuid)'::regprocedure)
     NOT LIKE '%is_sitting_out = false%' THEN
    RAISE EXCEPTION 'the seat-revival mirror did not land';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid,uuid)'::regprocedure)
     NOT LIKE '%fn_lock_daily_mission_user%' THEN
    RAISE EXCEPTION 'the missions lock ordering was lost';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the inner seat door became reachable';
  END IF;
END
$check$;

COMMIT;
