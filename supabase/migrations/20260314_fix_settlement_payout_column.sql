-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: atomic_pay_agent_settlement — agents.balance column does NOT exist
-- ═══════════════════════════════════════════════════════════════════════════════
-- BUG #22: The original RPC (20260312) used `SET balance = balance + p_amount`
-- on the agents table. The agents table has `agent_wallet_balance` (from
-- 002_financial_core.sql) — NOT `balance`. This caused every weekly settlement
-- payout to mark agents as "paid" without actually crediting their wallet.
-- Agents silently lost their commission payouts.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION atomic_pay_agent_settlement(
    p_settlement_id UUID,
    p_agent_id UUID,
    p_amount NUMERIC,
    p_period_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
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

    -- Process the payment — credit to agent_wallet_balance (canonical column)
    -- CRITICAL FIX: was `balance` which does NOT exist on agents table
    UPDATE agents 
    SET agent_wallet_balance = COALESCE(agent_wallet_balance, 0) + p_amount,
        updated_at = NOW() 
    WHERE id = p_agent_id;

    -- Verify the agent row was actually found
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent not found: %', p_agent_id;
    END IF;

    -- Log wallet transaction for audit trail
    INSERT INTO wallet_transactions (user_id, type, category, amount, period_id, description)
    VALUES (
        (SELECT user_id FROM agents WHERE id = p_agent_id),
        'credit',
        'commission',
        p_amount,
        p_period_id,
        'Weekly Commission payout'
    );

    -- Mark as paid
    UPDATE agent_settlements
    SET status = 'paid', paid_at = NOW(), updated_at = NOW()
    WHERE id = p_settlement_id;
END;
$$;

-- Grant execution to authenticated users (required for PostgREST)
GRANT EXECUTE ON FUNCTION atomic_pay_agent_settlement TO authenticated;
