-- ═══════════════════════════════════════════════════════════════════════════
-- SPIN SEAT LIFECYCLE (Dan 2026-08-23)
--
--   "their seat is only confirmed once the funds are taken from the players
--    wallet."
--   "when a spin is over, it must remove all players and reopen the table.
--    when a player busts, they must be removed as soon as they are out."
--   "spins can never ever start until 3 players have sat down, and paid for
--    there seat, only then does the spin feature start."
--
-- Applied to production 2026-08-23 through the Supabase MCP; this file is the
-- repo's copy of it, so a fresh database lands where production already is.
-- Ordered after 20260823270000 on purpose: that migration replaces
-- fn_register_for_tournament, which fn_take_seat_and_buy_in below CALLS.
--
-- Three defects this repairs, all observed on live data:
--
--   1. tournaments.current_players is a registration counter that is only ever
--      incremented. Seat-first buy-ins updated tables.current_players and left
--      it alone, and nothing decremented it on leave or bust. Live spins were
--      carrying 3/3 with two seats sold and 0/3 with three sold. Once it
--      reaches max_players, fn_register_for_tournament refuses every further
--      sit-down with 'tournament_full' — a spin that can never be joined.
--
--   2. Finished spins left their seat rows with left_at IS NULL. Those ghost
--      seats are invisible to the table page but real to the database, so an
--      apparently empty seat answered "seat_taken".
--
--   3. A busted player kept their seat until the whole game tore down.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Recompute a seat-first game's player count from the seats actually sold ──
CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_table  uuid;
  v_seats  integer := 0;
BEGIN
  -- Newest live table wins: the recycler leaves the freshest one open and an
  -- older sibling not yet stamped closed is a corpse.
  SELECT id INTO v_table
    FROM public.tables
   WHERE tournament_id = p_tournament_id
     AND status <> 'closed'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_table IS NULL THEN
    RETURN NULL;  -- no live table: leave the counter alone
  END IF;

  SELECT count(*) INTO v_seats
    FROM public.table_seats
   WHERE table_id = v_table AND left_at IS NULL;

  UPDATE public.tables      SET current_players = v_seats WHERE id = v_table;
  UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;

  RETURN v_seats;
END;
$function$;

-- ── Vacate every seat on a table and hand it back empty ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_clear_table_seats(p_table_id uuid, p_reopen boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_cleared integer := 0;
BEGIN
  UPDATE public.table_seats
     SET left_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND left_at IS NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  UPDATE public.tables
     SET current_players = 0,
         status = CASE WHEN p_reopen AND status <> 'closed' THEN 'waiting' ELSE status END
   WHERE id = p_table_id;

  RETURN v_cleared;
END;
$function$;

-- ── A finished game keeps no seats ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_clear_seats_on_game_end()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_table uuid;
BEGIN
  IF NEW.status IN ('COMPLETED', 'CANCELLED')
     AND COALESCE(OLD.status, '') IS DISTINCT FROM NEW.status THEN
    FOR v_table IN
      SELECT id FROM public.tables WHERE tournament_id = NEW.id
    LOOP
      -- Never reopen a table whose game is over: the recycler builds the next
      -- spin its own fresh table. What must not survive is the seat rows.
      PERFORM public.fn_clear_table_seats(v_table, false);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_clear_seats_on_game_end ON public.tournaments;
CREATE TRIGGER trg_clear_seats_on_game_end
  AFTER UPDATE OF status ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_clear_seats_on_game_end();

GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_clear_table_seats(uuid, boolean)   TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- fn_take_seat_and_buy_in: stop a drifted counter locking players out.
--
-- Dan 2026-08-23: "spins doesn't not let you sit down". Reproduced on live
-- data: fn_register_for_tournament refuses with 'tournament_full' whenever
-- tournaments.current_players has reached max_players, and that counter only
-- ever counts up. Live spins sat at current_players = 3 with two seats sold,
-- so every attempt to buy the free seat was rejected.
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

-- fn_bust_player_from_table was created alongside this work and never acquired
-- a caller: the engine releases the busted player's seat inline
-- (TournamentManagerEliminations) and then calls
-- fn_sync_seat_first_player_count. Two ways to do one thing is how two bust
-- paths drift apart, so the unused one is dropped rather than wired.
DROP FUNCTION IF EXISTS public.fn_bust_player_from_table(uuid, uuid);
