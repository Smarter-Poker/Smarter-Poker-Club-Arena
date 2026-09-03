-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ CLUB ARENA — User Preferences Migration
-- ═══════════════════════════════════════════════════════════════════════════════
-- Adds user preference fields for hamburger menu toggles and settings
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add preference fields to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sounds_enabled BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vibrations_enabled BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tutorial_completed BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

-- Add comment for documentation
COMMENT ON COLUMN profiles.sounds_enabled IS 'User preference for sound effects (hamburger menu toggle)';
COMMENT ON COLUMN profiles.vibrations_enabled IS 'User preference for vibrations (hamburger menu toggle)';
COMMENT ON COLUMN profiles.tutorial_completed IS 'Whether user has completed the tutorial';
COMMENT ON COLUMN profiles.language IS 'User preferred language (en, es, fr, etc.)';

-- ═══════════════════════════════════════════════════════════════════════════════
-- SUCCESS
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN 
    RAISE NOTICE '♠ USER PREFERENCES MIGRATION COMPLETE';
END $$;
