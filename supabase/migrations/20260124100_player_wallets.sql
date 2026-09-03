-- ═══════════════════════════════════════════════════════════════════════════════
-- 💰 PLAYER WALLETS MIGRATION
-- ═══════════════════════════════════════════════════════════════════════════════
-- Creates the user-level wallet system for the Triple-Wallet architecture
-- ═══════════════════════════════════════════════════════════════════════════════

-- Enable uuid extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. PLAYER WALLETS TABLE (Triple Wallet per User)
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    wallet_type TEXT NOT NULL CHECK (wallet_type IN ('BUSINESS', 'PLAYER', 'PROMO')),
    balance DECIMAL(15, 2) DEFAULT 0,
    locked_balance DECIMAL(15, 2) DEFAULT 0, -- Chips at tables
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, wallet_type)
);

-- 2. WALLET TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    wallet_type TEXT NOT NULL CHECK (wallet_type IN ('BUSINESS', 'PLAYER', 'PROMO')),
    amount DECIMAL(15, 2) NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
    category TEXT NOT NULL CHECK (category IN ('mint', 'transfer', 'buyin', 'cashout', 'rake', 'commission', 'promo', 'settlement', 'TIP', 'INSURANCE')),
    description TEXT,
    related_entity_id UUID,
    table_id UUID,
    hand_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. NOTE: diamond_wallets already exists in 013_missing_tables.sql
-- Skipping creation here to avoid conflict

-- 4. TABLE CHIP LOCKS (Chips at active tables)
CREATE TABLE IF NOT EXISTS table_chip_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    table_id UUID NOT NULL,
    amount DECIMAL(15, 2) DEFAULT 0,
    locked_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, table_id)
);

-- 5. INDEXES
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created ON wallet_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_table_chip_locks_table ON table_chip_locks(table_id);

-- 6. RLS POLICIES
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
-- diamond_wallets RLS already set in 013_missing_tables.sql
ALTER TABLE table_chip_locks ENABLE ROW LEVEL SECURITY;

-- Users can view their own wallets
CREATE POLICY "Users view own wallets" ON wallets
    FOR SELECT USING (user_id = auth.uid());

-- Users can view their own transactions
CREATE POLICY "Users view own transactions" ON wallet_transactions
    FOR SELECT USING (user_id = auth.uid());

-- diamond_wallets policy already set in 013_missing_tables.sql

-- Users can view their table locks
CREATE POLICY "Users view own table locks" ON table_chip_locks
    FOR SELECT USING (user_id = auth.uid());

-- 7. INITIALIZATION TRIGGER - Create wallets on user signup
CREATE OR REPLACE FUNCTION create_user_wallets()
RETURNS TRIGGER AS $$
BEGIN
    -- Create triple wallets
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES
        (NEW.id, 'BUSINESS', 0),
        (NEW.id, 'PLAYER', 1000), -- Starting chips for new players
        (NEW.id, 'PROMO', 100);   -- Welcome bonus
    
    -- Note: diamond_wallets is created in separate migration, so we skip it here
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created_wallets ON auth.users;
CREATE TRIGGER on_auth_user_created_wallets
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION create_user_wallets();

-- 8. Make sure existing users have wallets
INSERT INTO wallets (user_id, wallet_type, balance)
SELECT id, 'BUSINESS', 0 FROM auth.users
WHERE id NOT IN (SELECT user_id FROM wallets WHERE wallet_type = 'BUSINESS')
ON CONFLICT DO NOTHING;

INSERT INTO wallets (user_id, wallet_type, balance)
SELECT id, 'PLAYER', 1000 FROM auth.users
WHERE id NOT IN (SELECT user_id FROM wallets WHERE wallet_type = 'PLAYER')
ON CONFLICT DO NOTHING;

INSERT INTO wallets (user_id, wallet_type, balance)
SELECT id, 'PROMO', 100 FROM auth.users
WHERE id NOT IN (SELECT user_id FROM wallets WHERE wallet_type = 'PROMO')
ON CONFLICT DO NOTHING;

-- Note: diamond_wallets backfill handled in 013_missing_tables migration

DO $$ 
BEGIN 
    RAISE NOTICE '💰 PLAYER WALLETS MIGRATION APPLIED SUCCESSFULLY';
END $$;
