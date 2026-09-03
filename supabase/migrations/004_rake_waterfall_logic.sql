-- ═══════════════════════════════════════════════════════════════════════════════
-- 🌊 RAKE WATERFALL LOGIC - Phase 3 (Pot Drops)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. POT DROPS RPC
-- Moves chips from the Table/Hands context to the Financial Silos
CREATE OR REPLACE FUNCTION execute_pot_drops(
    p_hand_id UUID,
    p_club_id UUID,
    p_rake_amount DECIMAL,
    p_bbj_amount DECIMAL
) RETURNS BOOLEAN AS $$
DECLARE
    v_union_id UUID;
    v_is_pivot_mode BOOLEAN;
BEGIN
    -- Get Union Context for this Club
    SELECT union_id INTO v_union_id FROM union_clubs WHERE club_id = p_club_id;
    
    -- 1. RECORD RAKE COLLECTED
    -- We don't credit the Club ID directly yet; we store it in a 'pending_settlement' bucket
    -- or just log it in the hand history.
    -- For this system, let's create a 'daily_rake_holding' table simplified here
    
    INSERT INTO chip_transactions (club_id, to_user_id, amount, type, reference_id, notes)
    VALUES (
        p_club_id, 
        (SELECT owner_id FROM clubs WHERE id = p_club_id), -- Placeholder: Assigned to Owner for now
        p_rake_amount, 
        'rake', 
        p_hand_id, 
        'Gross Rake Collected'
    );

    -- 2. HANDLE BBJ DROP (Triple Bank)
    -- Union holds BBJ. If no union, Club holds it.
    
    -- Determined Pools based on Union logic (Simulated here)
    -- 50% Main, 25% Backup, 25% Promo (Standard)
    
    IF v_union_id IS NOT NULL THEN
        -- Union Custody
        UPDATE bbj_pools SET balance = balance + (p_bbj_amount * 0.50) 
        WHERE union_id = v_union_id AND pool_type = 'MAIN';
        
        UPDATE bbj_pools SET balance = balance + (p_bbj_amount * 0.25) 
        WHERE union_id = v_union_id AND pool_type = 'BACKUP';
        
        UPDATE bbj_pools SET balance = balance + (p_bbj_amount * 0.25) 
        WHERE union_id = v_union_id AND pool_type = 'PROMO';
    ELSE
        -- Club Custody (Independent)
        -- Upsert logic needed if row doesn't exist
        UPDATE bbj_pools SET balance = balance + (p_bbj_amount * 0.50) 
        WHERE club_id = p_club_id AND pool_type = 'MAIN';
        -- ... repeats for others
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. RAKE ATTRIBUTION TABLE
-- High-performance log for "Dealt-In" credit
CREATE TABLE IF NOT EXISTS rake_attribution_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hand_id UUID NOT NULL REFERENCES hands(id),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    club_id UUID NOT NULL REFERENCES clubs(id),
    rake_generated DECIMAL(10, 4) NOT NULL, -- High precision
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rake_attr_user ON rake_attribution_log(user_id);
CREATE INDEX IF NOT EXISTS idx_rake_attr_club_date ON rake_attribution_log(club_id, created_at);

DO $$ 
BEGIN 
    RAISE NOTICE '🌊 RAKE WATERFALL SCHEMA APPLIED';
END $$;
