-- ============================================================
-- V14 Audit Fix: Rake Deduction & House Wallet Crediting
-- As discovered in Pass 1, Rake was being recorded for stats
-- but NEVER actually deducted from the pot or credited to the
-- club's chip_treasury / wallet. This patches the execute_pot_drops RPC.
-- ============================================================

CREATE OR REPLACE FUNCTION execute_pot_drops(
    p_hand_id UUID,
    p_rake_amount NUMERIC,
    p_bbj_amount NUMERIC DEFAULT 0,
    p_table_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    v_club_id UUID;
    v_union_id UUID;
BEGIN
    IF p_table_id IS NOT NULL THEN
        SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
        IF v_club_id IS NOT NULL THEN
            SELECT union_id INTO v_union_id FROM clubs WHERE id = v_club_id;
        END IF;
    END IF;

    -- Record rake statistically 
    INSERT INTO rake_records (hand_id, table_id, rake_amount, bbj_contribution, created_at)
    VALUES (p_hand_id, p_table_id, p_rake_amount, p_bbj_amount, NOW());
    
    -- FINANCIAL TRANSFER: Move Rake directly to the Club Treasury
    IF p_rake_amount > 0 AND v_club_id IS NOT NULL THEN
        UPDATE clubs SET
            chip_treasury = COALESCE(chip_treasury, 0) + p_rake_amount,
            total_rake = COALESCE(total_rake, 0) + p_rake_amount,
            updated_at = NOW()
        WHERE id = v_club_id;
        
        -- Also add to union rake if part of a union
        IF v_union_id IS NOT NULL THEN
            UPDATE unions SET
                total_rake = COALESCE(total_rake, 0) + p_rake_amount,
                updated_at = NOW()
            WHERE id = v_union_id;
        END IF;
    END IF;
    
    -- FINANCIAL TRANSFER: Add to BBJ pool
    IF p_bbj_amount > 0 AND v_club_id IS NOT NULL THEN
        UPDATE bad_beat_jackpots SET
            current_amount = current_amount + p_bbj_amount,
            updated_at = NOW()
        WHERE club_id = v_club_id AND status = 'active';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
