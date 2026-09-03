-- ============================================================
-- V14 Audit Fix: BBJ Table Payout Injection
-- As per instruction: BBJ Trigger should award chips directly to the
-- table (table_seats stack) so balances go up significantly.
-- Chips move to wallets only when the player leaves the table.
-- ============================================================

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

    -- 1. Winner Share: Inject directly to table_seats stack
    IF p_winner_user_id IS NOT NULL AND v_winner_share > 0 THEN
        UPDATE table_seats 
        SET stack = stack + v_winner_share,
            updated_at = NOW()
        WHERE table_id = p_table_id AND user_id = p_winner_user_id AND is_active = true;

        IF NOT FOUND THEN
            -- Fallback: If player somehow stood up during the hand (rare but possible),
            -- credit their wallet instead.
            PERFORM credit_player_wallet(p_winner_user_id, v_winner_share);
            PERFORM log_wallet_transaction(p_winner_user_id, 'PLAYER', v_winner_share, 'credit', 'prize', 'BBJ Winner Payout (Offline/Stood Up)', p_table_id, NULL, p_club_id);
        ELSE
            -- Log the table drop for audit purposes (even though it's on table)
            PERFORM log_wallet_transaction(p_winner_user_id, 'PLAYER', v_winner_share, 'credit', 'prize', 'BBJ Winner Payout (Table Stack)', p_table_id, NULL, p_club_id);
        END IF;
    END IF;

    -- 2. Loser Share (Bad Beat Victim): Inject directly to table_seats stack
    IF p_loser_user_id IS NOT NULL AND v_loser_share > 0 THEN
        UPDATE table_seats 
        SET stack = stack + v_loser_share,
            updated_at = NOW()
        WHERE table_id = p_table_id AND user_id = p_loser_user_id AND is_active = true;

        IF NOT FOUND THEN
            -- Fallback 
            PERFORM credit_player_wallet(p_loser_user_id, v_loser_share);
            PERFORM log_wallet_transaction(p_loser_user_id, 'PLAYER', v_loser_share, 'credit', 'prize', 'BBJ Qualifying Hand Payout (Offline/Stood Up)', p_table_id, NULL, p_club_id);
        ELSE
            PERFORM log_wallet_transaction(p_loser_user_id, 'PLAYER', v_loser_share, 'credit', 'prize', 'BBJ Qualifying Hand Payout (Table Stack)', p_table_id, NULL, p_club_id);
        END IF;
    END IF;

    -- 3. Table Share: Inject directly to table_seats stack for each dealt-in player
    IF p_dealt_in_player_ids IS NOT NULL THEN
        v_dealt_in_count := array_length(p_dealt_in_player_ids, 1);
        IF v_dealt_in_count > 0 AND v_table_share > 0 THEN
            v_table_share_per_player := TRUNC(v_table_share / v_dealt_in_count, 2);
            IF v_table_share_per_player > 0 THEN
                FOREACH v_player_id IN ARRAY p_dealt_in_player_ids
                LOOP
                    -- Skip winner and loser as they get their main shares
                    IF v_player_id != p_winner_user_id AND v_player_id != p_loser_user_id THEN
                        UPDATE table_seats 
                        SET stack = stack + v_table_share_per_player,
                            updated_at = NOW()
                        WHERE table_id = p_table_id AND user_id = v_player_id AND is_active = true;

                        IF NOT FOUND THEN
                            PERFORM credit_player_wallet(v_player_id, v_table_share_per_player);
                            PERFORM log_wallet_transaction(v_player_id, 'PLAYER', v_table_share_per_player, 'credit', 'prize', 'BBJ Table Share (Offline/Stood Up)', p_table_id, NULL, p_club_id);
                        ELSE
                            PERFORM log_wallet_transaction(v_player_id, 'PLAYER', v_table_share_per_player, 'credit', 'prize', 'BBJ Table Share (Table Stack)', p_table_id, NULL, p_club_id);
                        END IF;
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
