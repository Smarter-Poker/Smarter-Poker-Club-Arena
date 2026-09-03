-- ═══════════════════════════════════════════════════════════════════════════════
-- Fix: Rewrite all RPCs that reference profiles.chip_balance → wallets.balance
-- The platform uses the `wallets` table (columns: user_id, wallet_type, balance)
-- NOT profiles.chip_balance (which doesn't exist).
-- Also fixes: chip_transactions requires club_id (NOT NULL) and has no table_id column
-- Deploy Date: 2026-03-17
-- Status: APPLIED TO LIVE DB ✓
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. atomic_pay_agent_settlement — Credits agent wallet on settlement payout
CREATE OR REPLACE FUNCTION atomic_pay_agent_settlement(
  p_settlement_id uuid, p_agent_id uuid, p_amount numeric, p_period_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_user_id uuid; v_club_id uuid;
BEGIN
  SELECT user_id INTO v_user_id FROM agents WHERE id = p_agent_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Agent not found'; END IF;
  SELECT club_id INTO v_club_id FROM agents WHERE id = p_agent_id;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  UPDATE wallets SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = v_user_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance) VALUES (v_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;
  INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, NULL, v_user_id, p_amount, 'settlement_payout', 'Weekly agent commission settlement for period ' || p_period_id::text);
  UPDATE agent_settlements SET status = 'paid', paid_at = now() WHERE id = p_settlement_id;
END; $func$;

-- 2. atomic_pay_player_rakeback — Credits player wallet on rakeback payout
CREATE OR REPLACE FUNCTION atomic_pay_player_rakeback(
  p_snapshot_id uuid, p_player_id uuid, p_amount numeric, p_period_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_club_id uuid;
BEGIN
  UPDATE wallets SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_player_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance) VALUES (p_player_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;
  SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_player_id LIMIT 1;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, NULL, p_player_id, p_amount, 'rakeback_payout', 'Weekly rakeback for period ' || p_period_id::text);
  UPDATE player_weekly_snapshots SET paid = true, paid_at = now() WHERE id = p_snapshot_id;
END; $func$;

-- 3. atomic_wallet_transfer — Wallet-to-wallet transfer (used by union settlement)
CREATE OR REPLACE FUNCTION atomic_wallet_transfer(
  p_from_user_id uuid, p_to_user_id uuid, p_amount numeric,
  p_category text DEFAULT 'transfer', p_debit_description text DEFAULT '',
  p_credit_description text DEFAULT '', p_related_entity_id uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_from_balance numeric; v_club_id uuid;
BEGIN
  SELECT balance INTO v_from_balance FROM wallets WHERE user_id = p_from_user_id AND wallet_type = 'PLAYER' FOR UPDATE;
  IF v_from_balance IS NULL OR v_from_balance < p_amount THEN RETURN false; END IF;
  UPDATE wallets SET balance = balance - p_amount, updated_at = now() WHERE user_id = p_from_user_id AND wallet_type = 'PLAYER';
  UPDATE wallets SET balance = COALESCE(balance, 0) + p_amount, updated_at = now() WHERE user_id = p_to_user_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance) VALUES (p_to_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;
  SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_from_user_id LIMIT 1;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, p_from_user_id, p_to_user_id, p_amount, p_category, COALESCE(NULLIF(p_debit_description, ''), 'Wallet transfer'));
  RETURN true;
END; $func$;

-- 4. execute_commission_payout — Executes commission payout to agent
CREATE OR REPLACE FUNCTION execute_commission_payout(p_payout_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_payout record; v_user_id uuid; v_club_id uuid;
BEGIN
  SELECT * INTO v_payout FROM commission_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission payout not found: %', p_payout_id; END IF;
  SELECT user_id INTO v_user_id FROM agents WHERE id = v_payout.agent_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Agent not found for payout: %', v_payout.agent_id; END IF;
  SELECT club_id INTO v_club_id FROM agents WHERE id = v_payout.agent_id;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  UPDATE wallets SET balance = COALESCE(balance, 0) + v_payout.net_payout, updated_at = now()
  WHERE user_id = v_user_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance) VALUES (v_user_id, 'PLAYER', v_payout.net_payout, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + v_payout.net_payout, updated_at = now();
  END IF;
  INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, NULL, v_user_id, v_payout.net_payout, 'commission_payout', 'Commission payout for period ' || v_payout.period_id::text);
  UPDATE commission_payouts SET status = 'paid', paid_at = now() WHERE id = p_payout_id;
END; $func$;

-- 5. atomic_credit_wallet_and_log — Generic credit operation
-- NOTE: Keeps p_table_id param name for backward compat with app code; resolves club_id from tables
CREATE OR REPLACE FUNCTION atomic_credit_wallet_and_log(
  p_user_id uuid, p_amount numeric, p_category text DEFAULT 'credit',
  p_description text DEFAULT '', p_table_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL, p_related_entity_id uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_club_id uuid;
BEGIN
  UPDATE wallets SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;
  IF p_table_id IS NOT NULL THEN SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id; END IF;
  IF v_club_id IS NULL THEN SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_user_id LIMIT 1; END IF;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, p_user_id, p_amount, p_category, COALESCE(NULLIF(p_description, ''), 'Wallet credit'));
  RETURN true;
END; $func$;

-- 6. atomic_deduct_wallet_and_log — Generic debit with balance check
-- NOTE: Keeps p_table_id param name for backward compat with app code; resolves club_id from tables
CREATE OR REPLACE FUNCTION atomic_deduct_wallet_and_log(
  p_user_id uuid, p_amount numeric, p_category text DEFAULT 'debit',
  p_description text DEFAULT '', p_table_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL, p_related_entity_id uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_balance numeric; v_club_id uuid;
BEGIN
  SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id AND wallet_type = 'PLAYER' FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN RETURN false; END IF;
  UPDATE wallets SET balance = balance - p_amount, updated_at = now()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  IF p_table_id IS NOT NULL THEN SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id; END IF;
  IF v_club_id IS NULL THEN SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_user_id LIMIT 1; END IF;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  INSERT INTO chip_transactions (club_id, from_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, p_user_id, p_amount, p_category, COALESCE(NULLIF(p_description, ''), 'Wallet debit'));
  RETURN true;
END; $func$;

-- 7. wallet_user_transfer — User-to-user transfer
CREATE OR REPLACE FUNCTION wallet_user_transfer(
  p_from_user_id uuid, p_to_user_id uuid, p_amount numeric,
  p_from_wallet text DEFAULT 'PLAYER', p_to_wallet text DEFAULT 'PLAYER',
  p_reference_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_from_balance numeric; v_club_id uuid;
BEGIN
  SELECT balance INTO v_from_balance FROM wallets WHERE user_id = p_from_user_id AND wallet_type = p_from_wallet FOR UPDATE;
  IF v_from_balance IS NULL OR v_from_balance < p_amount THEN RAISE EXCEPTION 'Insufficient balance for transfer'; END IF;
  UPDATE wallets SET balance = balance - p_amount, updated_at = now() WHERE user_id = p_from_user_id AND wallet_type = p_from_wallet;
  UPDATE wallets SET balance = COALESCE(balance, 0) + p_amount, updated_at = now() WHERE user_id = p_to_user_id AND wallet_type = p_to_wallet;
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance) VALUES (p_to_user_id, p_to_wallet, p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;
  SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_from_user_id LIMIT 1;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, p_from_user_id, p_to_user_id, p_amount, 'user_transfer',
    CASE WHEN p_reference_id IS NOT NULL THEN 'Transfer ref: ' || p_reference_id::text ELSE 'User-to-user transfer' END);
END; $func$;
