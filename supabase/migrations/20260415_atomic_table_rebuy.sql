-- ============================================================
-- REBUY ON BUST (Dan 2026-04-14 feedback):
-- When a cash-game player busts out (stack = 0) they should be
-- offered a rebuy instead of being booted. This RPC:
--   1. Verifies the user still holds an active seat at the table
--   2. Verifies wallet has the requested amount
--   3. Atomically: wallet -= amount, table_seats.stack += amount
--   4. Logs wallet_transactions entry
-- Bible V8 §1.9 (Settlement Law): server is the sole authority for
-- chip movement between wallet and seat.
-- ============================================================

CREATE OR REPLACE FUNCTION atomic_table_rebuy(
    p_user_id UUID,
    p_table_id UUID,
    p_amount NUMERIC
) RETURNS TABLE(new_stack NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_seat_number INT;
    v_new_stack NUMERIC;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Rebuy amount must be positive';
    END IF;

    -- 1. Look up the user's active seat at this table
    SELECT seat_number INTO v_seat_number
    FROM table_seats
    WHERE table_id = p_table_id
      AND user_id = p_user_id
      AND left_at IS NULL
    LIMIT 1;

    IF v_seat_number IS NULL THEN
        RAISE EXCEPTION 'Player has no active seat at this table to rebuy into';
    END IF;

    -- 2. Deduct from wallet (atomic — will raise if insufficient)
    UPDATE wallets
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id
      AND wallet_type = 'PLAYER'
      AND balance >= p_amount;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient wallet balance for rebuy';
    END IF;

    -- 3. Top up the seat stack
    UPDATE table_seats
    SET stack = stack + p_amount, updated_at = NOW()
    WHERE table_id = p_table_id
      AND user_id = p_user_id
      AND left_at IS NULL
    RETURNING stack INTO v_new_stack;

    -- 4. Log the transaction
    INSERT INTO wallet_transactions (
        user_id, type, amount, category, description, reference_id
    ) VALUES (
        p_user_id, 'debit', -p_amount, 'rebuy',
        'Cash game rebuy at table', p_table_id
    );

    RETURN QUERY SELECT v_new_stack;
END;
$$;

GRANT EXECUTE ON FUNCTION atomic_table_rebuy(UUID, UUID, NUMERIC) TO authenticated, anon, service_role;
