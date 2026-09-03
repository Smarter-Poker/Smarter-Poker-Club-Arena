-- ═══════════════════════════════════════════════════════════════════════════════
-- Gamification Gaps: Lucky Wheel & Missions Enhancements
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. ADD 'claimed' STATE TO DAILY CHALLENGES
ALTER TABLE user_daily_challenges 
ADD COLUMN IF NOT EXISTS claimed BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_daily_challenges_claimed 
ON user_daily_challenges(user_id, claimed);

-- 2. ATOMIC MISSION CLAIM RPC
-- Ensures users cannot double-claim mission rewards
CREATE OR REPLACE FUNCTION claim_daily_challenge(
    p_user_id UUID,
    p_challenge_row_id UUID,
    p_reward_amount NUMERIC
) RETURNS BOOLEAN AS $$
DECLARE
    v_completed BOOLEAN;
    v_claimed BOOLEAN;
BEGIN
    -- Lock row for update
    SELECT completed, claimed INTO v_completed, v_claimed
    FROM user_daily_challenges
    WHERE id = p_challenge_row_id AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Challenge not found';
    END IF;

    IF NOT v_completed THEN
        RAISE EXCEPTION 'Challenge not completed yet';
    END IF;

    IF v_claimed THEN
        RAISE EXCEPTION 'Challenge already claimed';
    END IF;

    -- Mark claimed
    UPDATE user_daily_challenges
    SET claimed = TRUE, claimed_at = NOW()
    WHERE id = p_challenge_row_id;

    -- Credit wallet
    IF p_reward_amount > 0 THEN
        PERFORM credit_player_wallet(p_user_id, p_reward_amount);
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 3. LUCKY WHEEL TRACKING & RNG SPINNER
CREATE TABLE IF NOT EXISTS user_lucky_wheel_spins (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    last_spin_date DATE,
    total_spins INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_lucky_wheel_spins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own wheel spins" ON user_lucky_wheel_spins FOR SELECT USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION claim_lucky_wheel_spin(
    p_user_id UUID
) RETURNS jsonb AS $$
DECLARE
    v_today DATE := CURRENT_DATE;
    v_last_spin DATE;
    v_roll INTEGER;
    v_segment_id TEXT;
    v_reward_type TEXT;
    v_amount NUMERIC;
BEGIN
    -- Safe Atomic Approach
    SELECT last_spin_date INTO v_last_spin FROM user_lucky_wheel_spins WHERE user_id = p_user_id FOR UPDATE;
    
    IF v_last_spin = v_today THEN
        RAISE EXCEPTION 'Already spun today';
    END IF;

    IF v_last_spin IS NULL THEN
        INSERT INTO user_lucky_wheel_spins (user_id, last_spin_date, total_spins)
        VALUES (p_user_id, v_today, 1);
    ELSE
        UPDATE user_lucky_wheel_spins 
        SET last_spin_date = v_today, total_spins = total_spins + 1, updated_at = NOW()
        WHERE user_id = p_user_id;
    END IF;

    -- Roll RNG 1-100
    v_roll := floor(random() * 100 + 1)::int;

    -- Probabilities matching UI DEFAULT_SEGMENTS:
    -- 1: 10 diamonds (15%) -> 1-15
    -- 2: 50 chips (25%) -> 16-40
    -- 3: 25 diamonds (7%) -> 41-47
    -- 4: 100 chips (15%) -> 48-62
    -- 5: 5 diamonds (30%) -> 63-92
    -- 6: 200 chips (3%) -> 93-95
    -- 7: 50 diamonds (4%) -> 96-99
    -- 8: 2x bonus (1%) -> 100

    IF v_roll <= 15 THEN
        v_segment_id := '1'; v_reward_type := 'diamonds'; v_amount := 10;
    ELSIF v_roll <= 40 THEN
        v_segment_id := '2'; v_reward_type := 'chips'; v_amount := 50;
    ELSIF v_roll <= 47 THEN
        v_segment_id := '3'; v_reward_type := 'diamonds'; v_amount := 25;
    ELSIF v_roll <= 62 THEN
        v_segment_id := '4'; v_reward_type := 'chips'; v_amount := 100;
    ELSIF v_roll <= 92 THEN
        v_segment_id := '5'; v_reward_type := 'diamonds'; v_amount := 5;
    ELSIF v_roll <= 95 THEN
        v_segment_id := '6'; v_reward_type := 'chips'; v_amount := 200;
    ELSIF v_roll <= 99 THEN
        v_segment_id := '7'; v_reward_type := 'diamonds'; v_amount := 50;
    ELSE
        v_segment_id := '8'; v_reward_type := 'bonus'; v_amount := 2;
    END IF;

    -- Grant Reward
    IF v_reward_type = 'chips' THEN
        PERFORM credit_player_wallet(p_user_id, v_amount);
    ELSIF v_reward_type = 'diamonds' THEN
        UPDATE profiles SET diamonds = COALESCE(diamonds, 0) + v_amount WHERE id = p_user_id;
    END IF;

    -- Return JSON payload matching UI
    RETURN json_build_object(
        'segmentId', v_segment_id,
        'rewardType', v_reward_type,
        'amount', v_amount
    )::jsonb;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
