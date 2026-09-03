-- ════════════════════════════════════════════════════════════════════════════════
-- 📆 Daily Challenges Schema
-- ════════════════════════════════════════════════════════════════════════════════

-- User Daily Challenges (tracks assigned challenges and progress)
CREATE TABLE IF NOT EXISTS user_daily_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    challenge_id TEXT NOT NULL,
    assigned_date DATE NOT NULL DEFAULT CURRENT_DATE,
    progress INTEGER NOT NULL DEFAULT 0,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Unique constraint: one challenge per user per day
    UNIQUE(user_id, challenge_id, assigned_date)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_daily_challenges_user_date 
    ON user_daily_challenges(user_id, assigned_date);
CREATE INDEX IF NOT EXISTS idx_user_daily_challenges_completed 
    ON user_daily_challenges(user_id, completed);

-- RLS Policies
ALTER TABLE user_daily_challenges ENABLE ROW LEVEL SECURITY;

-- Users can view their own challenges
CREATE POLICY "Users can view own challenges" ON user_daily_challenges
    FOR SELECT USING (auth.uid() = user_id);

-- Users can update their own challenges (progress)
CREATE POLICY "Users can update own challenges" ON user_daily_challenges
    FOR UPDATE USING (auth.uid() = user_id);

-- System can insert challenges for any user
CREATE POLICY "Service can insert challenges" ON user_daily_challenges
    FOR INSERT WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════════════════════
-- Player Stats (for tracking totals used in achievements)
-- ════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS player_stats (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    hands_played INTEGER NOT NULL DEFAULT 0,
    total_wins INTEGER NOT NULL DEFAULT 0,
    showdowns INTEGER NOT NULL DEFAULT 0,
    tournaments_played INTEGER NOT NULL DEFAULT 0,
    tournament_wins INTEGER NOT NULL DEFAULT 0,
    friends_count INTEGER NOT NULL DEFAULT 0,
    login_streak INTEGER NOT NULL DEFAULT 0,
    last_login_date DATE,
    total_xp INTEGER NOT NULL DEFAULT 0,
    total_chips_won DECIMAL(15, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS for player stats
ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own stats" ON player_stats
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own stats" ON player_stats
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "System can insert stats" ON player_stats
    FOR INSERT WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════════════════════
-- XP Addition RPC (used by achievement and challenge rewards)
-- ════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION add_player_xp(
    p_user_id UUID,
    p_amount INTEGER,
    p_reason TEXT DEFAULT NULL
) RETURNS INTEGER AS $$
DECLARE
    v_new_xp INTEGER;
BEGIN
    -- Upsert player stats and add XP
    INSERT INTO player_stats (user_id, total_xp)
    VALUES (p_user_id, p_amount)
    ON CONFLICT (user_id) DO UPDATE
    SET total_xp = player_stats.total_xp + EXCLUDED.total_xp,
        updated_at = NOW()
    RETURNING total_xp INTO v_new_xp;
    
    RETURN v_new_xp;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
