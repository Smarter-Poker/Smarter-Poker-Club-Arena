-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723235307 "ca_sweep4_wallet_type_transfer_category_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2db307a2ec5b2404383bb8de40438c0e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_wallet_type_transfer(
  p_user_id uuid, p_from_wallet text, p_to_wallet text, p_amount numeric, p_note text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_from_balance numeric;
  v_to_balance numeric;
  v_desc text;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;
  IF p_user_id IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'can only move your own funds');
  END IF;
  IF p_from_wallet NOT IN ('BUSINESS','PLAYER','PROMO')
     OR p_to_wallet NOT IN ('BUSINESS','PLAYER','PROMO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid wallet type');
  END IF;
  IF p_from_wallet = p_to_wallet THEN
    RETURN jsonb_build_object('success', false, 'error', 'source and destination wallets are the same');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be positive');
  END IF;

  SELECT balance INTO v_from_balance
    FROM wallets WHERE user_id = p_user_id AND wallet_type = p_from_wallet
    FOR UPDATE;
  IF v_from_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'source wallet not found');
  END IF;
  IF v_from_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient balance', 'balance', v_from_balance);
  END IF;

  v_desc := COALESCE(NULLIF(p_note, ''), 'Internal transfer ' || p_from_wallet || ' -> ' || p_to_wallet);

  UPDATE wallets SET balance = balance - p_amount, updated_at = now()
   WHERE user_id = p_user_id AND wallet_type = p_from_wallet;

  INSERT INTO wallets (user_id, wallet_type, balance)
       VALUES (p_user_id, p_to_wallet, p_amount)
  ON CONFLICT (user_id, wallet_type)
  DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now()
  RETURNING balance INTO v_to_balance;

  -- category must be one of the wallet_transactions CHECK values; 'transfer' is canonical
  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, balance_after)
  VALUES
    (p_user_id, p_from_wallet, 'debit',  p_amount, 'transfer', v_desc, v_from_balance - p_amount),
    (p_user_id, p_to_wallet,   'credit', p_amount, 'transfer', v_desc, v_to_balance);

  RETURN jsonb_build_object('success', true, 'from', p_from_wallet, 'to', p_to_wallet,
                            'amount', p_amount, 'from_balance', v_from_balance - p_amount,
                            'to_balance', v_to_balance);
END;
$function$;
