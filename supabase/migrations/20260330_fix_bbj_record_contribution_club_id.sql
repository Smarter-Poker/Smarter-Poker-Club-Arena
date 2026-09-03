-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX 205: bbj_record_contribution missing club_id
-- ═══════════════════════════════════════════════════════════════════════════════
-- The bbj_contributions table has a NOT NULL club_id column, but the
-- bbj_record_contribution function (from 20260325 migration) doesn't pass it.
-- This causes "null value in column club_id" errors on every BBJ contribution.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Make club_id nullable first (it may not be present for all historical records)
ALTER TABLE bbj_contributions ALTER COLUMN club_id DROP NOT NULL;

-- Recreate the function with p_club_id parameter
CREATE OR REPLACE FUNCTION bbj_record_contribution(
    p_pool_id UUID,
    p_hand_id UUID DEFAULT NULL,
    p_table_id UUID DEFAULT NULL,
    p_amount DECIMAL DEFAULT 0,
    p_main_portion DECIMAL DEFAULT 0,
    p_backup_portion DECIMAL DEFAULT 0,
    p_promo_portion DECIMAL DEFAULT 0,
    p_big_blind DECIMAL DEFAULT 2.00,
    p_hand_number INTEGER DEFAULT NULL,
    p_club_id UUID DEFAULT NULL
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

    -- Record contribution (now includes club_id)
    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_club_id, p_amount,
        p_main_portion, p_backup_portion, p_promo_portion, p_big_blind, p_hand_number
    ) RETURNING * INTO v_contribution;

    RETURN v_contribution;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
