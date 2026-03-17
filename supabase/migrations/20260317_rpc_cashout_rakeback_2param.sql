-- ═══════════════════════════════════════════════════════════════════════════════
-- Fix: atomic_table_cashout and atomic_pay_player_rakeback signature alignment
-- Deploy Date: 2026-03-17
-- Status: OBSOLETE — App code was fixed to match existing DB signatures instead.
--         atomic_table_cashout now sends (p_table_id, p_user_id) matching DB.
--         DO NOT APPLY — these DROP FUNCTION statements would break live RPCs.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. atomic_table_cashout: Remove p_seat_number — look up seat internally
DROP FUNCTION IF EXISTS atomic_table_cashout(uuid, uuid, integer);
DROP FUNCTION IF EXISTS atomic_table_cashout(uuid, uuid);

CREATE OR REPLACE FUNCTION atomic_table_cashout(p_user_id uuid, p_table_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_stack NUMERIC;
BEGIN
    SELECT stack INTO v_stack FROM table_seats
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active seat not found for cash-out'; END IF;
    IF v_stack > 0 THEN
        INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, 'PLAYER', v_stack)
        ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW();
        INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id)
        VALUES (p_user_id, 'PLAYER', 'credit', v_stack, 'cashout', 'Cash-out from table', p_table_id);
    END IF;
    UPDATE table_seats SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    UPDATE tables SET current_players = (SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL)
    WHERE id = p_table_id;
    RETURN v_stack;
END; $$;

-- 2. atomic_pay_player_rakeback: Simplify to (p_user_id, p_amount)
DROP FUNCTION IF EXISTS atomic_pay_player_rakeback(uuid, uuid, numeric, uuid);
DROP FUNCTION IF EXISTS atomic_pay_player_rakeback(uuid, numeric);

CREATE OR REPLACE FUNCTION atomic_pay_player_rakeback(p_user_id uuid, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF p_amount <= 0 THEN RETURN; END IF;
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
    VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'rakeback', 'Rakeback payout');
END; $$;

-- 3. Helper: exec_sql for future remote SQL execution
CREATE OR REPLACE FUNCTION exec_sql(query text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN EXECUTE query; RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END; $$;
