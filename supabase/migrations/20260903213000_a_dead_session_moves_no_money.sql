-- ═══════════════════════════════════════════════════════════════════════════
-- A DEAD SESSION MOVES NO MONEY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-03: "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO, SIT DOWN AND BUY
-- CHIPS AND GET DEALT A HAND. (I DID GET A SERVER ERROR NOTICE AT LEAST)
-- THAT CAN NEVER HAPPEN... EVER."
--
-- It could, and the seat and the money were real: table_seats shows him at
-- seat 4 of 39ce3371 at 20:24:12Z with a 400.00 debit, a second 400.00 rebuy
-- 19 seconds later and a 386.50 cash-out at 20:35:19Z.
--
-- WHY. This project issues SEVEN-DAY access tokens (measured on a live token:
-- 603,399 seconds of validity remaining). PostgREST verifies a JWT the only
-- way it can - signature and `exp`, locally, against the shared secret. It
-- has no way to ask GoTrue whether the session behind that token still
-- exists, and it does not try. So "logged out" was a statement about the
-- browser's UI and nothing else: the bearer token in that tab stayed a valid
-- credential at the database for the remainder of the week, and every money
-- door happily accepted it. auth.uid() was a real user id, so every existing
-- guard - and they are thorough - passed honestly.
--
-- The engine was never fooled. server/src/http/auth.ts and the WebSocket
-- server both verify through supabase.auth.getUser(token), which is a call to
-- GoTrue, and GoTrue checks the session row. A signed-out token is refused
-- there within the 60s verify cache. Only the database trusted it.
--
-- THE FIX. auth.sessions is the authority on whether a session still exists -
-- GoTrue deletes the row on sign-out - and every token this project issues
-- carries a `session_id` claim naming its row (verified on a live token:
-- aal amr app_metadata aud email exp iat is_anonymous iss phone role
-- session_id sub user_metadata). So the money doors can ask the same question
-- the engine asks, without a network call: is the session behind this token
-- still alive?
--
-- WHAT IS DELIBERATELY NOT DONE HERE. This does not shorten the seven-day
-- token - that is a project-level auth setting, it logs out every device that
-- cannot refresh, and it is Dan's call, not a migration's. It is the right
-- next step and the guard below does not depend on it.
--
-- ROLLBACK: restore the three functions from the previous migration and
--   DROP FUNCTION public.fn_caller_session_is_live();

BEGIN;

-- ── The question the engine already asks, asked in SQL ──────────────────────
--
-- STABLE, not VOLATILE: it is a read, and PostgREST calls it once per money
-- door. SECURITY DEFINER because auth.sessions is not readable by
-- `authenticated`, and it must stay that way - this function answers one
-- boolean about the CALLER'S OWN session and exposes no other row.
--
-- fn_caller_is_engine() first, and that is the whole service-side exemption:
-- the engine, pg_cron, psql and every migration authenticate as service_role
-- (or with no request context at all), have no browser session, and must not
-- be asked for one. A browser can never reach that branch - PostgREST always
-- sets request.jwt.claims from a verified JWT, so auth.role() is
-- 'authenticated' or 'anon' for it, never NULL.
--
-- A browser JWT with NO session_id claim FAILS. That is deliberate: this is a
-- money door, the claim is present on every token the project issues today,
-- and a token that cannot name its session cannot have that session checked.
-- Failing open there would reopen the exact hole this closes.
CREATE OR REPLACE FUNCTION public.fn_caller_session_is_live()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
$function$;

REVOKE ALL ON FUNCTION public.fn_caller_session_is_live() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_caller_session_is_live() TO authenticated, service_role;

-- ── atomic_table_buyin: refuse a signed-out token ─────────────────────────
CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_no_rathole boolean;
  v_is_template boolean;
  v_vip_only boolean;
  v_is_vip boolean;
  v_staff boolean;
  v_last_stack numeric;
  v_rathole_floor numeric;
  v_max_players integer;
  v_seats_taken integer;
  v_holds integer := 0;
  v_new_balance NUMERIC;
  v_club_id UUID;
  v_union_id UUID;
  v_ban_id UUID;
  v_min_buy_in NUMERIC;
  v_max_buy_in NUMERIC;
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
  -- "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO SIT DOWN AND BUY CHIPS AND GET
  -- DEALT A HAND. THAT CAN NEVER HAPPEN." It could, because this project
  -- issues SEVEN-DAY access tokens and PostgREST verifies a JWT locally -
  -- signature and exp only. It never asks GoTrue whether the session behind
  -- that token still exists, so signing out left a bearer token that kept
  -- spending real chips as its owner for the rest of the week. The engine
  -- was never fooled (it verifies through auth.getUser, which checks the
  -- session), only the database was. fn_caller_session_is_live closes that
  -- gap at the money door itself.
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
         COALESCE(t.no_rathole, false), COALESCE(t.is_vip_only, false), COALESCE(t.is_template, false)
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players,
         v_no_rathole, v_vip_only, v_is_template
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

  IF v_no_rathole THEN
    SELECT ts.stack INTO v_last_stack
      FROM table_seats ts
     WHERE ts.table_id = p_table_id
       AND ts.user_id = p_user_id
       AND ts.left_at IS NOT NULL
     ORDER BY ts.left_at DESC
     LIMIT 1;

    IF v_last_stack IS NOT NULL AND v_last_stack > 0 THEN
      v_rathole_floor := v_last_stack;
      IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND v_rathole_floor > v_max_buy_in THEN
        v_rathole_floor := v_max_buy_in;
      END IF;
      IF p_amount < v_rathole_floor THEN
        RAISE EXCEPTION
          'NO_RATHOLE: this table requires you to return with the % you left with', v_rathole_floor
          USING HINT = 'The host has switched ratholing off for this table.';
      END IF;
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
$function$;

