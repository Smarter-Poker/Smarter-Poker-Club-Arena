CREATE OR REPLACE FUNCTION fn_buy_streak_freeze()
RETURNS JSONB AS $$
DECLARE
    v_user_id UUID;
    v_diamonds DECIMAL;
    v_freeze_cost INT := 5000;
    v_streak_frozen BOOLEAN;
    v_today_date DATE;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- 1. Check user diamonds
    SELECT diamonds INTO v_diamonds FROM profiles WHERE id = v_user_id;
    IF v_diamonds IS NULL OR v_diamonds < v_freeze_cost THEN
        RETURN jsonb_build_object('success', false, 'error', 'Insufficient diamonds. 5,000 required.');
    END IF;

    -- 2. Check if already frozen for today
    v_today_date := CURRENT_DATE;
    
    SELECT streak_frozen INTO v_streak_frozen
    FROM user_daily_challenges
    WHERE user_id = v_user_id AND challenge_date = v_today_date;

    IF v_streak_frozen = TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', 'Streak is already frozen for today!');
    END IF;

    -- 3. Deduct diamonds
    UPDATE profiles SET diamonds = diamonds - v_freeze_cost WHERE id = v_user_id;

    -- 4. Update the streak freeze flag
    INSERT INTO user_daily_challenges (user_id, challenge_date, streak_frozen, created_at, updated_at)
    VALUES (v_user_id, v_today_date, TRUE, NOW(), NOW())
    ON CONFLICT (user_id, challenge_date)
    DO UPDATE SET streak_frozen = TRUE, updated_at = NOW();

    RETURN jsonb_build_object('success', true, 'message', 'Streak frozen for today!');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION fn_buy_streak_freeze TO authenticated;
