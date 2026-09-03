-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 FINAL SCHEMA FIXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Add orange_ball_status to club_members if not exists
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN orange_ball_status TEXT DEFAULT 'inactive';
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 2. Add status column to club_members if not exists
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN status TEXT DEFAULT 'active';
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 3. Ensure profiles table has all needed columns
DO $$ BEGIN
    ALTER TABLE profiles ADD COLUMN avatar_url TEXT;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE profiles ADD COLUMN display_name TEXT;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE profiles ADD COLUMN username TEXT;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 4. Clean up test club data that was created
DELETE FROM club_members WHERE club_id IN (SELECT id FROM clubs WHERE name LIKE '%Test Club%');
DELETE FROM clubs WHERE name LIKE '%Test Club%';

DO $$ 
BEGIN 
    RAISE NOTICE '🔧 FINAL SCHEMA FIXES AND TEST CLEANUP APPLIED';
END $$;
