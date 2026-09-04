-- ═══════════════════════════════════════════════════════════════════════════════
--  CHIP CONTINUITY, SLICE 0 - HARDENING FROM THE GATE 1 DEEP AUDIT. 2026-09-04.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 20260904120000_chip_continuity_slice_0 shipped the law. A hostile review of
-- it the same afternoon found seven things worth fixing before Slice 1 opens.
-- Each is named with its scenario so the next agent can see what it cost.
--
-- H1  THE FLOOR COULD BE RACED. atomic_table_buyin reads the floor under
--     pg_advisory_xact_lock('table_cap:<user>'); the cash-out that WRITES the
--     floor took no lock a buy-in shares. Two tabs: POST /leave at T1 and a
--     buy-in at T2 inside the RPC latency window read a NULL floor. The
--     cash-out now takes the same advisory lock FIRST (before the seat row),
--     which is also the order the buy-in uses, so there is no inversion.
--
-- H2  A SECOND CASH-OUT DOOR SKIPPED THE CLOCK AND THE FLOOR AND CLOSED NO
--     SESSION. fn_admin_kick_player (authenticated, SECURITY DEFINER) stamped
--     left_at and credited the wallet by hand - a third implementation of
--     "cash a seat out", contrary to the one-path law of 2026-09-02, and one
--     that a club owner could point at THEMSELVES to leave while up. It now
--     delegates to atomic_seat_cashout_locked with p_leave_mode = 'forced'
--     under a transaction-local authority marker that only this function
--     sets after is_club_admin() passes. A kick is a system exit: the clock
--     does not block it, the session closes, the floor is written. The
--     legacy key 'cashout:<seat id>' it used is still honoured by the locked
--     function, so a seat kicked under the old body cannot be paid twice.
--
-- H3  fn_cash_session_open RACED ITSELF. Two engines evaluating one table
--     (a lease hand-over, a leader flap) could both find no row and both
--     INSERT; the second hit cash_player_session_one_open and the WHOLE
--     evaluate rolled back for every player at the table. ON CONFLICT DO
--     NOTHING on the partial index, then re-read.
--
-- H4  TWO CLOCKS. The settle read clock_timestamp() and the stamp wrote
--     now() (transaction start), so every settle inside an older transaction
--     double-counted its age on the next read. One clock now:
--     clock_timestamp() for both.
--
-- H5  INTEGER OVERFLOW AT 24.8 DAYS. FLOOR(EXTRACT(EPOCH)*1000)::integer
--     raised "integer out of range" for a running row nobody had settled in
--     2^31 ms (a table that lost its engine), which jammed the voluntary
--     door. Computed in bigint and clamped.
--
-- H6  p_leave_mode WAS UNVALIDATED and stored verbatim in closed_reason.
--     Anything but 'voluntary' / 'forced' is NULL now, and closed_reason is
--     one of three words.
--
-- H7  ACL HYGIENE. fn_cash_effective_buyin was executable by anon (harmless
--     read, unintended); atomic_seat_cashout_locked's re-creation dropped the
--     explicit REVOKE FROM PUBLIC that 20260901002242 carried. Both stated.
--
-- H8  fn_thaw_platform LOST ITS COMMENTS in the re-creation. They exist to
--     stop the next agent "fixing" the on_break exclusion and the 4 s budget.
--     Restored verbatim from 20260902233000, plus the two chip-continuity
--     steps.
--
-- ROLLBACK: re-apply 20260904120000_chip_continuity_slice_0 sections 2-4 and
--   9 (they are CREATE OR REPLACE), and fn_admin_kick_player from
--   20260827214020_close_browser_chip_minting_and_privilege_escalation.
--
-- md5(prosrc) replaced (read 2026-09-04 12:05 UTC):
--   fn_admin_kick_player  see pg_proc; body as shipped 2026-08-27
--
-- ONE TRANSACTION.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- H5. bigint arithmetic, one clock
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_stay_remaining_ms(
  p_remaining integer, p_running boolean, p_last_tick timestamptz
) RETURNS integer
LANGUAGE sql
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN COALESCE(p_running, false)
      THEN LEAST(2147483647::bigint, GREATEST(0::bigint,
             COALESCE(p_remaining, 0)::bigint
             - FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(p_last_tick, clock_timestamp()))) * 1000)::bigint
           ))::integer
    ELSE GREATEST(0, COALESCE(p_remaining, 0))
  END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H3. open is idempotent under a race
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_session_open(p_user_id uuid, p_table_id uuid, p_buy_in numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_id uuid;
BEGIN
  SELECT t.id, t.club_id, t.game_variant, t.small_blind, t.big_blind, t.tournament_id
    INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN NULL; END IF;

  -- A row still open here means the seat left without closing (a crash, a
  -- direct seat delete). It carries nothing a fresh buy-in should inherit.
  -- Only a caller with a NEW buy-in (p_buy_in not null) may retire it; the
  -- evaluate path passes the current stack and must not close a live row.
  IF p_buy_in IS NOT NULL THEN
    UPDATE public.cash_player_session
       SET closed_at = clock_timestamp(), closed_reason = 'stale_on_reopen'
     WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
       AND closed_at IS NULL;
  END IF;

  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline,
     stay_remaining_ms, stay_running, stay_last_tick_at, opened_at)
  VALUES
    (p_user_id, v_t.club_id, 'table', p_table_id, p_table_id, v_t.game_variant,
     v_t.small_blind, v_t.big_blind, GREATEST(COALESCE(p_buy_in, 0), 0),
     600000, false, clock_timestamp(), clock_timestamp())
  ON CONFLICT (player_id, scope_type, scope_id) WHERE closed_at IS NULL DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Somebody opened it between our UPDATE and our INSERT (H3). Theirs wins.
    SELECT id INTO v_id FROM public.cash_player_session
     WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
       AND closed_at IS NULL;
  END IF;
  RETURN v_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H4. one clock in the writers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_session_add_baseline(p_user_id uuid, p_table_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_s record; v_stack numeric; v_rem integer;
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN RETURN; END IF;
  SELECT * INTO v_s FROM public.cash_player_session
   WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
     AND closed_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT ts.stack INTO v_stack FROM public.table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1;

  v_rem := public.fn_cash_stay_remaining_ms(v_s.stay_remaining_ms, v_s.stay_running, v_s.stay_last_tick_at);
  UPDATE public.cash_player_session
     SET baseline          = baseline + p_amount,
         stay_remaining_ms = v_rem,
         stay_last_tick_at = clock_timestamp(),
         stay_running      = (v_s.stay_running AND COALESCE(v_stack, 0) > (v_s.baseline + p_amount) AND v_rem > 0)
   WHERE id = v_s.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_cash_session_evaluate(p_table_id uuid, p_entries jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_e jsonb; v_uid uuid; v_active boolean; v_stack numeric;
  v_s record; v_rem integer; v_running boolean; v_out jsonb := '[]'::jsonb; v_now timestamptz;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_cash_session_evaluate is engine-only';
  END IF;
  SELECT t.id, t.tournament_id INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN v_out; END IF;

  FOR v_e IN SELECT * FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb)) LOOP
    BEGIN
      v_uid := (v_e->>'user_id')::uuid;
    EXCEPTION WHEN others THEN CONTINUE;
    END;
    v_active := COALESCE((v_e->>'active')::boolean, false);
    v_stack := NULLIF(v_e->>'stack', '')::numeric;

    IF v_stack IS NULL THEN
      SELECT ts.stack INTO v_stack FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL LIMIT 1;
      IF v_stack IS NULL THEN CONTINUE; END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_s FROM public.cash_player_session
     WHERE player_id = v_uid AND scope_type = 'table' AND scope_id = p_table_id AND closed_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      -- Seated before the session table existed: baseline = what they hold now.
      PERFORM public.fn_cash_session_open(v_uid, p_table_id, v_stack);
      SELECT * INTO v_s FROM public.cash_player_session
       WHERE player_id = v_uid AND scope_type = 'table' AND scope_id = p_table_id AND closed_at IS NULL
       FOR UPDATE;
      IF NOT FOUND THEN CONTINUE; END IF;
    END IF;

    v_now := clock_timestamp();
    v_rem := public.fn_cash_stay_remaining_ms(v_s.stay_remaining_ms, v_s.stay_running, v_s.stay_last_tick_at);
    v_running := v_active AND v_stack > v_s.baseline AND v_rem > 0;

    UPDATE public.cash_player_session
       SET stay_remaining_ms = v_rem,
           stay_last_tick_at = v_now,
           stay_running      = v_running
     WHERE id = v_s.id;

    v_out := v_out || jsonb_build_object(
      'user_id', v_uid, 'baseline', v_s.baseline, 'stack', v_stack,
      'stay_remaining_ms', v_rem, 'stay_running', v_running,
      'stay_last_tick_at', v_now, 'stay_clock_ms', v_s.stay_clock_ms,
      'leave_locked', (v_stack > v_s.baseline AND v_rem > 0));
  END LOOP;
  RETURN v_out;
