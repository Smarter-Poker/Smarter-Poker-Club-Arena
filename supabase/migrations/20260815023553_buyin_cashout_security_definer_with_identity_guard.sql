-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815023553 "buyin_cashout_security_definer_with_identity_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ce98fc982996c56b7964b9df114bd3f1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The seat/wallet RPCs were SECURITY INVOKER, but wallets / table_seats /
-- wallet_transactions / tables have no write policies for `authenticated`,
-- so a player's buy-in silently updated 0 wallet rows and raised
-- "Insufficient balance" despite ample funds (live P0, table d9f89a01).
-- These functions were designed to run privileged: convert to SECURITY
-- DEFINER with a pinned search_path, and add an identity guard so an
-- authenticated caller can only buy in / cash out as THEMSELVES.
-- Service-role callers (horse seeding, engine) have auth.uid() = NULL and
-- keep working unchanged.

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(
  p_user_id uuid, p_table_id uuid, p_seat_number integer,
  p_amount numeric, p_auto_rebuy boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_new_balance NUMERIC;
  v_club_id UUID;
  v_union_id UUID;
  v_ban_id UUID;
  v_min_buy_in NUMERIC;
  v_max_buy_in NUMERIC;
BEGIN
  -- SECURITY DEFINER identity guard: a JWT caller may only act as themselves.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  -- Round 78: blacklist gate. Resolve table's club + optional union, then
  -- check for an active ban on either scope.
  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in
    FROM tables t
    LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id
   LIMIT 1;

  -- AUDIT P1-2 (buy-in) FIX: server-side buy-in min/max enforcement.
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
              WHERE table_id = p_table_id
                AND user_id  = p_user_id
                AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  UPDATE wallets
     SET balance    = balance - p_amount,
         updated_at = NOW()
   WHERE user_id     = p_user_id
     AND wallet_type = 'PLAYER'
     AND balance    >= p_amount
   RETURNING balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient balance for buy-in';
  END IF;

  DELETE FROM table_seats
   WHERE table_id    = p_table_id
     AND seat_number = p_seat_number
     AND left_at IS NOT NULL;

  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy)
       VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy);

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_amount, 'buyin',
            'Cash game buy-in at table', p_table_id, v_new_balance);

  UPDATE tables
     SET current_players = (
       SELECT COUNT(*) FROM table_seats
        WHERE table_id = p_table_id AND left_at IS NULL
     )
   WHERE id = p_table_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.atomic_table_cashout(
  p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_stack NUMERIC; v_new_balance NUMERIC;
BEGIN
  -- SECURITY DEFINER identity guard: a JWT caller may only act as themselves.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  IF p_seat_number IS NOT NULL THEN
    SELECT stack INTO v_stack FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND seat_number = p_seat_number AND left_at IS NULL
      FOR UPDATE;
  ELSE
    SELECT stack INTO v_stack FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
      FOR UPDATE;
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'Active seat not found for cash-out'; END IF;

  IF v_stack > 0 THEN
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, 'PLAYER', v_stack)
      ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW()
      RETURNING balance INTO v_new_balance;

    -- BUG 018 FIX: balance_after now populated
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
      VALUES (p_user_id, 'PLAYER', 'credit', v_stack, 'cashout', 'Cash-out from table', p_table_id, v_new_balance);
  END IF;

  UPDATE table_seats SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  UPDATE tables SET current_players = (
    SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
  ) WHERE id = p_table_id;

  RETURN v_stack;
END;
$fn$;

-- Lock down who can call: revoke blanket PUBLIC/anon, grant the two intended roles.
REVOKE EXECUTE ON FUNCTION public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.atomic_table_cashout(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.atomic_table_cashout(uuid, uuid, integer) TO authenticated, service_role;
