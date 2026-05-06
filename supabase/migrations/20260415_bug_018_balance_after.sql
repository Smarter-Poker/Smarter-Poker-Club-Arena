-- BUG 018 — wallet_transactions.balance_after NEVER populated (0 / 1,951,152 rows)
-- Discovery: 2026-04-15 live audit: column exists but zero writes ever set it,
-- including 0 of 224 rows from the last 24 hours. Audit/reconciliation capability
-- entirely missing from wallet audit trail.
--
-- Root cause: every RPC (atomic_table_buyin, atomic_table_cashout, atomic_table_rebuy,
-- both log_wallet_transaction overloads) omits balance_after from the INSERT.
--
-- Bonus fix inside atomic_table_rebuy: prior body INSERTed into nonexistent column
-- `reference_id` and omitted NOT NULL `wallet_type`. Function would RAISE on first
-- call. Production narrowly avoided because auto-rebuy uses a different code path
-- (server/src/services/supabase.ts) and my BUG 017 bust-rebuy flow was never hit.

CREATE OR REPLACE FUNCTION public.log_wallet_transaction(
  p_user_id uuid, p_wallet_type text, p_amount numeric, p_type text, p_category text, p_description text DEFAULT NULL::text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_id UUID; v_bal NUMERIC;
BEGIN
  SELECT balance INTO v_bal FROM wallets WHERE user_id = p_user_id AND wallet_type = p_wallet_type;
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, balance_after)
  VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, COALESCE(v_bal, 0))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_wallet_transaction(
  p_user_id uuid, p_wallet_type text, p_amount numeric, p_type text, p_category text, p_description text,
  p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_bal NUMERIC;
BEGIN
  SELECT balance INTO v_bal FROM wallets WHERE user_id = p_user_id AND wallet_type = p_wallet_type;
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, table_id, hand_id, related_entity_id, balance_after, created_at)
  VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, p_table_id, p_hand_id, p_related_entity_id, COALESCE(v_bal, 0), NOW());
END;
$$;

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(
  p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_new_balance NUMERIC;
BEGIN
  IF EXISTS (SELECT 1 FROM table_seats WHERE table_id = p_table_id AND user_id = p_user_id::text AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  UPDATE wallets SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount
    RETURNING balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN RAISE EXCEPTION 'Insufficient balance for buy-in'; END IF;

  DELETE FROM table_seats WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;
  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy)
    VALUES (p_table_id, p_seat_number, p_user_id::text, p_amount, 'active', p_auto_rebuy);

  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_amount, 'buyin', 'Cash game buy-in at table', p_table_id, v_new_balance);

  UPDATE tables SET current_players = (
    SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
  ) WHERE id = p_table_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.atomic_table_cashout(
  p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_stack NUMERIC; v_new_balance NUMERIC;
BEGIN
  IF p_seat_number IS NOT NULL THEN
    SELECT stack INTO v_stack FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND seat_number = p_seat_number AND left_at IS NULL
      FOR UPDATE;
  ELSE
    SELECT stack INTO v_stack FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL FOR UPDATE;
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'Active seat not found for cash-out'; END IF;

  IF v_stack > 0 THEN
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, 'PLAYER', v_stack)
      ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW()
      RETURNING balance INTO v_new_balance;

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
$$;

-- Triple bug fix: wallet_type NOT NULL missing; reference_id column does not exist;
-- balance_after was NULL. This function would have RAISEd on every call.
CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(
  p_user_id uuid, p_table_id uuid, p_amount numeric
) RETURNS TABLE(new_stack numeric)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_seat_number INT; v_new_stack NUMERIC; v_new_balance NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Rebuy amount must be positive';
  END IF;

  SELECT seat_number INTO v_seat_number FROM table_seats
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL LIMIT 1;
  IF v_seat_number IS NULL THEN
    RAISE EXCEPTION 'Player has no active seat at this table to rebuy into';
  END IF;

  UPDATE wallets SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount
    RETURNING balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN RAISE EXCEPTION 'Insufficient wallet balance for rebuy'; END IF;

  UPDATE table_seats SET stack = stack + p_amount, updated_at = NOW()
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
    RETURNING stack INTO v_new_stack;

  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_amount, 'rebuy', 'Cash game rebuy at table', p_table_id, v_new_balance);
  RETURN QUERY SELECT v_new_stack;
END;
$$;

COMMENT ON FUNCTION public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean) IS
  'BUG 018 FIX 2026-04-15 — now writes balance_after on wallet_transactions row.';
COMMENT ON FUNCTION public.atomic_table_cashout(uuid, uuid, integer) IS
  'BUG 018 FIX 2026-04-15 — now writes balance_after on wallet_transactions row.';
COMMENT ON FUNCTION public.atomic_table_rebuy(uuid, uuid, numeric) IS
  'BUG 018 FIX 2026-04-15 — adds wallet_type (was missing NOT NULL), removes nonexistent reference_id column, adds balance_after.';
