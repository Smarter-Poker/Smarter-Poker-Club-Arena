-- ═══════════════════════════════════════════════════════════════════════════════
-- BOOTED FOR LOW VPIP: BARRED FROM THE GAME FOR TWO HOURS (Dan 2026-09-05)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "IF A PLAYER GETS BOOTED BECAUSE THERE VPIP IS TO LOW, RATHOLE
-- RULES APPLY, THEY CAN'T JOIN THAT GAME AGAIN FOR 2 HOURS."
--
-- The rejoin constraint row (club + variant + sb + bb, the same key the floor
-- uses) gains `barred_until`. A nit-game eviction closes the session with the
-- reason 'vpip_evicted' (atomic_seat_cashout_locked learns the leave mode; the
-- engine passes it), fn_cash_session_close writes the bar for the rejoin
-- window (two hours, or the game's longer one), and fn_cash_rejoin_floor -
-- the one read atomic_table_buyin makes before any chips move - raises
-- VPIP_BARRED:<seconds> while the bar stands. fn_cash_effective_buyin (the
-- buy-in modal's read) reports the bar instead of raising, and the game door
-- fn_cash_game_join refuses with GAME_BARRED so the lobby says so before a
-- table is even chosen. Horses are players: a barred horse is refused the
-- same way (fn_horse_seat_from_treasury reads the same floor).
--
-- ROLLBACK:
--   re-apply 20260905060000 for fn_cash_session_close; 20260904140000 for
--   fn_cash_rejoin_floor / fn_cash_effective_buyin; the previous
--   atomic_seat_cashout_locked body (it is only the two CASE arms);
--   ALTER TABLE public.cash_rejoin_constraints DROP COLUMN barred_until;

BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE public.cash_rejoin_constraints ADD COLUMN IF NOT EXISTS barred_until timestamptz;
COMMENT ON COLUMN public.cash_rejoin_constraints.barred_until IS
  'Booted for low VPIP (Dan 2026-09-05): no seat in this game (club+variant+stakes) until this time.';
COMMIT;

BEGIN;

-- ── The floor read raises while barred ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_rejoin_floor(p_user_id uuid, p_table_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_barred timestamptz;
  v_floor numeric;
BEGIN
  SELECT max(c.barred_until), max(c.required_stack)
    INTO v_barred, v_floor
    FROM public.tables t
    JOIN public.cash_rejoin_constraints c
      ON c.player_id = p_user_id
     AND c.club_id  = t.club_id
     AND c.variant  = t.game_variant
     AND c.sb       = t.small_blind
     AND c.bb       = t.big_blind
     AND c.expires_at > now()
   WHERE t.id = p_table_id
     AND t.tournament_id IS NULL;
  IF v_barred IS NOT NULL AND v_barred > now() THEN
    RAISE EXCEPTION 'VPIP_BARRED:%', ceil(extract(epoch FROM (v_barred - now())))::integer
      USING ERRCODE = 'check_violation',
            HINT = 'Removed for low VPIP: no seat in this game until the bar lifts.';
  END IF;
  RETURN v_floor;
END;
$$;

-- ── The modal's read reports the bar instead of raising ─────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_effective_buyin(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_min numeric; v_max numeric; v_bb numeric; v_floor numeric; v_eff numeric;
  v_barred_secs integer;
BEGIN
  SELECT t.min_buy_in, t.max_buy_in, t.big_blind INTO v_min, v_max, v_bb
    FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF COALESCE(v_min, 0) <= 0 THEN v_min := COALESCE(v_bb, 0) * 40; END IF;
  IF COALESCE(v_max, 0) <= 0 THEN v_max := COALESCE(v_bb, 0) * 200; END IF;
  v_eff := v_min;
  IF v_uid IS NOT NULL THEN
    BEGIN
      v_floor := public.fn_cash_rejoin_floor(v_uid, p_table_id);
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM LIKE 'VPIP_BARRED:%' THEN
        v_barred_secs := nullif(regexp_replace(SQLERRM, '^VPIP_BARRED:', ''), '')::integer;
      ELSE
        RAISE;
      END IF;
    END;
    IF v_floor IS NOT NULL THEN
      v_eff := GREATEST(v_min, v_floor);
      IF v_max > 0 THEN v_eff := LEAST(v_eff, v_max); END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'min', v_eff, 'max', v_max,
                            'table_min', v_min, 'floor_applied', v_floor IS NOT NULL AND v_eff > v_min,
                            'barred_seconds', v_barred_secs);
END;
$$;

-- ── The eviction writes the bar ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_session_close(p_user_id uuid, p_table_id uuid, p_stack numeric, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_s record; v_window integer := 7200000; v_exp timestamptz; v_c record; v_now timestamptz := clock_timestamp();
BEGIN
  SELECT t.club_id, t.game_variant, t.small_blind, t.big_blind, t.tournament_id
    INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN; END IF;

  UPDATE public.cash_player_session
     SET closed_at = v_now, closed_reason = COALESCE(p_reason, 'leave')
   WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id AND closed_at IS NULL
   RETURNING * INTO v_s;
  IF FOUND THEN v_window := COALESCE(v_s.rejoin_window_ms, 7200000); END IF;

  -- BOOTED FOR LOW VPIP = BARRED FROM THIS GAME FOR THE WINDOW (Dan
  -- 2026-09-05): "IF A PLAYER GETS BOOTED BECAUSE THERE VPIP IS TO LOW,
  -- RATHOLE RULES APPLY, THEY CAN'T JOIN THAT GAME AGAIN FOR 2 HOURS." The
  -- bar is written whatever the stack (a bust included); the floor, if they
  -- were ahead, is written by the same row as usual below.
  IF p_reason = 'vpip_evicted' AND v_t.club_id IS NOT NULL AND v_t.game_variant IS NOT NULL
     AND v_t.small_blind IS NOT NULL AND v_t.big_blind IS NOT NULL THEN
    v_exp := v_now + make_interval(secs => v_window / 1000.0);
    SELECT * INTO v_c FROM public.cash_rejoin_constraints c
     WHERE c.player_id = p_user_id AND c.club_id = v_t.club_id AND c.variant = v_t.game_variant
       AND c.sb = v_t.small_blind AND c.bb = v_t.big_blind AND c.expires_at > v_now
     ORDER BY c.expires_at DESC LIMIT 1
     FOR UPDATE;
    IF FOUND THEN
      UPDATE public.cash_rejoin_constraints
         SET barred_until = GREATEST(COALESCE(barred_until, v_exp), v_exp),
             expires_at   = GREATEST(expires_at, v_exp),
             left_at      = v_now,
             source_table_id = p_table_id
       WHERE id = v_c.id;
    ELSE
      INSERT INTO public.cash_rejoin_constraints
        (player_id, club_id, variant, sb, bb, required_stack, left_at, expires_at, source_table_id, barred_until)
      -- required_stack must be > 0 (CHECK); a bar-only row carries a cent,
      -- which GREATEST(table minimum, floor) never raises anything to.
      VALUES (p_user_id, v_t.club_id, v_t.game_variant, v_t.small_blind, v_t.big_blind,
              0.01, v_now, v_exp, p_table_id, v_exp);
    END IF;
  END IF;

  IF COALESCE(p_stack, 0) <= 0 THEN RETURN; END IF;             -- bust-to-zero: no floor (A0.11)
  -- RATHOLE ONLY APPLIES TO WINNING PLAYERS (Dan 2026-09-05). The floor is
  -- written only when the departing stack is above the session baseline (the
  -- buy-in plus every add-on and rebuy). A player who is down leaves and
  -- comes back at the table minimum like anyone else. No session, no
  -- baseline, no floor: a chair the platform never opened a session for
  -- cannot be judged a winner.
  IF v_s.id IS NULL OR p_stack <= COALESCE(v_s.baseline, 0) THEN RETURN; END IF;
  IF v_t.club_id IS NULL OR v_t.game_variant IS NULL
     OR v_t.small_blind IS NULL OR v_t.big_blind IS NULL THEN RETURN; END IF;

  v_exp := v_now + make_interval(secs => v_window / 1000.0);

  SELECT * INTO v_c FROM public.cash_rejoin_constraints c
   WHERE c.player_id = p_user_id AND c.club_id = v_t.club_id AND c.variant = v_t.game_variant
     AND c.sb = v_t.small_blind AND c.bb = v_t.big_blind AND c.expires_at > v_now
   ORDER BY c.expires_at DESC LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    UPDATE public.cash_rejoin_constraints
       SET required_stack = GREATEST(required_stack, p_stack),
           expires_at     = GREATEST(expires_at, v_exp),
           left_at        = v_now,
           source_table_id = p_table_id
     WHERE id = v_c.id;
  ELSE
    INSERT INTO public.cash_rejoin_constraints
      (player_id, club_id, variant, sb, bb, required_stack, left_at, expires_at, source_table_id)
    VALUES (p_user_id, v_t.club_id, v_t.game_variant, v_t.small_blind, v_t.big_blind,
            p_stack, v_now, v_exp, p_table_id);
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer, p_leave_mode text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $$
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

  SELECT t.tournament_id INTO v_tournament FROM tables t WHERE t.id = p_table_id;

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
$$;


-- ── The game door refuses a barred player before a table is chosen ─────────

CREATE OR REPLACE FUNCTION public.fn_cash_game_barred_seconds(p_game_id uuid, p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT ceil(extract(epoch FROM (max(c.barred_until) - now())))::integer
    FROM public.cash_games g
    JOIN public.cash_rejoin_constraints c
      ON c.player_id = p_user_id AND c.club_id = g.club_id AND c.variant = g.variant
     AND c.sb = g.sb AND c.bb = g.bb AND c.barred_until > now()
   WHERE g.id = p_game_id
  HAVING max(c.barred_until) IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.fn_cash_game_join(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  g record; s record; t record;
  v_position integer; v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in to join a game' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF NOT g.enabled THEN
    RAISE EXCEPTION 'GAME_CLOSED: this game is not taking players' USING ERRCODE = 'check_violation';
  END IF;
  -- Booted for low VPIP: no seat in this game until the bar lifts (Dan 2026-09-05).
  IF public.fn_cash_game_barred_seconds(g.id, v_uid) IS NOT NULL THEN
    RAISE EXCEPTION 'GAME_BARRED:%', public.fn_cash_game_barred_seconds(g.id, v_uid) USING ERRCODE = 'check_violation';
  END IF;

  -- Already in the game: say where.
  SELECT ts.table_id, ts.seat_number, tb.name, tb.role, tb.main_index
    INTO s
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.user_id = v_uid AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
   LIMIT 1;
  IF FOUND THEN
    UPDATE public.cash_game_waitlist SET status = 'seated', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seated', 'table_id', s.table_id,
                              'seat_number', s.seat_number, 'table_name', s.name,
                              'role', s.role, 'main_index', s.main_index);
  END IF;

  -- The shortest live Main with an unreserved open chair, then the feeder
  -- (opening or live). Never a breaking or closed table.
  SELECT tb.id, tb.name, tb.role, tb.main_index, public.fn_cash_game_open_seats(tb.id) AS open_seats,
         (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL) AS seated
    INTO t
    FROM public.tables tb
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle IN ('live', 'opening')
     AND public.fn_cash_game_open_seats(tb.id) > 0
   ORDER BY (tb.role = 'feeder') ASC, seated ASC, tb.main_index ASC NULLS LAST, tb.created_at ASC
   LIMIT 1;
  IF FOUND THEN
    UPDATE public.cash_game_waitlist SET status = 'notified', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seat', 'table_id', t.id, 'table_name', t.name,
                              'role', t.role, 'main_index', t.main_index, 'open_seats', t.open_seats);
  END IF;

  -- Nothing open anywhere: hold the place. One live row per game per player.
  INSERT INTO public.cash_game_waitlist (game_id, user_id, status)
  VALUES (g.id, v_uid, 'waiting')
  ON CONFLICT DO NOTHING;
  SELECT count(*) + 1 INTO v_position FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified')
     AND w.created_at < (SELECT created_at FROM public.cash_game_waitlist x
                          WHERE x.game_id = g.id AND x.user_id = v_uid AND x.status IN ('waiting', 'notified') LIMIT 1);
  SELECT count(*) INTO v_count FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');
  RETURN jsonb_build_object('ok', true, 'action', 'waitlisted', 'position', v_position, 'waiting', v_count,
                            'opening_hold_since', g.opening_hold_since,
                            'tables', (SELECT count(*) FROM public.tables tb WHERE tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
                                          AND coalesce(tb.is_deleted, false) = false));
END;
$$;


REVOKE ALL ON FUNCTION public.fn_cash_game_join(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_join(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_cash_rejoin_floor(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_rejoin_floor(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_effective_buyin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_effective_buyin(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_session_close(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_session_close(uuid, uuid, numeric, text) TO service_role;
REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_game_barred_seconds(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_barred_seconds(uuid, uuid) TO service_role;

DO $chk$
DECLARE v text;
BEGIN
  v := pg_get_functiondef('public.fn_cash_rejoin_floor(uuid,uuid)'::regprocedure);
  IF v NOT LIKE '%VPIP_BARRED:%' THEN RAISE EXCEPTION 'floor: bar missing'; END IF;
  v := pg_get_functiondef('public.fn_cash_session_close(uuid,uuid,numeric,text)'::regprocedure);
  IF v NOT LIKE '%p_reason = ''vpip_evicted''%' THEN RAISE EXCEPTION 'close: bar writer missing'; END IF;
  IF v NOT LIKE '%p_stack <= COALESCE(v_s.baseline, 0)%' THEN RAISE EXCEPTION 'close: the winner-only floor was lost'; END IF;
  v := pg_get_functiondef('public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'::regprocedure);
  IF v NOT LIKE '%''vpip_evicted''%' THEN RAISE EXCEPTION 'cashout: leave mode missing'; END IF;
END $chk$;

COMMIT;
