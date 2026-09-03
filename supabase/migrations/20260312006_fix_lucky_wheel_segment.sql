-- Fix for the dead "bonus" segment on the Lucky Draw Wheel
-- Replaces the unused 2x multiplier with a '500 Jackpot' chip reward

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

    v_roll := floor(random() * 100 + 1)::int;

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
        v_segment_id := '8'; v_reward_type := 'chips'; v_amount := 500;
    END IF;

    IF v_reward_type = 'chips' THEN
        PERFORM credit_player_wallet(p_user_id, v_amount);
    ELSIF v_reward_type = 'diamonds' THEN
        UPDATE profiles SET diamonds = COALESCE(diamonds, 0) + v_amount WHERE id = p_user_id;
    END IF;

    RETURN json_build_object(
        'segmentId', v_segment_id,
        'rewardType', v_reward_type,
        'amount', v_amount
    )::jsonb;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
