-- ============================================================
-- Fix BBJ Table Share Void & Missing Financial Audit Logs
-- ============================================================

-- 1. Redefine award_bbj to accept table players array, distribute the 25% table share,
-- and log all transactions natively into the wallet_transactions ledger.
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
    p_payout_table_pct NUMERIC DEFAULT 25,
    p_dealt_in_player_ids UUID[] DEFAULT NULL
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
    v_table_share_per_player NUMERIC;
    v_player_id UUID;
    v_dealt_in_count INTEGER;
BEGIN
    -- Get active BBJ pool
    SELECT * INTO v_pool FROM bbj_pools WHERE club_id = p_club_id AND status = 'active' LIMIT 1;

    IF v_pool IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'No active BBJ pool found');
    END IF;

    v_payout_amount := TRUNC(v_pool.current_amount * (p_payout_total_pct / 100.0), 2);
    v_winner_share := TRUNC(v_payout_amount * (p_payout_winner_pct / 100.0), 2);
    v_loser_share := TRUNC(v_payout_amount * (p_payout_loser_pct / 100.0), 2);
    v_table_share := TRUNC(v_payout_amount * (p_payout_table_pct / 100.0), 2);

    -- Credit winner via player wallet and log to unified ledger
    IF p_winner_user_id IS NOT NULL AND v_winner_share > 0 THEN
        PERFORM credit_player_wallet(p_winner_user_id, v_winner_share);
        PERFORM log_wallet_transaction(p_winner_user_id, 'PLAYER', v_winner_share, 'credit', 'prize', 'BBJ Winner Payout', p_table_id, NULL, p_club_id);
    END IF;

    -- Credit loser via player wallet and log to unified ledger
    IF p_loser_user_id IS NOT NULL AND v_loser_share > 0 THEN
        PERFORM credit_player_wallet(p_loser_user_id, v_loser_share);
        PERFORM log_wallet_transaction(p_loser_user_id, 'PLAYER', v_loser_share, 'credit', 'prize', 'BBJ Qualifying Hand Payout', p_table_id, NULL, p_club_id);
    END IF;

    -- Credit table share loop
    IF p_dealt_in_player_ids IS NOT NULL THEN
        v_dealt_in_count := array_length(p_dealt_in_player_ids, 1);
        IF v_dealt_in_count > 0 AND v_table_share > 0 THEN
            v_table_share_per_player := TRUNC(v_table_share / v_dealt_in_count, 2);
            IF v_table_share_per_player > 0 THEN
                FOREACH v_player_id IN ARRAY p_dealt_in_player_ids
                LOOP
                    -- Skip winner and loser to avoid double payout if they were incorrectly included in the array
                    IF v_player_id != p_winner_user_id AND v_player_id != p_loser_user_id THEN
                        PERFORM credit_player_wallet(v_player_id, v_table_share_per_player);
                        PERFORM log_wallet_transaction(v_player_id, 'PLAYER', v_table_share_per_player, 'credit', 'prize', 'BBJ Table Share', p_table_id, NULL, p_club_id);
                    END IF;
                END LOOP;
            END IF;
        END IF;
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


-- 2. Fix register_for_tournament: deduct_player_wallet does not log transactions
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

        -- SECURE AUDIT TRAIL LOGGING ADDED HERE:
        PERFORM log_wallet_transaction(p_user_id, 'PLAYER', v_buy_in, 'debit', 'buyin', 'Tournament registration buy-in: ' || COALESCE(v_tournament.name, v_tournament.id::TEXT), NULL, NULL, p_tournament_id);
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

GRANT EXECUTE ON FUNCTION award_bbj TO authenticated, anon;
GRANT EXECUTE ON FUNCTION register_for_tournament TO authenticated, anon;
