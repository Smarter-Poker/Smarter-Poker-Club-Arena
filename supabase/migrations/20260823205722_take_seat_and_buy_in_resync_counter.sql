-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823205722 "take_seat_and_buy_in_resync_counter"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 133c9ae5f3345f06217fef01c5f48577 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- fn_take_seat_and_buy_in: stop a drifted counter locking players out.
--
-- Dan 2026-08-23: "spins doesn't not let you sit down". Reproduced on live
-- data: fn_register_for_tournament refuses with 'tournament_full' whenever
-- tournaments.current_players has reached max_players, and that counter only
-- ever counts up — it is never decremented when a player leaves or busts. Live
-- spins were sitting at current_players = 3 with only two seats sold, so every
-- attempt to buy the free seat was rejected.
--
-- The seat rows are the truth. Reconcile the counter against them immediately
-- before the buy-in is attempted, and again once the seat is sold.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_take_seat_and_buy_in(p_table_id uuid, p_seat_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_tbl        record;
  v_t          record;
  v_reg        jsonb;
  v_seat_cap   integer;
  v_taken      integer;
  v_mine       integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_take_seat_and_buy_in requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, tournament_id, max_players, status
    INTO v_tbl FROM public.tables WHERE id = p_table_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF v_tbl.tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_game_table');
  END IF;
  -- A retired table sells no seats. Say so precisely so the client can follow
  -- the tournament to whichever table is live now instead of showing the
  -- player "That Seat Was Just Taken" on a seat that reads empty.
  IF v_tbl.status = 'closed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_closed');
  END IF;

  SELECT id, status, variant, max_players, starting_chips, name
    INTO v_t FROM public.tournaments WHERE id = v_tbl.tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;

  IF NOT (COALESCE(v_t.variant, '') = 'spin' OR COALESCE(v_t.max_players, 0) <= 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_seat_first_game');
  END IF;

  v_seat_cap := COALESCE(NULLIF(v_tbl.max_players, 0), v_t.max_players, 3);

  IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > v_seat_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_seat');
  END IF;

  SELECT seat_number INTO v_mine
    FROM public.table_seats
   WHERE table_id = p_table_id AND user_id = v_uid AND left_at IS NULL LIMIT 1;
  IF v_mine IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_seated', true,
      'table_id', p_table_id, 'seat_number', v_mine);
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_already_started');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.table_seats
     WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  END IF;

  -- Reconcile the registration counter with the seats actually sold BEFORE
  -- buying in, or a drifted count sends fn_register_for_tournament down its
  -- 'tournament_full' branch and the free seat can never be bought.
  PERFORM public.fn_sync_seat_first_player_count(v_t.id);

  v_reg := public.fn_register_for_tournament(v_t.id);
  IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
     AND COALESCE(v_reg->>'reason', '') <> 'already_registered' THEN
    RETURN jsonb_build_object('ok', false,
      'reason', COALESCE(v_reg->>'reason', 'buy_in_failed'));
  END IF;

  UPDATE public.tournament_players
     SET status = 'playing', chips = 0, table_id = p_table_id, seat_number = p_seat_number
   WHERE tournament_id = v_t.id AND user_id = v_uid;

  UPDATE public.table_seats
     SET user_id = v_uid, stack = 0, left_at = NULL, joined_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
      VALUES (p_table_id, v_uid, p_seat_number, 0);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'seat_taken' USING ERRCODE = '55000';
    END;
  END IF;

  -- The seat is paid for. Both counters now derive from the seat rows, so the
  -- lobby tile, the start gate and this function can never disagree again.
  v_taken := COALESCE(public.fn_sync_seat_first_player_count(v_t.id), 0);
  IF v_taken = 0 THEN
    SELECT count(*) INTO v_taken FROM public.table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
  END IF;

  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id,
    'seat_number', p_seat_number, 'stack', 0, 'seat_reserved', true,
    'seats_taken', v_taken, 'seats_needed', v_seat_cap,
    'starts_now', v_taken >= v_seat_cap,
    'cost', COALESCE((v_reg->>'cost')::numeric, 0));

EXCEPTION WHEN sqlstate '55000' THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
END;
$function$;
