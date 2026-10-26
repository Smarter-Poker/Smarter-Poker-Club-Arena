CREATE OR REPLACE FUNCTION public.fn_cash_effective_buyin(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_session_close(p_user_id uuid, p_table_id uuid, p_stack numeric, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_s record; v_window integer := 7200000; v_exp timestamptz; v_c record; v_now timestamptz := clock_timestamp();
BEGIN
  SELECT t.club_id, t.game_variant, t.small_blind, t.big_blind, t.tournament_id
    INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN; END IF;

  UPDATE public.cash_player_session
     SET closed_at = v_now, closed_reason = COALESCE(p_reason, 'leave'), final_stack = CASE WHEN p_stack IS NULL THEN NULL ELSE round(greatest(p_stack, 0), 2) END, final_stack_captured_at = CASE WHEN p_stack IS NULL THEN NULL ELSE v_now END, financial_capture_status = CASE WHEN p_stack IS NULL THEN 'partial' ELSE 'exact' END, close_table_id = p_table_id
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
$function$
;

CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury_before_maintenance_gate(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_st text;
  v_msg text;
  v_floor numeric;
  v_min numeric;
  v_max numeric;
  v_eff numeric;
BEGIN
  PERFORM set_config('app.money_path', 'fn_horse_seat_from_treasury', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_seat_number IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user, seat and positive amount required');
  END IF;

  /* A KEYED CALL IS ANSWERED ONCE. The engine funds a rebuy from a bust it
     has already seen; a retry after a lost response must not fund it twice.
     With no key this is the old behaviour exactly. */
  IF p_op_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'horse_fund:' || p_op_id::text) THEN
    RETURN jsonb_build_object('success', true, 'replayed', true, 'op_id', p_op_id);
  END IF;

  SELECT club_id, min_buy_in, max_buy_in INTO v_club_id, v_min, v_max FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to seat from club treasury');
  END IF;

  -- CHIP CONTINUITY (I7): the same floor a human meets at atomic_table_buyin.
  v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
  IF v_floor IS NOT NULL THEN
    v_eff := GREATEST(COALESCE(v_min, 0), v_floor);
    IF v_max IS NOT NULL AND v_max > 0 THEN v_eff := LEAST(v_eff, v_max); END IF;
    IF p_amount < v_eff THEN
      RETURN jsonb_build_object('success', false, 'error', 'BUYIN_BELOW_FLOOR', 'required', v_eff);
    END IF;
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  BEGIN
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, is_sitting_out)
    VALUES (p_table_id, p_user_id, p_seat_number, p_amount, false);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'seat already taken');
  END;

  -- CHIP CONTINUITY: the session opens with the seat, baseline = this buy-in.
  PERFORM public.fn_cash_session_open(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse seated + funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  BEGIN
    /* PHASE 7.2 (2026-09-06): the leg NAMES THE PLAYER and carries the
       caller's key when it has one. Before this a horse funding said only
       that a table was funded: 9,252 legs in seven days, none naming the
       seat, so no per-seat audit could read them and a replay could not be
       told from a second horse buying in for the same amount at the same
       table. The key is optional: without it nothing changes but the name. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, table_id, description, idempotency_key, metadata)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury', v_club_id,
      'table_stack',   p_table_id,
      p_amount, 'horse_funding', v_club_id, p_table_id,
      'Seated + funded from club treasury (fn_horse_seat_from_treasury) for ' || p_user_id::text,
      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'horse_fund:' || p_op_id::text END,
      jsonb_build_object('user_id', p_user_id, 'op_id', p_op_id, 'door', 'fn_horse_seat_from_treasury'));
  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN jsonb_build_object('success', true, 'treasury_after', v_treasury - p_amount);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.atomic_table_buyin_before_maintenance_announcement_gate(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_original_ledger uuid; v_original_wallet uuid; v_original_pending uuid;
  v_is_template boolean;
  v_vip_only boolean;
  v_is_vip boolean;
  v_staff boolean;
  v_floor numeric;
  v_effective_min numeric;
  v_max_players integer;
  v_seats_taken integer;
  v_holds integer := 0;
  v_moves integer := 0;
  v_new_balance NUMERIC;
  v_club_id UUID;
  v_union_id UUID;
  v_ban_id UUID;
  v_min_buy_in NUMERIC;
  v_max_buy_in NUMERIC;
  v_tournament_id UUID;
  v_active_tables INT;
  v_seat_club UUID;
  v_max_tables CONSTANT INT := 4;
BEGIN
  PERFORM set_config('app.money_path', 'atomic_table_buyin', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
    -- THE ONLY IDEMPOTENCY GUARD IN THIS FUNCTION. Do not add a second one.
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
        VALUES (p_idempotency_key, p_user_id, 'atomic_table_buyin', p_amount) ON CONFLICT (key) DO NOTHING;
        IF NOT FOUND THEN
            RETURN;
        END IF;
    END IF;
  -- ── A DEAD SESSION MOVES NO MONEY (Dan 2026-09-03) ────────────────────
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  /* ZERO-DRIFT (2026-08-31): declare the ledger context so the wallet debit
     journals as a buy-in against the table, not an anonymous adjustment. */
  PERFORM set_config('app.ledger_category', 'buyin', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in, COALESCE(t.max_players, 0),
         COALESCE(t.is_vip_only, false), COALESCE(t.is_template, false), t.tournament_id
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players,
         v_vip_only, v_is_template, v_tournament_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id LIMIT 1;

  IF v_is_template THEN
    RAISE EXCEPTION 'IS_TEMPLATE: this is a saved table template, not a live game';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid buy-in amount';
  END IF;
  IF v_min_buy_in IS NOT NULL AND v_min_buy_in > 0 AND p_amount < v_min_buy_in THEN
    RAISE EXCEPTION 'Buy-in below table minimum (min %)', v_min_buy_in;
  END IF;
  IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND p_amount > v_max_buy_in THEN
    RAISE EXCEPTION 'Buy-in above table maximum (max %)', v_max_buy_in;
  END IF;

  /* CHIP CONTINUITY (2026-09-04, I7): the rejoin floor. Keyed on club +
     variant + sb + bb, never on this table, so it follows the player to any
     table of the same game in this club and to no other game (A0.7-A0.10).
     effective_min = min(table.max, max(table.min, required)). This replaces
     the per-table opt-in column block that stood here. */
  IF v_tournament_id IS NULL THEN
    v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
    IF v_floor IS NOT NULL THEN
      v_effective_min := GREATEST(COALESCE(v_min_buy_in, 0), v_floor);
      IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 THEN
        v_effective_min := LEAST(v_effective_min, v_max_buy_in);
      END IF;
      IF p_amount < v_effective_min THEN
        RAISE EXCEPTION 'BUYIN_BELOW_FLOOR: minimum buy-in for this game right now is %', v_effective_min
          USING HINT = 'The minimum for this game is higher for you at the moment.';
      END IF;
    END IF;
  END IF;

  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id
       AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN
      RAISE EXCEPTION 'Banned from this club';
    END IF;
  END IF;

  IF v_vip_only THEN
    SELECT COALESCE(p.is_vip, false)
           AND (p.vip_expires_at IS NULL OR p.vip_expires_at > now())
      INTO v_is_vip
      FROM profiles p WHERE p.id = p_user_id LIMIT 1;

    IF NOT COALESCE(v_is_vip, false) AND v_club_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM club_members cm
         WHERE cm.club_id = v_club_id AND cm.user_id = p_user_id
           AND cm.role IN ('owner', 'co_owner', 'admin', 'manager', 'agent')
      ) OR EXISTS (
        SELECT 1 FROM clubs c WHERE c.id = v_club_id AND c.owner_id = p_user_id
      ) INTO v_staff;
    END IF;

    IF NOT COALESCE(v_is_vip, false) AND NOT COALESCE(v_staff, false) THEN
      RAISE EXCEPTION 'VIP_ONLY: this table is open to VIP members only'
        USING HINT = 'VIP membership is required to take a seat at this table.';
    END IF;
  END IF;

  DECLARE v_nit jsonb;
  BEGIN
    /* THE DOOR ASKS ONLY WHAT IT ACTS ON (2026-10-01). This door refuses on
       career_vpip and on no other answer fn_nit_check gives, and the
       maintain branch it ignored read the player's whole hand history in
       the game (7.7 s and 14.5 s cold for two horses, 8,767 page reads).
       fn_nit_career_check is the same career statement over the same rows. */
    v_nit := public.fn_nit_career_check(p_table_id, p_user_id);
    IF (v_nit->>'ok')::boolean = false AND v_nit->>'reason' = 'career_vpip' THEN
      RAISE EXCEPTION 'NIT_GAME: this table needs a career VPIP of at least %, and yours is % over % hands',
        v_nit->>'required', v_nit->>'vpip', v_nit->>'hands'
        USING HINT = 'The host has set a minimum voluntarily-put-in-pot rate for this game.';
    END IF;
  END;

  IF EXISTS (SELECT 1 FROM table_seats
              WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || p_table_id::text, 0));

  IF v_max_players > 0 AND p_seat_number > v_max_players THEN
    RAISE EXCEPTION 'TABLE_SIZE: seat % does not exist at this table (% max)',
      p_seat_number, v_max_players;
  END IF;

  IF v_max_players > 0 THEN
    SELECT COUNT(*) INTO v_seats_taken
      FROM table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
    IF v_seats_taken >= v_max_players THEN
      RAISE EXCEPTION 'TABLE_SIZE: table is full (% of % seats taken)',
        v_seats_taken, v_max_players;
    END IF;

    SELECT COUNT(*) INTO v_holds
      FROM public.table_waitlist w
     WHERE w.table_id = p_table_id
       AND w.status = 'notified'
       AND w.user_id <> p_user_id
       AND COALESCE(w.hold_expires_at, w.notified_at + interval '60 seconds') > now();
    -- THE DOOR HONOURS THE CHAIR THE GAME PROMISED (2026-09-10). A pending
    -- must-move / break / balance / seat-change plan into this table is a
    -- reservation everywhere else (fn_cash_game_open_seats, the planner, the
    -- lobby); a linked swap row is not (both chairs are occupied). Counted
    -- here exactly as fn_cash_game_open_seats counts it, never against the
    -- player it is for.
    SELECT COUNT(*) INTO v_moves
      FROM public.cash_seat_moves m
     WHERE m.to_table_id = p_table_id
       AND m.state = 'pending'
       AND m.swap_move_id IS NULL
       AND m.player_id <> p_user_id;
    IF v_seats_taken + v_holds >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for the next player on the waiting list'
        USING HINT = 'Join the waitlist to get the next seat in order.';
    END IF;
    IF v_seats_taken + v_holds + v_moves >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for a player the game is moving here'
        USING HINT = 'Tap Join Game for the next open chair.';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_active_tables
    FROM table_seats ts JOIN tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id AND ts.left_at IS NULL
     AND t.tournament_id IS NULL AND t.status NOT IN ('closed','deleted');
  IF v_active_tables >= v_max_tables THEN
    RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at % cash tables (max %)', v_active_tables, v_max_tables;
  END IF;

  v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this player at this table'
      USING HINT = 'The player must hold a membership in a club that belongs to this game''s union.';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  PERFORM set_config('app.cash_original_debit_ledger','',true);
  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  v_original_ledger:=NULLIF(current_setting('app.cash_original_debit_ledger',true),'')::uuid;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for buy-in (club %)', v_seat_club;
  END IF;

  DELETE FROM table_seats
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy, club_id)
       VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy, v_seat_club);

  -- CHIP CONTINUITY: the session opens with the seat. baseline = this buy-in.
  PERFORM public.fn_cash_session_open(p_user_id, p_table_id, p_amount);

  UPDATE public.table_waitlist
     SET status = 'seated'
   WHERE table_id = p_table_id
     AND user_id = p_user_id
     AND status IN ('waiting', 'notified');

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'buyin',
            'Cash game buy-in (club wallet)', p_table_id, v_new_balance) RETURNING id INTO v_original_wallet;

  PERFORM public.fn_cash_record_original_funding('buyin',p_idempotency_key::text,p_user_id,p_table_id,
    v_original_ledger,v_original_wallet,v_seat_club,p_amount,v_new_balance,v_original_pending);

  UPDATE tables
     SET current_players = (SELECT COUNT(*) FROM table_seats
                             WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_t public.tables%ROWTYPE;
 v_game_id uuid;
 v_locked_game public.cash_games%ROWTYPE;
 v_seat_id uuid:=gen_random_uuid();
 v_custody jsonb;
 v_taken integer;
 v_holds integer;
BEGIN
 IF p_idempotency_key IS NULL OR p_user_id IS NULL OR p_table_id IS NULL
    OR p_seat_number IS NULL OR p_seat_number<1 OR p_auto_rebuy IS DISTINCT FROM false
    OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647
    OR p_amount<>trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_cash_purchase' USING ERRCODE='22023';
 END IF;
 -- Staff pause/close and allocation lock game before table. Take the
 -- same lock before reserving money; a concurrent pause is observed here.
 SELECT t.cluster_id INTO v_game_id FROM public.tables t WHERE t.id=p_table_id;
 IF v_game_id IS NOT NULL THEN
   SELECT cg.* INTO v_locked_game FROM public.cash_games cg
     WHERE cg.id=v_game_id FOR UPDATE;
   IF NOT FOUND OR NOT coalesce(v_locked_game.enabled,false)
      OR v_locked_game.cluster_mode IS DISTINCT FROM 'must_move' THEN
     RAISE EXCEPTION 'GAME_CLOSED: this Diamond game is not taking new players' USING ERRCODE='23514';
   END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||p_user_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:'||p_table_id,0));
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
   JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL AND a.cash_games_enabled
 FOR UPDATE OF t;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'diamond_cash_not_open' USING ERRCODE='55000';
 END IF;
 IF v_t.cluster_id IS DISTINCT FROM v_game_id THEN
   RAISE EXCEPTION 'diamond_cash_entry_scope_changed' USING ERRCODE='55000';
 END IF;
 IF v_t.cluster_id IS NOT NULL AND v_t.lifecycle NOT IN ('opening','live') THEN
   RAISE EXCEPTION 'TABLE_CLOSING: this Diamond table is not taking new players' USING ERRCODE='23514';
 END IF;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_t) THEN
   RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 -- Match the shared engine load boundary before reserving any Diamonds.
 IF EXISTS(SELECT 1 FROM (VALUES(v_t.small_blind),(v_t.big_blind),
      (v_t.min_buy_in),(v_t.max_buy_in)) AS amount(value)
      WHERE value IS NULL OR value NOT BETWEEN 1 AND 2147483647
        OR value<>trunc(value))
    OR COALESCE(v_t.ante,0) NOT BETWEEN 0 AND 9007199254740991
    OR COALESCE(v_t.ante,0)<>trunc(COALESCE(v_t.ante,0)) THEN
   RAISE EXCEPTION 'diamond_cash_requires_whole_amounts' USING ERRCODE='23514';
 END IF;
 IF coalesce(v_t.bomb_pot_enabled,false) THEN
   IF coalesce(lower(v_t.bomb_pot_variant),'') NOT IN ('',v_t.game_variant) THEN
     RAISE EXCEPTION 'diamond_bomb_pot_requires_the_table_game' USING ERRCODE='23514';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM (SELECT CASE
          WHEN coalesce(v_t.bomb_pot_ante_fixed,0)>0 THEN v_t.bomb_pot_ante_fixed
          ELSE v_t.big_blind*coalesce(v_t.bomb_pot_ante_multiplier,2) END AS a) x
        WHERE x.a IS NOT NULL AND x.a BETWEEN 1 AND 2147483647 AND x.a=trunc(x.a)) THEN
     RAISE EXCEPTION 'diamond_bomb_pot_requires_a_whole_ante' USING ERRCODE='23514';
   END IF;
 END IF;
 IF p_club_id IS NOT NULL AND p_club_id<>v_t.club_id THEN
   RAISE EXCEPTION 'diamond_purchase_arena_mismatch' USING ERRCODE='22023';
 END IF;
 IF v_t.max_players IS NULL OR p_seat_number>v_t.max_players THEN
   RAISE EXCEPTION 'TABLE_SIZE: invalid Diamond seat' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.blacklists WHERE user_id=p_user_id
     AND club_id=v_t.club_id AND (expires_at IS NULL OR expires_at>now())) THEN
   RAISE EXCEPTION 'Banned from this club' USING ERRCODE='42501';
 END IF;
 IF coalesce(v_t.is_vip_only,false) AND NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.id=p_user_id AND p.is_vip IS TRUE
      AND (p.vip_expires_at IS NULL OR p.vip_expires_at>now())) THEN
   RAISE EXCEPTION 'VIP_ONLY: this table requires VIP membership' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL
           AND (user_id=p_user_id OR seat_number=p_seat_number)) THEN
   RAISE EXCEPTION 'Diamond seat or player is already seated' USING ERRCODE='23505';
 END IF;
 SELECT count(*) INTO v_taken FROM public.table_seats
   WHERE table_id=p_table_id AND left_at IS NULL;
 SELECT count(*) INTO v_holds FROM public.table_waitlist
   WHERE table_id=p_table_id AND status='notified' AND user_id<>p_user_id
     AND coalesce(hold_expires_at,notified_at+interval '60 seconds')>now();
 IF v_taken>=v_t.max_players OR v_taken+v_holds>=v_t.max_players THEN
   RAISE EXCEPTION 'SEAT_RESERVED: table capacity is taken or held' USING ERRCODE='55000';
 END IF;
 IF (SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL AND t.tournament_id IS NULL
       AND t.status NOT IN ('closed','deleted'))>=4 THEN
   RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at four cash tables' USING ERRCODE='55000';
 END IF;

 v_custody:=public.fn_poker_diamond_reserve(p_user_id,'cash_seat',p_table_id,
   'seat:'||v_seat_id,p_amount,p_idempotency_key);
 PERFORM set_config('app.money_path','atomic_table_buyin',true);
 DELETE FROM public.table_seats WHERE table_id=p_table_id
   AND seat_number=p_seat_number AND left_at IS NOT NULL;
 INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,auto_rebuy,club_id)
   VALUES(v_seat_id,p_table_id,p_seat_number,p_user_id,p_amount,'active',false,v_t.club_id);
 -- The after-insert binder sees the final occupancy stamped by the shared trigger.
 IF NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
     JOIN public.table_seats s ON s.id=c.seat_id AND s.joined_at=c.seat_joined_at
       AND s.occupancy_id=c.occupancy_id
     WHERE c.id=(v_custody->>'custody_id')::uuid AND c.state='active'
       AND s.id=v_seat_id AND s.left_at IS NULL AND s.stack=c.balance) THEN
   RAISE EXCEPTION 'diamond_seat_custody_binding_failed' USING ERRCODE='23514';
 END IF;
 UPDATE public.table_waitlist SET status='seated'
   WHERE table_id=p_table_id AND user_id=p_user_id AND status IN ('waiting','notified');
 UPDATE public.tables SET current_players=(
   SELECT count(*) FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
   WHERE id=p_table_id;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_cash_entry_need(p_user_id uuid, p_table_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_min numeric;
  v_max numeric;
  v_tournament uuid;
  v_need numeric;
BEGIN
  SELECT t.min_buy_in, t.max_buy_in, t.tournament_id
    INTO v_min, v_max, v_tournament
    FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  v_need := COALESCE(v_min, 0);
  IF v_tournament IS NULL AND p_user_id IS NOT NULL THEN
    v_need := GREATEST(v_need, COALESCE(public.fn_cash_rejoin_floor(p_user_id, p_table_id), 0));
  END IF;
  IF v_max IS NOT NULL AND v_max > 0 THEN
    v_need := LEAST(v_need, v_max);
  END IF;
  RETURN GREATEST(v_need, 0);
END
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_leave_check(p_user_id uuid, p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_s record; v_stack numeric; v_rem integer; v_locked boolean;
BEGIN
  SELECT * INTO v_s FROM public.cash_player_session
   WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id AND closed_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'stay_remaining_ms', 0);
  END IF;
  SELECT ts.stack INTO v_stack FROM public.table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL LIMIT 1;
  v_rem := public.fn_cash_stay_remaining_ms(v_s.stay_remaining_ms, v_s.stay_running, v_s.stay_last_tick_at);
  v_locked := COALESCE(v_stack, 0) > v_s.baseline AND v_rem > 0;
  RETURN jsonb_build_object(
    'allowed', NOT v_locked,
    'code', CASE WHEN v_locked THEN 'LEAVE_LOCKED' ELSE NULL END,
    'stay_remaining_ms', CASE WHEN v_locked THEN v_rem ELSE 0 END,
    'baseline', v_s.baseline, 'stack', COALESCE(v_stack, 0));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_rejoin_floor(p_user_id uuid, p_table_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_stay_remaining_ms(p_remaining integer, p_running boolean, p_last_tick timestamp with time zone)
 RETURNS integer
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN COALESCE(p_running, false)
      THEN LEAST(2147483647::bigint, GREATEST(0::bigint,
             COALESCE(p_remaining, 0)::bigint
             - FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(p_last_tick, clock_timestamp()))) * 1000)::bigint
           ))::integer
    ELSE GREATEST(0, COALESCE(p_remaining, 0))
  END;
$function$
;
