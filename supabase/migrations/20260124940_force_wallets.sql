-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 FORCE CREATE WALLETS WITH PROPER BALANCES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Delete existing wallets and recreate with correct values
DELETE FROM wallets;

-- Insert wallets for ALL users with proper balances
INSERT INTO wallets (id, user_id, wallet_type, balance, locked_balance, created_at, updated_at)
SELECT 
    gen_random_uuid(),
    u.id,
    wt.wallet_type::TEXT,
    CASE wt.wallet_type
        WHEN 'PLAYER' THEN 1000
        WHEN 'PROMO' THEN 100
        ELSE 0
    END as balance,
    0 as locked_balance,
    NOW(),
    NOW()
FROM auth.users u
CROSS JOIN (SELECT unnest(ARRAY['BUSINESS', 'PLAYER', 'PROMO']) as wallet_type) wt;

DO $$ BEGIN RAISE NOTICE '✅ ALL WALLETS CREATED: PLAYER=1000, PROMO=100, BUSINESS=0'; END $$;
