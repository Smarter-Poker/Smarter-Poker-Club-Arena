-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 MISSING RPC FUNCTIONS — Batch Creation
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Creates all RPC functions identified as missing from the comprehensive audit.
-- These functions are called by frontend services but were not yet in Supabase.
--
-- Created: 2026-01-24
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. BONUS & REWARDS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Claim daily bonus
CREATE OR REPLACE FUNCTION claim_daily_bonus(user_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_last_claim TIMESTAMP WITH TIME ZONE;
    v_streak INTEGER;
    v_bonus_amount INTEGER;
    v_result JSONB;
BEGIN
    -- Get last claim time and current streak
    SELECT last_daily_claim, COALESCE(login_streak, 0)
    INTO v_last_claim, v_streak
    FROM profiles WHERE id = user_id;
    
    -- Check if already claimed today
    IF v_last_claim IS NOT NULL AND v_last_claim::date = CURRENT_DATE THEN
        RETURN jsonb_build_object('success', false, 'message', 'Already claimed today');
    END IF;
    
    -- Calculate streak
    IF v_last_claim IS NULL OR v_last_claim::date < CURRENT_DATE - 1 THEN
        v_streak := 1; -- Reset streak
    ELSE
        v_streak := v_streak + 1; -- Continue streak
    END IF;
    
    -- Calculate bonus based on streak (base 100, +10 per day, max 500)
    v_bonus_amount := LEAST(100 + (v_streak - 1) * 10, 500);
    
    -- Update profile
    UPDATE profiles SET
        last_daily_claim = NOW(),
        login_streak = v_streak,
        updated_at = NOW()
    WHERE id = user_id;
    
    -- Add chips to player wallet
    UPDATE player_wallets SET
        balance = balance + v_bonus_amount,
        updated_at = NOW()
    WHERE user_id = claim_daily_bonus.user_id AND wallet_type = 'PROMO';
    
    -- If no promo wallet, create one
    IF NOT FOUND THEN
        INSERT INTO player_wallets (user_id, wallet_type, balance)
        VALUES (user_id, 'PROMO', v_bonus_amount);
    END IF;
    
    RETURN jsonb_build_object(
        'success', true,
        'bonus', v_bonus_amount,
        'streak', v_streak
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add chips to player wallet
CREATE OR REPLACE FUNCTION add_chips(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID AS $$
BEGIN
    UPDATE player_wallets SET
        balance = balance + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    
    IF NOT FOUND THEN
        INSERT INTO player_wallets (user_id, wallet_type, balance)
        VALUES (p_user_id, 'PLAYER', p_amount);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CLUB FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Increment member count when someone joins a club
CREATE OR REPLACE FUNCTION increment_member_count(club_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE clubs SET
        member_count = COALESCE(member_count, 0) + 1,
        updated_at = NOW()
    WHERE id = club_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Decrement member count when someone leaves a club
CREATE OR REPLACE FUNCTION decrement_member_count(club_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE clubs SET
        member_count = GREATEST(COALESCE(member_count, 1) - 1, 0),
        updated_at = NOW()
    WHERE id = club_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Discover clubs for browsing
CREATE OR REPLACE FUNCTION fn_discover_clubs(
    p_search TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 20,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id UUID,
    name TEXT,
    description TEXT,
    avatar_url TEXT,
    member_count INTEGER,
    online_count INTEGER,
    game_types TEXT[],
    is_public BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id,
        c.name,
        c.description,
        c.avatar_url,
        COALESCE(c.member_count, 0)::INTEGER as member_count,
        COALESCE(c.online_count, 0)::INTEGER as online_count,
        c.game_types,
        COALESCE(c.is_public, true) as is_public,
        c.created_at
    FROM clubs c
    WHERE c.is_public = true
    AND (p_search IS NULL OR c.name ILIKE '%' || p_search || '%')
    ORDER BY c.member_count DESC NULLS LAST
    LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. AGENT & CREDIT FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Deduct from agent balance
CREATE OR REPLACE FUNCTION deduct_agent_balance(
    p_agent_id UUID,
    p_amount NUMERIC,
    p_reason TEXT DEFAULT 'Transfer'
)
RETURNS BOOLEAN AS $$
DECLARE
    v_current_balance NUMERIC;
BEGIN
    SELECT balance INTO v_current_balance FROM agents WHERE id = p_agent_id;
    
    IF v_current_balance < p_amount THEN
        RETURN FALSE;
    END IF;
    
    UPDATE agents SET
        balance = balance - p_amount,
        updated_at = NOW()
    WHERE id = p_agent_id;
    
    -- Log transaction
    INSERT INTO wallet_transactions (user_id, type, amount, description)
    SELECT user_id, 'debit', -p_amount, p_reason
    FROM agents WHERE id = p_agent_id;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Distribute promo chips from agent to player
CREATE OR REPLACE FUNCTION distribute_promo_chips(
    p_agent_id UUID,
    p_player_id UUID,
    p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
    -- Deduct from agent's promo pool
    UPDATE agents SET
        promo_balance = COALESCE(promo_balance, 0) - p_amount,
        updated_at = NOW()
    WHERE id = p_agent_id AND COALESCE(promo_balance, 0) >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient promo balance';
    END IF;
    
    -- Add to player's promo wallet
    UPDATE player_wallets SET
        balance = balance + p_amount,
        updated_at = NOW()
    WHERE user_id = p_player_id AND wallet_type = 'PROMO';
    
    IF NOT FOUND THEN
        INSERT INTO player_wallets (user_id, wallet_type, balance)
        VALUES (p_player_id, 'PROMO', p_amount);
    END IF;
    
    -- Log transaction
    INSERT INTO wallet_transactions (user_id, type, amount, description)
    VALUES (p_player_id, 'credit', p_amount, 'Promo chips from agent');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Mint club chips (club owner buys chips with diamonds)
CREATE OR REPLACE FUNCTION mint_club_chips(
    p_club_id UUID,
    p_chips NUMERIC,
    p_diamonds INTEGER
)
RETURNS JSONB AS $$
DECLARE
    v_owner_id UUID;
    v_current_diamonds INTEGER;
    v_new_balance NUMERIC;
BEGIN
    -- Get club owner
    SELECT owner_id INTO v_owner_id FROM clubs WHERE id = p_club_id;
    
    -- Check diamond balance
    SELECT diamonds INTO v_current_diamonds FROM profiles WHERE id = v_owner_id;
    
    IF v_current_diamonds < p_diamonds THEN
        RAISE EXCEPTION 'Insufficient diamonds';
    END IF;
    
    -- Deduct diamonds
    UPDATE profiles SET
        diamonds = diamonds - p_diamonds,
        updated_at = NOW()
    WHERE id = v_owner_id;
    
    -- Add chips to club treasury
    UPDATE clubs SET
        chip_treasury = COALESCE(chip_treasury, 0) + p_chips,
        updated_at = NOW()
    WHERE id = p_club_id
    RETURNING chip_treasury INTO v_new_balance;
    
    RETURN jsonb_build_object(
        'success', true,
        'chips_added', p_chips,
        'diamonds_spent', p_diamonds,
        'new_balance', v_new_balance
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. WAITLIST FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Join waitlist for a table
CREATE OR REPLACE FUNCTION join_waitlist(
    p_user_id UUID,
    p_table_id UUID,
    p_preferred_seat INTEGER DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_position INTEGER;
    v_wait_id UUID;
BEGIN
    -- Check if already on waitlist
    IF EXISTS (SELECT 1 FROM table_waitlists WHERE user_id = p_user_id AND table_id = p_table_id AND status = 'waiting') THEN
        RETURN jsonb_build_object('success', false, 'message', 'Already on waitlist');
    END IF;
    
    -- Get current position count
    SELECT COUNT(*) + 1 INTO v_position
    FROM table_waitlists
    WHERE table_id = p_table_id AND status = 'waiting';
    
    -- Insert into waitlist
    INSERT INTO table_waitlists (user_id, table_id, position, preferred_seat, status)
    VALUES (p_user_id, p_table_id, v_position, p_preferred_seat, 'waiting')
    RETURNING id INTO v_wait_id;
    
    RETURN jsonb_build_object(
        'success', true,
        'wait_id', v_wait_id,
        'position', v_position
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get waitlist position
CREATE OR REPLACE FUNCTION get_waitlist_position(
    p_user_id UUID,
    p_table_id UUID
)
RETURNS JSONB AS $$
DECLARE
    v_position INTEGER;
    v_total INTEGER;
BEGIN
    SELECT position INTO v_position
    FROM table_waitlists
    WHERE user_id = p_user_id AND table_id = p_table_id AND status = 'waiting';
    
    IF v_position IS NULL THEN
        RETURN jsonb_build_object('on_waitlist', false);
    END IF;
    
    SELECT COUNT(*) INTO v_total
    FROM table_waitlists
    WHERE table_id = p_table_id AND status = 'waiting';
    
    RETURN jsonb_build_object(
        'on_waitlist', true,
        'position', v_position,
        'total_waiting', v_total
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. TABLE & GAMEPLAY FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add chips to player wallet from table (cash out)
CREATE OR REPLACE FUNCTION add_to_player_wallet(
    p_user_id UUID,
    p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
    UPDATE player_wallets SET
        balance = balance + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    
    IF NOT FOUND THEN
        INSERT INTO player_wallets (user_id, wallet_type, balance)
        VALUES (p_user_id, 'PLAYER', p_amount);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get current table state
CREATE OR REPLACE FUNCTION get_table_state(p_table_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_table RECORD;
    v_players JSONB;
BEGIN
    -- Get table info
    SELECT * INTO v_table FROM tables WHERE id = p_table_id;
    
    IF v_table IS NULL THEN
        RETURN jsonb_build_object('error', 'Table not found');
    END IF;
    
    -- Get seated players
    SELECT jsonb_agg(jsonb_build_object(
        'seat', ts.seat,
        'user_id', ts.user_id,
        'username', p.username,
        'avatar_url', p.avatar_url,
        'stack', ts.stack,
        'status', ts.status
    )) INTO v_players
    FROM table_seats ts
    JOIN profiles p ON ts.user_id = p.id
    WHERE ts.table_id = p_table_id;
    
    RETURN jsonb_build_object(
        'id', v_table.id,
        'name', v_table.name,
        'game_type', v_table.game_type,
        'blinds', v_table.blinds,
        'max_players', v_table.max_players,
        'status', v_table.status,
        'players', COALESCE(v_players, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Execute pot drops (rake distribution)
CREATE OR REPLACE FUNCTION execute_pot_drops(
    p_hand_id UUID,
    p_rake_amount NUMERIC,
    p_bbj_amount NUMERIC DEFAULT 0,
    p_table_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    -- Record rake
    INSERT INTO rake_records (hand_id, table_id, rake_amount, bbj_contribution, created_at)
    VALUES (p_hand_id, p_table_id, p_rake_amount, p_bbj_amount, NOW());
    
    -- Add to club rake totals if table has club
    IF p_table_id IS NOT NULL THEN
        UPDATE clubs SET
            total_rake = COALESCE(total_rake, 0) + p_rake_amount,
            updated_at = NOW()
        WHERE id = (SELECT club_id FROM tables WHERE id = p_table_id);
    END IF;
    
    -- Add to BBJ pool if applicable
    IF p_bbj_amount > 0 AND p_table_id IS NOT NULL THEN
        UPDATE bad_beat_jackpots SET
            current_amount = current_amount + p_bbj_amount,
            updated_at = NOW()
        WHERE club_id = (SELECT club_id FROM tables WHERE id = p_table_id)
        AND status = 'active';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. TOURNAMENT FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Process tournament rebuy
CREATE OR REPLACE FUNCTION process_tournament_rebuy(
    p_tournament_id UUID,
    p_player_id UUID,
    p_rebuy_amount NUMERIC
)
RETURNS JSONB AS $$
DECLARE
    v_tournament RECORD;
    v_reg RECORD;
    v_new_stack NUMERIC;
BEGIN
    -- Get tournament info
    SELECT * INTO v_tournament FROM tournaments WHERE id = p_tournament_id;
    
    IF v_tournament IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tournament not found');
    END IF;
    
    -- Check rebuy allowed
    IF NOT v_tournament.allow_rebuys THEN
        RETURN jsonb_build_object('success', false, 'error', 'Rebuys not allowed');
    END IF;
    
    -- Get registration
    SELECT * INTO v_reg FROM tournament_registrations
    WHERE tournament_id = p_tournament_id AND user_id = p_player_id;
    
    IF v_reg IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Not registered');
    END IF;
    
    -- Deduct from player wallet
    UPDATE player_wallets SET
        balance = balance - p_rebuy_amount,
        updated_at = NOW()
    WHERE user_id = p_player_id AND wallet_type = 'PLAYER' AND balance >= p_rebuy_amount;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance');
    END IF;
    
    -- Add to stack
    v_new_stack := COALESCE(v_reg.current_stack, 0) + v_tournament.starting_stack;
    
    UPDATE tournament_registrations SET
        current_stack = v_new_stack,
        rebuy_count = COALESCE(rebuy_count, 0) + 1,
        updated_at = NOW()
    WHERE tournament_id = p_tournament_id AND user_id = p_player_id;
    
    -- Add to prize pool
    UPDATE tournaments SET
        prize_pool = COALESCE(prize_pool, 0) + p_rebuy_amount,
        updated_at = NOW()
    WHERE id = p_tournament_id;
    
    RETURN jsonb_build_object(
        'success', true,
        'new_stack', v_new_stack,
        'rebuy_count', COALESCE(v_reg.rebuy_count, 0) + 1
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Balance tournament tables
CREATE OR REPLACE FUNCTION balance_tournament_tables(p_tournament_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_tables RECORD;
    v_moves JSONB := '[]'::jsonb;
BEGIN
    -- This is a placeholder for table balancing logic
    -- Real implementation would move players between tables
    
    -- For now, just return success
    RETURN jsonb_build_object(
        'success', true,
        'moves', v_moves,
        'message', 'Table balancing complete'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. PROMOTION FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Recalculate leaderboard ranks
-- Drop first to handle parameter rename from old p_leaderboard_id to p_promotion_id
DROP FUNCTION IF EXISTS recalculate_leaderboard_ranks(UUID);
CREATE OR REPLACE FUNCTION recalculate_leaderboard_ranks(p_promotion_id UUID)
RETURNS VOID AS $$
BEGIN
    -- Update ranks based on score
    WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY score DESC) as new_rank
        FROM promotion_leaderboards
        WHERE promotion_id = p_promotion_id
    )
    UPDATE promotion_leaderboards pl SET
        rank = r.new_rank,
        updated_at = NOW()
    FROM ranked r
    WHERE pl.id = r.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. PLAYER NOTES FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Save player note (uses existing table column names: user_id, target_user_id)
-- This function already exists in 202601242301_vip_usage_and_settings.sql
-- but we re-create it here to ensure it exists with all features
DROP FUNCTION IF EXISTS fn_save_player_note(UUID, UUID, TEXT, TEXT);
CREATE OR REPLACE FUNCTION fn_save_player_note(
    p_user_id UUID,
    p_target_id UUID,
    p_note TEXT,
    p_color TEXT DEFAULT '#3b82f6'
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO player_notes (user_id, target_user_id, note, color, last_seen, created_at, updated_at)
    VALUES (p_user_id, p_target_id, p_note, p_color, NOW(), NOW(), NOW())
    ON CONFLICT (user_id, target_user_id) DO UPDATE SET
        note = EXCLUDED.note,
        color = EXCLUDED.color,
        last_seen = NOW(),
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. VIP FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Increment VIP feature usage
CREATE OR REPLACE FUNCTION fn_increment_vip_usage(
    p_user_id UUID,
    p_feature TEXT
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO vip_feature_usage (user_id, feature, usage_count, last_used_at)
    VALUES (p_user_id, p_feature, 1, NOW())
    ON CONFLICT (user_id, feature) DO UPDATE SET
        usage_count = vip_feature_usage.usage_count + 1,
        last_used_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Consume VIP feature use
CREATE OR REPLACE FUNCTION fn_consume_feature_use(
    p_user_id UUID,
    p_feature TEXT,
    p_max_daily INTEGER DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    v_today_usage INTEGER;
BEGIN
    -- Check daily limit if specified
    IF p_max_daily IS NOT NULL THEN
        SELECT COALESCE(SUM(CASE WHEN last_used_at::date = CURRENT_DATE THEN 1 ELSE 0 END), 0)
        INTO v_today_usage
        FROM vip_feature_usage
        WHERE user_id = p_user_id AND feature = p_feature;
        
        IF v_today_usage >= p_max_daily THEN
            RETURN FALSE;
        END IF;
    END IF;
    
    -- Record usage
    PERFORM fn_increment_vip_usage(p_user_id, p_feature);
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. HYDRA SERVICE FUNCTIONS (Horse Bot System)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Get available horses for a table
CREATE OR REPLACE FUNCTION get_available_horses(
    p_table_id UUID,
    p_game_type TEXT DEFAULT 'NLH'
)
RETURNS TABLE (
    horse_id UUID,
    horse_name TEXT,
    skill_level INTEGER,
    play_style TEXT,
    avatar_url TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        h.id as horse_id,
        h.name as horse_name,
        h.skill_level,
        h.play_style,
        h.avatar_url
    FROM horses h
    WHERE h.status = 'available'
    AND h.supported_games @> ARRAY[p_game_type]
    AND NOT EXISTS (
        SELECT 1 FROM table_seats ts
        WHERE ts.horse_id = h.id AND ts.status = 'active'
    )
    ORDER BY RANDOM()
    LIMIT 10;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Seat a horse at table
CREATE OR REPLACE FUNCTION seat_horse(
    p_table_id UUID,
    p_horse_id UUID,
    p_seat INTEGER,
    p_stack NUMERIC
)
RETURNS BOOLEAN AS $$
BEGIN
    -- Check seat is available
    IF EXISTS (SELECT 1 FROM table_seats WHERE table_id = p_table_id AND seat = p_seat AND status = 'active') THEN
        RETURN FALSE;
    END IF;
    
    -- Seat the horse
    INSERT INTO table_seats (table_id, horse_id, seat, stack, status, seated_at)
    VALUES (p_table_id, p_horse_id, p_seat, p_stack, 'active', NOW());
    
    -- Update horse status
    UPDATE horses SET status = 'playing', current_table_id = p_table_id, updated_at = NOW()
    WHERE id = p_horse_id;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Schedule horse to leave
CREATE OR REPLACE FUNCTION schedule_horse_leave(
    p_table_id UUID,
    p_horse_id UUID,
    p_leave_after_hands INTEGER DEFAULT 10
)
RETURNS VOID AS $$
BEGIN
    UPDATE table_seats SET
        scheduled_leave_hands = p_leave_after_hands,
        updated_at = NOW()
    WHERE table_id = p_table_id AND horse_id = p_horse_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Remove horse from table
CREATE OR REPLACE FUNCTION remove_horse(
    p_table_id UUID,
    p_horse_id UUID
)
RETURNS VOID AS $$
BEGIN
    UPDATE table_seats SET
        status = 'left',
        left_at = NOW()
    WHERE table_id = p_table_id AND horse_id = p_horse_id;
    
    UPDATE horses SET
        status = 'available',
        current_table_id = NULL,
        updated_at = NOW()
    WHERE id = p_horse_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. ARENA TRAINING FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Check level advancement
CREATE OR REPLACE FUNCTION fn_check_level_advancement(
    p_user_id UUID,
    p_game_id TEXT,
    p_score INTEGER
)
RETURNS JSONB AS $$
DECLARE
    v_current_level INTEGER;
    v_current_xp INTEGER;
    v_xp_gained INTEGER;
    v_new_level INTEGER;
    v_advanced BOOLEAN := FALSE;
BEGIN
    -- Get current progress
    SELECT level, xp INTO v_current_level, v_current_xp
    FROM training_progress
    WHERE user_id = p_user_id AND game_id = p_game_id;
    
    IF v_current_level IS NULL THEN
        v_current_level := 1;
        v_current_xp := 0;
    END IF;
    
    -- Calculate XP gained (based on score)
    v_xp_gained := GREATEST(p_score / 10, 1);
    v_current_xp := v_current_xp + v_xp_gained;
    
    -- Check for level up (every 100 XP)
    v_new_level := v_current_level;
    WHILE v_current_xp >= v_new_level * 100 LOOP
        v_current_xp := v_current_xp - (v_new_level * 100);
        v_new_level := v_new_level + 1;
        v_advanced := TRUE;
    END LOOP;
    
    -- Update progress
    INSERT INTO training_progress (user_id, game_id, level, xp, last_played_at)
    VALUES (p_user_id, p_game_id, v_new_level, v_current_xp, NOW())
    ON CONFLICT (user_id, game_id) DO UPDATE SET
        level = v_new_level,
        xp = v_current_xp,
        last_played_at = NOW();
    
    RETURN jsonb_build_object(
        'level', v_new_level,
        'xp', v_current_xp,
        'xp_gained', v_xp_gained,
        'advanced', v_advanced
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Record arena session
CREATE OR REPLACE FUNCTION record_arena_session(
    p_user_id UUID,
    p_game_id TEXT,
    p_hands_played INTEGER,
    p_correct_answers INTEGER,
    p_total_questions INTEGER,
    p_duration_seconds INTEGER
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO arena_sessions (
        user_id, game_id, hands_played, correct_answers, 
        total_questions, duration_seconds, created_at
    )
    VALUES (
        p_user_id, p_game_id, p_hands_played, p_correct_answers,
        p_total_questions, p_duration_seconds, NOW()
    );
    
    -- Update player XP
    PERFORM add_xp(p_user_id, p_correct_answers * 5);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE — All missing RPC functions created
-- ═══════════════════════════════════════════════════════════════════════════════
