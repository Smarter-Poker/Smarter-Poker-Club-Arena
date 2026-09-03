-- ═══════════════════════════════════════════════════════════════════════════════
-- 🏆 ACHIEVEMENTS SYSTEM — Extensions & Functions
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Extends existing achievements system with additional columns and functions
-- The base achievements table exists in 013_missing_tables.sql
--
-- Created: 2026-01-24
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. ADD MISSING COLUMNS TO ACHIEVEMENTS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN
    -- Add requirement_type if missing (for count, streak, milestone, special)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'achievements' AND column_name = 'requirement_type') THEN
        ALTER TABLE achievements ADD COLUMN requirement_type TEXT DEFAULT 'count';
    END IF;
    
    -- Add requirement_value if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'achievements' AND column_name = 'requirement_value') THEN
        ALTER TABLE achievements ADD COLUMN requirement_value INTEGER DEFAULT 1;
    END IF;
    
    -- Add chip_reward if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'achievements' AND column_name = 'chip_reward') THEN
        ALTER TABLE achievements ADD COLUMN chip_reward DECIMAL(18, 2) DEFAULT 0;
    END IF;
    
    -- Add diamond_reward if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'achievements' AND column_name = 'diamond_reward') THEN
        ALTER TABLE achievements ADD COLUMN diamond_reward INTEGER DEFAULT 0;
    END IF;
    
    -- Add sort_order if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'achievements' AND column_name = 'sort_order') THEN
        ALTER TABLE achievements ADD COLUMN sort_order INTEGER DEFAULT 0;
    END IF;
    
    -- Add is_hidden if missing (for secret achievements)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'achievements' AND column_name = 'is_hidden') THEN
        ALTER TABLE achievements ADD COLUMN is_hidden BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ADD MISSING COLUMNS TO USER_ACHIEVEMENTS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN
    -- Add is_unlocked if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_achievements' AND column_name = 'is_unlocked') THEN
        ALTER TABLE user_achievements ADD COLUMN is_unlocked BOOLEAN DEFAULT FALSE;
    END IF;
    
    -- Add rewards_claimed if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_achievements' AND column_name = 'rewards_claimed') THEN
        ALTER TABLE user_achievements ADD COLUMN rewards_claimed BOOLEAN DEFAULT FALSE;
    END IF;
    
    -- Add rewards_claimed_at if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_achievements' AND column_name = 'rewards_claimed_at') THEN
        ALTER TABLE user_achievements ADD COLUMN rewards_claimed_at TIMESTAMP WITH TIME ZONE;
    END IF;
    
    -- Add updated_at if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_achievements' AND column_name = 'updated_at') THEN
        ALTER TABLE user_achievements ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    END IF;
END $$;

-- Set is_unlocked from unlocked_at for existing records
UPDATE user_achievements SET is_unlocked = true WHERE unlocked_at IS NOT NULL AND is_unlocked = false;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. ACHIEVEMENT UNLOCK FUNCTION
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION unlock_achievement(
    p_user_id UUID,
    p_achievement_id UUID
)
RETURNS JSONB AS $$
DECLARE
    v_achievement RECORD;
    v_user_progress RECORD;
BEGIN
    -- Get achievement details
    SELECT * INTO v_achievement FROM achievements WHERE id = p_achievement_id;
    
    IF v_achievement IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Achievement not found');
    END IF;
    
    -- Check if already unlocked
    SELECT * INTO v_user_progress 
    FROM user_achievements 
    WHERE user_id = p_user_id AND achievement_id = p_achievement_id;
    
    IF v_user_progress IS NOT NULL AND 
       (v_user_progress.unlocked_at IS NOT NULL OR v_user_progress.is_unlocked = true) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Already unlocked');
    END IF;
    
    -- Insert or update progress
    INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at, is_unlocked)
    VALUES (p_user_id, p_achievement_id, COALESCE(v_achievement.max_progress, 1), NOW(), true)
    ON CONFLICT (user_id, achievement_id) DO UPDATE SET
        progress = COALESCE(v_achievement.max_progress, 1),
        unlocked_at = NOW(),
        is_unlocked = true,
        updated_at = NOW();
    
    -- Award XP
    IF COALESCE(v_achievement.xp_reward, 0) > 0 THEN
        UPDATE profiles SET xp = COALESCE(xp, 0) + v_achievement.xp_reward WHERE id = p_user_id;
    END IF;
    
    RETURN jsonb_build_object(
        'success', true,
        'achievement', v_achievement.name,
        'icon', v_achievement.icon,
        'xp_reward', COALESCE(v_achievement.xp_reward, 0)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. UPDATE ACHIEVEMENT PROGRESS FUNCTION
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_achievement_progress(
    p_user_id UUID,
    p_achievement_id UUID,
    p_progress_delta INTEGER DEFAULT 1
)
RETURNS JSONB AS $$
DECLARE
    v_achievement RECORD;
    v_current_progress INTEGER;
    v_new_progress INTEGER;
    v_unlocked BOOLEAN := FALSE;
BEGIN
    -- Get achievement details
    SELECT * INTO v_achievement FROM achievements WHERE id = p_achievement_id;
    
    IF v_achievement IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Achievement not found');
    END IF;
    
    -- Get or create user achievement record
    INSERT INTO user_achievements (user_id, achievement_id, progress)
    VALUES (p_user_id, p_achievement_id, 0)
    ON CONFLICT (user_id, achievement_id) DO NOTHING;
    
    SELECT progress INTO v_current_progress
    FROM user_achievements
    WHERE user_id = p_user_id AND achievement_id = p_achievement_id;
    
    -- Calculate new progress
    v_new_progress := LEAST(COALESCE(v_current_progress, 0) + p_progress_delta, COALESCE(v_achievement.max_progress, 1));
    
    -- Check if should unlock
    IF v_new_progress >= COALESCE(v_achievement.max_progress, 1) THEN
        v_unlocked := TRUE;
        UPDATE user_achievements SET
            progress = v_new_progress,
            is_unlocked = true,
            unlocked_at = NOW(),
            updated_at = NOW()
        WHERE user_id = p_user_id AND achievement_id = p_achievement_id;
        
        -- Award XP
        IF COALESCE(v_achievement.xp_reward, 0) > 0 THEN
            UPDATE profiles SET xp = COALESCE(xp, 0) + v_achievement.xp_reward WHERE id = p_user_id;
        END IF;
    ELSE
        UPDATE user_achievements SET
            progress = v_new_progress,
            updated_at = NOW()
        WHERE user_id = p_user_id AND achievement_id = p_achievement_id;
    END IF;
    
    RETURN jsonb_build_object(
        'success', true,
        'progress', v_new_progress,
        'max_progress', COALESCE(v_achievement.max_progress, 1),
        'unlocked', v_unlocked
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE — Achievements system extensions complete
-- ═══════════════════════════════════════════════════════════════════════════════
