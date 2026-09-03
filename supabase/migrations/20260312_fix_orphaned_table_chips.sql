-- ============================================================
-- V15 Audit Fix: Orphaned Table Chips (Table Closure / Server Crash)
-- 
-- Description:
-- When a table is closed (e.g. by an admin, or due to a crash cleanup),
-- the system previously just updated the table status to 'closed'. 
-- All chips sitting in the `table_seats` stack were permanently trapped.
-- 
-- This RPC safely loops over all active seats at a table, refunds
-- their chips back to the `player_wallets`, logs the transaction, 
-- and then marks the seat as left.
-- ============================================================

CREATE OR REPLACE FUNCTION force_close_table_and_refund(p_table_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_seat RECORD;
    v_refunded_count INTEGER := 0;
    v_total_refunded NUMERIC := 0;
    v_club_id UUID;
BEGIN
    -- 1. Get the club ID for logging
    SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;

    IF v_club_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Table not found');
    END IF;

    -- 2. Loop through every active seat at the table
    FOR v_seat IN 
        SELECT id, user_id, stack 
        FROM table_seats 
        WHERE table_id = p_table_id AND left_at IS NULL
    LOOP
        -- 3. If they have chips, refund them to the wallet
        IF v_seat.stack > 0 THEN
            PERFORM credit_player_wallet(v_seat.user_id, v_seat.stack);
            
            -- Log the transaction
            PERFORM log_wallet_transaction(
                v_seat.user_id, 
                'PLAYER', 
                v_seat.stack, 
                'credit', 
                'cashout', 
                'Forced table closure refund', 
                p_table_id, 
                NULL, 
                v_club_id
            );
            
            v_total_refunded := v_total_refunded + v_seat.stack;
        END IF;

        -- 4. Mark the seat as formally left
        UPDATE table_seats 
        SET left_at = NOW(),
            status = 'left',
            updated_at = NOW()
        WHERE id = v_seat.id;

        v_refunded_count := v_refunded_count + 1;
    END LOOP;

    -- 5. Mark table as closed and update player count
    UPDATE tables 
    SET status = 'closed',
        current_players = 0,
        updated_at = NOW()
    WHERE id = p_table_id;

    RETURN jsonb_build_object(
        'success', true,
        'table_id', p_table_id,
        'seats_cleared', v_refunded_count,
        'total_chips_refunded', v_total_refunded
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
