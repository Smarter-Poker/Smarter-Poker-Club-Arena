-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 BACKFILL WALLETS FOR ALL EXISTING USERS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Ensure wallets table has correct columns
DO $$ BEGIN 
    ALTER TABLE wallets ADD COLUMN locked_balance DECIMAL(15,2) DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN 
    NULL;
END $$;

-- Create wallets for all users in auth.users that don't have them
INSERT INTO wallets (id, user_id, wallet_type, balance, locked_balance, created_at, updated_at)
SELECT 
    gen_random_uuid(),
    u.id,
    wallet_type,
    CASE 
        WHEN wallet_type = 'PLAYER' THEN 1000
        WHEN wallet_type = 'PROMO' THEN 100
        ELSE 0
    END as balance,
    0 as locked_balance,
    NOW(),
    NOW()
FROM auth.users u
CROSS JOIN (VALUES ('BUSINESS'), ('PLAYER'), ('PROMO')) AS t(wallet_type)
WHERE NOT EXISTS (
    SELECT 1 FROM wallets w 
    WHERE w.user_id = u.id 
    AND w.wallet_type = t.wallet_type
);

-- Also ensure messages table has is_read column
DO $$ BEGIN 
    ALTER TABLE messages ADD COLUMN is_read BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN 
    NULL;
END $$;

-- Ensure notifications has is_read  
DO $$ BEGIN 
    ALTER TABLE notifications ADD COLUMN is_read BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN 
    NULL;
END $$;

DO $$ BEGIN RAISE NOTICE '✅ WALLETS BACKFILLED AND MESSAGES/NOTIFICATIONS FIXED'; END $$;
