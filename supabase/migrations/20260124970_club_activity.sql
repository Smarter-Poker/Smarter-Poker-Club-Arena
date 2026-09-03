-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 CLUB ACTIVITY & ANNOUNCEMENTS SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════════

-- Club Activity Feed (for dashboard activity)
CREATE TABLE IF NOT EXISTS club_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    activity_type TEXT NOT NULL, -- 'member_joined', 'game_started', 'chip_transfer', 'announcement', etc.
    title TEXT NOT NULL,
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Club Announcements
CREATE TABLE IF NOT EXISTS club_announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_pinned BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_club_activity_club_id ON club_activity(club_id);
CREATE INDEX IF NOT EXISTS idx_club_activity_created_at ON club_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_club_announcements_club_id ON club_announcements(club_id);

-- Enable RLS
ALTER TABLE club_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_announcements ENABLE ROW LEVEL SECURITY;

-- RLS Policies for club_activity
DROP POLICY IF EXISTS "Members can view club activity" ON club_activity;
CREATE POLICY "Members can view club activity" ON club_activity
    FOR SELECT USING (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "System can insert activity" ON club_activity;
CREATE POLICY "System can insert activity" ON club_activity
    FOR INSERT WITH CHECK (true);

-- RLS Policies for club_announcements  
DROP POLICY IF EXISTS "Members can view announcements" ON club_announcements;
CREATE POLICY "Members can view announcements" ON club_announcements
    FOR SELECT USING (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Owners can manage announcements" ON club_announcements;
CREATE POLICY "Owners can manage announcements" ON club_announcements
    FOR ALL USING (
        club_id IN (
            SELECT id FROM clubs 
            WHERE owner_id = auth.uid()
        )
    );

DO $$ BEGIN RAISE NOTICE '🔧 CLUB ACTIVITY + ANNOUNCEMENTS TABLES CREATED'; END $$;
