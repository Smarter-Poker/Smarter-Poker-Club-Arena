-- ============================================================
-- FIX 132: Prevent duplicate seats at same table
--
-- Bible V8 §1.5 (Fairness Law): Every player receives equal treatment.
-- A player MUST NOT occupy two seats at the same table simultaneously.
--
-- This adds:
-- 1. A partial unique constraint on (table_id, user_id) WHERE left_at IS NULL
--    → Database-level enforcement, impossible to bypass
-- 2. An explicit duplicate check inside atomic_table_buyin
--    → Clear error message before INSERT fails
-- ============================================================

-- 1. Partial unique index: only one active seat per user per table
-- Uses WHERE left_at IS NULL to allow historical records (left seats)
CREATE UNIQUE INDEX IF NOT EXISTS idx_table_seats_one_active_per_user_per_table
  ON table_seats (table_id, user_id)
  WHERE left_at IS NULL;

-- 2. Update atomic_table_buyin to check for existing active seat
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
    -- FIX 132: Check if user already has an active seat at this table
    IF EXISTS (
        SELECT 1 FROM table_seats
        WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
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
