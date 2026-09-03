-- ═══════════════════════════════════════════════════════════════════════════════
-- 💰 FINANCIAL FUNCTIONS - Phase 2 (RPCs)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. MINT CLUB CHIPS (Atomic)
CREATE OR REPLACE FUNCTION mint_club_chips(
    p_club_id UUID,
    p_chips DECIMAL,
    p_diamonds DECIMAL
) RETURNS BOOLEAN AS $$
DECLARE
    v_current_diamonds DECIMAL;
BEGIN
    -- Check Balance
    SELECT balance INTO v_current_diamonds FROM club_diamond_wallets WHERE club_id = p_club_id;
    
    IF v_current_diamonds < p_diamonds THEN
        RAISE EXCEPTION 'Insufficient Diamonds in Club Wallet';
    END IF;

    -- Burn Diamonds
    UPDATE club_diamond_wallets 
    SET balance = balance - p_diamonds,
        total_minted = total_minted + p_chips,
        last_updated = NOW()
    WHERE club_id = p_club_id;

    -- Send Chips to Club Owner's Player Account (as the "Bank" vault)
    -- In a real system, this might go to a dedicated "Club Vault" account
    -- For now, we assume the Owner holds the Club's liquidity logic
    UPDATE club_members
    SET chip_balance = chip_balance + p_chips
    WHERE club_id = p_club_id AND role = 'owner';

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 2. AGENT WALLET TRANSFER (Agent -> Player Wallet)
CREATE OR REPLACE FUNCTION agent_wallet_transfer(
    p_agent_id UUID,
    p_amount DECIMAL,
    p_source TEXT, -- 'AGENT'
    p_dest TEXT    -- 'PLAYER'
) RETURNS BOOLEAN AS $$
DECLARE
    v_bal DECIMAL;
BEGIN
    -- Verify Sufficient Funds in Source
    SELECT agent_wallet_balance INTO v_bal FROM agents WHERE id = p_agent_id;
    
    IF v_bal < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds in Agent Wallet';
    END IF;

    -- Deduct from Agent Wallet
    UPDATE agents 
    SET agent_wallet_balance = agent_wallet_balance - p_amount
    WHERE id = p_agent_id;

    -- Add to Player Wallet
    UPDATE agents 
    SET player_wallet_balance = player_wallet_balance + p_amount
    WHERE id = p_agent_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 3. DISTRIBUTE PROMO CHIPS
CREATE OR REPLACE FUNCTION distribute_promo_chips(
    p_agent_id UUID,
    p_player_id UUID,
    p_amount DECIMAL
) RETURNS BOOLEAN AS $$
DECLARE
    v_promo_bal DECIMAL;
    v_club_id UUID;
BEGIN
    -- Get Agent Context
    SELECT promo_wallet_balance, club_id INTO v_promo_bal, v_club_id 
    FROM agents WHERE id = p_agent_id;

    IF v_promo_bal < p_amount THEN
        RAISE EXCEPTION 'Insufficient Promo Chips';
    END IF;

    -- Deduct from Promo Wallet
    UPDATE agents 
    SET promo_wallet_balance = promo_wallet_balance - p_amount
    WHERE id = p_agent_id;

    -- Credit Player (Marked as Promo if we track separate balances, 
    -- but usually mixed into chip_balance for simplicity in gameplay)
    UPDATE club_members
    SET chip_balance = chip_balance + p_amount
    WHERE user_id = p_player_id AND club_id = v_club_id;

    -- Log Transaction
    INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, type, notes)
    VALUES (v_club_id, (SELECT user_id FROM agents WHERE id = p_agent_id), p_player_id, p_amount, 'bonus', 'Promo Distribution');

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 4. SYSTEM PAYOUT COMMISSION (Inject Rake Share into Agent Wallet)
CREATE OR REPLACE FUNCTION system_payout_commission(
    p_agent_id UUID,
    p_amount DECIMAL
) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE agents 
    SET agent_wallet_balance = agent_wallet_balance + p_amount
    WHERE id = p_agent_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
