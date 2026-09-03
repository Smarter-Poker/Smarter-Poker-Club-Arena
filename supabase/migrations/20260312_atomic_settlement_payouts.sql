-- ============================================================
-- V20 Audit Fix: Atomic Settlement & Double-Payout Prevention
-- 
-- Description:
-- SettlementService historically executed payouts in TS, mutating 
-- wallets via RPC, and then asynchronously updating the settlement 
-- status to 'paid'. If the status update failed, the system would 
-- revert to 'approved' and repeatedly multi-pay the agent on each retry.
-- Union rakeback lacked ANY idempotency guards at all.
--
-- This migration hardens the system by moving all final settlement 
-- transitions into fully atomic Postgres RPCs, guaranteeing that a 
-- wallet credit CANNOT occur unless the settlement status is updated.
-- ============================================================

-- 1. Atomic Agent Settlement
CREATE OR REPLACE FUNCTION atomic_pay_agent_settlement(
    p_settlement_id UUID,
    p_agent_id UUID,
    p_amount NUMERIC,
    p_period_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_status TEXT;
BEGIN
    -- Claim the settlement row with an exclusive lock
    SELECT status INTO v_status
    FROM agent_settlements
    WHERE id = p_settlement_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Settlement record not found';
    END IF;

    -- Idempotency check: only pay if it hasn't been paid
    IF v_status = 'paid' THEN
        RAISE EXCEPTION 'Settlement already paid';
    END IF;

    IF v_status != 'processing' AND v_status != 'approved' THEN
        RAISE EXCEPTION 'Settlement is not in a payable state (%)', v_status;
    END IF;

    -- Process the payment
    UPDATE agents 
    SET balance = balance + p_amount, updated_at = NOW() 
    WHERE id = p_agent_id;
    
    INSERT INTO wallet_transactions (user_id, type, category, amount, period_id, description)
    VALUES ((SELECT user_id FROM agents WHERE id = p_agent_id), 'credit', 'commission', p_amount, p_period_id, 'Weekly Commission payout');

    -- Mark as paid
    UPDATE agent_settlements
    SET status = 'paid', paid_at = NOW(), updated_at = NOW()
    WHERE id = p_settlement_id;
END;
$$;


-- 2. Atomic Player Rakeback Settlement
-- Ensures rakeback can only be paid once per player per period
CREATE OR REPLACE FUNCTION atomic_pay_player_rakeback(
    p_snapshot_id UUID,
    p_player_id UUID,
    p_amount NUMERIC,
    p_period_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_is_paid BOOLEAN;
BEGIN
    -- Claim the snapshot row with an exclusive lock
    SELECT rakeback_paid INTO v_is_paid
    FROM player_weekly_snapshots
    WHERE id = p_snapshot_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player snapshot not found';
    END IF;

    -- Idempotency check
    IF v_is_paid = TRUE THEN
        RAISE EXCEPTION 'Rakeback already paid for this snapshot';
    END IF;

    -- Process the payment
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_player_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    
    INSERT INTO wallet_transactions (user_id, type, category, amount, period_id, description)
    VALUES (p_player_id, 'credit', 'rakeback', p_amount, p_period_id, 'Weekly Rakeback payout');

    -- Mark as paid
    UPDATE player_weekly_snapshots
    SET rakeback_paid = TRUE, updated_at = NOW()
    WHERE id = p_snapshot_id;
END;
$$;

-- Note: In order for the above to work, we need a rakeback_paid flag on player_weekly_snapshots
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'player_weekly_snapshots' AND column_name = 'rakeback_paid') THEN
        ALTER TABLE player_weekly_snapshots ADD COLUMN rakeback_paid BOOLEAN DEFAULT FALSE;
    END IF;
END $$;


-- 3. Atomic Union Rakeback Execution
-- Ensures we don't accidentally run the union rakeback multiple times for the same period
CREATE TABLE IF NOT EXISTS union_rakeback_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    union_id UUID NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    total_rakeback NUMERIC NOT NULL,
    executed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(union_id, period_start, period_end)
);

CREATE OR REPLACE FUNCTION verify_and_log_union_rakeback(
    p_union_id UUID,
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_total_rakeback NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    -- Attempt to insert the execution log. If it violates the UNIQUE constraint, 
    -- it means this union has already been processed for this exact time period.
    INSERT INTO union_rakeback_executions (union_id, period_start, period_end, total_rakeback)
    VALUES (p_union_id, p_period_start, p_period_end, p_total_rakeback);
    
    RETURN TRUE;
EXCEPTION WHEN unique_violation THEN
    -- Already executed!
    RETURN FALSE;
END;
$$;
