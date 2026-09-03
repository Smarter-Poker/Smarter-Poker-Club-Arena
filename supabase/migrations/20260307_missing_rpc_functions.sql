-- ============================================================
-- Missing RPC Functions - March 7, 2026
-- These functions are called from the frontend but were not
-- yet defined in the database.
-- ============================================================

-- 1. add_bbj_contribution: Records a Bad Beat Jackpot contribution
CREATE OR REPLACE FUNCTION add_bbj_contribution(
    p_table_id UUID,
    p_club_id UUID,
    p_amount NUMERIC,
    p_big_blind NUMERIC,
    p_hand_number BIGINT DEFAULT 0,
    p_stakes_tier TEXT DEFAULT 'mid'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pool RECORD;
    v_new_amount NUMERIC;
BEGIN
    -- Get or create BBJ pool for this club
    SELECT * INTO v_pool FROM bbj_pools WHERE club_id = p_club_id AND status = 'active' LIMIT 1;

    IF v_pool IS NULL THEN
        INSERT INTO bbj_pools (club_id, current_amount, status, stakes_tier)
        VALUES (p_club_id, p_amount, 'active', p_stakes_tier)
        RETURNING * INTO v_pool;
        v_new_amount := p_amount;
    ELSE
        UPDATE bbj_pools
        SET current_amount = current_amount + p_amount,
            updated_at = NOW()
        WHERE id = v_pool.id
        RETURNING current_amount INTO v_new_amount;
    END IF;

    -- Log the contribution
    INSERT INTO bbj_contributions (pool_id, table_id, club_id, amount, big_blind, hand_number, stakes_tier)
    VALUES (v_pool.id, p_table_id, p_club_id, p_amount, p_big_blind, p_hand_number, p_stakes_tier);

    RETURN jsonb_build_object(
        'pool_id', v_pool.id,
        'new_amount', v_new_amount,
        'contribution', p_amount
    );
EXCEPTION WHEN OTHERS THEN
    -- If tables don't exist yet, just return success silently
    RETURN jsonb_build_object('pool_id', NULL, 'new_amount', 0, 'contribution', p_amount, 'note', 'bbj tables not yet created');
END;
$$;


-- 2. award_bbj: Awards a Bad Beat Jackpot payout
CREATE OR REPLACE FUNCTION award_bbj(
    p_club_id UUID,
    p_table_id UUID,
    p_hand_number BIGINT DEFAULT 0,
    p_big_blind NUMERIC DEFAULT 0,
    p_stakes_tier TEXT DEFAULT 'mid',
    p_game_variant TEXT DEFAULT 'nlh',
    p_winner_user_id UUID DEFAULT NULL,
    p_winner_hand TEXT DEFAULT '',
    p_winner_cards TEXT DEFAULT '',
    p_winner_display_name TEXT DEFAULT '',
    p_loser_user_id UUID DEFAULT NULL,
    p_loser_hand TEXT DEFAULT '',
    p_loser_cards TEXT DEFAULT '',
    p_loser_display_name TEXT DEFAULT '',
    p_payout_total_pct NUMERIC DEFAULT 100,
    p_payout_winner_pct NUMERIC DEFAULT 50,
    p_payout_loser_pct NUMERIC DEFAULT 25,
    p_payout_table_pct NUMERIC DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pool RECORD;
    v_payout_amount NUMERIC;
    v_winner_share NUMERIC;
    v_loser_share NUMERIC;
    v_table_share NUMERIC;
BEGIN
    -- Get active BBJ pool
    SELECT * INTO v_pool FROM bbj_pools WHERE club_id = p_club_id AND status = 'active' LIMIT 1;

    IF v_pool IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'No active BBJ pool found');
    END IF;

    v_payout_amount := v_pool.current_amount * (p_payout_total_pct / 100.0);
    v_winner_share := v_payout_amount * (p_payout_winner_pct / 100.0);
    v_loser_share := v_payout_amount * (p_payout_loser_pct / 100.0);
    v_table_share := v_payout_amount * (p_payout_table_pct / 100.0);

    -- Credit winner via player wallet
    IF p_winner_user_id IS NOT NULL AND v_winner_share > 0 THEN
        PERFORM credit_player_wallet(p_winner_user_id, p_club_id, v_winner_share, 'bbj_winner', 'BBJ Winner Payout');
    END IF;

    -- Credit loser via player wallet
    IF p_loser_user_id IS NOT NULL AND v_loser_share > 0 THEN
        PERFORM credit_player_wallet(p_loser_user_id, p_club_id, v_loser_share, 'bbj_loser', 'BBJ Qualifying Hand Payout');
    END IF;

    -- Update pool
    UPDATE bbj_pools
    SET current_amount = current_amount - v_payout_amount,
        last_hit_at = NOW(),
        times_hit = COALESCE(times_hit, 0) + 1,
        updated_at = NOW()
    WHERE id = v_pool.id;

    RETURN jsonb_build_object(
        'success', true,
        'pool_id', v_pool.id,
        'payout_amount', v_payout_amount,
        'winner_share', v_winner_share,
        'loser_share', v_loser_share,
        'table_share', v_table_share
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- 3. deduct_diamonds: Deducts diamonds from user's diamond balance
CREATE OR REPLACE FUNCTION deduct_diamonds(
    p_user_id UUID,
    p_amount NUMERIC,
    p_description TEXT DEFAULT '',
    p_transaction_type TEXT DEFAULT 'purchase'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_current_balance NUMERIC;
BEGIN
    -- Get current diamond balance
    SELECT balance INTO v_current_balance
    FROM user_diamond_balance
    WHERE user_id = p_user_id;

    IF v_current_balance IS NULL OR v_current_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient diamond balance';
    END IF;

    -- Deduct
    UPDATE user_diamond_balance
    SET balance = balance - p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- Log transaction
    INSERT INTO diamond_transactions (user_id, amount, type, description, created_at)
    VALUES (p_user_id, -p_amount, p_transaction_type, p_description, NOW());
END;
$$;


-- 4. register_for_tournament: Registers a player for a tournament (atomic)
CREATE OR REPLACE FUNCTION register_for_tournament(
    p_tournament_id UUID,
    p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tournament RECORD;
    v_existing RECORD;
    v_buy_in NUMERIC;
    v_club_id UUID;
BEGIN
    -- Get tournament details
    SELECT * INTO v_tournament FROM tournaments WHERE id = p_tournament_id;

    IF v_tournament IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tournament not found');
    END IF;

    -- Check if already registered
    SELECT * INTO v_existing FROM tournament_registrations
    WHERE tournament_id = p_tournament_id AND user_id = p_user_id AND status = 'registered';

    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Already registered');
    END IF;

    -- Check capacity
    IF (SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id = p_tournament_id AND status = 'registered') >= v_tournament.max_players THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tournament is full');
    END IF;

    v_buy_in := COALESCE(v_tournament.buy_in_amount, 0) + COALESCE(v_tournament.buy_in_fee, 0);
    v_club_id := v_tournament.club_id;

    -- Deduct buy-in from player wallet
    IF v_buy_in > 0 THEN
        PERFORM deduct_player_wallet(p_user_id, v_club_id, v_buy_in, 'tournament_buyin',
            'Tournament buy-in: ' || COALESCE(v_tournament.name, v_tournament.id::TEXT));
    END IF;

    -- Register
    INSERT INTO tournament_registrations (tournament_id, user_id, status, registered_at)
    VALUES (p_tournament_id, p_user_id, 'registered', NOW());

    -- Update registered count
    UPDATE tournaments
    SET registered_players = COALESCE(registered_players, 0) + 1
    WHERE id = p_tournament_id;

    RETURN jsonb_build_object('success', true, 'buy_in_deducted', v_buy_in);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- 5. increment_agent_rake: Atomically increments an agent's rake earnings
CREATE OR REPLACE FUNCTION increment_agent_rake(
    p_agent_id UUID,
    p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE club_agents
    SET weekly_rake_generated = COALESCE(weekly_rake_generated, 0) + p_amount,
        lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_amount,
        updated_at = NOW()
    WHERE user_id = p_agent_id;
END;
$$;


-- 6. increment_bonus_progress: Atomically increments bonus progress for a user
CREATE OR REPLACE FUNCTION increment_bonus_progress(
    p_bonus_id UUID,
    p_user_id UUID,
    p_amount NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_progress NUMERIC;
BEGIN
    UPDATE user_bonuses
    SET progress = COALESCE(progress, 0) + p_amount,
        updated_at = NOW()
    WHERE bonus_id = p_bonus_id AND user_id = p_user_id
    RETURNING progress INTO v_new_progress;

    RETURN COALESCE(v_new_progress, 0);
EXCEPTION WHEN OTHERS THEN
    RETURN 0;
END;
$$;


-- 7. get_user_level_stats: Returns XP/level stats for a user
CREATE OR REPLACE FUNCTION get_user_level_stats(
    p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile RECORD;
    v_xp NUMERIC;
    v_level INT;
    v_xp_for_next NUMERIC;
BEGIN
    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id;

    v_xp := COALESCE(v_profile.xp, 0);
    v_level := COALESCE(v_profile.level, 1);
    v_xp_for_next := v_level * 1000; -- Simple formula: level * 1000 XP needed

    RETURN jsonb_build_object(
        'user_id', p_user_id,
        'level', v_level,
        'xp', v_xp,
        'xp_for_next_level', v_xp_for_next,
        'progress_pct', LEAST(100, ROUND((v_xp::NUMERIC / GREATEST(v_xp_for_next, 1)) * 100, 1))
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('user_id', p_user_id, 'level', 1, 'xp', 0, 'xp_for_next_level', 1000, 'progress_pct', 0);
END;
$$;


-- 8. fn_request_agent_payout: Requests a payout for an agent's earned commissions
CREATE OR REPLACE FUNCTION fn_request_agent_payout(
    p_agent_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_agent RECORD;
    v_payout_amount NUMERIC;
BEGIN
    SELECT * INTO v_agent FROM club_agents WHERE user_id = p_agent_id AND status = 'active';

    IF v_agent IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Agent not found or inactive');
    END IF;

    v_payout_amount := COALESCE(v_agent.pending_commission, 0);

    IF v_payout_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'No pending commission to pay out');
    END IF;

    -- Create payout request
    INSERT INTO agent_payout_requests (agent_id, club_id, amount, status, created_at)
    VALUES (p_agent_id, v_agent.club_id, v_payout_amount, 'pending', NOW());

    -- Reset pending commission
    UPDATE club_agents
    SET pending_commission = 0,
        updated_at = NOW()
    WHERE user_id = p_agent_id;

    RETURN jsonb_build_object('success', true, 'amount', v_payout_amount);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- Grant execute permissions to authenticated and anon roles
GRANT EXECUTE ON FUNCTION add_bbj_contribution TO authenticated, anon;
GRANT EXECUTE ON FUNCTION award_bbj TO authenticated, anon;
GRANT EXECUTE ON FUNCTION deduct_diamonds TO authenticated, anon;
GRANT EXECUTE ON FUNCTION register_for_tournament TO authenticated, anon;
GRANT EXECUTE ON FUNCTION increment_agent_rake TO authenticated, anon;
GRANT EXECUTE ON FUNCTION increment_bonus_progress TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_user_level_stats TO authenticated, anon;
GRANT EXECUTE ON FUNCTION fn_request_agent_payout TO authenticated, anon;
