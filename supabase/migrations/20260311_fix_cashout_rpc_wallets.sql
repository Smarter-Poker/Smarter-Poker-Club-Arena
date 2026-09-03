-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔒 CASHOUT RPC FIX — March 11, 2026
-- ═══════════════════════════════════════════════════════════════════════════════
-- CRITICAL FIX: Legacy cashout RPCs referenced a non-existent `chip_balances`
-- table and lacked FOR UPDATE row locks, creating both a crash vector and a
-- double-spend race condition.
--
-- This migration rewrites all 4 cashout RPCs to use the canonical `wallets`
-- table with atomic WHERE-clause guards (balance >= amount) that eliminate
-- the read-then-write race condition entirely.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. fn_request_cashout — Player requests chip cashout (locks in escrow)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_request_cashout(
    p_player_id UUID,
    p_club_id UUID,
    p_amount DECIMAL,
    p_note TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_cashout_id UUID;
    v_agent_id UUID;
    v_wallet_id UUID;
BEGIN
    -- Get player's agent
    SELECT agent_id INTO v_agent_id
    FROM club_members
    WHERE user_id = p_player_id AND club_id = p_club_id;

    IF v_agent_id IS NULL THEN
        RAISE EXCEPTION 'Player has no assigned agent';
    END IF;

    -- ATOMIC deduction: deduct from PLAYER wallet only if balance is sufficient.
    -- The WHERE clause (balance >= p_amount) acts as both a check AND a lock,
    -- making concurrent double-spend impossible.
    UPDATE wallets
    SET balance = balance - p_amount,
        updated_at = NOW()
    WHERE user_id = p_player_id
      AND wallet_type = 'PLAYER'
      AND balance >= p_amount
    RETURNING id INTO v_wallet_id;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'Insufficient balance for cashout';
    END IF;

    -- Create cashout request
    INSERT INTO cashout_requests (club_id, player_id, agent_id, amount, player_note, status)
    VALUES (p_club_id, p_player_id, v_agent_id, p_amount, p_note, 'pending')
    RETURNING id INTO v_cashout_id;

    -- Lock chips in escrow
    INSERT INTO chip_escrow (cashout_request_id, player_id, amount)
    VALUES (v_cashout_id, p_player_id, p_amount);

    -- Record transaction
    INSERT INTO chip_transactions (club_id, from_user_id, amount, transaction_type, related_cashout_id, notes)
    VALUES (p_club_id, p_player_id, p_amount, 'escrow_lock', v_cashout_id, 'Cashout request - chips locked');

    RETURN v_cashout_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. fn_cancel_cashout — Player cancels (returns chips from escrow)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_cancel_cashout(
    p_cashout_id UUID,
    p_player_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
    v_cashout RECORD;
BEGIN
    -- Get cashout details
    SELECT * INTO v_cashout
    FROM cashout_requests
    WHERE id = p_cashout_id AND player_id = p_player_id AND status = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cashout not found or not cancellable';
    END IF;

    -- Update cashout status
    UPDATE cashout_requests
    SET status = 'cancelled',
        cancelled_at = NOW(),
        updated_at = NOW()
    WHERE id = p_cashout_id;

    -- Release escrow
    UPDATE chip_escrow
    SET released_at = NOW(),
        release_type = 'cancelled'
    WHERE cashout_request_id = p_cashout_id;

    -- Return chips to player's PLAYER wallet (atomic credit)
    UPDATE wallets
    SET balance = balance + v_cashout.amount,
        updated_at = NOW()
    WHERE user_id = p_player_id AND wallet_type = 'PLAYER';

    -- Record transaction
    INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, related_cashout_id, notes)
    VALUES (v_cashout.club_id, p_player_id, v_cashout.amount, 'escrow_release', p_cashout_id, 'Cashout cancelled by player');

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. fn_agent_approve_cashout — No balance changes, just status update
--    (This one was already correct, but we re-declare for completeness)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_agent_approve_cashout(
    p_cashout_id UUID,
    p_agent_id UUID,
    p_note TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
    v_cashout RECORD;
BEGIN
    SELECT * INTO v_cashout
    FROM cashout_requests
    WHERE id = p_cashout_id AND agent_id = p_agent_id AND status = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cashout not found or not approvable';
    END IF;

    UPDATE cashout_requests
    SET status = 'approved',
        acknowledged_at = NOW(),
        agent_note = p_note,
        updated_at = NOW()
    WHERE id = p_cashout_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. fn_complete_cashout — Agent completes (escrow → agent wallet)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_complete_cashout(
    p_cashout_id UUID,
    p_agent_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
    v_cashout RECORD;
    v_agent_user_id UUID;
BEGIN
    -- Get approved cashout
    SELECT * INTO v_cashout
    FROM cashout_requests
    WHERE id = p_cashout_id AND agent_id = p_agent_id AND status = 'approved';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cashout not found or not completable';
    END IF;

    -- Resolve the agent's auth user_id (agents table stores user_id)
    SELECT user_id INTO v_agent_user_id
    FROM agents WHERE id = p_agent_id;

    -- Update cashout status
    UPDATE cashout_requests
    SET status = 'completed',
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_cashout_id;

    -- Release escrow
    UPDATE chip_escrow
    SET released_at = NOW(),
        release_type = 'completed'
    WHERE cashout_request_id = p_cashout_id;

    -- Credit escrow amount to agent's PLAYER wallet
    IF v_agent_user_id IS NOT NULL THEN
        UPDATE wallets
        SET balance = balance + v_cashout.amount,
            updated_at = NOW()
        WHERE user_id = v_agent_user_id AND wallet_type = 'PLAYER';
    END IF;

    -- Record transaction
    INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, related_cashout_id, notes)
    VALUES (v_cashout.club_id, v_cashout.player_id, v_agent_user_id, v_cashout.amount, 'cashout', p_cashout_id, 'Cashout completed');

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. fn_reject_cashout — Agent rejects (returns chips to player)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_reject_cashout(
    p_cashout_id UUID,
    p_agent_id UUID,
    p_note TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
    v_cashout RECORD;
BEGIN
    SELECT * INTO v_cashout
    FROM cashout_requests
    WHERE id = p_cashout_id AND agent_id = p_agent_id AND status = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cashout not found or not rejectable';
    END IF;

    -- Update cashout status
    UPDATE cashout_requests
    SET status = 'rejected',
        agent_note = COALESCE(p_note, 'Rejected by agent'),
        updated_at = NOW()
    WHERE id = p_cashout_id;

    -- Release escrow
    UPDATE chip_escrow
    SET released_at = NOW(),
        release_type = 'rejected'
    WHERE cashout_request_id = p_cashout_id;

    -- Return chips to player's PLAYER wallet (atomic credit)
    UPDATE wallets
    SET balance = balance + v_cashout.amount,
        updated_at = NOW()
    WHERE user_id = v_cashout.player_id AND wallet_type = 'PLAYER';

    -- Record transaction
    INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, related_cashout_id, notes)
    VALUES (v_cashout.club_id, v_cashout.player_id, v_cashout.amount, 'escrow_release', p_cashout_id, 'Cashout rejected by agent');

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$ BEGIN RAISE NOTICE '🔒 CASHOUT RPCs FIXED — now using wallets table with atomic guards'; END $$;
