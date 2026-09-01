-- ═══════════════════════════════════════════════════════════════════════════
--  THE SEAT HOLDS ITS CHIPS FROM THE MOMENT IT IS PAID FOR (Dan, 2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "as soon as they buy in 300 chips should appear in their
-- action box (not 0)."
--
-- Both seating paths wrote a ZERO stack and left it there:
--
--   fn_take_seat_and_buy_in       UPDATE ... SET chips = 0 / stack = 0
--   fn_seat_horse_in_seat_first_game            SET stack = 0
--
-- and the real number arrived about 14.8 seconds later, on the chip-drop beat
-- of the reveal, because the stack used to depend on the multiplier the wheel
-- had not drawn yet. The client papered over the gap by falling back to the
-- tournament row's placeholder, and rendered 0 whenever that read failed.
--
-- The stack no longer depends on the draw: it belongs to the board (Turbo 300,
-- Deep Stack 1000; spinSpec SPIN_STACKS), so it is known when the money leaves
-- the wallet and the seat can hold it immediately. That is all this migration
-- does - the seat is written with the chips it has actually bought.
--
-- HORSES GET THE SAME SEAT (CLAUDE.md 10.5). The horse path is changed in the
-- same breath and with the same value; a horse whose seat reads 0 while a human
-- beside it reads 300 is exactly the tell that law exists to prevent.
--
-- Nothing downstream double-credits: creditSeatStacks writes the same
-- tournaments.starting_chips onto the seat at the chip-drop beat, and
-- createTablesAndSeatPlayers seats from `chips || starting_chips`, which is now
-- that same number rather than 0.
--
-- ROLLBACK: re-apply 20260828_reopen_the_seat_first_front_door.sql and the
-- previous fn_seat_horse_in_seat_first_game definition.

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
  v_stack      numeric;
  v_err        text;
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

  -- The chips this seat is buying. Known now, because the board decides it.
  v_stack := COALESCE(v_t.starting_chips, 0);

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

  PERFORM public.fn_sync_seat_first_player_count(v_t.id);

  v_reg := public.fn_register_for_tournament(v_t.id, true);
  IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
     AND COALESCE(v_reg->>'reason', '') <> 'already_registered' THEN
    RETURN jsonb_build_object('ok', false,
      'reason', COALESCE(v_reg->>'reason', 'buy_in_failed'));
  END IF;

  UPDATE public.tournament_players
     SET status = 'playing', chips = v_stack, table_id = p_table_id, seat_number = p_seat_number
   WHERE tournament_id = v_t.id AND user_id = v_uid;

  UPDATE public.table_seats
     SET user_id = v_uid, stack = v_stack, left_at = NULL, joined_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
      VALUES (p_table_id, v_uid, p_seat_number, v_stack);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'seat_taken' USING ERRCODE = '55000';
    END;
  END IF;

  v_taken := COALESCE(public.fn_sync_seat_first_player_count(v_t.id), 0);
  IF v_taken = 0 THEN
    SELECT count(*) INTO v_taken FROM public.table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
  END IF;

  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id,
    'seat_number', p_seat_number, 'stack', v_stack, 'seat_reserved', true,
    'seats_taken', v_taken, 'seats_needed', v_seat_cap,
    'starts_now', v_taken >= v_seat_cap,
    'cost', COALESCE((v_reg->>'cost')::numeric, 0));

EXCEPTION
  WHEN sqlstate '55000' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  WHEN sqlstate '23514' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE '%FOUR TABLE LIMIT%' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'table_limit_reached',
        'limit', 4);
    END IF;
    RAISE;
END;
$function$;

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

DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_take_seat_and_buy_in';
  IF position('stack = 0' in v_src) > 0 OR position('chips = 0' in v_src) > 0 THEN
    RAISE EXCEPTION 'fn_take_seat_and_buy_in still seats a player at zero chips';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_seat_horse_in_seat_first_game';
  IF position('stack     = 0' in v_src) > 0 THEN
    RAISE EXCEPTION 'fn_seat_horse_in_seat_first_game still seats a horse at zero chips';
  END IF;
END $$;;
