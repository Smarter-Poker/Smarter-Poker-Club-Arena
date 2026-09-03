-- ═══════════════════════════════════════════════════════════════════════════════
-- 📋 MISSING TABLES — Phase 2 Creation
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Creates all tables identified as missing from the comprehensive audit.
-- These tables are queried by frontend services but were not yet in Supabase.
--
-- Created: 2026-01-24
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. PLAYER STATS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS player_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    
    -- Volume stats
    total_hands INTEGER DEFAULT 0,
    hands_won INTEGER DEFAULT 0,
    hands_lost INTEGER DEFAULT 0,
    showdowns_won INTEGER DEFAULT 0,
    showdowns_total INTEGER DEFAULT 0,
    
    -- Playing style
    vpip DECIMAL(5, 4) DEFAULT 0, -- Voluntarily Put $ In Pot
    pfr DECIMAL(5, 4) DEFAULT 0,  -- Pre-Flop Raise %
    aggression_factor DECIMAL(5, 2) DEFAULT 0,
    three_bet_percent DECIMAL(5, 4) DEFAULT 0,
    fold_to_three_bet DECIMAL(5, 4) DEFAULT 0,
    cbet_flop DECIMAL(5, 4) DEFAULT 0,
    cbet_turn DECIMAL(5, 4) DEFAULT 0,
    
    -- Results
    bb_per_100 DECIMAL(10, 2) DEFAULT 0,
    total_profit DECIMAL(18, 2) DEFAULT 0,
    biggest_pot_won DECIMAL(18, 2) DEFAULT 0,
    biggest_pot_lost DECIMAL(18, 2) DEFAULT 0,
    
    -- Time
    hours_played DECIMAL(10, 2) DEFAULT 0,
    avg_session_length DECIMAL(10, 2) DEFAULT 0,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_player_stats_user ON player_stats(user_id);

-- RLS
ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY player_stats_self ON player_stats
    FOR ALL USING (user_id = auth.uid());

CREATE POLICY player_stats_view ON player_stats
    FOR SELECT USING (true); -- Anyone can view stats

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. TABLE CHIP LOCKS (chips locked at tables)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS table_chip_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
    locked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id, table_id)
);

CREATE INDEX IF NOT EXISTS idx_chip_locks_user ON table_chip_locks(user_id);
CREATE INDEX IF NOT EXISTS idx_chip_locks_table ON table_chip_locks(table_id);

-- RLS
ALTER TABLE table_chip_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY chip_locks_self ON table_chip_locks
    FOR ALL USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. TABLE WAITLISTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS table_waitlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    preferred_seat INTEGER,
    status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'called', 'seated', 'expired', 'cancelled')),
    called_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_table ON table_waitlists(table_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_user ON table_waitlists(user_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON table_waitlists(status);

-- RLS
ALTER TABLE table_waitlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY waitlist_self ON table_waitlists
    FOR ALL USING (user_id = auth.uid());

CREATE POLICY waitlist_view ON table_waitlists
    FOR SELECT USING (true); -- Anyone can see waitlist

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. PROMOTIONS TABLE (must come before enrollments/leaderboards)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID REFERENCES clubs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'leaderboard' CHECK (type IN ('leaderboard', 'rake_race', 'milestone', 'mystery', 'high_hand')),
    
    -- Timing
    start_date TIMESTAMP WITH TIME ZONE NOT NULL,
    end_date TIMESTAMP WITH TIME ZONE NOT NULL,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'active', 'paused', 'completed', 'cancelled')),
    
    -- Requirements
    min_stakes TEXT,
    game_types TEXT[] DEFAULT ARRAY['NLH'],
    opt_in_required BOOLEAN DEFAULT false,
    
    -- Prizes
    prize_pool DECIMAL(18, 2) DEFAULT 0,
    prize_structure JSONB DEFAULT '[]',
    
    -- Display
    banner_url TEXT,
    is_featured BOOLEAN DEFAULT false,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotions_club ON promotions(club_id);
CREATE INDEX IF NOT EXISTS idx_promotions_status ON promotions(status);
CREATE INDEX IF NOT EXISTS idx_promotions_dates ON promotions(start_date, end_date);

-- RLS
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

CREATE POLICY promotions_view ON promotions
    FOR SELECT USING (true); -- Anyone can view promotions

CREATE POLICY promotions_admin ON promotions
    FOR ALL USING (
        club_id IS NULL 
        OR club_id IN (SELECT id FROM clubs WHERE owner_id = auth.uid())
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. PROMOTION ENROLLMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS promotion_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'forfeited')),
    progress JSONB DEFAULT '{}',
    reward_claimed BOOLEAN DEFAULT FALSE,
    reward_claimed_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id, promotion_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_enrollment_user ON promotion_enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_promo_enrollment_promo ON promotion_enrollments(promotion_id);

