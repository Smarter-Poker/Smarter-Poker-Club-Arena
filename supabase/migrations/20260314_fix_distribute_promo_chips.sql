-- ═══════════════════════════════════════════════════════════════════════════════
-- FIXED distribute_promo_chips — Phase 13 Audit BUG #13
-- 
-- The live RPC had WRONG SIGNATURE (p_user_id, p_amount, p_description) but 
-- frontend calls with (p_agent_id, p_player_id, p_amount).
-- Live version didn't deduct agent promo balance or insert into chip_transactions.
--
-- This version:
--   1. DROP the wrong-signature version first (can't CREATE OR REPLACE with different params)
--   2. Creates correct version matching frontend WalletService.distributePromo() call
--   3. Deducts from agents.promo_balance
--   4. Credits club_members.chip_balance (player's club balance)
--   5. Inserts into chip_transactions for clawback audit trail
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop ALL overloads to avoid ambiguity
DROP FUNCTION IF EXISTS distribute_promo_chips(UUID, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS distribute_promo_chips(UUID, UUID, NUMERIC);
DROP FUNCTION IF EXISTS distribute_promo_chips(UUID, UUID, DECIMAL);

CREATE OR REPLACE FUNCTION distribute_promo_chips(
    p_agent_id UUID,    -- agents.id (agent PK, NOT auth.users.id)
    p_player_id UUID,   -- auth.users.id of the receiving player
    p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_club_id UUID;
    v_agent_user_id UUID;
BEGIN
    -- 1. Get agent context (club_id and user_id for transaction logging)
    SELECT club_id, user_id INTO v_club_id, v_agent_user_id
    FROM agents WHERE id = p_agent_id;

    IF v_club_id IS NULL THEN
        RAISE EXCEPTION 'Agent not found';
    END IF;

    -- 2. Deduct from agent's promo balance
    UPDATE agents
    SET promo_balance = COALESCE(promo_balance, 0) - p_amount,
        updated_at = NOW()
    WHERE id = p_agent_id AND COALESCE(promo_balance, 0) >= p_amount;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient promo balance';
    END IF;

    -- 3. Credit player's club chip balance
    UPDATE club_members
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount
    WHERE user_id = p_player_id AND club_id = v_club_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not found in club';
    END IF;

    -- 4. Log to chip_transactions for clawback audit trail
    INSERT INTO chip_transactions (
        club_id, from_user_id, to_user_id, amount, transaction_type, notes
    ) VALUES (
        v_club_id,
        v_agent_user_id,   -- from_user_id = agent's auth.users.id (NOT agent PK)
        p_player_id,       -- to_user_id = player's auth.users.id
        p_amount,
        'promo_agent_to_player',
        'Promo Distribution'
    );
END;
$$;
