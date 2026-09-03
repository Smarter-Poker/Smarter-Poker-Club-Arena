-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: Consistent wallet_transactions sign convention and wallet_type across RPCs
-- ═══════════════════════════════════════════════════════════════════════════════
-- BUG-9: atomic_seat_horse stored debit amounts as POSITIVE while
-- atomic_table_buyin/rebuy stored them as NEGATIVE. This corrupted the
-- get_wallet_balance_totals() canary check used by SettlementCronService.
-- Also: all 3 atomic RPCs (buyin/cashout/rebuy) omitted wallet_type column.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. FIX atomic_seat_horse: use NEGATIVE amount for debits + ensure columns match
CREATE OR REPLACE FUNCTION atomic_seat_horse(
    p_horse_id UUID,
    p_table_id UUID,
    p_table_name TEXT,
    p_seat_number INT,
    p_buy_in NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    -- 1. Deduct from horse wallet
    UPDATE wallets
    SET balance = balance - p_buy_in, updated_at = NOW()
    WHERE user_id = p_horse_id AND wallet_type = 'PLAYER' AND balance >= p_buy_in;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient horse wallet balance';
    END IF;

    -- 2. Log transaction (NEGATIVE amount for debits — matches buyin/rebuy convention)
    INSERT INTO wallet_transactions (
        user_id, wallet_type, amount, type, category, description, reference_id
    ) VALUES (
        p_horse_id, 'PLAYER', -p_buy_in, 'debit', 'buyin',
        'Buy-in at ' || p_table_name || ': ' || p_buy_in || ' chips', p_table_id
    );

    -- 3. Insert seat
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, status, joined_at)
    VALUES (p_table_id, p_horse_id, p_seat_number, p_buy_in, 'active', NOW());

    -- 4. Update table player count
    UPDATE tables
    SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    )
    WHERE id = p_table_id;
END;
$$;

-- 2. FIX atomic_table_buyin: add wallet_type to transaction log
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

    -- B. Clear stale seat record
    DELETE FROM table_seats 
    WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

    -- C. Insert new active seat
    INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy)
    VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy);

    -- D. Log transaction (with wallet_type for data integrity)
    INSERT INTO wallet_transactions (
        user_id, wallet_type, type, amount, category, description, reference_id
    ) VALUES (
        p_user_id, 'PLAYER', 'debit', -p_amount, 'buyin', 'Cash game buy-in at table', p_table_id
    );

    -- E. Update player count
    UPDATE tables 
    SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    )
    WHERE id = p_table_id;
END;
$$;

-- 3. FIX atomic_table_cashout: add wallet_type to transaction log
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

    -- B. Credit wallet
    IF v_stack > 0 THEN
        INSERT INTO wallets (user_id, wallet_type, balance)
        VALUES (p_user_id, 'PLAYER', v_stack)
        ON CONFLICT (user_id, wallet_type) 
        DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW();

        -- Log transaction (with wallet_type)
        INSERT INTO wallet_transactions (
            user_id, wallet_type, type, amount, category, description, reference_id
        ) VALUES (
            p_user_id, 'PLAYER', 'credit', v_stack, 'cashout', 'Cash-out from table', p_table_id
        );
    END IF;

    -- C. Soft-delete the seat
    UPDATE table_seats 
    SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND seat_number = p_seat_number AND left_at IS NULL;

    -- D. Update table player count
    UPDATE tables 
    SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    )
    WHERE id = p_table_id;

    RETURN v_stack;
END;
$$;

-- 4. FIX atomic_table_rebuy: add wallet_type to transaction log
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
    -- A. Verify seat exists
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

    -- C. Update seat stack
    UPDATE table_seats
    SET stack = stack + p_amount
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;

    -- D. Log transaction (with wallet_type)
    INSERT INTO wallet_transactions (
        user_id, wallet_type, type, amount, category, description, reference_id
    ) VALUES (
        p_user_id, 'PLAYER', 'debit', -p_amount, 'rebuy', 'Auto-rebuy topup at table', p_table_id
    );
END;
$$;

-- 5. BACKFILL: Set wallet_type='PLAYER' for all NULL wallet_type transactions
-- These were created by the old RPCs before this fix
UPDATE wallet_transactions
SET wallet_type = 'PLAYER'
WHERE wallet_type IS NULL
  AND category IN ('buyin', 'cashout', 'rebuy');

DO $$ BEGIN
    RAISE NOTICE '💰 BUG-9 FIX: Consistent sign convention and wallet_type across all atomic RPCs';
END $$;
