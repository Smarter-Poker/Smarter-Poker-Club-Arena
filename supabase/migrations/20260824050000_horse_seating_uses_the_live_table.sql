-- ============================================================================
-- HORSE SEATING USES THE LIVE TABLE (2026-08-24 audit P1-3)
-- TIER: 2  |  AFFECTS: fn_seat_horse_in_seat_first_game (function replace only)
--
-- fn_seat_horse_in_seat_first_game picked its table with
--   ORDER BY created_at LIMIT 1
-- and NO status filter: the OLDEST table ever created for the tournament,
-- closed ones included. Every other component of the seat-first path — the
-- engine's paid-seat start gate, fn_sync_seat_first_player_count, and the
-- client's recycled-table follow — reads the NEWEST non-closed table. The
-- moment a tournament carries a recycled table pair, horses seat on the
-- corpse: the paid-seat count on the live table stays short, the game never
-- starts, and the corpse's seats block the four-table limit for nothing.
--
-- One-line fix: newest non-closed table, same as everyone else.
--
-- ROLLBACK: re-apply the previous definition with
--   ORDER BY created_at LIMIT 1  and no status filter (not recommended).
-- ============================================================================

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
BEGIN
  SELECT id, status, variant, max_players, name
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF NOT (COALESCE(v_t.variant,'') = 'spin' OR COALESCE(v_t.max_players,0) <= 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_seat_first_game');
  END IF;

  -- THE LIVE TABLE, not the oldest ever created. Same definition as
  -- fn_sync_seat_first_player_count and the engine's paid-seat start gate.
  SELECT id, max_players INTO v_table
    FROM public.tables
   WHERE tournament_id = p_tournament_id
     AND status <> 'closed'
   ORDER BY created_at DESC
   LIMIT 1;
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

  UPDATE public.tournament_players
     SET status = 'playing', table_id = v_table.id, seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  BEGIN
    INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
    VALUES (v_table.id, p_user_id, v_seat, 0);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  END;

  -- ONE DEFINITION OF HOW FULL THIS GAME IS. The same function the human path
  -- (fn_take_seat_and_buy_in) and elimination (fn_bust_player_from_table) use.
  -- It maintains BOTH tables.current_players and tournaments.current_players
  -- from the seats, so a horse sitting down and a human sitting down can never
  -- leave the lobby with two different answers.
  v_taken := COALESCE(public.fn_sync_seat_first_player_count(p_tournament_id), 0);

  RETURN jsonb_build_object('ok', true, 'table_id', v_table.id, 'seat_number', v_seat,
    'seats_taken', v_taken, 'reused_registration', v_already,
    'seats', COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3));
END;
$function$;

-- Post-apply assertion: exactly one overload, and the new table pick is live.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'fn_seat_horse_in_seat_first_game') <> 1 THEN
    RAISE EXCEPTION 'fn_seat_horse_in_seat_first_game must have exactly one overload';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_seat_horse_in_seat_first_game')
     NOT LIKE '%created_at DESC%' THEN
    RAISE EXCEPTION 'live-table pick did not land';
  END IF;
END $$;
