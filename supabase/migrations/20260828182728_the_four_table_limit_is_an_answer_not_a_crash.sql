-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828182728; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE FOUR-TABLE LIMIT IS AN ANSWER, NOT A CRASH.
--
-- 2026-08-28, found while sweeping every refusal path out of the seat-first
-- outage (#1620). `fn_enforce_four_table_limit` and `fn_enforce_booking_game_cap`
-- both RAISE with ERRCODE 23514. fn_take_seat_and_buy_in caught only 55000, so
-- the raise escaped the function entirely and reached the browser as a raw
-- PostgREST error:
--
--   sqlstate=23514
--   message=FOUR TABLE LIMIT: user 6443a6ce-... is already committed to 4 games
--
-- Proven live against production, in a rolled-back probe, before this migration.
--
-- Two things were wrong with that.
--
-- 1. IT IS THE SAME DEAD END DAN REPORTED. That message matches none of the
--    client's toast branches, so a player at their cap tapping a fifth seat got
--    "Could Not Take That Seat, Please Try Again" - the identical unhelpful
--    string, from a completely different cause. 29,522 of these were raised in
--    the last 24 hours across 131 distinct players.
--
-- 2. IT LEAKS AN INTERNAL SENTENCE AND A RAW UUID to the client, where every
--    other refusal in this function is a tidy machine-readable reason.
--
-- The cap itself is CORRECT and is not touched: it is the house rule, it is
-- enforced in a trigger under an advisory lock so it cannot be raced, and it
-- applies to horses exactly as it applies to humans (HORSES ARE PLAYERS). The
-- only thing that changes is that the seat path now ANSWERS with it instead of
-- crashing on it.
--
-- Narrow on purpose: 23514 is check_violation generally, so only the four-table
-- message is converted. Any other check violation is re-raised untouched -
-- a bare RAISE inside the handler preserves the original error, its sqlstate
-- and its context. Swallowing every 23514 here would hide real constraint bugs
-- behind a friendly sentence, which is the failure mode this repo keeps
-- learning about.
--
-- ROLLBACK
--   Re-apply the fn_take_seat_and_buy_in body from
--   20260828 'reopen_the_seat_first_front_door' (its statements are in
--   supabase_migrations.schema_migrations) - it is this function minus the
--   23514 handler and minus v_err.

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

  -- REOPENED 2026-08-28: the `true` is p_seat_first_internal. Without it the
  -- seat-first guard inside fn_register_for_tournament refuses THIS caller
  -- too, and no seat-first seat can be bought by anyone (the 2026-08-27 to
  -- 2026-08-28 outage). The guard still refuses every external registration
  -- into a seat-first event.
  v_reg := public.fn_register_for_tournament(v_t.id, true);
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

EXCEPTION
  WHEN sqlstate '55000' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  WHEN sqlstate '23514' THEN
    -- The four-table cap is a house rule, so answer with it. Every OTHER check
    -- violation is a real constraint failure and is re-raised untouched.
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE '%FOUR TABLE LIMIT%' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'table_limit_reached',
        'limit', 4);
    END IF;
    RAISE;
END;
$function$;

DO $post$
DECLARE v_n int;
BEGIN
  -- The handler exists and is narrow.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'fn_take_seat_and_buy_in'
       AND p.prosrc LIKE '%table_limit_reached%'
       AND p.prosrc LIKE '%FOUR TABLE LIMIT%'
       AND p.prosrc LIKE '%RAISE;%'
  ) THEN
    RAISE EXCEPTION 'the 23514 handler is missing, or is not re-raising other check violations';
  END IF;

  -- The front-door fix from earlier today is still in place (this migration
  -- rewrites the same function, so prove it did not regress it).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'fn_take_seat_and_buy_in'
       AND p.prosrc LIKE '%fn_register_for_tournament(v_t.id, true)%'
  ) THEN
    RAISE EXCEPTION 'the seat path stopped passing p_seat_first_internal';
  END IF;

  -- And the cap triggers still exist to be caught.
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosrc LIKE '%FOUR TABLE LIMIT%'
     AND p.prorettype = 'pg_catalog.trigger'::regtype;
  IF v_n < 2 THEN
    RAISE EXCEPTION 'expected both four-table-limit triggers, found %', v_n;
  END IF;
END
$post$;
