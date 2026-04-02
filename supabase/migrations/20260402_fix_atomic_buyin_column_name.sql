-- FIX: atomic_table_buyin bugs:
-- 1. Referenced non-existent 'reference_id' column (should be 'table_id')
-- 2. Missing required 'wallet_type' column (NOT NULL constraint)
-- 3. Type mismatch: p_user_id is UUID but table_seats.user_id is text. Must cast.

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
    -- Check if user already has an active seat at this table
    IF EXISTS (
        SELECT 1 FROM table_seats
        WHERE table_id = p_table_id AND user_id = p_user_id::text AND left_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Player already seated at this table';
    END IF;

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

    -- C. Insert new active seat (unique index prevents duplicates at DB level)
    INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy)
    VALUES (p_table_id, p_seat_number, p_user_id::text, p_amount, 'active', p_auto_rebuy);

    -- D. Log transaction (FIXED: use 'table_id' not 'reference_id', include wallet_type)
    INSERT INTO wallet_transactions (
        user_id, wallet_type, type, amount, category, description, table_id
    ) VALUES (
        p_user_id, 'PLAYER', 'debit', -p_amount, 'buyin', 'Cash game buy-in at table', p_table_id
    );

    -- E. Increment active player count atomically
    UPDATE tables
    SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    )
    WHERE id = p_table_id;

END;
$$;
