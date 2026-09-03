-- ═══════════════════════════════════════════════════════════════════════════════
-- 20260821d: SPINS AND HEADS-UP ARE SEAT-FIRST, LIKE A CASH GAME
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-08-21 (verbatim): "SPINS AREN'T SET UP RIGHT, YOU HAVE THEM SET UP
-- LIKE A TRADITIONAL TOURNAMENT, INSTEAD OF MORE LIKE A CASH GAME. SPINS AND
-- HEADS UP ARE FIRST COME FIRST SERVE, A PLAYER 'SITS DOWN' AT A TABLE AND BUYS
-- INTO THE SPIN OR HEADS UP, LIKE A CASH GAME, NOT LIKE A MTT TOURNAMENT. THE
-- SPIN STARTS WHEN ALL 3 PLAYERS HAVE BOUGHT INTO THE SPIN, THE HEADS UP BEGINS
-- WHEN BOTH PLAYERS BUY IN."
--
-- The old model was MTT-shaped: register in a lobby, wait for a scheduled
-- start, tables materialise at start time. The new model is cash-shaped: the
-- TABLE exists first with open seats, a player takes a specific seat and pays
-- in the same instant, and the game begins the moment the last seat is bought.
--
-- This function is that instant. It is deliberately thin on money: charging,
-- the rake split, the prize pool, the bounty head and the current_players
-- bump all stay inside fn_register_for_tournament, which is audited and
-- idempotent. Duplicating any of it here would create a second entry-fee
-- formula — the exact failure mode already recorded in payoutStructure.ts
-- ("a THIRD independent prize formula"). Seat-first adds SEATING, nothing else.
--
-- CONCURRENCY: the tables row is locked FOR UPDATE before anything is read or
-- written, so two players tapping the same seat serialise; the loser is told
-- 'seat_taken' and is never charged (the charge happens after the seat check,
-- and a unique violation on the seat row rolls the whole function back).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_take_seat_and_buy_in(uuid, integer);

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
  v_stack      numeric;
  v_mine       integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_take_seat_and_buy_in requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  -- Serialise every sit-down at this table.
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

  -- Seat-first applies to spins and heads-up only. Everything else (SNG
  -- fields of 6/9, MTTs) keeps the scheduled-registration model.
  IF NOT (COALESCE(v_t.variant, '') = 'spin' OR COALESCE(v_t.max_players, 0) <= 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_seat_first_game');
  END IF;

  v_seat_cap := COALESCE(NULLIF(v_tbl.max_players, 0), v_t.max_players, 3);

  IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > v_seat_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_seat');
  END IF;

  -- Already sitting here: idempotent, never a second charge. This is the
  -- reconnect / double-tap path.
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

  -- ── MONEY + REGISTRATION: the audited path, unchanged. ──
  v_reg := public.fn_register_for_tournament(v_t.id);
  IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
     AND COALESCE(v_reg->>'reason', '') <> 'already_registered' THEN
    RETURN jsonb_build_object('ok', false,
      'reason', COALESCE(v_reg->>'reason', 'buy_in_failed'));
  END IF;

  v_stack := COALESCE(v_t.starting_chips, 0);

  -- Bought in and seated: 'playing' from the moment the chips are paid, so
  -- the engine's start path seats nobody twice and the paid-gate sees them.
  UPDATE public.tournament_players
     SET status       = 'playing',
         chips        = v_stack,
         table_id     = p_table_id,
         seat_number  = p_seat_number
   WHERE tournament_id = v_t.id AND user_id = v_uid;

  -- Seats are ONE ROW PER (table, seat), reused by UPDATE — never blind-INSERT
  -- (23505 on any seat with history; see TournamentManager's seat-reuse note).
  UPDATE public.table_seats
     SET user_id        = v_uid,
         stack          = v_stack,
         left_at        = NULL,
         joined_at      = now(),
         is_sitting_out = false
   WHERE table_id = p_table_id
     AND seat_number = p_seat_number
     AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
      VALUES (p_table_id, v_uid, p_seat_number, v_stack);
    EXCEPTION WHEN unique_violation THEN
      -- Lost a race that slipped past the lock: refuse, and the whole
      -- function (including the buy-in) rolls back with it.
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
    'stack', v_stack,
    'seats_taken', v_taken,
    'seats_needed', v_seat_cap,
    -- The engine's discovery pass starts the game on this condition; the
    -- client uses it to say "Game Starting" instead of "Waiting".
    'starts_now', v_taken >= v_seat_cap,
    'cost', COALESCE((v_reg->>'cost')::numeric, 0)
  );

EXCEPTION WHEN sqlstate '55000' THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_take_seat_and_buy_in(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_take_seat_and_buy_in(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_take_seat_and_buy_in(uuid, integer) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'fn_take_seat_and_buy_in'
  ) THEN
    RAISE EXCEPTION 'fn_take_seat_and_buy_in missing after apply';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'fn_take_seat_and_buy_in') <> 1 THEN
    RAISE EXCEPTION 'fn_take_seat_and_buy_in must have exactly one overload';
  END IF;
END $$;
