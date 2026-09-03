-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift directive).
-- This file is the byte-exact mirror of the applied migration.
-- ZERO-DRIFT PART 4b: category plumbing on addon / cashout / transfer.
-- Bodies unchanged except the set_config declarations (transaction-local),
-- which make the auto-journaled club_members rows carry real categories.

CREATE OR REPLACE FUNCTION public.atomic_table_addon(p_user_id uuid, p_table_id uuid, p_amount numeric, p_apply_to_seat boolean DEFAULT true, p_idempotency_key text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_new_balance numeric; v_claimed integer; v_seat_club uuid; v_seat_rows integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Add-on amount must be positive';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot add on for another user';
  END IF;

  PERFORM set_config('app.ledger_category', 'addon', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  SELECT ts.club_id INTO v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1
   FOR UPDATE;
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
    GET DIAGNOSTICS v_seat_rows = ROW_COUNT;
    IF v_seat_rows = 0 THEN
      RAISE EXCEPTION
        'Add-on of % could not be applied: seat vacated mid-add-on (table %, player %)',
        p_amount, p_table_id, p_user_id;
    END IF;
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

CREATE OR REPLACE FUNCTION public.atomic_table_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_stack NUMERIC; v_new_balance NUMERIC; v_seat_club UUID;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  PERFORM set_config('app.ledger_category', 'table_cashout', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

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

CREATE OR REPLACE FUNCTION public.fn_transfer_chips(p_club_id uuid, p_from_user_id uuid, p_to_user_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_from_before numeric;
  v_to_before numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  PERFORM set_config('app.ledger_category', 'transfer', true);
  PERFORM set_config('app.ledger_counterparty', 'player_wallet', true);

  SELECT COALESCE(chip_balance, 0) INTO v_from_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_from_user_id FOR UPDATE;

  IF v_from_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'sender is not a member of this club');
  END IF;

  IF v_from_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_from_before);
  END IF;

  UPDATE club_members
  SET chip_balance = chip_balance - p_amount, updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_from_user_id;

  SELECT COALESCE(chip_balance, 0) INTO v_to_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_to_user_id FOR UPDATE;

  IF v_to_before IS NULL THEN
    INSERT INTO club_members (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (p_club_id, p_to_user_id, 'player', p_amount, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_members.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
  ELSE
    UPDATE club_members
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_to_user_id;
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_from_user_id, p_to_user_id, p_amount,
    'peer_transfer', COALESCE(p_reason, 'Peer chip transfer'),
    COALESCE(v_to_before, 0) + p_amount, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount);
END;
$function$;