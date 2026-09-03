-- ═══════════════════════════════════════════════════════════════════════════════
-- 🎮 GAMIFICATION AND SOCIAL FEATURES MIGRATION
-- ═══════════════════════════════════════════════════════════════════════════════
-- Adds tables and functions for:
-- - Daily bonus wheel spins
-- - Direct messaging
-- - Friend requests
-- - Notifications
-- - Leaderboards
-- - Wallet transactions
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════
-- DAILY BONUS SPINS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS daily_spins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    reward_type TEXT NOT NULL,
    reward_amount INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_spins_user ON daily_spins(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_spins_created ON daily_spins(created_at);

-- ═══════════════════════════════════════════════════════════════════
-- DIRECT MESSAGES
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS direct_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    content TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_dm_recipient ON direct_messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_dm_created ON direct_messages(created_at);

-- ═══════════════════════════════════════════════════════════════════
-- FRIEND REQUESTS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS friend_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_friend_req_sender ON friend_requests(sender_id);
CREATE INDEX IF NOT EXISTS idx_friend_req_recipient ON friend_requests(recipient_id);
CREATE INDEX IF NOT EXISTS idx_friend_req_status ON friend_requests(status);

-- ═══════════════════════════════════════════════════════════════════
-- FRIENDSHIPS (accepted relationships)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    friend_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, friend_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);

-- ═══════════════════════════════════════════════════════════════════
-- NOTIFICATIONS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    action_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
-- Note: is_read index only if column exists (may conflict with 013_missing_tables schema)
DO $$ BEGIN
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);
EXCEPTION WHEN undefined_column THEN
    NULL; -- Column doesn't exist, skip index
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- WALLET TRANSACTIONS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    wallet_id UUID,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER,
    description TEXT,
    status TEXT DEFAULT 'completed',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id);
-- wallet_id may not exist in all schemas, handle gracefully
DO $$ BEGIN
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id);
EXCEPTION WHEN undefined_column THEN
    NULL; -- Column doesn't exist, skip index
END $$;
CREATE INDEX IF NOT EXISTS idx_wallet_tx_type ON wallet_transactions(type);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_created ON wallet_transactions(created_at);

-- ═══════════════════════════════════════════════════════════════════
-- SPIN TOURNAMENTS (for Spin & Go)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS spin_tournaments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL,
    buy_in INTEGER NOT NULL,
    player_count INTEGER DEFAULT 0,
    max_players INTEGER DEFAULT 3,
    prize_pool INTEGER DEFAULT 0,
    multiplier INTEGER DEFAULT 2,
    multipliers INTEGER[] DEFAULT '{2,3,4,5,10,25,50,100,1000}',
    status TEXT DEFAULT 'registering' CHECK (status IN ('registering', 'spinning', 'running', 'complete')),
    start_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spin_club ON spin_tournaments(club_id);
CREATE INDEX IF NOT EXISTS idx_spin_status ON spin_tournaments(status);

-- ═══════════════════════════════════════════════════════════════════
-- CLUB ANNOUNCEMENTS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS club_announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL,
    author_id UUID NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    priority TEXT DEFAULT 'normal',
    is_pinned BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_announcements_club ON club_announcements(club_id);

-- ═══════════════════════════════════════════════════════════════════
-- COMMISSION RECORDS (for agents)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commission_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL,
    player_id UUID NOT NULL,
    player_name TEXT,
    table_id UUID,
    table_name TEXT,
    rake_amount INTEGER NOT NULL DEFAULT 0,
    commission_rate NUMERIC(5,4) DEFAULT 0.1,
    amount INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commission_agent ON commission_records(agent_id);
CREATE INDEX IF NOT EXISTS idx_commission_created ON commission_records(created_at);

-- ═══════════════════════════════════════════════════════════════════
-- RPC FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════