-- RLS
ALTER TABLE promotion_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY promo_enrollment_self ON promotion_enrollments
    FOR ALL USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. PROMOTION LEADERBOARDS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS promotion_leaderboards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    score DECIMAL(18, 2) DEFAULT 0,
    rank INTEGER,
    hands_played INTEGER DEFAULT 0,
    qualifying_hands INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(promotion_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_lb_promo ON promotion_leaderboards(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promo_lb_rank ON promotion_leaderboards(promotion_id, rank);

-- RLS
ALTER TABLE promotion_leaderboards ENABLE ROW LEVEL SECURITY;

CREATE POLICY promo_lb_view ON promotion_leaderboards
    FOR SELECT USING (true); -- Public leaderboards

CREATE POLICY promo_lb_self ON promotion_leaderboards
    FOR ALL USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. RAKE RECORDS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rake_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hand_id UUID,
    table_id UUID REFERENCES tables(id) ON DELETE SET NULL,
    club_id UUID REFERENCES clubs(id) ON DELETE SET NULL,
    rake_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
    bbj_contribution DECIMAL(18, 4) DEFAULT 0,
    pot_size DECIMAL(18, 4),
    num_players INTEGER,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rake_records_table ON rake_records(table_id);
CREATE INDEX IF NOT EXISTS idx_rake_records_club ON rake_records(club_id);
CREATE INDEX IF NOT EXISTS idx_rake_records_date ON rake_records(created_at);

-- RLS
ALTER TABLE rake_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY rake_records_club_owner ON rake_records
    FOR SELECT USING (
        club_id IN (SELECT id FROM clubs WHERE owner_id = auth.uid())
        OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. VIP FEATURE USAGE TRACKING
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vip_feature_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    feature TEXT NOT NULL,
    usage_count INTEGER DEFAULT 0,
    daily_usage INTEGER DEFAULT 0,
    last_used_at TIMESTAMP WITH TIME ZONE,
    last_reset_at DATE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id, feature)
);

CREATE INDEX IF NOT EXISTS idx_vip_usage_user ON vip_feature_usage(user_id);

-- RLS
ALTER TABLE vip_feature_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY vip_usage_self ON vip_feature_usage
    FOR ALL USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. TRAINING PROGRESS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS training_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    hands_played INTEGER DEFAULT 0,
    correct_answers INTEGER DEFAULT 0,
    total_answers INTEGER DEFAULT 0,
    best_streak INTEGER DEFAULT 0,
    current_streak INTEGER DEFAULT 0,
    last_played_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_training_progress_user ON training_progress(user_id);

-- RLS
ALTER TABLE training_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY training_progress_self ON training_progress
    FOR ALL USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. ARENA SESSIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS arena_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    hands_played INTEGER DEFAULT 0,
    correct_answers INTEGER DEFAULT 0,
    total_questions INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arena_sessions_user ON arena_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_arena_sessions_game ON arena_sessions(game_id);

-- RLS
ALTER TABLE arena_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY arena_sessions_self ON arena_sessions
    FOR ALL USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. HORSES (Bot players for Hydra system)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS horses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    avatar_url TEXT,
    skill_level INTEGER DEFAULT 5 CHECK (skill_level BETWEEN 1 AND 10),
    play_style TEXT DEFAULT 'balanced' CHECK (play_style IN ('tight', 'loose', 'aggressive', 'passive', 'balanced')),
    supported_games TEXT[] DEFAULT ARRAY['NLH'],
    status TEXT DEFAULT 'available' CHECK (status IN ('available', 'playing', 'maintenance')),
    current_table_id UUID REFERENCES tables(id) ON DELETE SET NULL,
    
    -- Stats
    hands_played INTEGER DEFAULT 0,
    total_profit DECIMAL(18, 2) DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_horses_status ON horses(status);
CREATE INDEX IF NOT EXISTS idx_horses_games ON horses USING GIN (supported_games);

-- RLS
ALTER TABLE horses ENABLE ROW LEVEL SECURITY;

CREATE POLICY horses_view ON horses
    FOR SELECT USING (true); -- Anyone can see horses

CREATE POLICY horses_admin ON horses
    FOR ALL USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. TABLE SEATS (add horse_id and scheduled leave)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add horse_id column if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'table_seats' AND column_name = 'horse_id') THEN
        ALTER TABLE table_seats ADD COLUMN horse_id UUID REFERENCES horses(id) ON DELETE SET NULL;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'table_seats' AND column_name = 'scheduled_leave_hands') THEN
        ALTER TABLE table_seats ADD COLUMN scheduled_leave_hands INTEGER;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'table_seats' AND column_name = 'left_at') THEN
        ALTER TABLE table_seats ADD COLUMN left_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. PLAYER NOTES — SKIP (already exists in 202601242301_vip_usage_and_settings.sql)
-- The existing table uses user_id/target_user_id columns, not author_id/target_player_id
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. ADD MISSING COLUMNS TO PROFILES
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'profiles' AND column_name = 'last_daily_claim') THEN
        ALTER TABLE profiles ADD COLUMN last_daily_claim TIMESTAMP WITH TIME ZONE;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'profiles' AND column_name = 'login_streak') THEN
        ALTER TABLE profiles ADD COLUMN login_streak INTEGER DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'profiles' AND column_name = 'referred_by_agent') THEN
        ALTER TABLE profiles ADD COLUMN referred_by_agent UUID REFERENCES agents(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 14. ADD MISSING COLUMNS TO AGENTS
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'agents' AND column_name = 'promo_balance') THEN
        ALTER TABLE agents ADD COLUMN promo_balance DECIMAL(18, 2) DEFAULT 0;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 15. ADD MISSING COLUMNS TO CLUBS
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'clubs' AND column_name = 'chip_treasury') THEN
        ALTER TABLE clubs ADD COLUMN chip_treasury DECIMAL(18, 2) DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'clubs' AND column_name = 'total_rake') THEN
        ALTER TABLE clubs ADD COLUMN total_rake DECIMAL(18, 2) DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'clubs' AND column_name = 'online_count') THEN
        ALTER TABLE clubs ADD COLUMN online_count INTEGER DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'clubs' AND column_name = 'game_types') THEN
        ALTER TABLE clubs ADD COLUMN game_types TEXT[] DEFAULT ARRAY['NLH'];
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'clubs' AND column_name = 'is_public') THEN
        ALTER TABLE clubs ADD COLUMN is_public BOOLEAN DEFAULT true;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE — All missing tables and columns created
-- ═══════════════════════════════════════════════════════════════════════════════
