-- ═══════════════════════════════════════════════════════════════════════════════
-- 20260821e: A SEAT IS A RESERVATION. LEAVING IT REFUNDS IN FULL.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-08-21:
--   (1) "PLAYERS DO NOT RECEIVE CHIPS UNTIL AFTER THE SPIN HAPPENS AND THE GAME
--        IS DETERMINED... THEY ARE SIMPLY SECURING A SEAT, WHEN THEY BUY IN
--        EARLY."
--   (2) "IF THEY 'LEAVE THE SEAT' THEY ARE FULLY REFUNDED."
--
-- (1) Buying in early secures a SEAT, nothing more. The stack is 0 until the
--     wheel decides the game: spin tiers carry different starting stacks
--     (300/400/500), so any chips handed out before the draw would be a
--     guess — and a visible one, since the seat renders its stack. Start
--     assigns the real tier stack to every seat (the seat-stack sync in
--     TournamentManagerBase), so 0 is not a placeholder to be corrected
--     later, it is the truth until there is a truth.
--
-- (2) A reservation you cannot cancel is a trap. Leaving before the game
--     starts returns the ENTIRE charge — buy-in, fee and bounty alike — and
--     unwinds every trace of the entry: the prize pool, the bounty pool, the
--     rake total, the player count, the rake record and the seat itself. The
--     refund is idempotent (a keyed credit), so a double-tap cannot pay twice.
--     Once the game has started the seat is no longer refundable; you are in
--     the game and the normal payout rules own the outcome.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_leave_seat_and_refund(uuid);
--   -- and restore the previous fn_take_seat_and_buy_in body from 20260821d
--   -- (its only difference is v_stack := COALESCE(v_t.starting_chips, 0)).

-- ── (1) The seat carries no chips until the game is determined ───────────────
CREATE OR REPLACE FUNCTION public.fn_take_seat_and_buy_in(
  p_table_id uuid,
  p_seat_number integer
)
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
    INTO v_tbl
    FROM public.tables
   WHERE id = p_table_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF v_tbl.tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_game_table');
  END IF;

  SELECT id, status, variant, max_players, starting_chips, name
    INTO v_t
    FROM public.tournaments
   WHERE id = v_tbl.tournament_id
     FOR UPDATE;
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
   WHERE table_id = p_table_id AND user_id = v_uid AND left_at IS NULL
   LIMIT 1;
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

  v_reg := public.fn_register_for_tournament(v_t.id);
  IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
     AND COALESCE(v_reg->>'reason', '') <> 'already_registered' THEN
    RETURN jsonb_build_object('ok', false,
      'reason', COALESCE(v_reg->>'reason', 'buy_in_failed'));
  END IF;

  -- NO CHIPS YET. The seat is secured; the stack arrives when the game is
  -- determined and start() syncs every seat to the drawn tier's stack.
  UPDATE public.tournament_players
     SET status       = 'playing',
         chips        = 0,
         table_id     = p_table_id,
         seat_number  = p_seat_number
   WHERE tournament_id = v_t.id AND user_id = v_uid;

  UPDATE public.table_seats
     SET user_id        = v_uid,
         stack          = 0,
         left_at        = NULL,
         joined_at      = now(),
         is_sitting_out = false
   WHERE table_id = p_table_id
     AND seat_number = p_seat_number
     AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
      VALUES (p_table_id, v_uid, p_seat_number, 0);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'seat_taken' USING ERRCODE = '55000';
    END;
  END IF;

  SELECT count(*) INTO v_taken
    FROM public.table_seats
   WHERE table_id = p_table_id AND left_at IS NULL;

  UPDATE public.tables SET current_players = v_taken WHERE id = p_table_id;

  RETURN jsonb_build_object(
    'ok', true,
    'table_id', p_table_id,
    'seat_number', p_seat_number,
    'stack', 0,
    'seat_reserved', true,
    'seats_taken', v_taken,
    'seats_needed', v_seat_cap,
    'starts_now', v_taken >= v_seat_cap,
    'cost', COALESCE((v_reg->>'cost')::numeric, 0)
  );

