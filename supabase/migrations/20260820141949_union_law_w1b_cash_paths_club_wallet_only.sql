-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820141949 "union_law_w1b_cash_paths_club_wallet_only"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d6139a65bc86533b6121242e989e2c08 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- W1b — CASH PATHS USE THE CLUB WALLET ONLY (2026-08-20)
--
-- Buy-in, cash-out, rebuy and add-on each still had a global-wallet branch.
-- Under the owner's rule there is no shared wallet in Club Arena, so those
-- branches are removed: the club wallet is created if missing, and the
-- operation fails loudly if no club can be resolved rather than silently
-- using a pooled balance.
--
-- Safe to remove now: seat provenance is 100% (zero unstamped active seats),
-- so every live seat already knows which club wallet it belongs to.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
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
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id LIMIT 1;

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

  IF EXISTS (SELECT 1 FROM table_seats
              WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  SELECT COUNT(*) INTO v_active_tables
    FROM table_seats ts JOIN tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id AND ts.left_at IS NULL
     AND t.tournament_id IS NULL AND t.status NOT IN ('closed','deleted');
  IF v_active_tables >= v_max_tables THEN
    RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at % cash tables (max %)', v_active_tables, v_max_tables;
  END IF;

  -- CLUB ARENA RULE: chips come from the club wallet. There is no global wallet.
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

CREATE OR REPLACE FUNCTION public.atomic_table_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_stack NUMERIC; v_new_balance NUMERIC; v_seat_club UUID;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  IF p_seat_number IS NOT NULL THEN
    SELECT stack, club_id INTO v_stack, v_seat_club FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND seat_number = p_seat_number AND left_at IS NULL
      FOR UPDATE;
  ELSE
    SELECT stack, club_id INTO v_stack, v_seat_club FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
      FOR UPDATE;
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'Active seat not found for cash-out'; END IF;

  IF v_stack > 0 THEN
    -- CLUB ARENA RULE: chips return to the club wallet they came from. If that
    -- membership has gone, the wallet is RE-CREATED — chips are never diverted
    -- to a shared wallet and never stranded.
    IF v_seat_club IS NULL THEN
      v_seat_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;
    IF v_seat_club IS NULL THEN
      RAISE EXCEPTION 'No club wallet resolves for cash-out of player %', p_user_id;
    END IF;

    PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + v_stack, updated_at = NOW()
     WHERE user_id = p_user_id AND club_id = v_seat_club
     RETURNING chip_balance INTO v_new_balance;

    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
      VALUES (p_user_id, 'PLAYER', 'credit', v_stack, 'cashout',
              'Cash-out to club wallet', p_table_id, v_new_balance);
  END IF;

  UPDATE table_seats SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  UPDATE tables SET current_players = (
    SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
  ) WHERE id = p_table_id;

  RETURN v_stack;
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(p_user_id uuid, p_table_id uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric; v_club_id uuid; v_union_id uuid; v_ban_id uuid; v_seat_club uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Rebuy amount must be positive';
  END IF;

  SELECT ts.club_id INTO v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1;
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

  UPDATE table_seats SET stack = stack + p_amount
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'rebuy',
            'Cash game rebuy (club wallet)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_table_addon(p_user_id uuid, p_table_id uuid, p_amount numeric, p_apply_to_seat boolean DEFAULT true, p_idempotency_key text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_new_balance numeric; v_claimed integer; v_seat_club uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Add-on amount must be positive';
  END IF;

  SELECT ts.club_id INTO v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not seated at this table'; END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this add-on';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO table_addon_idempotency (key, user_id, table_id, amount, applied_to_seat)
    VALUES (p_idempotency_key, p_user_id, p_table_id, p_amount, p_apply_to_seat)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 0 THEN
      SELECT chip_balance INTO v_new_balance FROM club_members
       WHERE user_id = p_user_id AND club_id = v_seat_club;
      RETURN v_new_balance;
    END IF;
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for add-on (club %)', v_seat_club;
  END IF;

  IF p_apply_to_seat THEN
    UPDATE table_seats SET stack = stack + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  ELSE
    INSERT INTO table_pending_addons (table_id, user_id, amount)
    VALUES (p_table_id, p_user_id, p_amount);
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'addon',
            'Table add-on (club wallet)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

