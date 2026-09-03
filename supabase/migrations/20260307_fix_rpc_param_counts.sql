-- ============================================================
-- Fix RPC functions that call credit_player_wallet / deduct_player_wallet
-- with wrong parameter counts (5 params instead of 2)
-- ============================================================

-- Fix award_bbj: credit_player_wallet only takes (p_user_id, p_amount)
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

    -- Credit winner via player wallet (2 params: user_id, amount)
    IF p_winner_user_id IS NOT NULL AND v_winner_share > 0 THEN
        PERFORM credit_player_wallet(p_winner_user_id, v_winner_share);
    END IF;

    -- Credit loser via player wallet (2 params: user_id, amount)
    IF p_loser_user_id IS NOT NULL AND v_loser_share > 0 THEN
        PERFORM credit_player_wallet(p_loser_user_id, v_loser_share);
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


-- Fix register_for_tournament: deduct_player_wallet only takes (p_user_id, p_amount)
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
BEGIN
    -- Get tournament details
    SELECT * INTO v_tournament FROM tournaments WHERE id = p_tournament_id;

    IF v_tournament IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tournament not found');
    END IF;

    -- Check if already registered
    SELECT * INTO v_existing FROM tournament_players
    WHERE tournament_id = p_tournament_id AND user_id = p_user_id AND status = 'registered';

    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Already registered');
    END IF;

    -- Check capacity
    IF v_tournament.max_players IS NOT NULL AND
       (SELECT COUNT(*) FROM tournament_players WHERE tournament_id = p_tournament_id AND status = 'registered') >= v_tournament.max_players THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tournament is full');
    END IF;

    v_buy_in := COALESCE(v_tournament.buy_in_amount, 0) + COALESCE(v_tournament.buy_in_fee, 0);

    -- Deduct buy-in from player wallet (2 params: user_id, amount)
    IF v_buy_in > 0 THEN
        IF NOT deduct_player_wallet(p_user_id, v_buy_in) THEN
            RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance for tournament buy-in');
        END IF;
    END IF;

    -- Register in tournament_players (not tournament_registrations)
    INSERT INTO tournament_players (tournament_id, user_id, username, chips, status, registered_at)
    VALUES (p_tournament_id, p_user_id,
            COALESCE((SELECT username FROM profiles WHERE id = p_user_id), 'Player'),
            0, 'registered', NOW());

    -- Update player count
    UPDATE tournaments
    SET current_players = COALESCE(current_players, 0) + 1
    WHERE id = p_tournament_id;

    RETURN jsonb_build_object('success', true, 'buy_in_deducted', v_buy_in);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION award_bbj TO authenticated, anon;
GRANT EXECUTE ON FUNCTION register_for_tournament TO authenticated, anon;
