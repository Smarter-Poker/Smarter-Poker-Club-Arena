-- ═══════════════════════════════════════════════════════════════════════════════
-- 🆕 AUTO-INITIALIZE USER DATA — Trigger on Auth Signup
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Automatically creates required rows for new users:
-- - profiles (minimal fields only)
-- - diamond_wallets (with starting balance)
--
-- Created: 2026-01-24
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. ENSURE DIAMOND_WALLETS TABLE EXISTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS diamond_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL,
    balance INTEGER DEFAULT 0,
    lifetime_earned INTEGER DEFAULT 0,
    lifetime_spent INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_diamond_wallets_user ON diamond_wallets(user_id);

-- RLS
ALTER TABLE diamond_wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS diamond_wallets_self ON diamond_wallets;
CREATE POLICY diamond_wallets_self ON diamond_wallets
    FOR ALL USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. FUNCTION TO INITIALIZE NEW USER DATA
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    -- Create profile if not exists (minimal fields only)
    INSERT INTO profiles (id, username, display_name)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'username', 'Player' || (1000 + floor(random() * 9000)::int)::text),
        COALESCE(NEW.raw_user_meta_data->>'display_name', 'New Player')
    )
    ON CONFLICT (id) DO NOTHING;
    
    -- Create diamond wallet with starting balance (0 diamonds for new users)
    INSERT INTO diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES (
        NEW.id,
        0,
        0,
        0
    )
    ON CONFLICT (user_id) DO NOTHING;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. TRIGGER ON AUTH.USERS INSERT
-- ═══════════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. BACKFILL EXISTING USERS WITHOUT WALLETS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Create diamond wallets for any existing users who don't have one
INSERT INTO diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent)
SELECT 
    u.id,
    0,
    0,
    0
FROM auth.users u
WHERE NOT EXISTS (
    SELECT 1 FROM diamond_wallets dw WHERE dw.user_id = u.id
)
ON CONFLICT (user_id) DO NOTHING;

-- Create profiles for any existing users who don't have one (minimal fields)
INSERT INTO profiles (id, username, display_name)
SELECT 
    u.id,
    'Player' || (1000 + floor(random() * 9000)::int)::text,
    'Player'
FROM auth.users u
WHERE NOT EXISTS (
    SELECT 1 FROM profiles p WHERE p.id = u.id
)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE — Auto-initialization configured
-- ═══════════════════════════════════════════════════════════════════════════════
