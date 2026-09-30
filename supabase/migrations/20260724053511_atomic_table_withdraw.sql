-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724053511 "atomic_table_withdraw"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 580819f696e778385ab7241ab8e01150 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Server-authoritative partial cash-out (withdraw), mirror of atomic_table_addon.
-- Credits the PLAYER wallet by p_amount and (when p_apply_to_seat) reduces
-- table_seats.stack by p_amount. Guards amount > 0 and amount <= seated stack.
-- Same security model / grants as atomic_table_addon.
CREATE OR REPLACE FUNCTION public.atomic_table_withdraw(
  p_user_id uuid,
  p_table_id uuid,
  p_amount numeric,
  p_apply_to_seat boolean DEFAULT true
)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric;
  v_stack numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Withdraw amount must be positive';
  END IF;

  SELECT stack INTO v_stack FROM table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table';
  END IF;

  -- Reject over-withdraw: cannot cash out more than the seated stack.
  IF p_amount > v_stack THEN
    RAISE EXCEPTION 'Withdraw exceeds seated stack';
  END IF;

  IF p_apply_to_seat THEN
    UPDATE table_seats
       SET stack = stack - p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  END IF;

  UPDATE wallets
     SET balance    = balance + p_amount,
         updated_at = NOW()
   WHERE user_id     = p_user_id
     AND wallet_type = 'PLAYER'
   RETURNING balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    INSERT INTO wallets (user_id, wallet_type, balance)
      VALUES (p_user_id, 'PLAYER', p_amount)
      ON CONFLICT (user_id, wallet_type)
        DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW()
      RETURNING balance INTO v_new_balance;
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'cashout',
            'Table withdraw (partial cash-out)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.atomic_table_withdraw(uuid, uuid, numeric, boolean)
  TO anon, authenticated, service_role;
