-- A SEAT CASHOUT LOCKS THE GAME BEFORE THE SEAT.
--
-- ROOT CAUSE, from the Postgres log for the 24 hours to 2026-09-06 15:15 UTC:
-- 131 deadlocks "while locking tuple in relation table_seats", every one the
-- same pair - atomic_seat_cashout_locked against the engine's
-- UPDATE tournaments SET status = 'COMPLETED' - and every one at the end of a
-- spin or a heads-up match, because that is the moment the engine both cashes
-- the seats out and marks the game finished:
--
--   finish:  tournaments (row) -> trigger fn_clear_seats_on_game_end
--                              -> fn_clear_table_seats -> every table_seats row
--   cashout: table_seats (row) -> trigger fn_seat_change_syncs_seat_first_count
--                              -> fn_sync_seat_first_player_count
--                              -> UPDATE tournaments SET current_players
--
-- Child-then-parent on one side, parent-then-child on the other. One of the
-- two is killed: a cashout that dies leaves the seat and, on a cash table, the
-- stack; a finish that dies leaves the game COMPLETING for the watchdog. When
-- fn_spin_book_entry ran inside that same trigger (the last seat of a spin
-- filling while another was released) it was the booking that died - the nine
-- 'fn_spin_book_entry raised: deadlock detected' criticals filed at 12:50 and
-- 15:00 today.
--
-- THE FIX IS THE ORDER. atomic_seat_cashout_locked now reads the table's game
-- and, when there is one, takes the game row FOR NO KEY UPDATE before it locks
-- the seat. Parent before child, the same order as the finish, so the two
-- queue instead of cycling. Cash tables (no game row) are untouched. The
-- advisory 'table_cap' lock stays first, exactly where atomic_table_buyin
-- takes it. Everything after the seat lock is unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer, p_leave_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_seat      record;
  v_stack     numeric;
  v_key       text;
  v_legacy    text;
  v_credited  boolean := false;
  v_seat_rows integer;
  v_tournament uuid;
  v_engine    boolean;
  v_mode      text;
  v_admin_forced boolean;
  v_enforce   boolean;
  v_chk       jsonb;
