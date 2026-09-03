-- ═══════════════════════════════════════════════════════════════════════════════
-- 🐴 ATOMIC HORSE SEATING
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Safely deducting wallet, logging transaction, and sitting horse in one atomic
-- transaction to prevent phantom wallet deductions if the node server crashes mid-seat.
-- 
-- Created: 2026-03-13
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION atomic_seat_horse(
    p_table_id UUID,
    p_horse_id UUID,
    p_seat_number INTEGER,
    p_buy_in DECIMAL,
    p_table_name TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_balance DECIMAL;
BEGIN
    -- 1. Deduct wallet atomically
    SELECT balance INTO v_balance
    FROM wallets
    WHERE user_id = p_horse_id AND wallet_type = 'PLAYER'
    FOR UPDATE;

    IF v_balance IS NULL OR v_balance < p_buy_in THEN
        RETURN FALSE; -- Insufficient funds
    END IF;

    UPDATE wallets
    SET balance = balance - p_buy_in,
        updated_at = NOW()
    WHERE user_id = p_horse_id AND wallet_type = 'PLAYER';

    -- 2. Log transaction
    INSERT INTO wallet_transactions (
        user_id, wallet_type, amount, type, category, description
    ) VALUES (
        p_horse_id, 'PLAYER', p_buy_in, 'debit', 'buyin', 'Buy-in at ' || p_table_name || ': ' || p_buy_in || ' chips'
    );

    -- 3. Insert seat (will throw error and rollback if seat is taken due to unique constraint)
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, status, joined_at)
    VALUES (p_table_id, p_horse_id, p_seat_number, p_buy_in, 'active', NOW());

    -- 4. Update horse status
    UPDATE profiles 
    SET horse_status = 'seated', 
        updated_at = NOW()
    WHERE id = p_horse_id;
    
    -- 5. Hard-sync the tables current_players count to trigger Realtime UI updates
    UPDATE tables
    SET current_players = (
        SELECT COUNT(*)
        FROM table_seats
        WHERE table_id = p_table_id AND status IN ('active', 'sitting_out') AND left_at IS NULL
    )
    WHERE id = p_table_id;

    RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION atomic_seat_horse(UUID, UUID, INTEGER, DECIMAL, TEXT) TO anon, authenticated;
