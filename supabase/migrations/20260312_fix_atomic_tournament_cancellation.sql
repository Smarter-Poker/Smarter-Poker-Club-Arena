-- 20260312_fix_atomic_tournament_cancellation.sql
-- Fixes a catastrophic risk where tournament cancellations were iterating players in Node.js,
-- risking partial-refunds and zombie tournaments if the server crashed mid-loop.

CREATE OR REPLACE FUNCTION atomic_cancel_tournament(
    p_tournament_id UUID,
    p_admin_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
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

    IF v_tournament.status IN ('completed', 'canceled') THEN
        RAISE EXCEPTION 'Tournament is already %', v_tournament.status;
    END IF;

    -- Calculate total refund per player (buy-in + fee)
    v_refund_amount := COALESCE(v_tournament.buy_in_amount, 0) + COALESCE(v_tournament.buy_in_fee, 0);

    -- 2. Mark tournament as canceled FIRST to prevent new registrations
    UPDATE tournaments
    SET status = 'canceled',
        updated_at = NOW()
    WHERE id = p_tournament_id;

    -- 3. Iterate all registered players and refund atomically
    IF v_refund_amount > 0 THEN
        FOR v_player IN (SELECT user_id, id FROM tournament_players WHERE tournament_id = p_tournament_id)
        LOOP
            -- Refund the player wallet
            UPDATE player_wallets
            SET balance = balance + v_refund_amount,
                updated_at = NOW()
            WHERE user_id = v_player.user_id AND club_id = v_tournament.club_id;

            -- Log the transaction
            INSERT INTO wallet_transactions (
                user_id, club_id, amount, type, description
            ) VALUES (
                v_player.user_id,
                v_tournament.club_id,
                v_refund_amount,
                'refund',
                'Tournament cancellation refund: ' || v_tournament.name
            );

            v_refunded_count := v_refunded_count + 1;
            v_total_refunded := v_total_refunded + v_refund_amount;
        END LOOP;
    END IF;
    
    -- 4. Delete the player registrations (or mark them canceled)
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
