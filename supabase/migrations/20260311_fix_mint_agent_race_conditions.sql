-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔒 RACE CONDITION FIX — mint_club_chips + deduct_agent_balance
-- ═══════════════════════════════════════════════════════════════════════════════
-- Both functions had SELECT-then-UPDATE patterns allowing double-spend under
-- concurrent requests. This migration replaces them with atomic UPDATE...WHERE
-- guards that combine the balance check and deduction in a single statement.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. mint_club_chips — Atomic diamond deduction
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mint_club_chips(
    p_club_id UUID,
    p_chips NUMERIC,
    p_diamonds INTEGER
)
RETURNS JSONB AS $$
DECLARE
    v_owner_id UUID;
    v_new_balance NUMERIC;
    v_rows_affected INTEGER;
BEGIN
    -- Get club owner
    SELECT owner_id INTO v_owner_id FROM clubs WHERE id = p_club_id;

    IF v_owner_id IS NULL THEN
        RAISE EXCEPTION 'Club not found';
    END IF;

    -- ATOMIC diamond deduction: deduct only if balance >= cost.
    -- The WHERE clause prevents negative balances under concurrency.
    UPDATE profiles
    SET diamonds = diamonds - p_diamonds,
        updated_at = NOW()
    WHERE id = v_owner_id
      AND diamonds >= p_diamonds;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    IF v_rows_affected = 0 THEN
        RAISE EXCEPTION 'Insufficient diamonds';
    END IF;

    -- Add chips to club treasury
    UPDATE clubs
    SET chip_treasury = COALESCE(chip_treasury, 0) + p_chips,
        updated_at = NOW()
    WHERE id = p_club_id
    RETURNING chip_treasury INTO v_new_balance;

    RETURN jsonb_build_object(
        'success', true,
        'chips_added', p_chips,
        'diamonds_spent', p_diamonds,
        'new_balance', v_new_balance
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. deduct_agent_balance — Atomic balance deduction
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION deduct_agent_balance(
    p_agent_id UUID,
    p_amount NUMERIC,
    p_reason TEXT DEFAULT 'Transfer'
)
RETURNS BOOLEAN AS $$
DECLARE
    v_rows_affected INTEGER;
BEGIN
    -- ATOMIC deduction: deduct only if balance >= amount.
    -- Eliminates the SELECT-then-UPDATE race condition.
    UPDATE agents
    SET balance = balance - p_amount,
        updated_at = NOW()
    WHERE id = p_agent_id
      AND balance >= p_amount;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    IF v_rows_affected = 0 THEN
        RETURN FALSE;
    END IF;

    -- Log transaction
    INSERT INTO wallet_transactions (user_id, type, amount, description)
    SELECT user_id, 'debit', p_amount, p_reason
    FROM agents WHERE id = p_agent_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$ BEGIN RAISE NOTICE '🔒 mint_club_chips + deduct_agent_balance race conditions FIXED'; END $$;
