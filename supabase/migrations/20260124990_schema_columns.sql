-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 FIX CLUB SCHEMA COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Ensure club_activity has all required columns
ALTER TABLE club_activity ADD COLUMN IF NOT EXISTS activity_type TEXT;
ALTER TABLE club_activity ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE club_activity ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}';
ALTER TABLE club_activity ADD COLUMN IF NOT EXISTS title TEXT;  

-- Update any null activity_types
UPDATE club_activity SET activity_type = 'system' WHERE activity_type IS NULL;

-- Add username and display_name to profiles if missing (for joins)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Ensure profiles.id FK is correct for club_members
-- First check if constraint exists, if not add it
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'club_members_profiles_fkey'
    ) THEN
        ALTER TABLE club_members 
        ADD CONSTRAINT club_members_profiles_fkey
        FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
    END IF;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'club_members FK may already exist or failed: %', SQLERRM;
END $$;

DO $$ BEGIN RAISE NOTICE '🔧 CLUB SCHEMA COLUMNS FIXED'; END $$;