-- Grant daily reward
CREATE OR REPLACE FUNCTION fn_grant_daily_reward(
    p_user_id UUID,
    p_reward_type TEXT,
    p_reward_amount INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF p_reward_type = 'chips' THEN
        UPDATE wallets SET balance = balance + p_reward_amount WHERE user_id = p_user_id;
    ELSIF p_reward_type = 'diamonds' THEN
        UPDATE profiles SET diamonds = COALESCE(diamonds, 0) + p_reward_amount WHERE id = p_user_id;
    ELSIF p_reward_type = 'xp' THEN
        UPDATE profiles SET xp = COALESCE(xp, 0) + p_reward_amount WHERE id = p_user_id;
    END IF;
END;
$$;

-- Get conversations for a user
CREATE OR REPLACE FUNCTION fn_get_conversations(p_user_id UUID)
RETURNS TABLE (
    partner_id UUID,
    partner_name TEXT,
    partner_avatar TEXT,
    last_message TEXT,
    last_message_at TIMESTAMPTZ,
    unread_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    WITH conversations AS (
        SELECT 
            CASE WHEN sender_id = p_user_id THEN recipient_id ELSE sender_id END as partner,
            content,
            created_at,
            CASE WHEN recipient_id = p_user_id AND NOT is_read THEN 1 ELSE 0 END as is_unread
        FROM direct_messages
        WHERE sender_id = p_user_id OR recipient_id = p_user_id
    ),
    latest AS (
        SELECT 
            partner,
            content as last_msg,
            created_at as last_at,
            SUM(is_unread) as unread
        FROM conversations
        GROUP BY partner, content, created_at
    )
    SELECT 
        l.partner,
        p.username,
        p.avatar_url,
        MAX(l.last_msg),
        MAX(l.last_at),
        COALESCE(SUM(l.unread), 0)
    FROM latest l
    JOIN profiles p ON p.id = l.partner
    GROUP BY l.partner, p.username, p.avatar_url
    ORDER BY MAX(l.last_at) DESC;
END;
$$;

-- Get friends list
CREATE OR REPLACE FUNCTION fn_get_friends(p_user_id UUID)
RETURNS TABLE (
    friend_id UUID,
    username TEXT,
    avatar_url TEXT,
    status TEXT,
    current_table_name TEXT,
    last_seen TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        f.friend_id,
        p.username,
        p.avatar_url,
        COALESCE(pp.status, 'offline')::TEXT,
        NULL::TEXT,
        pp.last_seen_at
    FROM friendships f
    JOIN profiles p ON p.id = f.friend_id
    LEFT JOIN player_presence pp ON pp.user_id = f.friend_id
    WHERE f.user_id = p_user_id;
END;
$$;

-- Accept friend request
CREATE OR REPLACE FUNCTION fn_accept_friend_request(p_request_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_sender UUID;
    v_recipient UUID;
BEGIN
    SELECT sender_id, recipient_id INTO v_sender, v_recipient
    FROM friend_requests WHERE id = p_request_id;
    
    UPDATE friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = p_request_id;
    
    INSERT INTO friendships (user_id, friend_id) VALUES (v_sender, v_recipient);
    INSERT INTO friendships (user_id, friend_id) VALUES (v_recipient, v_sender);
END;
$$;

-- Remove friend
CREATE OR REPLACE FUNCTION fn_remove_friend(p_user_id UUID, p_friend_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM friendships WHERE 
        (user_id = p_user_id AND friend_id = p_friend_id) OR
        (user_id = p_friend_id AND friend_id = p_user_id);
END;
$$;

-- Get leaderboard
CREATE OR REPLACE FUNCTION fn_get_leaderboard(
    p_club_id UUID,
    p_period TEXT,
    p_metric TEXT,
    p_limit INTEGER
)
RETURNS TABLE (
    user_id UUID,
    username TEXT,
    avatar_url TEXT,
    value BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_start_date TIMESTAMPTZ;
BEGIN
    v_start_date := CASE p_period
        WHEN 'daily' THEN NOW() - INTERVAL '1 day'
        WHEN 'weekly' THEN NOW() - INTERVAL '7 days'
        WHEN 'monthly' THEN NOW() - INTERVAL '30 days'
        ELSE '1970-01-01'::TIMESTAMPTZ
    END;

    RETURN QUERY
    SELECT 
        ps.user_id,
        p.username,
        p.avatar_url,
        CASE p_metric
            WHEN 'profit' THEN COALESCE(ps.total_winnings - ps.total_losses, 0)
            WHEN 'hands' THEN COALESCE(ps.hands_played, 0)
            WHEN 'rake' THEN COALESCE(ps.total_rake, 0)
            ELSE 0
        END as value
    FROM player_stats ps
    JOIN profiles p ON p.id = ps.user_id
    WHERE (p_club_id IS NULL OR ps.club_id = p_club_id)
    ORDER BY value DESC
    LIMIT p_limit;
END;
$$;

-- Purchase chips with diamonds
CREATE OR REPLACE FUNCTION fn_purchase_chips(
    p_user_id UUID,
    p_diamond_cost INTEGER,
    p_chip_amount INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_current_diamonds INTEGER;
BEGIN
    SELECT diamonds INTO v_current_diamonds FROM profiles WHERE id = p_user_id;
    
    IF v_current_diamonds < p_diamond_cost THEN
        RAISE EXCEPTION 'Insufficient diamonds';
    END IF;
    
    UPDATE profiles SET diamonds = diamonds - p_diamond_cost WHERE id = p_user_id;
    UPDATE wallets SET balance = balance + p_chip_amount WHERE user_id = p_user_id;
    
    INSERT INTO wallet_transactions (user_id, type, amount, description)
    VALUES (p_user_id, 'purchase', p_chip_amount, 'Chip purchase with diamonds');
END;
$$;

-- Get agent commission summary
CREATE OR REPLACE FUNCTION fn_get_agent_commission_summary(p_agent_id UUID)
RETURNS TABLE (
    total_earned BIGINT,
    this_week BIGINT,
    this_month BIGINT,
    pending_payout BIGINT,
    last_payout TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(SUM(amount), 0)::BIGINT,
        COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN amount ELSE 0 END), 0)::BIGINT,
        COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN amount ELSE 0 END), 0)::BIGINT,
        0::BIGINT,
        NULL::TIMESTAMPTZ
    FROM commission_records
    WHERE agent_id = p_agent_id;
END;
$$;
