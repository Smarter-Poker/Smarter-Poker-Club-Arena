-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 FIX WALLET RLS AND ENSURE BALANCES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Enable RLS on wallets
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to recreate them cleanly
DROP POLICY IF EXISTS "Users can view own wallets" ON wallets;
DROP POLICY IF EXISTS "Users can read own wallets" ON wallets;
DROP POLICY IF EXISTS "wallets_select" ON wallets;

-- Create simple RLS policy for users to read their own wallets
CREATE POLICY "Users can read own wallets" ON wallets
    FOR SELECT USING (auth.uid() = user_id);

-- Update existing wallet balances to ensure they have values
UPDATE wallets SET balance = 1000 WHERE wallet_type = 'PLAYER' AND balance = 0;
UPDATE wallets SET balance = 100 WHERE wallet_type = 'PROMO' AND balance = 0;

DO $$ BEGIN RAISE NOTICE '✅ WALLET RLS AND BALANCES FIXED'; END $$;
