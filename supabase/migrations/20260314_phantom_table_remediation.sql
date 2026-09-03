-- ═══════════════════════════════════════════════════════════════════════════════
-- PHANTOM TABLE REMEDIATION (March 14, 2026)
-- Creates 14 phantom tables referenced in code but not in Supabase.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Tournament system tables
CREATE TABLE IF NOT EXISTS tournament_flights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL,
    user_id UUID NOT NULL,
    bagged_chips NUMERIC(18,4) DEFAULT 0,
    status TEXT DEFAULT 'bagged',
    bagged_at TIMESTAMPTZ DEFAULT NOW(),
    resumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tournament_id, user_id)
);

CREATE TABLE IF NOT EXISTS tournament_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL,
    table_number INTEGER NOT NULL,
    max_players INTEGER DEFAULT 9,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tournament_waitlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL,
    user_id UUID NOT NULL,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tournament_id, user_id)
);

-- 2. Table/seat system
CREATE TABLE IF NOT EXISTS table_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id UUID NOT NULL,
    user_id UUID NOT NULL,
    seat_number INTEGER,
    stack NUMERIC(18,4) DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS waitlist_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    table_id UUID NOT NULL,
    position INTEGER NOT NULL,
    status TEXT DEFAULT 'waiting',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, table_id)
);

-- 3. Referral system
CREATE TABLE IF NOT EXISTS referral_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    code TEXT NOT NULL UNIQUE,
    uses INTEGER DEFAULT 0,
    max_uses INTEGER DEFAULT 100,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID NOT NULL,
    redeemer_id UUID NOT NULL,
    referral_code_id UUID,
    chips_awarded_referrer NUMERIC(18,4) DEFAULT 0,
    chips_awarded_redeemer NUMERIC(18,4) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Social/blocking
CREATE TABLE IF NOT EXISTS user_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id UUID NOT NULL,
    blocked_id UUID NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS friend_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenger_id UUID NOT NULL,
    challengee_id UUID NOT NULL,
    challenge_type TEXT,
    target_value INTEGER DEFAULT 0,
    challenger_progress INTEGER DEFAULT 0,
    challengee_progress INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'completed', 'declined', 'expired')),
    expires_at TIMESTAMPTZ,
    winner_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Stats/history
CREATE TABLE IF NOT EXISTS session_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    vpip_percent NUMERIC(5,2) DEFAULT 0,
    pfr_percent NUMERIC(5,2) DEFAULT 0,
    hands_played INTEGER DEFAULT 0,
    hands_won INTEGER DEFAULT 0,
    bb_won NUMERIC(18,4) DEFAULT 0,
    session_start TIMESTAMPTZ DEFAULT NOW(),
    session_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hand_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hand_id UUID NOT NULL,
    user_id UUID,
    action TEXT,
    amount NUMERIC(18,4),
    street TEXT,
    position TEXT,
    seq INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Marketplace
CREATE TABLE IF NOT EXISTS marketplace_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    item_id UUID,
    price_paid NUMERIC(18,4) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Flash pools
CREATE TABLE IF NOT EXISTS flash_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    small_blind NUMERIC(18,4),
    big_blind NUMERIC(18,4),
    min_buy_in NUMERIC(18,4),
    max_buy_in NUMERIC(18,4),
    max_players INTEGER DEFAULT 6,
    current_players INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Daily rewards
CREATE TABLE IF NOT EXISTS user_daily_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE,
    current_streak INTEGER DEFAULT 0,
    last_claim_date DATE,
    total_claimed INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tournament_flights_tid ON tournament_flights(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_tables_tid ON tournament_tables(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_waitlists_tid ON tournament_waitlists(tournament_id);
CREATE INDEX IF NOT EXISTS idx_table_players_tid ON table_players(table_id);
CREATE INDEX IF NOT EXISTS idx_table_players_uid ON table_players(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_uid ON referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_ref ON referral_redemptions(referrer_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_session_history_uid ON session_history(user_id);
CREATE INDEX IF NOT EXISTS idx_hand_actions_hid ON hand_actions(hand_id);
CREATE INDEX IF NOT EXISTS idx_friend_challenges_cid ON friend_challenges(challenger_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_uid ON waitlist_entries(user_id);

-- RLS
ALTER TABLE tournament_flights ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_waitlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE hand_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flash_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE friend_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_daily_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY tf_sel ON tournament_flights FOR ALL USING (true);
CREATE POLICY tt_sel ON tournament_tables FOR ALL USING (true);
CREATE POLICY tw_sel ON tournament_waitlists FOR ALL USING (true);
CREATE POLICY tp_sel ON table_players FOR ALL USING (true);
CREATE POLICY rc_sel ON referral_codes FOR SELECT USING (user_id = auth.uid());
CREATE POLICY rc_ins ON referral_codes FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY rr_sel ON referral_redemptions FOR SELECT USING (referrer_id = auth.uid() OR redeemer_id = auth.uid());
CREATE POLICY ub_sel ON user_blocks FOR ALL USING (blocker_id = auth.uid());
CREATE POLICY sh_sel ON session_history FOR SELECT USING (user_id = auth.uid());
CREATE POLICY mp_sel ON marketplace_purchases FOR SELECT USING (user_id = auth.uid());
CREATE POLICY ha_sel ON hand_actions FOR ALL USING (true);
CREATE POLICY fp_sel ON flash_pools FOR SELECT USING (true);
CREATE POLICY fc_sel ON friend_challenges FOR ALL USING (challenger_id = auth.uid() OR challengee_id = auth.uid());
CREATE POLICY udr_sel ON user_daily_rewards FOR ALL USING (user_id = auth.uid());
CREATE POLICY we_sel ON waitlist_entries FOR ALL USING (user_id = auth.uid());
