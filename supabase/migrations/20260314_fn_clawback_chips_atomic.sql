-- ═══════════════════════════════════════════════════════════════════════════════
-- fn_clawback_chips_atomic — Phase 13 Fix (v2 — correct architecture)
-- 
-- Club balances are in club_members.chip_balance (NOT wallets table).
-- Agent promo balance is in agents.promo_balance.
-- This RPC atomically: 
--   1. Deducts from player's club_members.chip_balance
--   2. Credits agent's agents.promo_balance (returns to promo pool)
--   3. Handles partial clawback when player has insufficient balance
--   4. Logs the clawback transaction
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_clawback_chips_atomic(
    p_transaction_id UUID,
    p_club_id UUID,
    p_agent_id UUID,  -- This is auth.users.id of the agent
    p_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_player_id UUID;
    v_player_balance NUMERIC;
    v_actual_amount NUMERIC;
    v_is_partial BOOLEAN := FALSE;
    v_player_new_balance NUMERIC;
    v_agent_new_balance NUMERIC;
    v_agent_pk UUID;  -- agents table PK
BEGIN
    -- 1. Get the target player from the original transaction
    SELECT to_user_id INTO v_player_id
    FROM chip_transactions
    WHERE id = p_transaction_id AND club_id = p_club_id;

    IF v_player_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', FALSE,
            'error', 'Transaction not found'
        );
    END IF;

    -- 2. Get player's current club chip balance (lock row for update)
    SELECT COALESCE(chip_balance, 0) INTO v_player_balance
    FROM club_members
    WHERE user_id = v_player_id AND club_id = p_club_id
    FOR UPDATE;

    IF v_player_balance IS NULL THEN
        RETURN jsonb_build_object(
            'success', FALSE,
            'error', 'Player not found in club'
        );
    END IF;

    -- 3. Get agent PK from agents table (agent is identified by user_id + club_id)
    SELECT id INTO v_agent_pk
    FROM agents
    WHERE user_id = p_agent_id AND club_id = p_club_id;

    -- 4. Determine actual clawback amount (partial if insufficient balance)
    IF v_player_balance >= p_amount THEN
        v_actual_amount := p_amount;
    ELSIF v_player_balance > 0 THEN
        v_actual_amount := v_player_balance;
        v_is_partial := TRUE;
    ELSE
        RETURN jsonb_build_object(
            'success', FALSE,
            'partial', FALSE,
            'recovered', 0,
            'player_new_balance', 0,
            'error', 'Player has zero balance — nothing to recover'
        );
    END IF;

    -- 5. Deduct from player's club chip balance
    UPDATE club_members
    SET chip_balance = chip_balance - v_actual_amount
    WHERE user_id = v_player_id AND club_id = p_club_id;

    -- 6. Credit back to agent's promo wallet (if agent PK found)
    IF v_agent_pk IS NOT NULL THEN
        UPDATE agents
        SET promo_balance = promo_balance + v_actual_amount
        WHERE id = v_agent_pk;
    ELSE
        -- Fallback: credit to agent's club_members chip_balance
        UPDATE club_members
        SET chip_balance = chip_balance + v_actual_amount
        WHERE user_id = p_agent_id AND club_id = p_club_id;
    END IF;

    -- 7. Get new balances for response
    SELECT chip_balance INTO v_player_new_balance
    FROM club_members
    WHERE user_id = v_player_id AND club_id = p_club_id;

    IF v_agent_pk IS NOT NULL THEN
        SELECT promo_balance INTO v_agent_new_balance
        FROM agents
        WHERE id = v_agent_pk;
    ELSE
        SELECT chip_balance INTO v_agent_new_balance
        FROM club_members
        WHERE user_id = p_agent_id AND club_id = p_club_id;
    END IF;

    -- 8. Log the clawback transaction
    INSERT INTO chip_transactions (
        club_id, from_user_id, to_user_id, amount, transaction_type, notes
    ) VALUES (
        p_club_id,
        v_player_id,
        p_agent_id,
        v_actual_amount,
        'clawback',
        format('Clawback of txn %s — %s chips recovered', p_transaction_id::text, v_actual_amount)
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'partial', v_is_partial,
        'recovered', v_actual_amount,
        'player_new_balance', COALESCE(v_player_new_balance, 0),
        'agent_new_balance', COALESCE(v_agent_new_balance, 0)
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', FALSE,
        'error', SQLERRM
    );
END;
$$;
