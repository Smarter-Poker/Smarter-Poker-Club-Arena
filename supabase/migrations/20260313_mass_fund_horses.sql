-- ============================================================
-- 🐴 ATOMIC MASS FUNDING FOR HORSE FLEET
-- 
-- Description:
-- Safely grants virtual chips to all active autonomous horse accounts
-- at once. Used by `/api/club-arena/horse-launch` to ensure they 
-- don't hit "Insufficient balance" errors during `atomic_table_buyin`.
-- Since horses play with house chips, their wallets can be arbitrarily top-upped.
-- ============================================================

CREATE OR REPLACE FUNCTION mass_fund_horses(p_amount NUMERIC)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    -- Only fund accounts explicitly marked as horses
    UPDATE wallets
    SET balance = p_amount, updated_at = NOW()
    WHERE wallet_type = 'PLAYER' 
      AND user_id IN (
          SELECT id FROM profiles WHERE is_horse = true
      );

    -- If any horse lacks a PLAYER wallet row, create it
    INSERT INTO wallets (user_id, wallet_type, balance, updated_at)
    SELECT id, 'PLAYER', p_amount, NOW()
    FROM profiles
    WHERE is_horse = true
    ON CONFLICT (user_id, wallet_type) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION mass_fund_horses(NUMERIC) TO anon, authenticated;
