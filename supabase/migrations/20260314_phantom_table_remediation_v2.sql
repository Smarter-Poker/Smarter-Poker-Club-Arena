-- ═══════════════════════════════════════════════════════════════════════════════
-- PHANTOM TABLE REMEDIATION v2 (March 14, 2026)
-- Creates 28 missing tables and 1 RPC referenced in code but absent from Supabase.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. MESSAGING / SOCIAL
-- ─────────────────────────────────────────────────────────────────────────────

-- conversation_participants: links users to conversations (used by MessagingService, ConversationList, MessageThread)
CREATE TABLE IF NOT EXISTS conversation_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL,
    user_id UUID NOT NULL,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    last_read_at TIMESTAMPTZ,
    is_muted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_participants_conv ON conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_participants_user ON conversation_participants(user_id);

-- social_conversation_participants: social hub variant (used by ClubArenaBottomNav)
CREATE TABLE IF NOT EXISTS social_conversation_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL,
    user_id UUID NOT NULL,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    last_read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_social_conv_parts_user ON social_conversation_participants(user_id);

-- table_chat: in-game chat messages (used by TableChatHUD)
CREATE TABLE IF NOT EXISTS table_chat (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id UUID NOT NULL,
    user_id UUID NOT NULL,
    message TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_table_chat_table ON table_chat(table_id);
CREATE INDEX IF NOT EXISTS idx_table_chat_created ON table_chat(table_id, created_at DESC);

-- club_chat: club-level chat (used by ClubChat)
CREATE TABLE IF NOT EXISTS club_chat (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL,
    user_id UUID NOT NULL,
    message TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_club_chat_club ON club_chat(club_id);
CREATE INDEX IF NOT EXISTS idx_club_chat_created ON club_chat(club_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FINANCIAL / DIAMOND
-- ─────────────────────────────────────────────────────────────────────────────

-- diamond_transactions: diamond purchase/spend ledger (used by DiamondWalletModal, deduct_diamonds RPC)
CREATE TABLE IF NOT EXISTS diamond_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('credit', 'debit', 'purchase', 'reward', 'spend')),
    source TEXT,
    description TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_diamond_tx_user ON diamond_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_diamond_tx_created ON diamond_transactions(user_id, created_at DESC);

-- rake_attributions: per-player rake credit records (used by CommissionService)
CREATE TABLE IF NOT EXISTS rake_attributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hand_id UUID,
    table_id UUID,
    club_id UUID,
    user_id UUID NOT NULL,
    rake_credit NUMERIC(18,4) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rake_attr_user ON rake_attributions(user_id);
CREATE INDEX IF NOT EXISTS idx_rake_attr_club ON rake_attributions(club_id);
CREATE INDEX IF NOT EXISTS idx_rake_attr_hand ON rake_attributions(hand_id);

-- rake_transactions: union-level rake ledger (used by UnionService)
CREATE TABLE IF NOT EXISTS rake_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    union_id UUID,
    club_id UUID,
    amount NUMERIC(18,4) NOT NULL,
    type TEXT DEFAULT 'rake',
    source TEXT,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rake_tx_union ON rake_transactions(union_id);
CREATE INDEX IF NOT EXISTS idx_rake_tx_club ON rake_transactions(club_id);

-- settlement_locks: concurrent settlement guards (used by settlementLock.ts)
CREATE TABLE IF NOT EXISTS settlement_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL,
    lock_type TEXT DEFAULT 'settlement',
    locked_by UUID,
    locked_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes'),
    released_at TIMESTAMPTZ,
    UNIQUE(club_id, lock_type)
);
CREATE INDEX IF NOT EXISTS idx_settlement_locks_club ON settlement_locks(club_id);

-- union_wallets: union treasury balance (used by UnionDashboardPage)
CREATE TABLE IF NOT EXISTS union_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    union_id UUID NOT NULL UNIQUE,
    balance NUMERIC(18,4) DEFAULT 0,
    total_deposited NUMERIC(18,4) DEFAULT 0,
    total_withdrawn NUMERIC(18,4) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_union_wallets_union ON union_wallets(union_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. STATS / HISTORY
-- ─────────────────────────────────────────────────────────────────────────────

-- hand_players: per-hand player records (used by HandPersistenceService, HandHistoryService, ProfileService, FriendSuggestionService)
CREATE TABLE IF NOT EXISTS hand_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hand_id UUID NOT NULL,
    user_id UUID NOT NULL,
    seat_number INTEGER,
    position TEXT,
    hole_cards TEXT,
    stack_start NUMERIC(18,4) DEFAULT 0,
    stack_end NUMERIC(18,4) DEFAULT 0,
    net_result NUMERIC(18,4) DEFAULT 0,
    is_winner BOOLEAN DEFAULT FALSE,
    went_to_showdown BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hand_players_hand ON hand_players(hand_id);
CREATE INDEX IF NOT EXISTS idx_hand_players_user ON hand_players(user_id);

-- hand_results: showdown outcomes (used by HorseOrchestrator)
CREATE TABLE IF NOT EXISTS hand_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hand_id UUID NOT NULL,
    winner_id UUID,
    pot_amount NUMERIC(18,4) DEFAULT 0,
    winning_hand TEXT,
    hand_rank TEXT,
    side_pots JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hand_results_hand ON hand_results(hand_id);
CREATE INDEX IF NOT EXISTS idx_hand_results_winner ON hand_results(winner_id);

-- player_position_stats: position-based win rates (used by PositionStatsPopup, PlayerStyleRadar, PositionWinRates, AnalyticsDashboard, PlayerStatsPage)
CREATE TABLE IF NOT EXISTS player_position_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    position TEXT NOT NULL,
    hands_played INTEGER DEFAULT 0,
    hands_won INTEGER DEFAULT 0,
    vpip_count INTEGER DEFAULT 0,
    pfr_count INTEGER DEFAULT 0,
    three_bet_count INTEGER DEFAULT 0,
    total_profit NUMERIC(18,4) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, position)
);
CREATE INDEX IF NOT EXISTS idx_position_stats_user ON player_position_stats(user_id);

