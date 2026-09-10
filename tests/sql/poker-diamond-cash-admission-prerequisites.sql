CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role')
         OR COALESCE(r.rolsuper, false)
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;

  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  SELECT max(t.release_target_at) INTO v_release_target
    FROM public.engine_maintenance_thaws t
   WHERE t.contract_version = 3
     AND t.release_target_at > clock_timestamp()
     AND COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$
;
-- Current production public doors and guards, retained for isolated contract tests.
CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  -- The engine and every server-side job authenticate as service_role. A NULL
  -- means there is no PostgREST request context at all - psql, pg_cron, a
  -- migration - which is equally trusted. A browser can never produce NULL:
  -- reaching `authenticated` requires a verified JWT and PostgREST always sets
  -- request.jwt.claims from it.
  --
  -- NOT current_user. Inside a SECURITY DEFINER body current_user is the
  -- function OWNER for the browser and the engine alike, which is what made an
  -- earlier guard on club_members a silent no-op.
  SELECT COALESCE(auth.role(), 'service_role') = 'service_role';
$function$
;

CREATE OR REPLACE FUNCTION public.fn_caller_session_is_live()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
DECLARE
  v_claims jsonb;
  v_sid    uuid;
BEGIN
  IF public.fn_caller_is_engine() THEN
    RETURN true;
  END IF;

  -- Malformed or absent claims are not a crash, they are a refusal.
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  IF v_claims IS NULL THEN
    RETURN false;
  END IF;

  BEGIN
    v_sid := (v_claims ->> 'session_id')::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  IF v_sid IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM auth.sessions s
     WHERE s.id = v_sid
       AND (s.not_after IS NULL OR s.not_after > now())
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_claim_entry_purchase_receipt(p_key_domain text, p_idempotency_key text, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  INSERT INTO public.entry_purchase_idempotency_receipts
    (key_domain, idempotency_key, request)
  VALUES (p_key_domain, p_idempotency_key, p_request)
  ON CONFLICT (key_domain, idempotency_key) DO NOTHING
  RETURNING request, response INTO v_request, v_response;
  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  /* The unique-index wait above cannot observe an uncommitted placeholder.
     A committed placeholder without a response means some code violated the
     same-transaction contract, so it is corruption-not permission to rerun
     a money core. */
  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key is already bound to a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NULL THEN
    RAISE EXCEPTION
      'INCOMPLETE_IDEMPOTENCY_RECEIPT: % key was committed without its response',
      p_key_domain
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('claimed', false, 'response', v_response);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$
;

CREATE OR REPLACE FUNCTION public.fn_record_entry_purchase_receipt(p_key_domain text, p_idempotency_key text, p_request jsonb, p_response jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN p_response;
  END IF;
  IF p_request IS NULL OR p_response IS NULL THEN
    RAISE EXCEPTION 'entry purchase receipts require a non-null request and response'
      USING ERRCODE = '22004';
  END IF;

  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key completed concurrently for a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NOT NULL THEN
    RETURN v_response;
  END IF;

  UPDATE public.entry_purchase_idempotency_receipts r
     SET response = p_response,
         completed_at = transaction_timestamp()
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
     AND r.request IS NOT DISTINCT FROM p_request
     AND r.response IS NULL
  RETURNING r.response INTO STRICT v_response;
  RETURN v_response;
END;
$function$
;



CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_replay jsonb;
BEGIN
  IF p_amount IS NULL
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Chips Move In Hundredths At Most' USING ERRCODE = '22003';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Cannot buy in for another user' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object(
    'door', 'atomic_table_buyin',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'seat_number', p_seat_number,
    'amount', p_amount,
    'auto_rebuy', p_auto_rebuy,
    'club_id', p_club_id
  );
  v_replay := public.fn_claim_entry_purchase_receipt(
    'cash_transaction', p_idempotency_key::text, v_request
  );
  IF NOT COALESCE((v_replay->>'claimed')::boolean, false) THEN
    RETURN;
  END IF;
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transaction_idempotency_keys k
     WHERE k.key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical cash key does not prove its table and seat'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash buy-ins; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  PERFORM public.atomic_table_buyin_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_seat_number, p_amount, p_auto_rebuy,
    p_club_id, p_idempotency_key
  );
  PERFORM public.fn_record_entry_purchase_receipt(
    'cash_transaction',
    p_idempotency_key::text,
    v_request,
    jsonb_build_object('completed', true)
  );
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
  v_is_template boolean;
  v_vip_only boolean;
  v_is_vip boolean;
  v_staff boolean;
  v_floor numeric;
  v_effective_min numeric;
  v_max_players integer;
  v_seats_taken integer;
  v_holds integer := 0;
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
    v_nit := public.fn_nit_check(p_table_id, p_user_id, NULL);
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
    IF v_seats_taken + v_holds >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for the next player on the waiting list'
        USING HINT = 'Join the waitlist to get the next seat in order.';
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

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;

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
            'Cash game buy-in (club wallet)', p_table_id, v_new_balance);

  UPDATE tables
     SET current_players = (SELECT COUNT(*) FROM table_seats
                             WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_cash_buyin_receipt(p_idempotency_key uuid, p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth'
 SET statement_timeout TO '5s'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_request jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in to check your buy-in' USING ERRCODE = '42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: sign in again to check your buy-in'
      USING ERRCODE = '28000';
  END IF;

  SELECT r.request INTO v_request
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = 'cash_transaction'
     AND r.idempotency_key = p_idempotency_key::text
     AND r.request->>'door' = 'atomic_table_buyin'
     AND r.request->>'user_id' = v_user_id::text
     AND r.request->>'table_id' = p_table_id::text
     AND r.response = jsonb_build_object('completed', true)
     AND r.completed_at IS NOT NULL;

  -- An in-flight transaction is invisible here. Never call absence a refusal,
  -- and never infer the purchase from a current seat or current wallet balance.
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unconfirmed'); END IF;
  RETURN jsonb_build_object('status', 'confirmed', 'request', jsonb_build_object(
    'door', 'atomic_table_buyin', 'user_id', v_user_id, 'table_id', p_table_id,
    'seat_number', v_request->'seat_number', 'amount', v_request->'amount',
    'auto_rebuy', v_request->'auto_rebuy', 'club_id', v_request->'club_id'
  ));
END;
$function$
;

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
  v_credited  boolean := false;
  v_seat_rows integer;
  v_tournament uuid;
  v_engine    boolean;
  v_mode      text;
  v_admin_forced boolean;
  v_enforce   boolean;
  v_chk       jsonb;
  v_receipt   jsonb;
BEGIN
  v_engine := coalesce(public.fn_caller_is_engine(),false);
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    PERFORM 1 FROM tournaments WHERE id = v_tournament FOR NO KEY UPDATE;
  END IF;

  IF p_seat_number IS NOT NULL THEN
    SELECT id, stack, joined_at, seat_number, occupancy_id INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id
       AND seat_number = p_seat_number AND left_at IS NULL
     FOR UPDATE;
  ELSE
    SELECT id, stack, joined_at, seat_number, occupancy_id INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     ORDER BY joined_at DESC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'stack', 0, 'reason', 'no_active_seat');
  END IF;

  -- Cash amounts must be valid BEFORE the credit, idempotency record and
  -- seat exit. A receipt rejected after commit cannot roll those writes back.
  -- Tournament stacks are play chips and still return zero below.
  IF v_tournament IS NULL AND (
    v_seat.stack IS NULL OR
    v_seat.stack::text IN ('NaN', 'Infinity', '-Infinity') OR
    v_seat.stack < 0 OR v_seat.stack <> trunc(v_seat.stack, 2)
  ) THEN
    RAISE EXCEPTION 'CASHOUT_INVALID_STACK' USING ERRCODE = '22003';
  END IF;
  v_stack := v_seat.stack;

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

  -- The database renews this identity on every new occupancy, even when
  -- a physical row or seniority timestamp is reused.
  v_key := 'cashout:occupancy:' || v_seat.occupancy_id::text;

  /* ZERO-DRIFT (2026-09-01): a tournament-table stack is play chips. */
  IF v_tournament IS NOT NULL THEN
    v_stack := 0;
    v_credited := false;
  ELSIF v_stack > 0 THEN
    PERFORM public.atomic_credit_wallet_and_log(
      p_user_id, v_stack, 'cashout', 'Cash-out from table',
      p_table_id, NULL, NULL, v_key
    );
    v_credited := true;
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

  v_receipt := jsonb_build_object(
    'ok', true, 'stack', v_stack, 'credited', v_credited,
    'seat_number', v_seat.seat_number, 'idempotency_key', v_key,
    'tournament_table', v_tournament IS NOT NULL,
    'occupancy_id',v_seat.occupancy_id,'user_id',p_user_id,'table_id',p_table_id);
  -- Every ingress, including an older engine during adoption, records the
  -- original outcome in the transaction that moves the money and exits the seat.
  INSERT INTO public.seat_cashout_receipts
    (occupancy_id,user_id,table_id,seat_id,seat_number,receipt)
  VALUES(v_seat.occupancy_id,p_user_id,p_table_id,v_seat.id,v_seat.seat_number,v_receipt);
  RETURN v_receipt;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_poker_guard_chip_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
      WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Seats Require Dedicated Diamond Custody' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_cashout_seat_occupancy(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid, p_leave_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_tournament uuid;
  v_seat record;
  v_previous public.seat_cashout_receipts%ROWTYPE;
  v_result jsonb;
  v_effective_mode text;
  v_previous_authority text;
BEGIN
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_seat_number IS NULL
     OR p_occupancy_id IS NULL THEN
    RAISE EXCEPTION 'CASHOUT_OCCUPANCY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- The engine owns the live-hand boundary. Knowing an occupancy UUID or
  -- owning the seat cannot authorize a direct browser cashout mid-hand.
  IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
    RAISE EXCEPTION 'Engine authority required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text,0));
  SELECT * INTO v_previous FROM public.seat_cashout_receipts
   WHERE occupancy_id = p_occupancy_id;
  IF FOUND THEN
    IF v_previous.user_id <> p_user_id OR v_previous.table_id <> p_table_id
       OR v_previous.seat_number <> p_seat_number THEN
      RAISE EXCEPTION 'CASHOUT_OCCUPANCY_SCOPE_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN v_previous.receipt;
  END IF;

  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    PERFORM 1 FROM public.tournaments WHERE id=v_tournament FOR NO KEY UPDATE;
  END IF;
  SELECT id,seat_number,occupancy_id INTO v_seat FROM public.table_seats
   WHERE occupancy_id=p_occupancy_id AND table_id=p_table_id AND user_id=p_user_id
     AND seat_number=p_seat_number AND left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_STALE_OCCUPANCY' USING ERRCODE = '22023';
  END IF;

  -- This lock and the canonical function's locks are in the same transaction.
  -- A concurrent seat replacement cannot cross the identity check.
  v_effective_mode := p_leave_mode;
  -- A forced request survives restart and cannot leak onto a later occupancy.
  IF p_leave_mode IS DISTINCT FROM 'vpip_evicted' AND EXISTS (SELECT 1 FROM public.seat_departure_requests
    WHERE occupancy_id=p_occupancy_id AND user_id=p_user_id AND table_id=p_table_id
      AND seat_number=p_seat_number AND leave_mode='forced') THEN
    v_effective_mode := 'forced';
  END IF;
  -- Classification is derived from retained, occupancy-bound authority.
  -- Never inherit another operation's transaction-local admin marker.
  v_previous_authority := current_setting('app.cash_exit_authority',true);
  PERFORM set_config('app.cash_exit_authority',
    CASE WHEN v_effective_mode='forced' AND EXISTS(
      SELECT 1 FROM public.seat_admin_departure_authorizations
       WHERE occupancy_id=p_occupancy_id AND user_id=p_user_id
         AND table_id=p_table_id AND seat_number=p_seat_number)
    THEN 'club_admin' ELSE '' END,true);
  v_result := public.atomic_seat_cashout_locked(
    p_user_id,p_table_id,p_seat_number,v_effective_mode);
  PERFORM set_config('app.cash_exit_authority',coalesce(v_previous_authority,''),true);
  IF v_result->>'ok' IS DISTINCT FROM 'true'
     OR v_result->>'reason' IS NOT NULL
     OR (v_result->>'seat_number')::integer IS DISTINCT FROM p_seat_number
     OR v_result->>'idempotency_key' IS DISTINCT FROM 'cashout:occupancy:'||p_occupancy_id::text THEN
    RAISE EXCEPTION 'CASHOUT_UNCONFIRMED_OUTCOME' USING ERRCODE = '22023';
  END IF;
  -- The canonical transaction writes this receipt for every ingress.
  -- The wrapper owns request identity and replay, never a second receipt write.
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
  v_tournament_id uuid;
  v_variant text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id, t.variant, t.max_players, t.starting_chips
    INTO v_tournament_id, v_variant, v_max_players, v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack <= 0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack
        USING ERRCODE = 'check_violation',
              HINT = 'Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF lower(COALESCE(v_variant,'')) = 'spin'
       OR COALESCE(v_max_players,0) <= 2 THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips <= 0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id, v_starting_chips
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.stack IS DISTINCT FROM v_starting_chips THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack, v_starting_chips
          USING ERRCODE = 'check_violation',
                HINT = 'The paid seat transaction is the only starting-stack authority; no later top-up exists.';
      END IF;
    END IF;
  END IF;

  -- Cash seats with no funded stack preserve their existing reservation path.
  IF COALESCE(NEW.stack,0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_assign_tournament_player_seat_atomic',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_occupancy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.table_id IS DISTINCT FROM NEW.table_id
     OR OLD.seat_number IS DISTINCT FROM NEW.seat_number
     OR (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL) THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id THEN
    RAISE EXCEPTION 'SEAT_OCCUPANCY_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_assert_cash_chip_purchase_table(p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_is_template boolean;
BEGIN
  SELECT t.tournament_id, COALESCE(t.is_template, false)
    INTO v_tournament_id, v_is_template
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TABLE_NOT_FOUND: cash chip purchase target does not exist'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION
      'CASH_PURCHASE_ONLY: cash buy-in, rebuy and add-on RPCs cannot fund a tournament table'
      USING ERRCODE = '55000';
  END IF;
  IF v_is_template THEN
    RAISE EXCEPTION 'IS_TEMPLATE: this is a saved table template, not a live game'
      USING ERRCODE = '55000';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_log_seat_stack_exit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stack numeric;
  v_kind  text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A departed seat being tidied up is not an exit: its stack left when
    -- left_at was stamped, and that is already recorded below.
    IF OLD.left_at IS NOT NULL THEN RETURN OLD; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'deleted';
  ELSE
    IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN RETURN NEW; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'left';
  END IF;

  IF v_stack <= 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- CASH ONLY. A tournament stack is play money inside the event -- it credits
  -- no wallet when the seat ends, so it cannot be lost in the sense this table
  -- exists to detect. Filtering HERE rather than in the report keeps ~2,000
  -- meaningless rows an hour out of the audit trail entirely.
  IF EXISTS (SELECT 1 FROM public.tables t
              WHERE t.id = OLD.table_id AND t.tournament_id IS NOT NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.ca_seat_stack_exits
    (seat_id, table_id, user_id, club_id, seat_number, stack, exit_kind, db_role, app_name)
  VALUES (OLD.id, OLD.table_id, OLD.user_id, OLD.club_id, OLD.seat_number,
          v_stack, v_kind, current_user,
          NULLIF(current_setting('application_name', true), ''));

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_fn_close_session_when_seat_vacated()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  BEGIN
    /* A VACATED SEAT CLOSES ITS SESSION AT COMMIT (2026-09-10). Deferred: any
       proper close in this transaction has already run. Only a session that
       NOBODY closed is still open here, and that is the one this closes. */
    IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = NEW.table_id AND t.tournament_id IS NULL) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'seat_vacated'
       WHERE player_id = NEW.user_id AND scope_type = 'table'
         AND scope_id = NEW.table_id AND closed_at IS NULL;
    END IF;
    RETURN NULL;
  END $function$
;
