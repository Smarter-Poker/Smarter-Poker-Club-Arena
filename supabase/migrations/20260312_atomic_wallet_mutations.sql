-- ============================================================
-- V23 Audit Fix: Atomic Ledger Mutations
-- 
-- Description:
-- Previously, TS code called `credit_player_wallet` or 
-- `deduct_player_wallet`, followed by a separate TS call 
-- to `WalletService.logTransaction`. 
-- If a node crashed between these two lines, chips were
-- created or destroyed without any ledger trail.
--
-- This migration provides fully atomic primitives that
-- MANDATE logging as part of the database transaction.
-- ============================================================

-- 1. ATOMIC CREDIT AND LOG
CREATE OR REPLACE FUNCTION atomic_credit_wallet_and_log(
    p_user_id UUID,
    p_amount NUMERIC,
    p_category TEXT,
    p_description TEXT,
    p_table_id UUID DEFAULT NULL,
    p_hand_id UUID DEFAULT NULL,
    p_related_entity_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Credit amount must be positive';
    END IF;

    -- Credit Wallet
    UPDATE wallets
    SET balance = balance + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

    IF NOT FOUND THEN
        -- Auto-create wallet if it doesn't exist
        INSERT INTO wallets (user_id, wallet_type, balance)
        VALUES (p_user_id, 'PLAYER', p_amount);
    END IF;

    -- Mandate Logging
    PERFORM log_wallet_transaction(
        p_user_id, 'PLAYER', p_amount, 'credit', p_category,
        p_description, p_table_id, p_hand_id, p_related_entity_id
    );
END;
$$;

-- 2. ATOMIC DEDUCT AND LOG
CREATE OR REPLACE FUNCTION atomic_deduct_wallet_and_log(
    p_user_id UUID,
    p_amount NUMERIC,
    p_category TEXT,
    p_description TEXT,
    p_table_id UUID DEFAULT NULL,
    p_hand_id UUID DEFAULT NULL,
    p_related_entity_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_balance NUMERIC;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Deduct amount must be positive';
    END IF;

    -- Lock the row and get current balance atomically
    SELECT balance INTO v_balance
    FROM wallets
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER'
    FOR UPDATE;

    IF v_balance IS NULL THEN
        RAISE EXCEPTION 'Player wallet not found for user %', p_user_id;
    END IF;

    IF v_balance < p_amount THEN
        RETURN FALSE;
    END IF;

    -- Deduct Wallet
    UPDATE wallets
    SET balance = balance - p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

    -- Mandate Logging
    PERFORM log_wallet_transaction(
        p_user_id, 'PLAYER', -p_amount, 'debit', p_category,
        p_description, p_table_id, p_hand_id, p_related_entity_id
    );

    RETURN TRUE;
END;
$$;