BEGIN
  v_engine := public.fn_caller_is_engine();
  -- H6: the mode is one of two words or nothing. 'vpip_evicted' (Dan
  -- 2026-09-05) is a system exit for the clock (a forced one) that closes
  -- the session with its own reason, so the two-hour bar is written.
  v_mode := CASE WHEN p_leave_mode IN ('voluntary', 'forced') THEN p_leave_mode
                 WHEN p_leave_mode = 'vpip_evicted' THEN 'forced' ELSE NULL END;
  -- H2: a club admin's kick, marked by fn_admin_kick_player in THIS transaction
  -- only, after is_club_admin() passed. A browser cannot set a GUC through
  -- PostgREST; one request is one function call in one transaction.
  v_admin_forced := (v_mode = 'forced')
                    AND COALESCE(current_setting('app.cash_exit_authority', true), '') = 'club_admin';

  IF NOT v_engine AND NOT v_admin_forced
     AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  -- H1: the same lock atomic_table_buyin holds while it reads the floor, taken
  -- BEFORE the seat row so the two functions lock in one order.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  /* THE GAME BEFORE THE SEAT (20260906). A seat change on a seat-first game
     (spin, SNG, heads-up) fires trg_seat_change_syncs_seat_first_count, which
     writes tournaments.current_players - a lock on the game's row taken AFTER
     the seat row. The engine finishing that same game does the reverse: its
     UPDATE tournaments ... status holds the game row and its trigger
     fn_clear_seats_on_game_end then locks every seat. 131 deadlocks a day,
     every one this pair, every one at the end of a spin or heads-up. Parent
     before child: take the game row first, in the mode the trigger's UPDATE
     needs, so a cashout racing a finish waits for it instead of dying.
     Cash tables have no game row and skip this. */
  SELECT t.tournament_id INTO v_tournament FROM tables t WHERE t.id = p_table_id;
  IF v_tournament IS NOT NULL THEN
    PERFORM 1 FROM tournaments WHERE id = v_tournament FOR NO KEY UPDATE;
  END IF;

  IF p_seat_number IS NOT NULL THEN
    SELECT id, stack, joined_at, seat_number INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id
       AND seat_number = p_seat_number AND left_at IS NULL
     FOR UPDATE;
  ELSE
    SELECT id, stack, joined_at, seat_number INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     ORDER BY joined_at DESC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'stack', 0, 'reason', 'no_active_seat');
  END IF;

  v_stack := COALESCE(v_seat.stack, 0);

  /* CHIP CONTINUITY (OPORD 1.3 s6.4 / I5). A browser caller is always checked
     unless it is a club admin's kick (H2); the engine is checked when it says
     the exit is the player's own choice. Raised BEFORE any credit. */
  v_enforce := v_tournament IS NULL
               AND ((NOT v_engine AND NOT v_admin_forced) OR (v_engine AND v_mode = 'voluntary'));
  IF v_enforce THEN
    v_chk := public.fn_cash_leave_check(p_user_id, p_table_id);
    IF NOT COALESCE((v_chk->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION 'LEAVE_LOCKED:%', COALESCE(v_chk->>'stay_remaining_ms', '0')
        USING HINT = 'Leave available when the stay clock reaches zero';
    END IF;
  END IF;

  -- to_json, NOT to_char. See 20260901002242: to_char pads microseconds and
  -- breaks dedupe against every key the TypeScript already wrote.
  v_key := CASE
             WHEN v_seat.joined_at IS NOT NULL
               THEN 'cashout:' || v_seat.id || ':' || btrim(to_json(v_seat.joined_at)::text, '"')
             ELSE 'cashout:' || v_seat.id
           END;
  v_legacy := 'cashout:' || v_seat.id;

  /* ZERO-DRIFT (2026-09-01): a tournament-table stack is play chips. */
  IF v_tournament IS NOT NULL THEN
    v_stack := 0;
    v_credited := false;
  ELSIF v_stack > 0 THEN
    IF EXISTS (SELECT 1 FROM wallet_credit_idempotency WHERE key = v_legacy) THEN
      v_credited := false;
    ELSE
      PERFORM public.atomic_credit_wallet_and_log(
        p_user_id, v_stack, 'cashout', 'Cash-out from table',
        p_table_id, NULL, NULL, v_key
      );
      v_credited := true;
    END IF;
  END IF;

  UPDATE table_seats
     SET left_at = NOW(), leave_pending = false
   WHERE table_id = p_table_id AND user_id = p_user_id
     AND seat_number = v_seat.seat_number AND left_at IS NULL;
  GET DIAGNOSTICS v_seat_rows = ROW_COUNT;

  IF v_seat_rows = 0 THEN
    RAISE EXCEPTION
      'Cash-out could not vacate the locked seat (table %, player %, seat %)',
      p_table_id, p_user_id, v_seat.seat_number;
  END IF;

  IF v_tournament IS NULL THEN
    PERFORM public.fn_cash_session_close(
      p_user_id, p_table_id, v_stack,
      CASE WHEN v_mode = 'voluntary' THEN 'voluntary'
           WHEN p_leave_mode = 'vpip_evicted' THEN 'vpip_evicted'
           WHEN v_admin_forced THEN 'kicked'
           ELSE 'system' END);
  END IF;

  UPDATE tables
     SET current_players = (
       SELECT count(*) FROM table_seats
        WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;

  RETURN jsonb_build_object(
    'ok', true, 'stack', v_stack, 'credited', v_credited,
    'seat_number', v_seat.seat_number, 'idempotency_key', v_key,
    'tournament_table', v_tournament IS NOT NULL);
END;
$function$;

DO $verify$
DECLARE v_src text; p_adv int; p_game int; p_seat int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'atomic_seat_cashout_locked' AND pronamespace = 'public'::regnamespace;
  p_adv  := position('table_cap:' in v_src);
  p_game := position('FROM tournaments WHERE id = v_tournament FOR NO KEY UPDATE' in v_src);
  p_seat := position('FROM table_seats' in v_src);
  IF p_game = 0 OR p_adv = 0 OR NOT (p_adv < p_game AND p_game < p_seat) THEN
    RAISE EXCEPTION 'VERIFY FAILED: lock order is not advisory -> game -> seat (adv %, game %, seat %)', p_adv, p_game, p_seat;
  END IF;
  -- the finish side still goes game -> seats through its trigger; pin the trigger exists
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'public.tournaments'::regclass AND p.proname = 'fn_clear_seats_on_game_end') THEN
    RAISE EXCEPTION 'VERIFY FAILED: fn_clear_seats_on_game_end is no longer a trigger on tournaments; re-derive the order';
  END IF;
  RAISE NOTICE 'SEAT_CASHOUT_ORDER advisory -> game -> seat';
END $verify$;

COMMIT;
