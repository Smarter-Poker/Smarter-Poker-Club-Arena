-- ═══════════════════════════════════════════════════════════════════════════════
-- BBJ CONTRIBUTIONS: Make hand_id nullable
-- ═══════════════════════════════════════════════════════════════════════════════
-- The server logs hands to `hand_history` table, not the legacy `hands` table.
-- BBJ contributions need to be logged without a `hands` table FK.
-- Adding hand_number + table_id as the identifying reference instead.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Make hand_id nullable (was NOT NULL REFERENCES hands(id))
ALTER TABLE bbj_contributions ALTER COLUMN hand_id DROP NOT NULL;

-- Add hand_number column for reference without FK
ALTER TABLE bbj_contributions ADD COLUMN IF NOT EXISTS hand_number INTEGER;

-- Update the bbj_record_contribution function to accept nullable hand_id
CREATE OR REPLACE FUNCTION bbj_record_contribution(
    p_pool_id UUID,
    p_hand_id UUID DEFAULT NULL,
    p_table_id UUID DEFAULT NULL,
    p_amount DECIMAL DEFAULT 0,
    p_main_portion DECIMAL DEFAULT 0,
    p_backup_portion DECIMAL DEFAULT 0,
    p_promo_portion DECIMAL DEFAULT 0,
    p_big_blind DECIMAL DEFAULT 2.00,
    p_hand_number INTEGER DEFAULT NULL
) RETURNS bbj_contributions AS $$
DECLARE
    v_contribution bbj_contributions;
BEGIN
    -- Update pool balances
    UPDATE bbj_pools
    SET
        main_balance = main_balance + p_main_portion,
        backup_balance = backup_balance + p_backup_portion,
        promo_balance = promo_balance + p_promo_portion,
        total_contributed = total_contributed + p_amount,
        updated_at = now()
    WHERE id = p_pool_id;

    -- Record contribution
    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_amount,
        p_main_portion, p_backup_portion, p_promo_portion, p_big_blind, p_hand_number
    ) RETURNING * INTO v_contribution;

    RETURN v_contribution;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
