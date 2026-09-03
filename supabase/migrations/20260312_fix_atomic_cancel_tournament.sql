-- ============================================================
-- V18 Audit Fix: Atomic Cancel Tournament Refund Bug
-- 
-- Description:
-- Fixes a bug where atomic_cancel_tournament was attempting
-- to insert into wallet_transactions with incorrect columns.
-- Now properly utilizes the centralized PERFORM log_wallet_transaction()
-- and explicitly credits the unified PLAYER wallet.
-- ============================================================

CREATE OR REPLACE FUNCTION atomic_cancel_tournament(
    p_tournament_id UUID,
    p_admin_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tournament RECORD;
    v_player RECORD;
    v_refund_amount NUMERIC;
    v_refunded_count INT := 0;
    v_total_refunded NUMERIC := 0;
BEGIN
    -- 1. Fetch tournament info & lock row
    SELECT * INTO v_tournament
    FROM tournaments
    WHERE id = p_tournament_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tournament not found';
    END IF;

    IF v_tournament.status IN ('completed', 'canceled', 'CANCELLED') THEN
        RAISE EXCEPTION 'Tournament is already %', v_tournament.status;
    END IF;

    -- Calculate total refund per player (buy-in + fee)
    v_refund_amount := COALESCE(v_tournament.buy_in_amount, 0) + COALESCE(v_tournament.buy_in_fee, 0);

    -- 2. Mark tournament as canceled FIRST to prevent new registrations
    UPDATE tournaments
    SET status = 'CANCELLED',
        canceled_at = NOW(),
        updated_at = NOW()
    WHERE id = p_tournament_id;

    -- 3. Iterate all registered players and refund atomically
    IF v_refund_amount > 0 THEN
        FOR v_player IN (SELECT user_id, id FROM tournament_players WHERE tournament_id = p_tournament_id)
        LOOP
            -- Refund the player's unified global wallet
            UPDATE wallets
            SET balance = balance + v_refund_amount,
                updated_at = NOW()
            WHERE user_id = v_player.user_id AND wallet_type = 'PLAYER';

            -- Log the transaction safely using the master logging function
            PERFORM log_wallet_transaction(
                v_player.user_id,
                'PLAYER',
                v_refund_amount,
                'credit',
                'refund',
                'Tournament cancellation refund: ' || COALESCE(v_tournament.name, 'Unknown'),
                NULL,
                NULL,
                p_tournament_id
            );

            v_refunded_count := v_refunded_count + 1;
            v_total_refunded := v_total_refunded + v_refund_amount;
        END LOOP;
    END IF;
    
    -- 4. Delete the player registrations
    DELETE FROM tournament_players WHERE tournament_id = p_tournament_id;
    
    -- 5. Close any active child tables
    UPDATE tables 
    SET status = 'closed', current_players = 0 
    WHERE tournament_id = p_tournament_id;

    RETURN jsonb_build_object(
        'success', true,
        'refunded_count', v_refunded_count,
        'total_refunded', v_total_refunded
    );
END;
$$;

GRANT EXECUTE ON FUNCTION atomic_cancel_tournament(UUID, UUID) TO anon, authenticated;
