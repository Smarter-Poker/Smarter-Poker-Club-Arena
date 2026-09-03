-- ═══════════════════════════════════════════════════════════════════════════════
--  Player Wallet Operations
--  Atomic deduct/credit functions for the wallets table (PLAYER type)
--  Used by tournament registration, cash game buy-ins, and transfers
-- ═══════════════════════════════════════════════════════════════════════════════

-- Deduct from Player wallet (returns FALSE if insufficient balance)
CREATE OR REPLACE FUNCTION deduct_player_wallet(
    p_user_id UUID,
    p_amount DECIMAL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_balance DECIMAL;
BEGIN
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

    UPDATE wallets
    SET balance = balance - p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

    RETURN TRUE;
END;
$$;

-- Credit to Player wallet (always succeeds if wallet exists)
CREATE OR REPLACE FUNCTION credit_player_wallet(
    p_user_id UUID,
    p_amount DECIMAL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE wallets
    SET balance = balance + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player wallet not found for user %', p_user_id;
    END IF;
END;
$$;

-- Grant execute to anon and authenticated roles
GRANT EXECUTE ON FUNCTION deduct_player_wallet(UUID, DECIMAL) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION credit_player_wallet(UUID, DECIMAL) TO anon, authenticated;
