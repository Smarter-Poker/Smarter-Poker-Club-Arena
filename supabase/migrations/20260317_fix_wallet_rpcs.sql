-- ═══════════════════════════════════════════════════════════════════════════════
-- Fix: Rewrite all RPCs that reference profiles.chip_balance → wallets.balance
-- The platform uses the `wallets` table (columns: user_id, wallet_type, balance)
-- NOT profiles.chip_balance (which doesn't exist).
-- Deploy Date: 2026-03-17
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. atomic_pay_agent_settlement — Credits agent wallet on settlement payout
CREATE OR REPLACE FUNCTION atomic_pay_agent_settlement(
  p_settlement_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_period_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- Get agent's auth user_id
  SELECT user_id INTO v_user_id FROM agents WHERE id = p_agent_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Agent not found';
  END IF;

  -- Credit agent's PLAYER wallet
  UPDATE wallets
  SET balance = COALESCE(balance, 0) + p_amount,
      updated_at = now()
  WHERE user_id = v_user_id AND wallet_type = 'PLAYER';

  -- If no wallet row existed, create one
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (v_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE
    SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;

  -- Log the transaction
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes, club_id)
  SELECT NULL, v_user_id, p_amount, 'settlement_payout',
    'Weekly agent commission settlement for period ' || p_period_id::text,
    a.club_id
  FROM agents a WHERE a.id = p_agent_id;

  -- Mark settlement as paid
  UPDATE agent_settlements
  SET status = 'paid', paid_at = now()
  WHERE id = p_settlement_id;
END;
$$;

-- 2. atomic_pay_player_rakeback — Credits player wallet on rakeback payout
CREATE OR REPLACE FUNCTION atomic_pay_player_rakeback(
  p_snapshot_id uuid,
  p_player_id uuid,
  p_amount numeric,
  p_period_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Credit player's PLAYER wallet
  UPDATE wallets
  SET balance = COALESCE(balance, 0) + p_amount,
      updated_at = now()
  WHERE user_id = p_player_id AND wallet_type = 'PLAYER';

  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_player_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE
    SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;

  -- Log the transaction
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (NULL, p_player_id, p_amount, 'rakeback_payout',
    'Weekly rakeback for period ' || p_period_id::text);

  -- Mark snapshot as paid
  UPDATE player_weekly_snapshots
  SET paid = true, paid_at = now()
  WHERE id = p_snapshot_id;
END;
$$;

-- 3. atomic_wallet_transfer — Wallet-to-wallet transfer (used by union settlement)
CREATE OR REPLACE FUNCTION atomic_wallet_transfer(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_category text DEFAULT 'transfer',
  p_debit_description text DEFAULT '',
  p_credit_description text DEFAULT '',
  p_related_entity_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_from_balance numeric;
BEGIN
  -- Lock and check sender balance
  SELECT balance INTO v_from_balance
  FROM wallets
  WHERE user_id = p_from_user_id AND wallet_type = 'PLAYER'
  FOR UPDATE;

  IF v_from_balance IS NULL OR v_from_balance < p_amount THEN
    RETURN false;
  END IF;

  -- Debit sender
  UPDATE wallets
  SET balance = balance - p_amount, updated_at = now()
  WHERE user_id = p_from_user_id AND wallet_type = 'PLAYER';

  -- Credit receiver
  UPDATE wallets
  SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_to_user_id AND wallet_type = 'PLAYER';

  -- If receiver wallet doesn't exist, create it
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_to_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE
    SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;

  -- Log debit transaction
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (p_from_user_id, p_to_user_id, p_amount, p_category,
    COALESCE(NULLIF(p_debit_description, ''), 'Wallet transfer'));

  RETURN true;
END;
$$;

-- 4. execute_commission_payout — Executes commission payout to agent
CREATE OR REPLACE FUNCTION execute_commission_payout(p_payout_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_payout record;
  v_user_id uuid;
BEGIN
  SELECT * INTO v_payout FROM commission_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payout not found: %', p_payout_id;
  END IF;

  SELECT user_id INTO v_user_id FROM agents WHERE id = v_payout.agent_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Agent not found for payout: %', v_payout.agent_id;
  END IF;

  -- Credit agent's PLAYER wallet
  UPDATE wallets
  SET balance = COALESCE(balance, 0) + v_payout.net_payout,
      updated_at = now()
  WHERE user_id = v_user_id AND wallet_type = 'PLAYER';

  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (v_user_id, 'PLAYER', v_payout.net_payout, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE
    SET balance = wallets.balance + v_payout.net_payout, updated_at = now();
  END IF;

  -- Log transaction
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (NULL, v_user_id, v_payout.net_payout, 'commission_payout',
    'Commission payout for period ' || v_payout.period_id::text);

  -- Mark paid
  UPDATE commission_payouts
  SET status = 'paid', paid_at = now()
  WHERE id = p_payout_id;
END;
$$;

-- 5. atomic_credit_wallet_and_log — Generic credit operation
CREATE OR REPLACE FUNCTION atomic_credit_wallet_and_log(
  p_user_id uuid,
  p_amount numeric,
  p_category text DEFAULT 'credit',
  p_description text DEFAULT '',
  p_table_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL,
  p_related_entity_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Credit PLAYER wallet
  UPDATE wallets
  SET balance = COALESCE(balance, 0) + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE
    SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;

  -- Log transaction
  INSERT INTO chip_transactions (to_user_id, amount, transaction_type, notes, table_id)
  VALUES (p_user_id, p_amount, p_category,
    COALESCE(NULLIF(p_description, ''), 'Wallet credit'),
    p_table_id);

  RETURN true;
END;
$$;

-- 6. atomic_deduct_wallet_and_log — Generic debit with balance check
CREATE OR REPLACE FUNCTION atomic_deduct_wallet_and_log(
  p_user_id uuid,
  p_amount numeric,
  p_category text DEFAULT 'debit',
  p_description text DEFAULT '',
  p_table_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL,
  p_related_entity_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_balance numeric;
BEGIN
  -- Lock and check balance
  SELECT balance INTO v_balance
  FROM wallets
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER'
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN false;
  END IF;

  -- Deduct
  UPDATE wallets
  SET balance = balance - p_amount, updated_at = now()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

  -- Log transaction
  INSERT INTO chip_transactions (from_user_id, amount, transaction_type, notes, table_id)
  VALUES (p_user_id, p_amount, p_category,
    COALESCE(NULLIF(p_description, ''), 'Wallet debit'),
    p_table_id);

  RETURN true;
END;
$$;

-- 7. wallet_user_transfer — User-to-user transfer
CREATE OR REPLACE FUNCTION wallet_user_transfer(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_from_wallet text DEFAULT 'PLAYER',
  p_to_wallet text DEFAULT 'PLAYER',
  p_reference_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_from_balance numeric;
BEGIN
  -- Lock and check sender balance
  SELECT balance INTO v_from_balance
  FROM wallets
  WHERE user_id = p_from_user_id AND wallet_type = p_from_wallet
  FOR UPDATE;

  IF v_from_balance IS NULL OR v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance for transfer';
  END IF;

  -- Debit sender
  UPDATE wallets
  SET balance = balance - p_amount, updated_at = now()
  WHERE user_id = p_from_user_id AND wallet_type = p_from_wallet;

  -- Credit receiver
  UPDATE wallets
  SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_to_user_id AND wallet_type = p_to_wallet;

  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_to_user_id, p_to_wallet, p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE
    SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;

  -- Log
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (p_from_user_id, p_to_user_id, p_amount, 'user_transfer',
    CASE WHEN p_reference_id IS NOT NULL
      THEN 'Transfer ref: ' || p_reference_id::text
      ELSE 'User-to-user transfer'
    END);
END;
$$;
