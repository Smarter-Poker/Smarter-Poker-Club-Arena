-- 20260724g_rakeback_credit_idempotency.sql
-- RAKE-AUDIT 2026-07-24 [money] P1: make the PLAYER rakeback credit RPCs
-- idempotent, backward-compatibly, via an optional p_idempotency_key (mirrors
-- credit_player_wallet in 20260724e). A committed-but-timed-out RPC that a
-- caller retries can no longer double-credit a real-money wallet. Existing
-- callers omit the key -> key = NULL -> behaviour EXACTLY as before.
-- Reuses the wallet_credit_idempotency dedup table from 20260724e.
--
-- Agent commission (credit_agent_commission_from_rake) is ALREADY idempotent
-- (dedupes on (user_id, source_id, source_type) and only bumps agents.* on the
-- first insert), so it is intentionally left unchanged.

-- ── credit_player_rakeback: 3-arg -> 4-arg (optional key) ────────────────────
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

  -- Idempotency gate: only engaged when a key is supplied. First caller wins;
  -- a later call with the same key is a no-op (returns false = not credited now).
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

-- ── atomic_pay_player_rakeback (period variant): 4-arg -> 5-arg (optional key) ─
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
    IF v_inserted = 0 THEN RETURN; END IF;  -- already paid under this key
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