-- ── atomic_table_rebuy: refuse a signed-out token ─────────────────────────
CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(p_user_id uuid, p_table_id uuid, p_amount numeric, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new_balance numeric; v_club_id uuid; v_union_id uuid; v_ban_id uuid; v_seat_club uuid;
  v_seat_id uuid; v_pending uuid;
BEGIN
  -- ── A DEAD SESSION MOVES NO MONEY (Dan 2026-09-03) ────────────────────
  -- "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO SIT DOWN AND BUY CHIPS AND GET
  -- DEALT A HAND. THAT CAN NEVER HAPPEN." It could, because this project
  -- issues SEVEN-DAY access tokens and PostgREST verifies a JWT locally -
  -- signature and exp only. It never asks GoTrue whether the session behind
  -- that token still exists, so signing out left a bearer token that kept
  -- spending real chips as its owner for the rest of the week. The engine
  -- was never fooled (it verifies through auth.getUser, which checks the
  -- session), only the database was. fn_caller_session_is_live closes that
  -- gap at the money door itself.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot rebuy for another player';
  END IF;

  PERFORM set_config('app.money_path', 'atomic_table_rebuy', true);
  PERFORM set_config('app.ledger_category', 'rebuy', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
    VALUES (p_idempotency_key, p_user_id, 'atomic_table_rebuy', p_amount) ON CONFLICT (key) DO NOTHING;
    IF NOT FOUND THEN RETURN (SELECT chip_balance FROM club_members WHERE user_id = p_user_id AND club_id = (SELECT club_id FROM table_seats WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL LIMIT 1)); END IF;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Rebuy amount must be positive';
  END IF;

  /* ZERO-DRIFT (2026-08-31): lock the seat so it cannot vacate between this
     check and the debit below. */
  SELECT ts.id, ts.club_id INTO v_seat_id, v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table (cannot rebuy a vacated seat)';
  END IF;

  SELECT t.club_id, c.union_id INTO v_club_id, v_union_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id WHERE t.id = p_table_id LIMIT 1;
  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN RAISE EXCEPTION 'Banned from this club'; END IF;
  END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this rebuy';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for rebuy (club %)', v_seat_club;
  END IF;

  /* CHIP STANDARD C3 (2026-09-02): the chips do NOT go onto the seat here.
     This used to be a relative `stack + p_amount` UPDATE on table_seats,
     racing the engine's absolute writes: a rebuy committing after
     loadSeatedPlayers and before the next syncStacks was erased from the felt
     while the wallet stayed debited. The debit and this row land in ONE
     transaction; the engine's resolve_pending_addon delivers the chips into its
     own memory first and only then persists, so nothing can overwrite them. */
  INSERT INTO public.table_pending_addons (table_id, user_id, amount, kind)
  VALUES (p_table_id, p_user_id, p_amount, 'rebuy')
  RETURNING id INTO v_pending;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'rebuy',
            'Cash game rebuy (club wallet)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

-- ── fn_take_seat_and_buy_in: refuse a signed-out token ─────────────────────────
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
  PERFORM set_config('app.money_path', 'fn_take_seat_and_buy_in', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  -- ── A DEAD SESSION MOVES NO MONEY (Dan 2026-09-03) ────────────────────
  -- "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO SIT DOWN AND BUY CHIPS AND GET
  -- DEALT A HAND. THAT CAN NEVER HAPPEN." It could, because this project
  -- issues SEVEN-DAY access tokens and PostgREST verifies a JWT locally -
  -- signature and exp only. It never asks GoTrue whether the session behind
  -- that token still exists, so signing out left a bearer token that kept
  -- spending real chips as its owner for the rest of the week. The engine
  -- was never fooled (it verifies through auth.getUser, which checks the
  -- session), only the database was. fn_caller_session_is_live closes that
  -- gap at the money door itself.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
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

-- Post-apply assertions: fail rather than report a false success.
DO $$
DECLARE
  v_fn text;
BEGIN
  IF to_regprocedure('public.fn_caller_session_is_live()') IS NULL THEN
    RAISE EXCEPTION 'fn_caller_session_is_live did not get created';
  END IF;

  -- Every guarded door must actually call the guard.
  FOREACH v_fn IN ARRAY ARRAY[
    'atomic_table_buyin','atomic_table_rebuy','fn_take_seat_and_buy_in'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_fn
         AND pg_get_functiondef(p.oid) LIKE '%fn_caller_session_is_live%'
    ) THEN
      RAISE EXCEPTION '% does not call fn_caller_session_is_live', v_fn;
    END IF;
  END LOOP;

  -- The engine, pg_cron and psql must never be asked for a browser session.
  -- This very block runs with no request context, which is that case.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'the service-side path must pass the session check';
  END IF;

  -- auth.sessions must stay unreadable by the browser role.
  IF has_table_privilege('authenticated', 'auth.sessions', 'SELECT') THEN
    RAISE EXCEPTION 'auth.sessions became readable by authenticated';
  END IF;
END $$;

COMMIT;
