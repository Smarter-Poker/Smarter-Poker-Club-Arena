-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX 207/208/209: Comprehensive RPC overload cleanup + BBJ schema fixes
-- ═══════════════════════════════════════════════════════════════════════════════
-- ISSUES:
-- 1. atomic_table_cashout has duplicate overloads (uuid,uuid,int) AND (uuid,uuid)
--    causing PostgREST "text = uuid" ambiguity errors
-- 2. atomic_seat_horse has duplicate overloads causing same issue
-- 3. bbj_contributions.club_id NOT NULL constraint (should be nullable)
-- 4. bbj_record_contribution needs p_club_id parameter
-- 5. PostgREST schema cache needs reload after these changes
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Drop ALL overloads of atomic_table_cashout, recreate single clean version
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS atomic_table_cashout(uuid, uuid, integer);
DROP FUNCTION IF EXISTS atomic_table_cashout(uuid, uuid);

CREATE OR REPLACE FUNCTION atomic_table_cashout(
    p_user_id UUID,
    p_table_id UUID,
    p_seat_number INT DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_stack NUMERIC;
BEGIN
    -- Get active stack and lock row (seat_number optional)
    IF p_seat_number IS NOT NULL THEN
        SELECT stack INTO v_stack
        FROM table_seats
        WHERE table_id = p_table_id
          AND user_id = p_user_id
          AND seat_number = p_seat_number
          AND left_at IS NULL
        FOR UPDATE;
    ELSE
        SELECT stack INTO v_stack
        FROM table_seats
        WHERE table_id = p_table_id
          AND user_id = p_user_id
          AND left_at IS NULL
        FOR UPDATE;
    END IF;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active seat not found for cash-out';
    END IF;

    -- Credit chips to wallet
    IF v_stack > 0 THEN
        INSERT INTO wallets (user_id, wallet_type, balance)
        VALUES (p_user_id, 'PLAYER', v_stack)
        ON CONFLICT (user_id, wallet_type)
        DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW();

        INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id)
        VALUES (p_user_id, 'PLAYER', 'credit', v_stack, 'cashout', 'Cash-out from table', p_table_id);
    END IF;

    -- Soft-delete the seat
    UPDATE table_seats SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;

    -- Update table player count
    UPDATE tables SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    ) WHERE id = p_table_id;

    RETURN v_stack;
END;
$$;

GRANT EXECUTE ON FUNCTION atomic_table_cashout(UUID, UUID, INT) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Drop ALL overloads of atomic_seat_horse, recreate single clean version
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS atomic_seat_horse(uuid, uuid, integer, numeric, text, uuid);
DROP FUNCTION IF EXISTS atomic_seat_horse(uuid, uuid, int, numeric, text, uuid);

-- Recreate with clear signature
CREATE OR REPLACE FUNCTION atomic_seat_horse(
    p_horse_id UUID,
    p_table_id UUID,
    p_seat_number INT,
    p_buy_in NUMERIC,
    p_table_name TEXT DEFAULT '',
    p_club_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_balance NUMERIC;
BEGIN
    -- Check wallet balance
    SELECT balance INTO v_balance FROM wallets
    WHERE user_id = p_horse_id AND wallet_type = 'PLAYER'
    FOR UPDATE;

    IF v_balance IS NULL OR v_balance < p_buy_in THEN
        RETURN FALSE;
    END IF;

    -- Deduct from wallet
    UPDATE wallets SET balance = balance - p_buy_in, updated_at = NOW()
    WHERE user_id = p_horse_id AND wallet_type = 'PLAYER';

    -- Log wallet transaction
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
    VALUES (p_horse_id, 'PLAYER', 'debit', p_buy_in, 'buyin',
            'Buy-in at ' || COALESCE(p_table_name, 'table') || ': ' || p_buy_in || ' chips');

    -- Insert seat
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, status, joined_at)
    VALUES (p_table_id, p_horse_id, p_seat_number, p_buy_in, 'active', NOW());

    -- Update table player count
    UPDATE tables SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    ) WHERE id = p_table_id;

    RETURN TRUE;
EXCEPTION WHEN unique_violation THEN
    -- Duplicate seat — refund wallet
    UPDATE wallets SET balance = balance + p_buy_in, updated_at = NOW()
    WHERE user_id = p_horse_id AND wallet_type = 'PLAYER';
    RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION atomic_seat_horse(UUID, UUID, INT, NUMERIC, TEXT, UUID) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Ensure bbj_contributions.club_id is nullable
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE bbj_contributions ALTER COLUMN club_id DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Drop ALL overloads of bbj_record_contribution, recreate with p_club_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS bbj_record_contribution(uuid, uuid, uuid, decimal, decimal, decimal, decimal, decimal);
DROP FUNCTION IF EXISTS bbj_record_contribution(uuid, uuid, uuid, decimal, decimal, decimal, decimal, decimal, integer);
DROP FUNCTION IF EXISTS bbj_record_contribution(uuid, uuid, uuid, decimal, decimal, decimal, decimal, decimal, integer, uuid);

CREATE OR REPLACE FUNCTION bbj_record_contribution(
    p_pool_id UUID,
    p_hand_id UUID DEFAULT NULL,
    p_table_id UUID DEFAULT NULL,
    p_amount DECIMAL DEFAULT 0,
    p_main_portion DECIMAL DEFAULT 0,
    p_backup_portion DECIMAL DEFAULT 0,
    p_promo_portion DECIMAL DEFAULT 0,
    p_big_blind DECIMAL DEFAULT 2.00,
    p_hand_number INTEGER DEFAULT NULL,
    p_club_id UUID DEFAULT NULL
) RETURNS bbj_contributions AS $$
DECLARE
    v_contribution bbj_contributions;
BEGIN
    -- Update pool balances
    UPDATE bbj_pools
    SET
        main_balance = main_balance + p_main_portion,
        backup_balance = backup_balance + p_backup_portion,
        promo_balance = promo_balance + p_promo_portion,
        total_contributed = total_contributed + p_amount,
        updated_at = now()
    WHERE id = p_pool_id;

    -- Record contribution (includes club_id)
    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_club_id, p_amount,
        p_main_portion, p_backup_portion, p_promo_portion, p_big_blind, p_hand_number
    ) RETURNING * INTO v_contribution;

    RETURN v_contribution;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION bbj_record_contribution(UUID, UUID, UUID, DECIMAL, DECIMAL, DECIMAL, DECIMAL, DECIMAL, INTEGER, UUID) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: Ensure bbj_pools has all required columns (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE bbj_pools ADD COLUMN IF NOT EXISTS total_paid_out DECIMAL(15,2) NOT NULL DEFAULT 0.00;
ALTER TABLE bbj_pools ADD COLUMN IF NOT EXISTS hit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbj_pools ADD COLUMN IF NOT EXISTS last_hit_at TIMESTAMPTZ;
ALTER TABLE bbj_pools ADD COLUMN IF NOT EXISTS last_hit_amount DECIMAL(15,2);
ALTER TABLE bbj_pools ADD COLUMN IF NOT EXISTS last_winner_id UUID;
ALTER TABLE bbj_pools ADD COLUMN IF NOT EXISTS last_loser_id UUID;

-- ─────────────────────────────────────────────────────────────────────════════
-- STEP 6: Notify PostgREST to reload schema cache
-- ─────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