-- player_sessions: session-level analytics (used by AdminDashboardPage, PlayerStatsPage)
CREATE TABLE IF NOT EXISTS player_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    club_id UUID,
    table_id UUID,
    start_time TIMESTAMPTZ DEFAULT NOW(),
    end_time TIMESTAMPTZ,
    hands_played INTEGER DEFAULT 0,
    net_result NUMERIC(18,4) DEFAULT 0,
    buy_in_total NUMERIC(18,4) DEFAULT 0,
    cash_out_total NUMERIC(18,4) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_user ON player_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_player_sessions_club ON player_sessions(club_id);

-- table_hole_cards: dealt hole cards per hand (used by TablePage)
CREATE TABLE IF NOT EXISTS table_hole_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hand_id UUID NOT NULL,
    table_id UUID NOT NULL,
    user_id UUID NOT NULL,
    cards TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hole_cards_hand ON table_hole_cards(hand_id);
CREATE INDEX IF NOT EXISTS idx_hole_cards_table ON table_hole_cards(table_id);

-- table_activity: table lifecycle events (used by TableService)
CREATE TABLE IF NOT EXISTS table_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id UUID NOT NULL,
    activity_type TEXT NOT NULL,
    user_id UUID,
    data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_table_activity_table ON table_activity(table_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ANTI-CHEAT
-- ─────────────────────────────────────────────────────────────────────────────

-- anti_cheat_events: flagged suspicious events (used by AntiCheatPage)
CREATE TABLE IF NOT EXISTS anti_cheat_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID,
    user_id UUID,
    event_type TEXT NOT NULL,
    severity TEXT DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    details JSONB,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed', 'confirmed')),
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_events_club ON anti_cheat_events(club_id);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_events_user ON anti_cheat_events(user_id);

-- anti_cheat_flags: player-level flags (used by AntiCheatPage)
CREATE TABLE IF NOT EXISTS anti_cheat_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    club_id UUID,
    flag_type TEXT NOT NULL,
    risk_score NUMERIC(5,2) DEFAULT 0,
    details JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_flags_user ON anti_cheat_flags(user_id);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_flags_club ON anti_cheat_flags(club_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CLUB / UNION
-- ─────────────────────────────────────────────────────────────────────────────

-- club_challenges: club mission definitions (used by ClubsService)
CREATE TABLE IF NOT EXISTS club_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    challenge_type TEXT DEFAULT 'daily',
    target_value INTEGER DEFAULT 1,
    reward_type TEXT DEFAULT 'xp',
    reward_amount INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_club_challenges_club ON club_challenges(club_id);

-- club_daily_stats: daily aggregate stats (used by ClubStatsCards)
CREATE TABLE IF NOT EXISTS club_daily_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL,
    stat_date DATE NOT NULL DEFAULT CURRENT_DATE,
    hands_played INTEGER DEFAULT 0,
    rake_collected NUMERIC(18,4) DEFAULT 0,
    active_players INTEGER DEFAULT 0,
    tables_active INTEGER DEFAULT 0,
    peak_concurrent INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(club_id, stat_date)
);
CREATE INDEX IF NOT EXISTS idx_club_daily_stats_club ON club_daily_stats(club_id);

-- union_announcements: union-level bulletins (used by UnionDashboardPage)
CREATE TABLE IF NOT EXISTS union_announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    union_id UUID NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    type TEXT DEFAULT 'info',
    is_pinned BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_by UUID,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_union_announcements_union ON union_announcements(union_id);

-- union_applications: club join requests to union (used by UnionDashboardPage)
CREATE TABLE IF NOT EXISTS union_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    union_id UUID NOT NULL,
    club_id UUID NOT NULL,
    applicant_id UUID,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    notes TEXT,
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(union_id, club_id)
);
CREATE INDEX IF NOT EXISTS idx_union_applications_union ON union_applications(union_id);

