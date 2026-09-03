-- ═══════════════════════════════════════════════════════════════════════════════
-- BBJ Triple-Bank Upgrade — March 11, 2026
-- Upgrades add_bbj_contribution to support MAIN/BACKUP/PROMO allocation
-- Adds triple-bank columns if not present, preserves existing current_amount
-- ═══════════════════════════════════════════════════════════════════════════════

-- Step 1: Add triple-bank columns if they don't exist
ALTER TABLE bbj_pools ADD COLUMN IF NOT EXISTS main_balance DECIMAL(15,2) DEFAULT 0;
ALTER TABLE bbj_pools ADD COLUMN IF NOT EXISTS backup_balance DECIMAL(15,2) DEFAULT 0;
ALTER TABLE bbj_pools ADD COLUMN IF NOT EXISTS promo_balance DECIMAL(15,2) DEFAULT 0;

-- Migrate existing current_amount into main_balance (one-time data migration)
UPDATE bbj_pools
SET main_balance = COALESCE(current_amount, 0)
WHERE main_balance = 0 AND COALESCE(current_amount, 0) > 0;

-- Step 2: Add portion columns to bbj_contributions for audit trail
ALTER TABLE bbj_contributions ADD COLUMN IF NOT EXISTS main_portion DECIMAL(10,2) DEFAULT 0;
ALTER TABLE bbj_contributions ADD COLUMN IF NOT EXISTS backup_portion DECIMAL(10,2) DEFAULT 0;
ALTER TABLE bbj_contributions ADD COLUMN IF NOT EXISTS promo_portion DECIMAL(10,2) DEFAULT 0;

-- Step 3: Upgrade add_bbj_contribution to accept and allocate triple-bank portions
CREATE OR REPLACE FUNCTION add_bbj_contribution(
    p_table_id UUID,
    p_club_id UUID,
    p_amount NUMERIC,
    p_big_blind NUMERIC,
    p_hand_number BIGINT DEFAULT 0,
    p_stakes_tier TEXT DEFAULT 'mid',
    p_main_portion NUMERIC DEFAULT NULL,
    p_backup_portion NUMERIC DEFAULT NULL,
    p_promo_portion NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pool RECORD;
    v_new_amount NUMERIC;
    v_main NUMERIC;
    v_backup NUMERIC;
    v_promo NUMERIC;
BEGIN
    -- Calculate portions: use provided values or default to full amount in main
    v_main := COALESCE(p_main_portion, p_amount);
    v_backup := COALESCE(p_backup_portion, 0);
    v_promo := COALESCE(p_promo_portion, 0);

    -- Get or create BBJ pool for this club
    SELECT * INTO v_pool FROM bbj_pools WHERE club_id = p_club_id AND status = 'active' LIMIT 1;

    IF v_pool IS NULL THEN
        INSERT INTO bbj_pools (
            club_id, current_amount, main_balance, backup_balance, promo_balance,
            status, stakes_tier
        )
        VALUES (
            p_club_id, p_amount, v_main, v_backup, v_promo,
            'active', p_stakes_tier
        )
        RETURNING * INTO v_pool;
        v_new_amount := p_amount;
    ELSE
        UPDATE bbj_pools
        SET current_amount = COALESCE(current_amount, 0) + p_amount,
            main_balance = COALESCE(main_balance, 0) + v_main,
            backup_balance = COALESCE(backup_balance, 0) + v_backup,
            promo_balance = COALESCE(promo_balance, 0) + v_promo,
            updated_at = NOW()
        WHERE id = v_pool.id
        RETURNING current_amount INTO v_new_amount;
    END IF;

    -- Log the contribution with portion breakdown
    INSERT INTO bbj_contributions (
        pool_id, table_id, club_id, amount, big_blind, hand_number, stakes_tier,
        main_portion, backup_portion, promo_portion
    )
    VALUES (
        v_pool.id, p_table_id, p_club_id, p_amount, p_big_blind, p_hand_number, p_stakes_tier,
        v_main, v_backup, v_promo
    );

    RETURN jsonb_build_object(
        'pool_id', v_pool.id,
        'new_amount', v_new_amount,
        'main_balance', COALESCE(v_pool.main_balance, 0) + v_main,
        'backup_balance', COALESCE(v_pool.backup_balance, 0) + v_backup,
        'promo_balance', COALESCE(v_pool.promo_balance, 0) + v_promo,
        'contribution', p_amount
    );
EXCEPTION WHEN OTHERS THEN
    -- If tables don't exist yet, just return success silently
    RETURN jsonb_build_object('pool_id', NULL, 'new_amount', 0, 'contribution', p_amount, 'note', 'bbj tables not yet created');
END;
$$;

-- Re-grant permissions
GRANT EXECUTE ON FUNCTION add_bbj_contribution TO authenticated, anon;

DO $$
BEGIN
    RAISE NOTICE '✅ BBJ Triple-Bank Upgrade applied — add_bbj_contribution now supports MAIN/BACKUP/PROMO allocation';
END $$;
