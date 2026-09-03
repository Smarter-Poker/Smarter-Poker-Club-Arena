-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 MISSING RPC FUNCTIONS — Phase 2 Backend Completion
-- ═══════════════════════════════════════════════════════════════════════════════
-- This migration adds all remaining RPC functions called by frontend services
-- that were not included in previous migrations.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. WALLET FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Internal wallet transfer (between user's own wallets)
CREATE OR REPLACE FUNCTION wallet_internal_transfer(
    p_user_id UUID,
    p_from_wallet TEXT,
    p_to_wallet TEXT,
    p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
    -- Deduct from source wallet
    UPDATE player_wallets 
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = p_from_wallet AND balance >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient balance in % wallet', p_from_wallet;
    END IF;
    
    -- Add to destination wallet
    INSERT INTO player_wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, p_to_wallet, p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = player_wallets.balance + p_amount, updated_at = NOW();
    
    -- Record transaction
    INSERT INTO wallet_transactions (user_id, type, amount, from_wallet, to_wallet, description)
    VALUES (p_user_id, 'INTERNAL_TRANSFER', p_amount, p_from_wallet, p_to_wallet, 'Internal wallet transfer');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- User-to-user transfer
CREATE OR REPLACE FUNCTION wallet_user_transfer(
    p_from_user_id UUID,
    p_to_user_id UUID,
    p_amount NUMERIC,
    p_description TEXT DEFAULT 'Chip transfer'
)
RETURNS VOID AS $$
BEGIN
    -- Deduct from sender
    UPDATE player_wallets 
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_from_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient balance';
    END IF;
    
    -- Add to recipient
    INSERT INTO player_wallets (user_id, wallet_type, balance)
    VALUES (p_to_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = player_wallets.balance + p_amount, updated_at = NOW();
    
    -- Record both transactions
    INSERT INTO wallet_transactions (user_id, type, amount, related_user_id, description)
    VALUES 
        (p_from_user_id, 'TRANSFER_OUT', -p_amount, p_to_user_id, p_description),
        (p_to_user_id, 'TRANSFER_IN', p_amount, p_from_user_id, p_description);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Lock chips for table buy-in
CREATE OR REPLACE FUNCTION lock_chips_for_table(
    p_user_id UUID,
    p_table_id UUID,
    p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
    -- Deduct from player wallet
    UPDATE player_wallets 
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient balance for buy-in';
    END IF;
    
    -- Add to locked chips tracking
    INSERT INTO table_chip_locks (user_id, table_id, amount)
    VALUES (p_user_id, p_table_id, p_amount)
    ON CONFLICT (user_id, table_id) 
    DO UPDATE SET amount = table_chip_locks.amount + p_amount, updated_at = NOW();
    
    -- Record transaction
    INSERT INTO wallet_transactions (user_id, type, amount, table_id, description)
    VALUES (p_user_id, 'TABLE_BUY_IN', -p_amount, p_table_id, 'Chips locked for table');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Unlock chips when cashing out
CREATE OR REPLACE FUNCTION unlock_chips_from_table(
    p_user_id UUID,
    p_table_id UUID,
    p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
    -- Remove from locked chips
    UPDATE table_chip_locks 
    SET amount = amount - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND table_id = p_table_id;
    
    -- Delete lock if zero
    DELETE FROM table_chip_locks WHERE user_id = p_user_id AND table_id = p_table_id AND amount <= 0;
    
    -- Return to player wallet
    INSERT INTO player_wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = player_wallets.balance + p_amount, updated_at = NOW();
    
    -- Record transaction
    INSERT INTO wallet_transactions (user_id, type, amount, table_id, description)
    VALUES (p_user_id, 'TABLE_CASH_OUT', p_amount, p_table_id, 'Chips unlocked from table');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add to player wallet  
CREATE OR REPLACE FUNCTION add_to_player_wallet(
    p_user_id UUID,
    p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO player_wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = player_wallets.balance + p_amount, updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Credit agent commission
CREATE OR REPLACE FUNCTION credit_agent_commission(
    p_agent_id UUID,
    p_amount NUMERIC,
    p_period_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    UPDATE agents SET balance = balance + p_amount, updated_at = NOW() WHERE id = p_agent_id;
    
    INSERT INTO wallet_transactions (user_id, type, amount, period_id, description)
    VALUES ((SELECT user_id FROM agents WHERE id = p_agent_id), 'COMMISSION', p_amount, p_period_id, 'Agent commission credit');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Credit player rakeback
CREATE OR REPLACE FUNCTION credit_player_rakeback(
    p_user_id UUID,
    p_amount NUMERIC,
    p_period_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO player_wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = player_wallets.balance + p_amount, updated_at = NOW();
    
    INSERT INTO wallet_transactions (user_id, type, amount, period_id, description)
    VALUES (p_user_id, 'RAKEBACK', p_amount, p_period_id, 'Rakeback credit');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. LEADERBOARD & STATS FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_club_leaderboard(
    p_club_id UUID,
    p_period TEXT DEFAULT 'week',
    p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
    rank INTEGER,
    user_id UUID,
    username TEXT,
    avatar_url TEXT,
    total_profit NUMERIC,
    hands_played INTEGER,
    biggest_pot NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ROW_NUMBER() OVER (ORDER BY COALESCE(ps.total_profit, 0) DESC)::INTEGER as rank,
        p.id as user_id,
        p.username,
        p.avatar_url,
        COALESCE(ps.total_profit, 0) as total_profit,
        COALESCE(ps.hands_played, 0) as hands_played,
        COALESCE(ps.biggest_pot, 0) as biggest_pot
    FROM profiles p
    JOIN club_memberships cm ON cm.user_id = p.id
    LEFT JOIN player_stats ps ON ps.user_id = p.id AND ps.club_id = p_club_id
    WHERE cm.club_id = p_club_id AND cm.status = 'active'
    ORDER BY total_profit DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_union_leaderboard(
    p_union_id UUID,
    p_period TEXT DEFAULT 'week',
    p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
    rank INTEGER,
    user_id UUID,
    username TEXT,
    avatar_url TEXT,
    club_name TEXT,
    total_profit NUMERIC,
    hands_played INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ROW_NUMBER() OVER (ORDER BY COALESCE(ps.total_profit, 0) DESC)::INTEGER as rank,
        p.id as user_id,
        p.username,
        p.avatar_url,
        c.name as club_name,
        COALESCE(ps.total_profit, 0) as total_profit,
        COALESCE(ps.hands_played, 0) as hands_played
    FROM profiles p
    JOIN club_memberships cm ON cm.user_id = p.id
    JOIN clubs c ON c.id = cm.club_id
    LEFT JOIN player_stats ps ON ps.user_id = p.id
    WHERE c.union_id = p_union_id AND cm.status = 'active'
    ORDER BY total_profit DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_player_hand_stats(
    p_user_id UUID,
    p_hands_delta INTEGER,
    p_profit_delta NUMERIC,
    p_pot_size NUMERIC DEFAULT 0
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO player_stats (user_id, hands_played, total_profit, biggest_pot)
    VALUES (p_user_id, p_hands_delta, p_profit_delta, p_pot_size)
    ON CONFLICT (user_id) 
    DO UPDATE SET 
        hands_played = player_stats.hands_played + p_hands_delta,
        total_profit = player_stats.total_profit + p_profit_delta,
        biggest_pot = GREATEST(player_stats.biggest_pot, p_pot_size),
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_user_leaderboard_rank(
    p_user_id UUID,
    p_club_id UUID DEFAULT NULL
)
RETURNS TABLE (rank INTEGER, total_players INTEGER) AS $$
DECLARE
    v_profit NUMERIC;
    v_rank INTEGER;
    v_total INTEGER;
BEGIN
    -- Get user's profit
    SELECT COALESCE(total_profit, 0) INTO v_profit FROM player_stats WHERE user_id = p_user_id;
    
    -- Count users with higher profit
    IF p_club_id IS NOT NULL THEN
        SELECT COUNT(*) INTO v_rank 
        FROM player_stats ps
        JOIN club_memberships cm ON cm.user_id = ps.user_id
        WHERE cm.club_id = p_club_id AND ps.total_profit > v_profit;
        
        SELECT COUNT(*) INTO v_total FROM club_memberships WHERE club_id = p_club_id;
    ELSE
        SELECT COUNT(*) INTO v_rank FROM player_stats WHERE total_profit > v_profit;
        SELECT COUNT(*) INTO v_total FROM player_stats;
    END IF;
    
    RETURN QUERY SELECT v_rank + 1, v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. BONUS & REWARDS FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION add_chips(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID AS $$
BEGIN
    INSERT INTO player_wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = player_wallets.balance + p_amount, updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION add_xp(p_user_id UUID, p_amount INTEGER)
RETURNS VOID AS $$
DECLARE
    v_current_xp INTEGER;
    v_current_level INTEGER;
    v_xp_for_next INTEGER;
BEGIN
    -- Get current XP and level
    SELECT COALESCE(xp, 0), COALESCE(level, 1) INTO v_current_xp, v_current_level 
    FROM profiles WHERE id = p_user_id;
    
    v_current_xp := v_current_xp + p_amount;
    
    -- Calculate level ups (simple: 1000 XP per level)
    v_xp_for_next := v_current_level * 1000;
    WHILE v_current_xp >= v_xp_for_next LOOP
        v_current_xp := v_current_xp - v_xp_for_next;
        v_current_level := v_current_level + 1;
        v_xp_for_next := v_current_level * 1000;
    END LOOP;
    
    UPDATE profiles SET xp = v_current_xp, level = v_current_level, updated_at = NOW()
    WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION add_vip_points(p_user_id UUID, p_amount INTEGER)
RETURNS VOID AS $$
BEGIN
    UPDATE profiles SET vip_points = COALESCE(vip_points, 0) + p_amount, updated_at = NOW()
    WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION add_to_promo_wallet(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID AS $$
BEGIN
    INSERT INTO player_wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PROMO', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = player_wallets.balance + p_amount, updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. COMMISSION FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION calculate_agent_spread(p_agent_id UUID)
RETURNS TABLE (
    player_id UUID,
    player_name TEXT,
    rake_generated NUMERIC,
    commission_rate NUMERIC,
    commission_amount NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ap.player_id,
        p.username as player_name,
        COALESCE(SUM(rr.amount), 0) as rake_generated,
        COALESCE(ap.commission_rate, 0.10) as commission_rate,
        COALESCE(SUM(rr.amount), 0) * COALESCE(ap.commission_rate, 0.10) as commission_amount
    FROM agent_players ap
    JOIN profiles p ON p.id = ap.player_id
    LEFT JOIN rake_records rr ON rr.player_id = ap.player_id
    WHERE ap.agent_id = p_agent_id
    GROUP BY ap.player_id, p.username, ap.commission_rate;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_player_rake_total(
    p_player_id UUID,
    p_period_id UUID DEFAULT NULL
)
RETURNS NUMERIC AS $$
DECLARE
    v_total NUMERIC;
BEGIN
    IF p_period_id IS NOT NULL THEN
        SELECT COALESCE(SUM(amount), 0) INTO v_total 
        FROM rake_records WHERE player_id = p_player_id AND period_id = p_period_id;
    ELSE
        SELECT COALESCE(SUM(amount), 0) INTO v_total 
        FROM rake_records WHERE player_id = p_player_id;
    END IF;
    
    RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION calculate_cascading_commission(p_agent_id UUID, p_gross_rake NUMERIC)
RETURNS TABLE (
    agent_id UUID,
    level INTEGER,
    commission_rate NUMERIC,
    commission_amount NUMERIC
) AS $$
DECLARE
    v_current_agent UUID := p_agent_id;
    v_level INTEGER := 0;
    v_remaining NUMERIC := p_gross_rake;
    v_rate NUMERIC;
    v_amount NUMERIC;
BEGIN
    WHILE v_current_agent IS NOT NULL AND v_level < 10 LOOP
        SELECT a.commission_rate, a.parent_agent_id INTO v_rate, v_current_agent
        FROM agents a WHERE a.id = v_current_agent;
        
        v_amount := v_remaining * COALESCE(v_rate, 0.10);
        v_remaining := v_remaining - v_amount;
        v_level := v_level + 1;
        
        RETURN QUERY SELECT v_current_agent, v_level, v_rate, v_amount;
        
        v_current_agent := (SELECT parent_agent_id FROM agents WHERE id = v_current_agent);
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION generate_period_commissions(p_period_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    -- Generate commission records for all agents for this period
    INSERT INTO commission_records (agent_id, period_id, gross_rake, commission_rate, commission_amount, status)
    SELECT 
        a.id,
        p_period_id,
        COALESCE(SUM(rr.amount), 0),
        COALESCE(a.commission_rate, 0.10),
        COALESCE(SUM(rr.amount), 0) * COALESCE(a.commission_rate, 0.10),
        'pending'
    FROM agents a
    LEFT JOIN agent_players ap ON ap.agent_id = a.id
    LEFT JOIN rake_records rr ON rr.player_id = ap.player_id AND rr.period_id = p_period_id
    GROUP BY a.id
    ON CONFLICT (agent_id, period_id) DO UPDATE SET
        gross_rake = EXCLUDED.gross_rake,
        commission_amount = EXCLUDED.commission_amount,
        updated_at = NOW();
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION execute_commission_payout(p_commission_id UUID)
RETURNS VOID AS $$
DECLARE
    v_agent_id UUID;
    v_amount NUMERIC;
BEGIN
    SELECT agent_id, commission_amount INTO v_agent_id, v_amount
    FROM commission_records WHERE id = p_commission_id AND status = 'pending';
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Commission record not found or already paid';
    END IF;
    
    -- Credit agent
    UPDATE agents SET balance = balance + v_amount WHERE id = v_agent_id;
    
    -- Mark as paid
    UPDATE commission_records SET status = 'paid', paid_at = NOW() WHERE id = p_commission_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Deduct agent balance
CREATE OR REPLACE FUNCTION deduct_agent_balance(p_agent_id UUID, p_amount NUMERIC)
RETURNS VOID AS $$
BEGIN
    UPDATE agents SET balance = balance - p_amount, updated_at = NOW()
    WHERE id = p_agent_id AND balance >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient agent balance';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. ARENA & TRAINING FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_check_level_advancement(
    p_user_id UUID,
    p_game_id UUID
)
RETURNS TABLE (advanced BOOLEAN, new_level INTEGER, xp_earned INTEGER) AS $$
DECLARE
    v_current_level INTEGER;
    v_score INTEGER;
    v_threshold INTEGER;
BEGIN
    SELECT COALESCE(level, 1), COALESCE(score, 0) INTO v_current_level, v_score
    FROM user_game_progress WHERE user_id = p_user_id AND game_id = p_game_id;
    
    v_threshold := v_current_level * 100; -- 100 points per level
    
    IF v_score >= v_threshold THEN
        UPDATE user_game_progress 
        SET level = level + 1, score = score - v_threshold, updated_at = NOW()
        WHERE user_id = p_user_id AND game_id = p_game_id;
        
        RETURN QUERY SELECT TRUE, v_current_level + 1, 50; -- 50 XP for level up
    ELSE
        RETURN QUERY SELECT FALSE, v_current_level, 0;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION record_arena_session(
    p_user_id UUID,
    p_game_id UUID,
    p_score_delta INTEGER,
    p_hands_played INTEGER
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO user_game_progress (user_id, game_id, score, hands_played)
    VALUES (p_user_id, p_game_id, p_score_delta, p_hands_played)
    ON CONFLICT (user_id, game_id) 
    DO UPDATE SET 
        score = user_game_progress.score + p_score_delta,
        hands_played = user_game_progress.hands_played + p_hands_played,
        last_played_at = NOW(),
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_arena_lobby_clubs()
RETURNS TABLE (
    club_id UUID,
    club_name TEXT,
    avatar_url TEXT,
    active_tables INTEGER,
    active_players INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id,
        c.name,
        c.avatar_url,
        COUNT(DISTINCT t.id)::INTEGER,
        COUNT(DISTINCT tp.user_id)::INTEGER
    FROM clubs c
    LEFT JOIN tables t ON t.club_id = c.id AND t.status = 'active'
    LEFT JOIN table_players tp ON tp.table_id = t.id AND tp.status = 'seated'
    WHERE c.is_public = TRUE
    GROUP BY c.id, c.name, c.avatar_url
    ORDER BY COUNT(DISTINCT tp.user_id) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_club_traffic(p_club_id UUID)
RETURNS TABLE (
    table_id UUID,
    table_name TEXT,
    game_type TEXT,
    stakes TEXT,
    seated_count INTEGER,
    max_seats INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        t.id,
        t.name,
        t.game_type,
        t.stakes,
        COUNT(tp.user_id)::INTEGER as seated_count,
        t.max_players
    FROM tables t
    LEFT JOIN table_players tp ON tp.table_id = t.id AND tp.status = 'seated'
    WHERE t.club_id = p_club_id AND t.status = 'active'
    GROUP BY t.id, t.name, t.game_type, t.stakes, t.max_players;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_table_state(p_table_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_state JSONB;
BEGIN
    SELECT jsonb_build_object(
        'table', row_to_json(t.*),
        'players', (
            SELECT jsonb_agg(row_to_json(tp.*))
            FROM table_players tp WHERE tp.table_id = p_table_id
        ),
        'current_hand', (
            SELECT row_to_json(h.*)
            FROM hands h WHERE h.table_id = p_table_id 
            ORDER BY h.created_at DESC LIMIT 1
        )
    ) INTO v_state
    FROM tables t WHERE t.id = p_table_id;
    
    RETURN v_state;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. CLUB DISCOVERY & UNION FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_discover_clubs(
    p_search TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
    id UUID,
    name TEXT,
    description TEXT,
    avatar_url TEXT,
    member_count INTEGER,
    active_tables INTEGER,
    is_public BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id,
        c.name,
        c.description,
        c.avatar_url,
        c.member_count,
        COUNT(t.id)::INTEGER as active_tables,
        c.is_public
    FROM clubs c
    LEFT JOIN tables t ON t.club_id = c.id AND t.status = 'active'
    WHERE c.is_public = TRUE
      AND (p_search IS NULL OR c.name ILIKE '%' || p_search || '%')
    GROUP BY c.id
    ORDER BY c.member_count DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION increment_union_club_count(p_union_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE unions SET club_count = club_count + 1, updated_at = NOW()
    WHERE id = p_union_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. SETTLEMENT FUNCTIONS (Missing)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION generate_period_settlements(p_period_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    -- Generate settlement records for all clubs
    INSERT INTO settlements (club_id, period_id, gross_rake, net_amount, status)
    SELECT 
        c.id,
        p_period_id,
        COALESCE(SUM(rr.amount), 0),
        COALESCE(SUM(rr.amount), 0) * 0.9, -- 90% to club after union fee
        'pending'
    FROM clubs c
    LEFT JOIN rake_records rr ON rr.club_id = c.id AND rr.period_id = p_period_id
    GROUP BY c.id
    ON CONFLICT (club_id, period_id) DO UPDATE SET
        gross_rake = EXCLUDED.gross_rake,
        net_amount = EXCLUDED.net_amount,
        updated_at = NOW();
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. LEADERBOARD RECALCULATION
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION recalculate_leaderboard_ranks(p_leaderboard_id UUID)
RETURNS VOID AS $$
BEGIN
    -- Update ranks based on score
    UPDATE leaderboard_entries le
    SET rank = subq.new_rank
    FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY score DESC) as new_rank
        FROM leaderboard_entries WHERE leaderboard_id = p_leaderboard_id
    ) subq
    WHERE le.id = subq.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. SUPPORTING TABLES (if not exist)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS table_chip_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    table_id UUID NOT NULL,
    amount NUMERIC NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, table_id)
);

CREATE TABLE IF NOT EXISTS user_game_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    game_id UUID NOT NULL,
    level INTEGER DEFAULT 1,
    score INTEGER DEFAULT 0,
    hands_played INTEGER DEFAULT 0,
    last_played_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, game_id)
);

CREATE TABLE IF NOT EXISTS commission_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL,
    period_id UUID NOT NULL,
    gross_rake NUMERIC DEFAULT 0,
    commission_rate NUMERIC DEFAULT 0.10,
    commission_amount NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'pending',
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, period_id)
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leaderboard_id UUID NOT NULL,
    user_id UUID NOT NULL,
    score NUMERIC DEFAULT 0,
    rank INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Grant execute permissions
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
