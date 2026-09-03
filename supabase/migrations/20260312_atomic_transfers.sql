-- ============================================================
-- V24 Audit Fix: Atomic User Transfers
-- 
-- Description:
-- Replaces JS-driven dual RPC logic (debit + credit + rollback) 
-- with a single, true atomic transfer in SQL.
-- Also replaces the broken `wallet_user_transfer` from earlier
-- phases which lacked `wallet_type` logic.
-- ============================================================

CREATE OR REPLACE FUNCTION atomic_wallet_transfer(
    p_from_user_id UUID,
    p_to_user_id UUID,
    p_amount NUMERIC,
    p_category TEXT,
    p_debit_description TEXT,
    p_credit_description TEXT,
    p_related_entity_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sender_balance NUMERIC;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Transfer amount must be positive';
    END IF;

    -- 1. Lock Sender Wallet
    SELECT balance INTO v_sender_balance
    FROM wallets
    WHERE user_id = p_from_user_id AND wallet_type = 'PLAYER'
    FOR UPDATE;

    IF v_sender_balance IS NULL OR v_sender_balance < p_amount THEN
        RETURN FALSE;
    END IF;

    -- 2. Deduct from Sender
    UPDATE wallets
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_from_user_id AND wallet_type = 'PLAYER';

    -- 3. Credit Receiver (Upsert)
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_to_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();

    -- 4. Log Sender Debit
    PERFORM log_wallet_transaction(
        p_from_user_id, 'PLAYER', -p_amount, 'debit', p_category,
        p_debit_description, NULL, NULL, p_related_entity_id
    );

    -- 5. Log Receiver Credit
    PERFORM log_wallet_transaction(
        p_to_user_id, 'PLAYER', p_amount, 'credit', p_category,
        p_credit_description, NULL, NULL, p_related_entity_id
    );

    RETURN TRUE;
END;
$$;
