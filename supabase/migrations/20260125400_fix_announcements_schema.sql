-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 FIX CLUB ANNOUNCEMENTS SCHEMA + MEMBERSHIPS TABLE NAME
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add missing columns to club_announcements that ClubAnnouncementBanner expects
ALTER TABLE club_announcements ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE club_announcements ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'info';
ALTER TABLE club_announcements ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE club_announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE club_announcements ADD COLUMN IF NOT EXISTS created_by UUID;

-- Copy content to message if message is null
UPDATE club_announcements SET message = content WHERE message IS NULL;
UPDATE club_announcements SET created_by = author_id WHERE created_by IS NULL;

-- Create FK for created_by -> profiles if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'club_announcements_created_by_fkey'
    ) THEN
        ALTER TABLE club_announcements
        ADD CONSTRAINT club_announcements_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
    END IF;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'FK already exists or failed: %', SQLERRM;
END $$;

-- Create view for backwards compatibility of club_memberships
CREATE OR REPLACE VIEW club_memberships AS
SELECT * FROM club_members;

DO $$ BEGIN RAISE NOTICE '🔧 CLUB ANNOUNCEMENTS SCHEMA FIXED'; END $$;
