-- ============================================================
-- V22 Audit Fix: Atomic Table Buy-in and Cash-out
-- 
-- Description:
-- Previously, buying into a table or cashing out involved multiple
-- sequential RPC and REST calls from the TS client. (e.g. deduct wallet ->
-- insert seat). If the client disconnected midway, chips would be 
-- permanently lost or duplicated.
--
-- This migration provides fully atomic RPCs for `TablePage`, `TableService`,
-- and `AutoRebuyService` to ensure 100% financial integrity.
-- ============================================================

-- 1. ATOMIC BUY IN (Used by TablePage.tsx and HeadlessTableEngine)
-- Deducts wallet, sets table seat, and updates table player count.
CREATE OR REPLACE FUNCTION atomic_table_buyin(
    p_user_id UUID,
    p_table_id UUID,
    p_seat_number INT,
    p_amount NUMERIC,
    p_auto_rebuy BOOLEAN DEFAULT FALSE
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    -- A. Deduct from Player Wallet
    UPDATE wallets 
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient balance for buy-in';
    END IF;

    -- B. Clear stale seat record (if they previously sat here and left)
    DELETE FROM table_seats 
    WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

    -- C. Insert new active seat
    INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy)
    VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy);

    -- D. Log transaction
    INSERT INTO wallet_transactions (
        user_id, type, amount, category, description, reference_id
    ) VALUES (
        p_user_id, 'debit', -p_amount, 'buyin', 'Cash game buy-in at table', p_table_id
    );

    -- E. Increment active player count atomically
    UPDATE tables 
    SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    )
    WHERE id = p_table_id;

END;
$$;

-- 2. ATOMIC CASH OUT / LEAVE (Used by TableService.leaveTable)
-- Retrieves stack, credits wallet, marks seat as left, and updates table count.
CREATE OR REPLACE FUNCTION atomic_table_cashout(
    p_user_id UUID,
    p_table_id UUID,
    p_seat_number INT
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_stack NUMERIC;
BEGIN
    -- A. Get active stack and lock row
    SELECT stack INTO v_stack
    FROM table_seats
    WHERE table_id = p_table_id 
      AND user_id = p_user_id 
      AND seat_number = p_seat_number 
      AND left_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active seat not found for cash-out';
    END IF;

    -- B. If there are chips, credit them to the player's wallet
    IF v_stack > 0 THEN
        INSERT INTO wallets (user_id, wallet_type, balance)
        VALUES (p_user_id, 'PLAYER', v_stack)
        ON CONFLICT (user_id, wallet_type) 
        DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW();

        -- Log transaction
        INSERT INTO wallet_transactions (
            user_id, type, amount, category, description, reference_id
        ) VALUES (
            p_user_id, 'credit', v_stack, 'cashout', 'Cash-out from table', p_table_id
        );
    END IF;

    -- C. Soft-delete the seat (mark as left)
    UPDATE table_seats 
    SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND seat_number = p_seat_number AND left_at IS NULL;

    -- D. Update table player count atomically
    UPDATE tables 
    SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    )
    WHERE id = p_table_id;

    RETURN v_stack;
END;
$$;

-- 3. ATOMIC AUTO-REBUY (Used by AutoRebuyService.rebuyHorse)
-- Deducts wallet, adds directly to existing active seat stack.
CREATE OR REPLACE FUNCTION atomic_table_rebuy(
    p_user_id UUID,
    p_table_id UUID,
    p_amount NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_seat_exists BOOLEAN;
BEGIN
    -- A. Verify seat exists and is active FIRST
    SELECT EXISTS (
        SELECT 1 FROM table_seats 
        WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
    ) INTO v_seat_exists;

    IF NOT v_seat_exists THEN
        RAISE EXCEPTION 'Active seat not found for auto-rebuy';
    END IF;

    -- B. Deduct from Player Wallet
    UPDATE wallets 
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient balance for auto-rebuy';
    END IF;

    -- C. Update seat stack directly
    UPDATE table_seats
    SET stack = stack + p_amount
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;

    -- D. Log transaction
    INSERT INTO wallet_transactions (
        user_id, type, amount, category, description, reference_id
    ) VALUES (
        p_user_id, 'debit', -p_amount, 'rebuy', 'Auto-rebuy topup at table', p_table_id
    );

END;
$$;

GRANT EXECUTE ON FUNCTION atomic_table_buyin(UUID, UUID, INT, NUMERIC, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION atomic_table_cashout(UUID, UUID, INT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION atomic_table_rebuy(UUID, UUID, NUMERIC) TO anon, authenticated;