-- union_members: union membership links (used by PermissionService, ClubMessagingPermissions)
CREATE TABLE IF NOT EXISTS union_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    union_id UUID NOT NULL,
    user_id UUID NOT NULL,
    role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(union_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_union_members_union ON union_members(union_id);
CREATE INDEX IF NOT EXISTS idx_union_members_user ON union_members(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. ENGAGEMENT / GAMIFICATION
-- ─────────────────────────────────────────────────────────────────────────────

-- bbj_winners: bad beat jackpot winner records (used by BBJDisplay, BadBeatJackpotPage)
CREATE TABLE IF NOT EXISTS bbj_winners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID,
    club_id UUID,
    user_id UUID NOT NULL,
    hand_id UUID,
    amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    winner_type TEXT DEFAULT 'loser' CHECK (winner_type IN ('loser', 'winner', 'table')),
    hand_description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bbj_winners_pool ON bbj_winners(pool_id);
CREATE INDEX IF NOT EXISTS idx_bbj_winners_user ON bbj_winners(user_id);

-- favorite_tables: user table bookmarks (used by FavoriteTablesWidget)
CREATE TABLE IF NOT EXISTS favorite_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    table_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, table_id)
);
CREATE INDEX IF NOT EXISTS idx_favorite_tables_user ON favorite_tables(user_id);

-- marketplace_items: store item catalog (used by MarketplacePage)
CREATE TABLE IF NOT EXISTS marketplace_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'general',
    price NUMERIC(18,4) NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'diamonds' CHECK (currency IN ('diamonds', 'chips')),
    image_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    stock INTEGER DEFAULT -1,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_category ON marketplace_items(category);

