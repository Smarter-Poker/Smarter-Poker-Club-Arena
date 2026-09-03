-- A VACATED SEAT CAN BE SAT IN AGAIN (2026-08-25)
--
-- `table_seats_table_id_seat_number_key` is UNIQUE (table_id, seat_number) with
-- NO left_at predicate, while its sibling `idx_unique_active_user_per_table` is
-- correctly UNIQUE (table_id, user_id) WHERE left_at IS NULL.
--
-- So a DEPARTED seat row occupies its seat number on that table forever. The
-- seat picker in fn_seat_horse_in_seat_first_game excludes left_at IS NOT NULL
-- and therefore offers seat 1 as free; the INSERT then collides with the dead
-- row and returns 'seat_taken' - on a table with ZERO live seats.
--
-- Once every seat number on a table has been occupied and vacated once, that
-- table can never seat anybody again. Measured live: tournament 88ef09af had
-- three roster members, zero live seats, and three dead rows holding seats 1, 2
-- and 3 since 2026-08-24. It sat REGISTERING for 29 hours refusing every horse.
-- Seven spins were stuck this way, the oldest 33 hours.
--
-- The index is NOT made partial here on purpose: two shipped migrations
-- (20260317_waitlist_auto_promote.sql, 008_hydra_horse_fleet.sql) use
-- ON CONFLICT (table_id, seat_number), and a partial index does not satisfy an
-- unqualified ON CONFLICT. Narrowing it would trade this bug for a broken
-- upsert in the waitlist and the horse fleet.
--
-- Instead the seating path REUSES the vacated row, which is what actually
-- happens in the world: seat 1 is being sat in again. The live-user index still
-- prevents one player holding two live seats at the same table.
--
-- Applied to production before commit. Result: all 7 wedged spins went from
-- 0-1 live seats to 3 of 3, and the first flipped to RUNNING immediately.
--
-- ROLLBACK: re-apply 20260825090000_seat_the_player_before_claiming_the_seat.sql.

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t       record;
  v_table   record;
  v_seat    int;
  v_reg     jsonb;
  v_taken   int;
  v_already boolean;
  v_seated  int;
BEGIN
  SELECT id, status, variant, max_players, name
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF NOT (COALESCE(v_t.variant,'') = 'spin' OR COALESCE(v_t.max_players,0) <= 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_seat_first_game');
  END IF;

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

  -- TAKE THE SEAT FIRST, and take it by REUSING the vacated row when one is
  -- holding that seat number. The INSERT is the operation that can lose a race,
  -- so it is the one that decides; the roster is told nothing until the seat is
  -- actually held.
  UPDATE public.table_seats
     SET user_id   = p_user_id,
         left_at   = NULL,
         stack     = 0,
         joined_at = now()
   WHERE table_id = v_table.id
     AND seat_number = v_seat
     AND left_at IS NOT NULL;
  GET DIAGNOSTICS v_seated = ROW_COUNT;

  IF v_seated = 0 THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
      VALUES (v_table.id, p_user_id, v_seat, 0);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
    END;
  END IF;

  -- Only now is the claim true.
  UPDATE public.tournament_players
     SET status = 'playing', table_id = v_table.id, seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  v_taken := COALESCE(public.fn_sync_seat_first_player_count(p_tournament_id), 0);

  RETURN jsonb_build_object('ok', true, 'table_id', v_table.id, 'seat_number', v_seat,
    'seats_taken', v_taken, 'reused_registration', v_already, 'reused_seat', v_seated > 0,
    'seats', COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3));
END;
$function$;