EXCEPTION WHEN sqlstate '55000' THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
END;
$function$;

-- ── (2) Leaving the seat before the start refunds everything ────────────────
CREATE OR REPLACE FUNCTION public.fn_leave_seat_and_refund(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_tbl     record;
  v_t       record;
  v_split   record;
  v_bounty  boolean;
  v_seat    integer;
  v_taken   integer;
  v_ok      boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, tournament_id INTO v_tbl
    FROM public.tables WHERE id = p_table_id FOR UPDATE;
  IF NOT FOUND OR v_tbl.tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  SELECT id, status, variant, max_players, buy_in_amount, buy_in_fee,
         bounty_amount, is_bounty, is_pko, is_mystery_bounty, club_id, name
    INTO v_t
    FROM public.tournaments WHERE id = v_tbl.tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;

  -- Refundable only while the seats are still being sold. Once the cards are
  -- in the air the buy-in belongs to the prize pool.
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_already_started');
  END IF;

  SELECT seat_number INTO v_seat
    FROM public.table_seats
   WHERE table_id = p_table_id AND user_id = v_uid AND left_at IS NULL
   LIMIT 1;
  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_seated');
  END IF;

  v_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
              OR COALESCE(v_t.is_mystery_bounty, false);

  -- The same split the entry was priced with — never a second formula.
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_bounty);

  -- Free the seat first: whatever else happens, the seat is available again.
  UPDATE public.table_seats
     SET left_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND user_id = v_uid AND left_at IS NULL;

  -- Unwind the registration itself.
  DELETE FROM public.tournament_players
   WHERE tournament_id = v_t.id AND user_id = v_uid;

  -- Unwind every pool the entry fed. GREATEST(...,0) so a mis-set column can
  -- never drive a pool negative.
  UPDATE public.tournaments
     SET current_players = GREATEST(COALESCE(current_players, 0) - 1, 0),
         prize_pool      = GREATEST(COALESCE(prize_pool, 0)  - v_split.prize, 0),
         bounty_pool     = GREATEST(COALESCE(bounty_pool, 0) - v_split.bounty, 0),
         total_rake      = GREATEST(COALESCE(total_rake, 0)  - v_split.rake, 0)
   WHERE id = v_t.id;

  -- The entry fee never happened, so neither did its rake record.
  DELETE FROM public.rake_records
   WHERE tournament_id = v_t.id
     AND source = 'fn_register_for_tournament'
     AND (metadata->>'user_id') = v_uid::text;

  -- Refund the WHOLE charge. Keyed, so a double-tap cannot pay twice.
  IF COALESCE(v_split.charge, 0) > 0 THEN
    v_ok := public.credit_player_wallet(
      v_uid, v_split.charge,
      'seat_refund:' || v_t.id::text || ':' || v_uid::text);
    PERFORM public.log_wallet_transaction(
      v_uid, 'PLAYER', v_split.charge, 'credit', 'tournament_refund',
      'Seat released: ' || COALESCE(v_t.name, 'game') || ' (full refund)',
      NULL, NULL, v_t.id);
  END IF;

  SELECT count(*) INTO v_taken
    FROM public.table_seats
   WHERE table_id = p_table_id AND left_at IS NULL;
  UPDATE public.tables SET current_players = v_taken WHERE id = p_table_id;

  RETURN jsonb_build_object(
    'ok', true,
    'refunded', COALESCE(v_split.charge, 0),
    'seat_number', v_seat,
    'seats_taken', v_taken
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_leave_seat_and_refund(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_leave_seat_and_refund(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_leave_seat_and_refund(uuid) TO service_role;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'fn_leave_seat_and_refund') <> 1 THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund must exist with exactly one overload';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'fn_take_seat_and_buy_in') <> 1 THEN
    RAISE EXCEPTION 'fn_take_seat_and_buy_in must exist with exactly one overload';
  END IF;
END $$;
