-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 SCHEMA FIX MIGRATION
-- ═══════════════════════════════════════════════════════════════════════════════
-- Adds missing columns referenced by services
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Add color_theme to clubs if not exists
DO $$ BEGIN
    ALTER TABLE clubs ADD COLUMN color_theme TEXT DEFAULT 'royal-blue';
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 2. Add is_read to notifications if not exists  
DO $$ BEGIN
    ALTER TABLE notifications ADD COLUMN is_read BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 3. Create tables table if not exists (for poker tables)
CREATE TABLE IF NOT EXISTS tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL,
    name TEXT NOT NULL,
    game_type TEXT DEFAULT 'nlhe',
    stakes TEXT,
    small_blind DECIMAL(15,2) DEFAULT 1,
    big_blind DECIMAL(15,2) DEFAULT 2,
    min_buy_in DECIMAL(15,2) DEFAULT 40,
    max_buy_in DECIMAL(15,2) DEFAULT 200,
    max_players INTEGER DEFAULT 9,
    current_players INTEGER DEFAULT 0,
    status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'running', 'paused', 'closed')),
    is_private BOOLEAN DEFAULT FALSE,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tables_club ON tables(club_id);
CREATE INDEX IF NOT EXISTS idx_tables_status ON tables(status);

-- 4. Create messages table if not exists
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL,
    recipient_id UUID,
    club_id UUID,
    content TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_club ON messages(club_id);

-- 5. Create club_activity table if not exists
CREATE TABLE IF NOT EXISTS club_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL,
    user_id UUID,
    action TEXT NOT NULL,
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_club_activity_club ON club_activity(club_id);
CREATE INDEX IF NOT EXISTS idx_club_activity_created ON club_activity(created_at DESC);

-- 6. Create user_achievements table if not exists
CREATE TABLE IF NOT EXISTS user_achievements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    achievement_id UUID NOT NULL,
    progress INTEGER DEFAULT 0,
    unlocked_at TIMESTAMPTZ,
    notified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);

-- 7. Create player_stats table if not exists (for leaderboards)
CREATE TABLE IF NOT EXISTS player_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    club_id UUID,
    hands_played INTEGER DEFAULT 0,
    total_winnings DECIMAL(15,2) DEFAULT 0,
    total_losses DECIMAL(15,2) DEFAULT 0,
    total_rake DECIMAL(15,2) DEFAULT 0,
    vpip DECIMAL(5,2) DEFAULT 0,
    pfr DECIMAL(5,2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, club_id)
);

CREATE INDEX IF NOT EXISTS idx_player_stats_user ON player_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_player_stats_club ON player_stats(club_id);

-- 8. Create player_presence table for online status
CREATE TABLE IF NOT EXISTS player_presence (
    user_id UUID PRIMARY KEY,
    status TEXT DEFAULT 'offline',
    table_id UUID,
    last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Add diamonds column to profiles if missing
DO $$ BEGIN
    ALTER TABLE profiles ADD COLUMN diamonds INTEGER DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 10. RLS policies for new tables
ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_achievements ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_presence ENABLE ROW LEVEL SECURITY;

-- Tables: Club members can view
CREATE POLICY "Club members can view tables" ON tables
    FOR SELECT USING (true);

-- Messages: Users can see own
CREATE POLICY "Users can view own messages" ON messages
    FOR SELECT USING (sender_id = auth.uid() OR recipient_id = auth.uid());

-- Club Activity: Club members can view
CREATE POLICY "Club members can view activity" ON club_activity
    FOR SELECT USING (true);

-- User Achievements: Users can view own
CREATE POLICY "Users can view own achievements" ON user_achievements
    FOR SELECT USING (user_id = auth.uid());

-- Player Stats: Public for leaderboards
CREATE POLICY "Player stats are public" ON player_stats
    FOR SELECT USING (true);

-- Presence: Public
CREATE POLICY "Presence is public" ON player_presence
    FOR SELECT USING (true);

DO $$ 
BEGIN 
    RAISE NOTICE '🔧 SCHEMA FIX MIGRATION APPLIED SUCCESSFULLY';
END $$;

-- 11. Add slug column to clubs if not exists
DO $$ BEGIN
    ALTER TABLE clubs ADD COLUMN slug TEXT;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- Create unique index on slug
CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_slug ON clubs(slug) WHERE slug IS NOT NULL;
