-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260724164425 as "rakeback_credit_idempotency"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
DROP FUNCTION IF EXISTS public.credit_player_rakeback(uuid, numeric, text);
CREATE OR REPLACE FUNCTION public.credit_player_rakeback(
  p_user_id uuid,
  p_amount numeric,
  p_description text DEFAULT ''::text,
  p_idempotency_key text DEFAULT NULL
)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_inserted integer;
BEGIN
  IF p_amount <= 0 THEN RETURN false; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_user_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN RETURN false; END IF;
  END IF;

  UPDATE wallets SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;
  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
  VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'rakeback', COALESCE(NULLIF(p_description, ''), 'Rakeback credit'));
  SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_user_id LIMIT 1;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, p_user_id, p_amount, 'rakeback', COALESCE(NULLIF(p_description, ''), 'Rakeback credit'));
  RETURN true;
END; $function$;

ALTER FUNCTION public.credit_player_rakeback(uuid, numeric, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.credit_player_rakeback(uuid, numeric, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_player_rakeback(uuid, numeric, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_player_rakeback(uuid, numeric, text, text) TO postgres, service_role;

DROP FUNCTION IF EXISTS public.atomic_pay_player_rakeback(uuid, uuid, numeric, uuid);
CREATE OR REPLACE FUNCTION public.atomic_pay_player_rakeback(
  p_snapshot_id uuid,
  p_player_id uuid,
  p_amount numeric,
  p_period_id uuid,
  p_idempotency_key text DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric;
  v_inserted integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_player_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN RETURN; END IF;
  END IF;

  INSERT INTO public.wallets (user_id, wallet_type, balance)
       VALUES (p_player_id, 'PLAYER', p_amount)
  ON CONFLICT (user_id, wallet_type) DO UPDATE
     SET balance    = public.wallets.balance + p_amount,
         updated_at = NOW()
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, type, amount, category, description,
     related_entity_id, balance_after)
  VALUES
    (p_player_id, 'PLAYER', 'credit', p_amount, 'rakeback',
     'Rakeback payout (snapshot ' || p_snapshot_id::text || ', period ' || p_period_id::text || ')',
     p_snapshot_id, v_new_balance);
END;
$function$;

ALTER FUNCTION public.atomic_pay_player_rakeback(uuid, uuid, numeric, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.atomic_pay_player_rakeback(uuid, uuid, numeric, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.atomic_pay_player_rakeback(uuid, uuid, numeric, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_pay_player_rakeback(uuid, uuid, numeric, uuid, text) TO postgres, service_role;
