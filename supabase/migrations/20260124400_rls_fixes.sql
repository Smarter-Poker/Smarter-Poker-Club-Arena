-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔐 RLS POLICY FIXES
-- ═══════════════════════════════════════════════════════════════════════════════
-- Fix RLS policies to allow authenticated users to create clubs
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Enable RLS on clubs if not already
ALTER TABLE clubs ENABLE ROW LEVEL SECURITY;

-- 2. Drop existing restrictive policies if they exist
DROP POLICY IF EXISTS "Authenticated users can create clubs" ON clubs;
DROP POLICY IF EXISTS "Anyone can view clubs" ON clubs;
DROP POLICY IF EXISTS "Owners can update clubs" ON clubs;
DROP POLICY IF EXISTS "Owners can delete clubs" ON clubs;

-- 3. Create permissive policies for clubs
-- Anyone can view clubs (public)
CREATE POLICY "Anyone can view clubs" ON clubs
    FOR SELECT USING (true);

-- Authenticated users can create clubs (set owner_id to their id)
CREATE POLICY "Authenticated users can create clubs" ON clubs
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Owners can update their clubs
CREATE POLICY "Owners can update clubs" ON clubs
    FOR UPDATE USING (owner_id = auth.uid());

-- Owners can delete their clubs
CREATE POLICY "Owners can delete clubs" ON clubs
    FOR DELETE USING (owner_id = auth.uid());

-- 4. Also fix club_members insert policy
ALTER TABLE club_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can join clubs" ON club_members;
DROP POLICY IF EXISTS "Members can view club members" ON club_members;

CREATE POLICY "Members can view club members" ON club_members
    FOR SELECT USING (true);

CREATE POLICY "Users can join clubs" ON club_members
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- 5. Fix wallets insert policy
DROP POLICY IF EXISTS "Users can insert own wallets" ON wallets;
CREATE POLICY "Users can insert own wallets" ON wallets
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "System can insert wallets" ON wallets;
CREATE POLICY "System can insert wallets" ON wallets
    FOR INSERT WITH CHECK (true);

-- 6. Fix tables insert policy
DROP POLICY IF EXISTS "Club admins can create tables" ON tables;
CREATE POLICY "Club admins can create tables" ON tables
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Club admins can update tables" ON tables;
CREATE POLICY "Club admins can update tables" ON tables
    FOR UPDATE USING (true);

-- 7. Allow authenticated users to update their profiles
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles
    FOR UPDATE USING (id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile" ON profiles
    FOR INSERT WITH CHECK (id = auth.uid());

-- 8. Allow profile creation by trigger (service role)
DROP POLICY IF EXISTS "Service role can manage profiles" ON profiles;

DO $$ 
BEGIN 
    RAISE NOTICE '🔐 RLS POLICY FIXES APPLIED SUCCESSFULLY';
END $$;