END;
$$;

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

  IF COALESCE(p_stack, 0) <= 0 THEN RETURN; END IF;             -- bust-to-zero: no floor (A0.11)
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

-- ─────────────────────────────────────────────────────────────────────────────
-- H1 + H2 + H6 + H7. The cash-out door.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(
  p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer,
  p_leave_mode text DEFAULT NULL::text
) RETURNS jsonb
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
  -- H6: the mode is one of two words or nothing.
  v_mode := CASE WHEN p_leave_mode IN ('voluntary', 'forced') THEN p_leave_mode ELSE NULL END;
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

REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_cash_effective_buyin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_effective_buyin(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- H2. The admin kick delegates to the one cash-out path, as a forced exit.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_admin_kick_player(p_table_id uuid, p_user_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_club    uuid;
  v_tourn   uuid;
  v_seat_no integer;
  v_seat_id uuid;
  v_res     jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_admin_kick_player requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT club_id, tournament_id INTO v_club, v_tourn FROM public.tables WHERE id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF NOT public.is_club_admin(v_club) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  SELECT id, seat_number INTO v_seat_id, v_seat_no
    FROM public.table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_seated');
  END IF;

  /* CHIP CONTINUITY H2 (2026-09-04): ONE cash-out path. This body used to
     stamp left_at and credit the wallet itself (a third implementation, and
     one a club owner could aim at their own seat to skip the stay clock).
     The authority marker below is transaction-local and is the only thing
     that lets a browser-originated call through atomic_seat_cashout_locked
     as a forced exit; it is set only after is_club_admin() passed. */
  PERFORM set_config('app.cash_exit_authority', 'club_admin', true);
  IF v_tourn IS NULL THEN
    PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);
  END IF;

  BEGIN
    v_res := public.atomic_seat_cashout_locked(p_user_id, p_table_id, v_seat_no, 'forced');
  EXCEPTION WHEN others THEN
    -- The marker must not outlive the kick, even on the failure path.
    PERFORM set_config('app.cash_exit_authority', '', true);
    RAISE;
  END;
  -- The marker is transaction-local and one PostgREST request is one call,
  -- but a definer that calls this function and then something else in the
  -- same transaction must not inherit a kick's authority.
  PERFORM set_config('app.cash_exit_authority', '', true);

  IF COALESCE(v_res->>'reason', '') = 'no_active_seat' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_seated');
  END IF;

  RETURN jsonb_build_object('ok', true,
    'refunded', COALESCE((v_res->>'stack')::numeric, 0),
    'seat_id', v_seat_id,
    'reason_text', p_reason);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_admin_kick_player(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_admin_kick_player(uuid, uuid, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- H8. fn_thaw_platform with its comments back (20260902233000 verbatim) plus
--     the two chip-continuity steps.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_thaw_platform(p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_thawed_by text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Stop starting new steps once this much of our own wall clock is spent.
  -- PostgREST's service_role statement_timeout is 8s; the remainder is head
  -- room for the step in flight and for the FOR UPDATE wait.
  c_budget      CONSTANT INTERVAL := interval '4 seconds';
  -- tournaments.level_started_at rows per call (~20ms each through triggers).
  c_level_batch CONSTANT INTEGER  := 40;

  v_started  TIMESTAMPTZ := clock_timestamp();
  v_row      public.engine_maintenance_thaws%ROWTYPE;
  v_shift    INTERVAL;
  v_counts   JSONB;
  v_n        INTEGER;
  v_done     TEXT[] := '{}';
  v_cursor   UUID;
  v_last     UUID;
  v_batch_n  INTEGER;
  v_total    INTEGER;
BEGIN
  -- Sanity: a thaw claiming more than fifteen frozen minutes is a bug or a
  -- clock skew, and shifting every deadline on the platform by a wrong number
  -- is strictly worse than shifting by nothing.
  IF p_frozen_seconds IS NULL OR p_frozen_seconds <= 0 OR p_frozen_seconds > 900 THEN
    RETURN jsonb_build_object('ok', false, 'complete', false, 'reason', 'implausible_frozen_seconds');
  END IF;

  -- Claim this freeze (or find it already claimed). The ledger row is the
  -- checkpoint file for every call that follows.
  INSERT INTO public.engine_maintenance_thaws (freeze_started_at, frozen_seconds, shifted, thawed_by)
  VALUES (p_freeze_started, p_frozen_seconds, '{}'::jsonb, p_thawed_by)
  ON CONFLICT (freeze_started_at) DO NOTHING;

  SELECT * INTO v_row
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at = p_freeze_started
     FOR UPDATE;

  v_counts := COALESCE(v_row.shifted, '{}'::jsonb);
  IF COALESCE((v_counts->>'complete')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'complete', true, 'reason', 'already_thawed', 'shifted', v_counts);
  END IF;

  -- One shift for the whole platform: the number the claim recorded.
  v_shift := make_interval(secs => v_row.frozen_seconds);

  -- The thaw's own writes must pass the freeze guard even if it is called a
  -- moment before break_ends_at, and trg_stamp_sit_out_at lets the sit-out
  -- shift through only under this GUC. LOCAL: dies with this transaction.
  PERFORM set_config('app.freeze_bypass', 'on', TRUE);

  -- ── Step: sit-out clocks on live seats ─────────────────────────────────
  -- The whole reason a player can sit out at :53 and still own their seat
  -- at :00. Cheap (index on status; a handful of rows).
  IF NOT (v_counts ? 'sit_out_at') THEN
    UPDATE public.table_seats
       SET sit_out_at = sit_out_at + v_shift
     WHERE left_at IS NULL AND sit_out_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('sit_out_at', v_n);
    v_done := array_append(v_done, 'sit_out_at');
  END IF;

  -- ── Step: waitlist seat holds ──────────────────────────────────────────
  -- Holds alive when the freeze began (including any that "expired" during
  -- it - the shift resurrects exactly the time they were owed and no more).
  IF NOT (v_counts ? 'hold_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.table_waitlist
       SET hold_expires_at = hold_expires_at + v_shift
     WHERE hold_expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('hold_expires_at', v_n);
    v_done := array_append(v_done, 'hold_expires_at');
  END IF;

  -- ── Step: tournament add-on windows ────────────────────────────────────
  IF NOT (v_counts ? 'addon_period_ends_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournaments
       SET addon_period_ends_at = addon_period_ends_at + v_shift
     WHERE addon_period_ends_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('addon_period_ends_at', v_n);
    v_done := array_append(v_done, 'addon_period_ends_at');
  END IF;

  -- ── Step: the cashier claim-back window (10 minutes; a freeze would eat half)
  IF NOT (v_counts ? 'reversible_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.chip_transactions
       SET reversible_until = reversible_until + v_shift
     WHERE reversible_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reversible_until', v_n);
    v_done := array_append(v_done, 'reversible_until');
  END IF;

  -- ── Step: mystery bounty reveal windows ────────────────────────────────
  IF NOT (v_counts ? 'reveal_deadline_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_bounty_awards
       SET reveal_deadline_at = reveal_deadline_at + v_shift
     WHERE reveal_deadline_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reveal_deadline_at', v_n);
    v_done := array_append(v_done, 'reveal_deadline_at');
  END IF;

  -- ── Step: bust-rebuy prompts ───────────────────────────────────────────
  IF NOT (v_counts ? 'rebuy_prompt_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_players
       SET rebuy_prompt_until = rebuy_prompt_until + v_shift
     WHERE rebuy_prompt_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('rebuy_prompt_until', v_n);
    v_done := array_append(v_done, 'rebuy_prompt_until');
  END IF;

  -- ── Step: timed bomb pots ──────────────────────────────────────────────
  -- Due exactly as far after the thaw as they were before the freeze.
  IF NOT (v_counts ? 'bomb_pot_next_due_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tables
       SET bomb_pot_next_due_at = bomb_pot_next_due_at + v_shift
     WHERE bomb_pot_next_due_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('bomb_pot_next_due_at', v_n);
    v_done := array_append(v_done, 'bomb_pot_next_due_at');
  END IF;

  -- ── Step: CHIP CONTINUITY stay clocks (2026-09-04) ─────────────────────
  -- A running stay clock is `remaining as of last_tick`; shifting last_tick
  -- forward by the frozen minutes is exactly "the freeze did not count".
  -- Only ticks stamped before the thaw: a row the engine has already
  -- re-settled after the break carries no frozen time to give back.
  IF NOT (v_counts ? 'cash_stay_last_tick_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_player_session
       SET stay_last_tick_at = stay_last_tick_at + v_shift
     WHERE closed_at IS NULL AND stay_running AND stay_last_tick_at <= p_freeze_started + v_shift;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_stay_last_tick_at', v_n);
    v_done := array_append(v_done, 'cash_stay_last_tick_at');
  END IF;

  -- ── Step: CHIP CONTINUITY rejoin floors (2026-09-04) ───────────────────
  IF NOT (v_counts ? 'cash_rejoin_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_rejoin_constraints
       SET expires_at = expires_at + v_shift
     WHERE expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_rejoin_expires_at', v_n);
    v_done := array_append(v_done, 'cash_rejoin_expires_at');
  END IF;

  -- ── Step (chunked): blind level clocks ─────────────────────────────────
  -- ONLY for running events NOT on the synchronized break. An MTT on the :55
  -- break has its level clock suspended by pauseForBreak and restored by
  -- resumeFromBreak; shifting it here would give that event the five minutes
  -- twice. Short formats (Spins, Heads-Up) never take the synchronized break,
  -- so their wall-time level clock ran straight through the park - this is
  -- what gives it back (the 2026-08-27 incident class where Spins lost whole
  -- levels to a stop they never asked for).
  --
  -- This is the expensive one (~20ms/row through the table's UPDATE
  -- triggers), so it walks the primary key c_level_batch rows at a time and
  -- checkpoints the cursor after every batch. The shift is additive, so the
  -- cursor is what makes re-entry safe: a row below the cursor is done.
  -- The batch ordering by id is stable because no row's id changes and the
  -- set of RUNNING events cannot grow while the engine is parked.
  WHILE NOT (v_counts ? 'level_started_at') AND clock_timestamp() - v_started <= c_budget LOOP
    v_cursor := NULLIF(v_counts->>'level_started_at_cursor', '')::uuid;
    v_total  := COALESCE((v_counts->>'level_started_at_so_far')::integer, 0);

    WITH batch AS (
      SELECT id
        FROM public.tournaments
       WHERE status = 'RUNNING'
         AND COALESCE(on_break, FALSE) = FALSE
         AND level_started_at IS NOT NULL
         AND (v_cursor IS NULL OR id > v_cursor)
       ORDER BY id
       LIMIT c_level_batch
    ),
    shifted AS (
      UPDATE public.tournaments t
         SET level_started_at = t.level_started_at + v_shift
        FROM batch b
       WHERE t.id = b.id
      RETURNING t.id
    )
    -- (no max(uuid) in Postgres; uuid order is bytewise, identical to its hex text order)
    SELECT count(*), max(id::text)::uuid INTO v_batch_n, v_last FROM shifted;

    v_total := v_total + COALESCE(v_batch_n, 0);

    IF COALESCE(v_batch_n, 0) < c_level_batch THEN
      -- The last batch. Record the final count and drop the cursor keys.
      v_counts := (v_counts - 'level_started_at_cursor' - 'level_started_at_so_far')
                  || jsonb_build_object('level_started_at', v_total);
      v_done := array_append(v_done, 'level_started_at');
    ELSE
      v_counts := v_counts || jsonb_build_object(
        'level_started_at_cursor', v_last::text,
        'level_started_at_so_far', v_total
      );
    END IF;
  END LOOP;

  -- NOT shifted, deliberately:
  --   * tournaments.break_ends_at - the synchronized break owns it and the
  --     engine's resumeFromBreak restores it;
  --   * late_reg (started_at + late_reg_mins) - registration is frozen during
  --     the break, and the hourly tournament break has consumed those same
  --     five minutes of late-reg wall time since it was built. Shifting
  --     started_at would falsify history; parity with the existing break is
  --     the honest behaviour;
  --   * ban/mute/promotion expiries - a punishment or a promotion elapsing
  --     during a break is time genuinely passing, not play being taken away.

  -- Complete when every step has its key.
  IF v_counts ?& ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
                       'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
                       'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at'] THEN
    v_counts := v_counts || jsonb_build_object('complete', true);
  END IF;

  -- Checkpoint. This commit is what a later call resumes from.
  UPDATE public.engine_maintenance_thaws
     SET shifted   = v_counts,
         thawed_at = now()
   WHERE freeze_started_at = p_freeze_started;

  RETURN jsonb_build_object(
    'ok', true,
    'complete', COALESCE((v_counts->>'complete')::boolean, false),
    'steps_this_call', to_jsonb(v_done),
    'elapsed_ms', round(extract(epoch from clock_timestamp() - v_started) * 1000),
    'shifted', v_counts
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz, numeric, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- ASSERTIONS
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_admin_kick_player';
  IF position('atomic_seat_cashout_locked' in v_src) = 0 OR position('atomic_credit_wallet_and_log' in v_src) > 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: fn_admin_kick_player still cashes out by hand';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_seat_cashout_locked';
  IF position('table_cap:' in v_src) = 0 OR position('app.cash_exit_authority' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: cash-out door lacks the floor lock or the admin authority check';
  END IF;
  IF has_function_privilege('anon', 'public.fn_cash_effective_buyin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAILED: anon can still execute fn_cash_effective_buyin';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_thaw_platform';
  IF position('resumeFromBreak' in v_src) = 0 OR position('cash_rejoin_expires_at' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: thaw comments or steps missing';
  END IF;
  RAISE NOTICE 'chip continuity slice 0 hardening: H1-H8 in place.';
END $$;

COMMIT;