-- promotion_claims: promo reward claims (used by PromotionService)
CREATE TABLE IF NOT EXISTS promotion_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promotion_id UUID NOT NULL,
    user_id UUID NOT NULL,
    reward_type TEXT,
    reward_amount NUMERIC(18,4) DEFAULT 0,
    claimed_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(promotion_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_promotion_claims_promo ON promotion_claims(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promotion_claims_user ON promotion_claims(user_id);

-- referrals: referral tracking (used by PromotionService)
CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID NOT NULL,
    referred_id UUID NOT NULL,
    code TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired')),
    reward_paid BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(referrer_id, referred_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

-- user_bonuses: bonus reward history (used by BonusService)
CREATE TABLE IF NOT EXISTS user_bonuses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    bonus_type TEXT NOT NULL,
    bonus_amount NUMERIC(18,4) DEFAULT 0,
    source TEXT,
    claimed BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_bonuses_user ON user_bonuses(user_id);

-- user_feedback: support feedback submissions (used by FeedbackForm)
CREATE TABLE IF NOT EXISTS user_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    category TEXT DEFAULT 'general',
    subject TEXT,
    message TEXT NOT NULL,
    screenshot_url TEXT,
    status TEXT DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved', 'closed')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_feedback_user ON user_feedback(user_id);

-- user_presence: online status tracking (used by PresenceIndicator)
CREATE TABLE IF NOT EXISTS user_presence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE,
    status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'away', 'playing', 'offline')),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    current_table_id UUID,
    current_club_id UUID,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_presence_user ON user_presence(user_id);
CREATE INDEX IF NOT EXISTS idx_user_presence_status ON user_presence(status);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_chat ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_chat ENABLE ROW LEVEL SECURITY;
ALTER TABLE diamond_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rake_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rake_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE union_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hand_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE hand_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_position_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_hole_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE anti_cheat_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE anti_cheat_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE union_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE union_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE union_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE bbj_winners ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorite_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_bonuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_presence ENABLE ROW LEVEL SECURITY;

-- Permissive policies: read-all for game-related tables, own-data for personal tables
CREATE POLICY "conv_parts_all" ON conversation_participants FOR ALL USING (user_id = auth.uid());
CREATE POLICY "social_conv_parts_all" ON social_conversation_participants FOR ALL USING (user_id = auth.uid());
CREATE POLICY "table_chat_select" ON table_chat FOR SELECT USING (true);
CREATE POLICY "table_chat_insert" ON table_chat FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "club_chat_select" ON club_chat FOR SELECT USING (true);
CREATE POLICY "club_chat_insert" ON club_chat FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "diamond_tx_select" ON diamond_transactions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "rake_attr_select" ON rake_attributions FOR SELECT USING (true);
CREATE POLICY "rake_attr_insert" ON rake_attributions FOR INSERT WITH CHECK (true);
CREATE POLICY "rake_tx_select" ON rake_transactions FOR SELECT USING (true);
CREATE POLICY "settlement_locks_all" ON settlement_locks FOR ALL USING (true);
CREATE POLICY "union_wallets_select" ON union_wallets FOR SELECT USING (true);
CREATE POLICY "hand_players_all" ON hand_players FOR ALL USING (true);
CREATE POLICY "hand_results_all" ON hand_results FOR ALL USING (true);
CREATE POLICY "position_stats_select" ON player_position_stats FOR SELECT USING (true);
CREATE POLICY "position_stats_modify" ON player_position_stats FOR ALL USING (user_id = auth.uid());
CREATE POLICY "player_sessions_select" ON player_sessions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "player_sessions_insert" ON player_sessions FOR INSERT WITH CHECK (true);
CREATE POLICY "hole_cards_all" ON table_hole_cards FOR ALL USING (true);
CREATE POLICY "table_activity_all" ON table_activity FOR ALL USING (true);
CREATE POLICY "anti_cheat_events_select" ON anti_cheat_events FOR SELECT USING (true);
CREATE POLICY "anti_cheat_flags_select" ON anti_cheat_flags FOR SELECT USING (true);
CREATE POLICY "club_challenges_select" ON club_challenges FOR SELECT USING (true);
CREATE POLICY "club_daily_stats_select" ON club_daily_stats FOR SELECT USING (true);
CREATE POLICY "union_announcements_select" ON union_announcements FOR SELECT USING (true);
CREATE POLICY "union_applications_all" ON union_applications FOR ALL USING (true);
CREATE POLICY "union_members_select" ON union_members FOR SELECT USING (true);
CREATE POLICY "union_members_modify" ON union_members FOR ALL USING (user_id = auth.uid());
CREATE POLICY "bbj_winners_select" ON bbj_winners FOR SELECT USING (true);
CREATE POLICY "favorite_tables_all" ON favorite_tables FOR ALL USING (user_id = auth.uid());
CREATE POLICY "marketplace_items_select" ON marketplace_items FOR SELECT USING (true);
CREATE POLICY "promotion_claims_all" ON promotion_claims FOR ALL USING (user_id = auth.uid());
CREATE POLICY "referrals_select" ON referrals FOR SELECT USING (referrer_id = auth.uid() OR referred_id = auth.uid());
CREATE POLICY "user_bonuses_all" ON user_bonuses FOR ALL USING (user_id = auth.uid());
CREATE POLICY "user_feedback_all" ON user_feedback FOR ALL USING (user_id = auth.uid() OR user_id IS NULL);
CREATE POLICY "user_presence_select" ON user_presence FOR SELECT USING (true);
CREATE POLICY "user_presence_modify" ON user_presence FOR ALL USING (user_id = auth.uid());


-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. MISSING RPC: distribute_chips (used by AgentService.distributeFromTreasury)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION distribute_chips(
    p_club_id UUID,
    p_to_user_id UUID,
    p_amount NUMERIC,
    p_distributed_by UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_treasury_before NUMERIC;
    v_treasury_after NUMERIC;
    v_member_before NUMERIC;
    v_member_after NUMERIC;
BEGIN
    -- Get current treasury balance
    SELECT COALESCE(balance, 0) INTO v_treasury_before
    FROM club_diamond_wallets WHERE club_id = p_club_id;

    IF v_treasury_before IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Club treasury not found');
    END IF;

    IF v_treasury_before < p_amount THEN
        RETURN json_build_object('success', false, 'error', 'Insufficient treasury balance');
    END IF;

    -- Get member's current balance
    SELECT COALESCE(chip_balance, 0) INTO v_member_before
    FROM club_members WHERE club_id = p_club_id AND user_id = p_to_user_id;

    IF v_member_before IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Member not found in club');
    END IF;

    -- Deduct from treasury
    UPDATE club_diamond_wallets
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE club_id = p_club_id AND balance >= p_amount;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Treasury deduction failed');
    END IF;

    -- Credit to member
    UPDATE club_members
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_to_user_id;

    v_treasury_after := v_treasury_before - p_amount;
    v_member_after := v_member_before + p_amount;

    -- Log the transaction
    INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
    VALUES (p_club_id, p_distributed_by, p_to_user_id, p_amount, 'treasury_distribution', 
            'Treasury distribution by ' || p_distributed_by);

    RETURN json_build_object(
        'success', true,
        'treasury_before', v_treasury_before,
        'treasury_after', v_treasury_after,
        'member_before', v_member_before,
        'member_after', v_member_after
    );
END;
$$;

GRANT EXECUTE ON FUNCTION distribute_chips TO authenticated, anon;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. REALTIME PUBLICATION for chat tables
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add chat tables to realtime publication so subscriptions work
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE table_chat;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE club_chat;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE conversation_participants;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE user_presence;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
