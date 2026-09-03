-- ============================================================
-- V18 Audit Fix: Modernize Legacy Wallet RPCs
-- 
-- Description:
-- Several RPC functions from earlier phases (e.g. 20260124000) 
-- were still pointing to the deprecated `player_wallets` table.
-- This caused internal transfers, user transfers, promo wallet 
-- drops, and rakeback to fail silently or write to ghost records.
--
-- This migration repoints all of these legacy RPCs to use 
-- the unified `wallets` table, preserving atomic integrity.
-- ============================================================

-- Internal wallet transfer (between user's own wallets)
CREATE OR REPLACE FUNCTION wallet_internal_transfer(
    p_user_id UUID,
    p_from_wallet TEXT,
    p_to_wallet TEXT,
    p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
    -- Deduct from source wallet
    UPDATE wallets 
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = p_from_wallet AND balance >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient balance in % wallet', p_from_wallet;
    END IF;
    
    -- Add to destination wallet
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, p_to_wallet, p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    
    -- Record transaction
    INSERT INTO wallet_transactions (user_id, type, amount, from_wallet, to_wallet, description)
    VALUES (p_user_id, 'INTERNAL_TRANSFER', p_amount, p_from_wallet, p_to_wallet, 'Internal wallet transfer');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- User-to-user transfer
CREATE OR REPLACE FUNCTION wallet_user_transfer(
    p_from_user_id UUID,
    p_to_user_id UUID,
    p_amount NUMERIC,
    p_description TEXT DEFAULT 'Chip transfer'
)
RETURNS VOID AS $$
BEGIN
    -- Deduct from sender
    UPDATE wallets 
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_from_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient balance';
    END IF;
    
    -- Add to recipient
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_to_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    
    -- Record both transactions
    INSERT INTO wallet_transactions (user_id, type, amount, related_user_id, description)
    VALUES 
        (p_from_user_id, 'TRANSFER_OUT', -p_amount, p_to_user_id, p_description),
        (p_to_user_id, 'TRANSFER_IN', p_amount, p_from_user_id, p_description);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Add to player wallet (used by admin/general bonuses)
CREATE OR REPLACE FUNCTION add_to_player_wallet(
    p_user_id UUID,
    p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Add to promo wallet (used for BBJ and achievements)
CREATE OR REPLACE FUNCTION add_to_promo_wallet(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID AS $$
BEGIN
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PROMO', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Credit player rakeback
CREATE OR REPLACE FUNCTION credit_player_rakeback(
    p_user_id UUID,
    p_amount NUMERIC,
    p_period_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    
    INSERT INTO wallet_transactions (user_id, type, amount, period_id, description)
    VALUES (p_user_id, 'RAKEBACK', p_amount, p_period_id, 'Rakeback credit');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- General add_chips alias
CREATE OR REPLACE FUNCTION add_chips(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID AS $$
BEGIN
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant permissions explicitly
GRANT EXECUTE ON FUNCTION wallet_internal_transfer(UUID, TEXT, TEXT, NUMERIC) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION wallet_user_transfer(UUID, UUID, NUMERIC, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION add_to_player_wallet(UUID, NUMERIC) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION add_to_promo_wallet(UUID, NUMERIC) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION credit_player_rakeback(UUID, NUMERIC, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION add_chips(UUID, NUMERIC) TO anon, authenticated;
