-- ═══════════════════════════════════════════════════════════════════════════
--  TWO WRITERS FOR "HOW FULL IS THIS SPIN", AGAIN, WITHIN THE HOUR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260823310000 taught fn_seat_horse_in_seat_first_game to maintain
-- tournaments.current_players, because a Spin with two horses in seats 1 and 2
-- was advertising itself as 0/3. It computed the number from tournament_players.
--
-- Independently, and within the same hour, fn_sync_seat_first_player_count
-- appeared and now maintains the SAME column from the SEATS at the newest live
-- table. It is called by fn_take_seat_and_buy_in (the human path) and by
-- fn_bust_player_from_table (elimination).
--
-- So the count a player reads had two definitions that do not agree:
--
--     horse sits    -> count(tournament_players WHERE status IN (...))
--     human sits    -> count(table_seats WHERE left_at IS NULL)
--
-- They diverge the moment a registration exists without a seat, and a lobby
-- number that depends on WHO last touched it is the exact shape of every bug
-- fixed here today: the club-home scope written twice, the member count
-- answered by two queries and flipping between 1,172 and 588.
--
-- THE SEATS ARE RIGHT, so the seats win. A seat-first game starts when every
-- SEAT is sold, buying in and taking a seat are one atomic step
-- (fn_take_seat_and_buy_in), and the card shows how many of three chairs are
-- occupied. Counting registrations describes an MTT, which this is not.
--
-- One definition now, called by all three paths. Applied to production
-- 2026-08-23 via the Supabase MCP; 88 live seat-first games resynced after.
-- ═══════════════════════════════════════════════════════════════════════════
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

  SELECT id, max_players INTO v_table
    FROM public.tables WHERE tournament_id = p_tournament_id
    ORDER BY created_at LIMIT 1;
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

DO $check$
DECLARE def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO def FROM pg_proc WHERE proname = 'fn_seat_horse_in_seat_first_game';
  IF def NOT LIKE '%fn_sync_seat_first_player_count%' THEN
    RAISE EXCEPTION 'the horse path no longer delegates to fn_sync_seat_first_player_count';
  END IF;
  IF def LIKE '%UPDATE public.tournaments%' THEN
    RAISE EXCEPTION 'the horse path is writing tournaments.current_players itself again - two writers, one rule';
  END IF;
END $check$;
