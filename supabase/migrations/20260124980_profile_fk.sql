-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔗 ADD PROFILE FK RELATIONSHIPS FOR POSTGREST JOINS
-- ═══════════════════════════════════════════════════════════════════════════════

-- club_activity needs FK to profiles for PostgREST joins
ALTER TABLE club_activity 
DROP CONSTRAINT IF EXISTS club_activity_user_id_fkey;

ALTER TABLE club_activity
ADD CONSTRAINT club_activity_profiles_fkey
FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- club_announcements needs FK to profiles for author joins
ALTER TABLE club_announcements
DROP CONSTRAINT IF EXISTS club_announcements_author_id_fkey;

ALTER TABLE club_announcements
ADD CONSTRAINT club_announcements_profiles_fkey
FOREIGN KEY (author_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- Ensure club_activity has message column (referenced in query)
ALTER TABLE club_activity ADD COLUMN IF NOT EXISTS message TEXT;

-- Ensure club_activity has data column (referenced in query)
ALTER TABLE club_activity ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}';

DO $$ BEGIN RAISE NOTICE '🔗 PROFILE FK RELATIONSHIPS ADDED'; END $$;
