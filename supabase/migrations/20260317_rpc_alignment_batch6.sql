-- ═══════════════════════════════════════════════════════════════════════════════
-- RPC Alignment Batch 6: Fix remaining call site ↔ function mismatches
-- Deploy Date: 2026-03-17
-- Status: OBSOLETE — App code was fixed to match existing DB signatures instead.
--         See commits: "fix: align remaining RPC call sites with live DB signatures"
--         DO NOT APPLY — these DROP FUNCTION statements would break live RPCs.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. wallet_internal_transfer: add optional p_note parameter
DROP FUNCTION IF EXISTS wallet_internal_transfer(uuid, text, text, numeric);
DROP FUNCTION IF EXISTS wallet_internal_transfer(uuid, text, text, numeric, text);

CREATE OR REPLACE FUNCTION wallet_internal_transfer(
  p_user_id uuid, p_from_wallet text, p_to_wallet text, p_amount numeric, p_note text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
    -- Deduct from source wallet
    UPDATE wallets SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = p_from_wallet AND balance >= p_amount;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    -- Credit destination wallet
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, p_to_wallet, p_amount)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    -- Log both transactions
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
    VALUES (p_user_id, p_from_wallet, 'debit', -p_amount, 'transfer', COALESCE(p_note, 'Internal wallet transfer'));
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
    VALUES (p_user_id, p_to_wallet, 'credit', p_amount, 'transfer', COALESCE(p_note, 'Internal wallet transfer'));
    RETURN TRUE;
END; $$;

-- 2. atomic_pay_agent_settlement: make p_period_id optional (3-param call from SettlementService)
DROP FUNCTION IF EXISTS atomic_pay_agent_settlement(uuid, uuid, numeric, uuid);
DROP FUNCTION IF EXISTS atomic_pay_agent_settlement(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION atomic_pay_agent_settlement(
  p_settlement_id uuid, p_agent_id uuid, p_amount numeric, p_period_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF p_amount <= 0 THEN RETURN; END IF;
    -- Credit agent wallet
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_agent_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    -- Log transaction
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, related_entity_id)
    VALUES (p_agent_id, 'PLAYER', 'credit', p_amount, 'settlement',
            'Agent commission settlement' || CASE WHEN p_period_id IS NOT NULL THEN ' for period ' || p_period_id::text ELSE '' END,
            p_settlement_id);
    -- Mark settlement as paid
    UPDATE commission_payouts SET status = 'paid', paid_at = NOW() WHERE id = p_settlement_id;
END; $$;

-- 3. credit_agent_commission: add optional p_club_id parameter
DROP FUNCTION IF EXISTS credit_agent_commission(uuid, numeric, uuid);
DROP FUNCTION IF EXISTS credit_agent_commission(uuid, numeric, uuid, uuid);

CREATE OR REPLACE FUNCTION credit_agent_commission(
  p_agent_id uuid, p_amount numeric, p_period_id uuid DEFAULT NULL, p_club_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF p_amount <= 0 THEN RETURN; END IF;
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_agent_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
    VALUES (p_agent_id, 'PLAYER', 'credit', p_amount, 'commission',
            'Agent commission' || CASE WHEN p_period_id IS NOT NULL THEN ' for period ' || p_period_id::text ELSE '' END);
END; $$;

-- 4. atomic_deduct_wallet_and_log: ensure it accepts 7 params as all call sites expect
DROP FUNCTION IF EXISTS atomic_deduct_wallet_and_log(uuid, numeric, text, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS atomic_deduct_wallet_and_log(uuid, numeric);

CREATE OR REPLACE FUNCTION atomic_deduct_wallet_and_log(
  p_user_id uuid, p_amount numeric,
  p_category text DEFAULT 'debit', p_description text DEFAULT '',
  p_table_id uuid DEFAULT NULL, p_hand_id uuid DEFAULT NULL, p_related_entity_id uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
    UPDATE wallets SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id, related_entity_id)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_amount, p_category, p_description, p_table_id, p_related_entity_id);
    RETURN TRUE;
END; $$;

-- 5. Also ensure atomic_credit_wallet_and_log exists (used by DisputeService)
DROP FUNCTION IF EXISTS atomic_credit_wallet_and_log(uuid, numeric, text, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS atomic_credit_wallet_and_log(uuid, numeric);

CREATE OR REPLACE FUNCTION atomic_credit_wallet_and_log(
  p_user_id uuid, p_amount numeric,
  p_category text DEFAULT 'credit', p_description text DEFAULT '',
  p_table_id uuid DEFAULT NULL, p_hand_id uuid DEFAULT NULL, p_related_entity_id uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id, related_entity_id)
    VALUES (p_user_id, 'PLAYER', 'credit', p_amount, p_category, p_description, p_table_id, p_related_entity_id);
    RETURN TRUE;
END; $$;
