-- ═══════════════════════════════════════════════════════════════════════════════
-- CREATE: player_leave_table RPC for sendBeacon tab-close cleanup
-- Deploy Date: 2026-03-17
--
-- CRITICAL FIX: The frontend sendBeacon (beforeunload) calls this RPC when
-- a player closes their browser tab while seated. Without this function,
-- seats become zombies — chips locked, seat unrecoverable.
--
-- This is a lightweight wrapper that looks up the player's seat internally
-- (sendBeacon cannot pass seat_number) and performs atomic cashout.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop any stale signatures
DROP FUNCTION IF EXISTS player_leave_table(uuid, uuid);

CREATE OR REPLACE FUNCTION player_leave_table(p_table_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_seat_number INTEGER;
    v_stack NUMERIC;
    v_tournament_id UUID;
BEGIN
    -- 1. Find the player's active seat at this table
    SELECT seat_number, stack INTO v_seat_number, v_stack
    FROM table_seats
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        -- Player is not seated — nothing to do (idempotent)
        RETURN;
    END IF;

    -- 2. Check if this is a tournament table (no chip refund for tournaments)
    SELECT tournament_id INTO v_tournament_id
    FROM tables WHERE id = p_table_id;

    -- 3. Return chips to wallet for cash games only
    IF v_tournament_id IS NULL AND v_stack > 0 THEN
        INSERT INTO wallets (user_id, wallet_type, balance)
        VALUES (p_user_id, 'PLAYER', v_stack)
        ON CONFLICT (user_id, wallet_type)
        DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW();

        INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id)
        VALUES (p_user_id, 'PLAYER', 'credit', v_stack, 'cashout', 'Tab-close auto-cashout', p_table_id);
    END IF;

    -- 4. Soft-delete the seat
    UPDATE table_seats
    SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;

    -- 5. Update table player count
    UPDATE tables
    SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    )
    WHERE id = p_table_id;
END;
$$;

-- Grant access to anon (sendBeacon uses anon key) and authenticated
GRANT EXECUTE ON FUNCTION player_leave_table(uuid, uuid) TO anon, authenticated;

DO $$ BEGIN
    RAISE NOTICE '✅ player_leave_table RPC created — tab-close cleanup now functional';
END $$;
