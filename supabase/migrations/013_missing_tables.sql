-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ CLUB ARENA — Missing Tables Migration
-- ═══════════════════════════════════════════════════════════════════════════════
-- Creates tables needed by UI that were not in original schema
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- PROFILES (User XP, VIP, streak tracking)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT UNIQUE,
    display_name TEXT,
    avatar_url TEXT,
    player_number INTEGER DEFAULT (1000 + floor(random() * 99000)::int),
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    vip_level TEXT DEFAULT 'bronze' CHECK (vip_level IN ('bronze', 'silver', 'gold', 'platinum', 'diamond')),
    streak_days INTEGER DEFAULT 0,
    last_login TIMESTAMPTZ,
    stats JSONB DEFAULT '{}'::jsonb,
    settings JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_vip ON profiles(vip_level);

-- ═══════════════════════════════════════════════════════════════════════════════
-- NOTIFICATIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TYPE notification_type AS ENUM (
    'club_invite', 'agent_invite', 'message', 'table_ready', 'tournament_start',
    'settlement', 'achievement', 'bonus', 'system', 'friend_request'
);

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type notification_type NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    data JSONB DEFAULT '{}'::jsonb,
    is_read BOOLEAN DEFAULT FALSE,
    action_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_date ON notifications(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- MESSAGES (Direct messaging)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID NOT NULL REFERENCES auth.users(id),
    recipient_id UUID NOT NULL REFERENCES auth.users(id),
    club_id UUID REFERENCES clubs(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_club ON messages(club_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(recipient_id, is_read) WHERE is_read = FALSE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ACHIEVEMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS achievements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    icon TEXT DEFAULT '🏆',
    category TEXT DEFAULT 'general',
    max_progress INTEGER DEFAULT 1,
    xp_reward INTEGER DEFAULT 0,
    is_secret BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_achievements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    progress INTEGER DEFAULT 0,
    unlocked_at TIMESTAMPTZ,
    notified BOOLEAN DEFAULT FALSE,
    UNIQUE(user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_user_achievements_unlocked ON user_achievements(unlocked_at) WHERE unlocked_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- BONUSES (Daily/Special)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS special_bonuses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    reward TEXT NOT NULL,
    bonus_type TEXT DEFAULT 'special',
    expires_at TIMESTAMPTZ NOT NULL,
    claimed BOOLEAN DEFAULT FALSE,
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_special_bonuses_user ON special_bonuses(user_id);
CREATE INDEX IF NOT EXISTS idx_special_bonuses_active ON special_bonuses(user_id, expires_at) WHERE claimed = FALSE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PLAYER REPORTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TYPE report_status AS ENUM ('pending', 'reviewing', 'resolved', 'dismissed');

CREATE TABLE IF NOT EXISTS player_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reporter_id UUID NOT NULL REFERENCES auth.users(id),
    reported_player_id UUID NOT NULL REFERENCES auth.users(id),
    reason TEXT NOT NULL,
    description TEXT,
    hand_id UUID REFERENCES hands(id),
    include_chat_logs BOOLEAN DEFAULT FALSE,
    status report_status DEFAULT 'pending',
    admin_notes TEXT,
    resolved_by UUID REFERENCES auth.users(id),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_reports_reporter ON player_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_player_reports_reported ON player_reports(reported_player_id);
CREATE INDEX IF NOT EXISTS idx_player_reports_status ON player_reports(status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUB ANNOUNCEMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS club_announcements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES auth.users(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_pinned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_club_announcements_club ON club_announcements(club_id);
CREATE INDEX IF NOT EXISTS idx_club_announcements_pinned ON club_announcements(club_id, is_pinned) WHERE is_pinned = TRUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE WAITLIST
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS table_waitlist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(table_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_table_waitlist_table ON table_waitlist(table_id);
CREATE INDEX IF NOT EXISTS idx_table_waitlist_user ON table_waitlist(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TRANSACTIONS (General purpose)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    club_id UUID REFERENCES clubs(id),
    type TEXT NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    currency TEXT DEFAULT 'chips',
    description TEXT,
    reference_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_club ON transactions(club_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUB FINANCIAL SUMMARY
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS club_financial_summary (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    period TEXT NOT NULL, -- 'week', 'month', 'all'
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    rake_collected DECIMAL(15, 2) DEFAULT 0,
    rakeback_paid DECIMAL(15, 2) DEFAULT 0,
    agent_commissions DECIMAL(15, 2) DEFAULT 0,
    union_fees DECIMAL(15, 2) DEFAULT 0,
    net_revenue DECIMAL(15, 2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(club_id, period)
);

CREATE INDEX IF NOT EXISTS idx_club_financial_club ON club_financial_summary(club_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUB TRANSACTIONS (for ClubFinancialsPage)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS club_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    description TEXT,
    reference_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_club_transactions_club ON club_transactions(club_id);
CREATE INDEX IF NOT EXISTS idx_club_transactions_date ON club_transactions(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PROMOTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TYPE promotion_type AS ENUM ('freeroll', 'bonus', 'rakeback', 'tournament', 'leaderboard', 'other');

CREATE TABLE IF NOT EXISTS promotions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID REFERENCES clubs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    type promotion_type DEFAULT 'other',
    image_url TEXT,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE,
    terms TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotions_club ON promotions(club_id);
CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(is_active, ends_at);

-- ═══════════════════════════════════════════════════════════════════════════════
-- DIAMOND WALLETS (for VIP/economy)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS diamond_wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    balance INTEGER DEFAULT 0,
    lifetime_earned INTEGER DEFAULT 0,
    lifetime_spent INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_diamond_wallets_user ON diamond_wallets(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- RPC FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Claim daily bonus
CREATE OR REPLACE FUNCTION claim_daily_bonus(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_last_login TIMESTAMPTZ;
    v_streak INTEGER;
BEGIN
    SELECT last_login, streak_days INTO v_last_login, v_streak
    FROM profiles WHERE id = p_user_id;
    
    -- Check if already claimed today
    IF v_last_login IS NOT NULL AND v_last_login::date = CURRENT_DATE THEN
        RETURN FALSE;
    END IF;
    
    -- Update streak
    IF v_last_login IS NOT NULL AND v_last_login::date = (CURRENT_DATE - INTERVAL '1 day')::date THEN
        v_streak := COALESCE(v_streak, 0) + 1;
    ELSE
        v_streak := 1;
    END IF;
    
    -- Cap at 7 for cycle
    IF v_streak > 7 THEN v_streak := 1; END IF;
    
    -- Update profile
    UPDATE profiles
    SET streak_days = v_streak,
        last_login = NOW(),
        xp = xp + (v_streak * 10)
    WHERE id = p_user_id;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment member count
CREATE OR REPLACE FUNCTION increment_member_count(p_club_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE clubs
    SET updated_at = NOW()
    WHERE id = p_club_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get waitlist position
CREATE OR REPLACE FUNCTION get_waitlist_position(p_table_id UUID, p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_position INTEGER;
BEGIN
    SELECT position INTO v_position
    FROM table_waitlist
    WHERE table_id = p_table_id AND user_id = p_user_id;
    
    RETURN COALESCE(v_position, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Join waitlist
CREATE OR REPLACE FUNCTION join_waitlist(p_table_id UUID, p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_max_position INTEGER;
    v_new_position INTEGER;
BEGIN
    SELECT COALESCE(MAX(position), 0) INTO v_max_position
    FROM table_waitlist WHERE table_id = p_table_id;
    
    v_new_position := v_max_position + 1;
    
    INSERT INTO table_waitlist (table_id, user_id, position)
    VALUES (p_table_id, p_user_id, v_new_position)
    ON CONFLICT (table_id, user_id) DO NOTHING;
    
    RETURN v_new_position;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE achievements ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_achievements ENABLE ROW LEVEL SECURITY;
ALTER TABLE special_bonuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_financial_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE diamond_wallets ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can see all profiles, but only edit their own
CREATE POLICY "Public profiles are viewable by everyone" ON profiles FOR SELECT USING (true);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (id = auth.uid());
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (id = auth.uid());

-- Notifications: Users can only see their own
CREATE POLICY "Users can view own notifications" ON notifications FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can update own notifications" ON notifications FOR UPDATE USING (user_id = auth.uid());

-- Messages: Users can see messages they sent or received
CREATE POLICY "Users can view own messages" ON messages FOR SELECT USING (sender_id = auth.uid() OR recipient_id = auth.uid());
CREATE POLICY "Users can send messages" ON messages FOR INSERT WITH CHECK (sender_id = auth.uid());

-- Achievements: Public
CREATE POLICY "Achievements are public" ON achievements FOR SELECT USING (true);

-- User Achievements: Users can see their own
CREATE POLICY "Users can view own achievements" ON user_achievements FOR SELECT USING (user_id = auth.uid());

-- Bonuses: Users can see their own
CREATE POLICY "Users can view own bonuses" ON special_bonuses FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can update own bonuses" ON special_bonuses FOR UPDATE USING (user_id = auth.uid());

-- Reports: Users can see their own reports
CREATE POLICY "Users can view own reports" ON player_reports FOR SELECT USING (reporter_id = auth.uid());
CREATE POLICY "Users can submit reports" ON player_reports FOR INSERT WITH CHECK (reporter_id = auth.uid());

-- Announcements: Club members can see
CREATE POLICY "Club members can view announcements" ON club_announcements FOR SELECT USING (
    club_id IN (SELECT club_id FROM club_members WHERE user_id = auth.uid())
);

-- Waitlist: Users can see their own
CREATE POLICY "Users can view own waitlist entries" ON table_waitlist FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can join waitlist" ON table_waitlist FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can leave waitlist" ON table_waitlist FOR DELETE USING (user_id = auth.uid());

-- Transactions: Users can see their own
CREATE POLICY "Users can view own transactions" ON transactions FOR SELECT USING (user_id = auth.uid());

-- Club Financials: Club owners/admins
CREATE POLICY "Club admins can view financials" ON club_financial_summary FOR SELECT USING (
    club_id IN (SELECT club_id FROM club_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin'))
);

-- Club Transactions: Club owners/admins
CREATE POLICY "Club admins can view club transactions" ON club_transactions FOR SELECT USING (
    club_id IN (SELECT club_id FROM club_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin'))
);

-- Promotions: Active promotions are public
CREATE POLICY "Active promotions are viewable" ON promotions FOR SELECT USING (is_active = true);

-- Diamond Wallets: Users can see their own
CREATE POLICY "Users can view own wallet" ON diamond_wallets FOR SELECT USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- REALTIME
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE table_waitlist;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SEED DEFAULT ACHIEVEMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO achievements (name, description, icon, category, max_progress, xp_reward) VALUES
    ('First Hand', 'Play your first hand of poker', '🃏', 'getting_started', 1, 10),
    ('High Roller', 'Win a pot worth 100+ big blinds', '💰', 'cash_game', 1, 50),
    ('Table Captain', 'Win 10 hands in a single session', '👑', 'cash_game', 10, 100),
    ('Tournament Victor', 'Win your first tournament', '🏆', 'tournament', 1, 200),
    ('Social Butterfly', 'Add 5 friends', '🦋', 'social', 5, 25),
    ('Regular', 'Login 7 days in a row', '🔥', 'engagement', 7, 100),
    ('VIP Bronze', 'Reach Bronze VIP status', '🥉', 'vip', 1, 0),
    ('VIP Silver', 'Reach Silver VIP status', '🥈', 'vip', 1, 0),
    ('VIP Gold', 'Reach Gold VIP status', '🥇', 'vip', 1, 0),
    ('VIP Diamond', 'Reach Diamond VIP status', '💎', 'vip', 1, 0)
ON CONFLICT (name) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SUCCESS
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN 
    RAISE NOTICE '♠ CLUB ARENA MISSING TABLES MIGRATION COMPLETE';
END $$;
