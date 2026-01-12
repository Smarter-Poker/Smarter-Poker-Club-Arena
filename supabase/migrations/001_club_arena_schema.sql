-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ CLUB ARENA — Database Schema Migration
-- ═══════════════════════════════════════════════════════════════════════════════
-- PokerBros Clone + Better
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUBS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS clubs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id INTEGER UNIQUE NOT NULL DEFAULT (100000 + floor(random() * 900000)::int),
    name TEXT NOT NULL,
    description TEXT,
    avatar_url TEXT,
    owner_id UUID NOT NULL REFERENCES auth.users(id),
    is_public BOOLEAN DEFAULT true,
    requires_approval BOOLEAN DEFAULT false,
    gps_restricted BOOLEAN DEFAULT false,
    settings JSONB DEFAULT '{
        "default_rake_percent": 5,
        "rake_cap": 15,
        "time_bank_seconds": 30,
        "allow_straddle": true,
        "allow_run_it_twice": true,
        "min_buy_in_bb": 40,
        "max_buy_in_bb": 200
    }'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_clubs_owner ON clubs(owner_id);
CREATE INDEX IF NOT EXISTS idx_clubs_public ON clubs(is_public) WHERE is_public = true;
CREATE INDEX IF NOT EXISTS idx_clubs_club_id ON clubs(club_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUB MEMBERS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TYPE member_role AS ENUM ('owner', 'admin', 'agent', 'member');
CREATE TYPE member_status AS ENUM ('active', 'pending', 'suspended', 'banned');

CREATE TABLE IF NOT EXISTS club_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role member_role DEFAULT 'member',
    nickname TEXT,
    chip_balance DECIMAL(15, 2) DEFAULT 0,
    agent_id UUID REFERENCES club_members(id),
    status member_status DEFAULT 'pending',
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(club_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_club_members_club ON club_members(club_id);
CREATE INDEX IF NOT EXISTS idx_club_members_user ON club_members(user_id);
CREATE INDEX IF NOT EXISTS idx_club_members_agent ON club_members(agent_id);
CREATE INDEX IF NOT EXISTS idx_club_members_status ON club_members(status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- AGENTS (PokerBros-style chip distribution)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    member_id UUID NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    chip_balance DECIMAL(15, 2) DEFAULT 0,
    commission_rate DECIMAL(5, 2) DEFAULT 10.00, -- % of rake returned
    player_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(club_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_agents_club ON agents(club_id);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(is_active) WHERE is_active = true;

-- ═══════════════════════════════════════════════════════════════════════════════
-- POKER TABLES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TYPE game_type AS ENUM ('cash', 'tournament', 'sit_n_go');
CREATE TYPE game_variant AS ENUM (
    'nlh', 'flh', 'plo4', 'plo5', 'plo6', 
    'plo_hilo', 'plo8', 'short_deck', 'ofc', 'ofc_pineapple'
);
CREATE TYPE table_status AS ENUM ('waiting', 'running', 'paused', 'closed');

CREATE TABLE IF NOT EXISTS tables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    game_type game_type DEFAULT 'cash',
    game_variant game_variant DEFAULT 'nlh',
    stakes TEXT NOT NULL, -- e.g., "1/2", "5/10"
    small_blind DECIMAL(10, 2) NOT NULL,
    big_blind DECIMAL(10, 2) NOT NULL,
    min_buy_in DECIMAL(15, 2) NOT NULL,
    max_buy_in DECIMAL(15, 2) NOT NULL,
    max_players INTEGER DEFAULT 9,
    current_players INTEGER DEFAULT 0,
    status table_status DEFAULT 'waiting',
    settings JSONB DEFAULT '{
        "straddle_enabled": true,
        "straddle_type": "utg",
        "run_it_twice": true,
        "bomb_pot_enabled": false,
        "bomb_pot_frequency": 0,
        "bomb_pot_ante_bb": 0,
        "time_bank_seconds": 30,
        "auto_muck": true
    }'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tables_club ON tables(club_id);
CREATE INDEX IF NOT EXISTS idx_tables_status ON tables(status);
CREATE INDEX IF NOT EXISTS idx_tables_variant ON tables(game_variant);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE SEATS (who is sitting where)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS table_seats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    seat_number INTEGER NOT NULL CHECK (seat_number >= 1 AND seat_number <= 10),
    user_id UUID REFERENCES auth.users(id),
    member_id UUID REFERENCES club_members(id),
    stack DECIMAL(15, 2) DEFAULT 0,
    is_sitting_out BOOLEAN DEFAULT false,
    is_away BOOLEAN DEFAULT false,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(table_id, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_table_seats_table ON table_seats(table_id);
CREATE INDEX IF NOT EXISTS idx_table_seats_user ON table_seats(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CHIP TRANSACTIONS (immutable ledger)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TYPE transaction_type AS ENUM (
    'deposit', 'withdrawal', 'buy_in', 'cash_out',
    'agent_transfer', 'rake', 'bonus', 'refund'
);

CREATE TABLE IF NOT EXISTS chip_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id),
    from_user_id UUID REFERENCES auth.users(id),
    to_user_id UUID NOT NULL REFERENCES auth.users(id),
    amount DECIMAL(15, 2) NOT NULL,
    type transaction_type NOT NULL,
    reference_id UUID, -- table/hand/tournament ID
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_club ON chip_transactions(club_id);
CREATE INDEX IF NOT EXISTS idx_transactions_from ON chip_transactions(from_user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON chip_transactions(to_user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON chip_transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON chip_transactions(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- HAND HISTORY
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hands (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_id UUID NOT NULL REFERENCES tables(id),
    club_id UUID NOT NULL REFERENCES clubs(id),
    hand_number BIGINT NOT NULL,
    game_variant game_variant NOT NULL,
    stakes TEXT NOT NULL,
    pot DECIMAL(15, 2) NOT NULL,
    rake DECIMAL(10, 2) DEFAULT 0,
    community_cards TEXT[], -- ['Ah', 'Ks', 'Qd', 'Jc', 'Th']
    winner_ids UUID[],
    players JSONB NOT NULL, -- Full hand details
    actions JSONB NOT NULL, -- Action sequence
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hands_table ON hands(table_id);
CREATE INDEX IF NOT EXISTS idx_hands_club ON hands(club_id);
CREATE INDEX IF NOT EXISTS idx_hands_date ON hands(ended_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- UNIONS (Club Networks)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS unions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    owner_id UUID NOT NULL REFERENCES auth.users(id),
    settings JSONB DEFAULT '{
        "revenue_share_percent": 10,
        "shared_player_pool": true,
        "cross_club_tournaments": true
    }'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS union_clubs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    union_id UUID NOT NULL REFERENCES unions(id) ON DELETE CASCADE,
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(union_id, club_id)
);

CREATE INDEX IF NOT EXISTS idx_union_clubs_union ON union_clubs(union_id);
CREATE INDEX IF NOT EXISTS idx_union_clubs_club ON union_clubs(club_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TOURNAMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TYPE tournament_status AS ENUM (
    'registering', 'late_reg', 'running', 'paused', 
    'final_table', 'heads_up', 'completed', 'cancelled'
);

CREATE TABLE IF NOT EXISTS tournaments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    game_variant game_variant DEFAULT 'nlh',
    buy_in DECIMAL(10, 2) NOT NULL,
    fee DECIMAL(10, 2) DEFAULT 0,
    starting_chips INTEGER NOT NULL,
    max_players INTEGER,
    min_players INTEGER DEFAULT 2,
    current_players INTEGER DEFAULT 0,
    prize_pool DECIMAL(15, 2) DEFAULT 0,
    status tournament_status DEFAULT 'registering',
    blind_structure JSONB NOT NULL, -- [{level, sb, bb, ante, duration_mins}]
    current_level INTEGER DEFAULT 1,
    scheduled_start TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    settings JSONB DEFAULT '{
        "late_registration_levels": 6,
        "re_entry_allowed": true,
        "re_entry_max": 1,
        "addon_allowed": false,
        "bounty_enabled": false
    }'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tournaments_club ON tournaments(club_id);
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
CREATE INDEX IF NOT EXISTS idx_tournaments_start ON tournaments(scheduled_start);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE clubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE chip_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hands ENABLE ROW LEVEL SECURITY;
ALTER TABLE unions ENABLE ROW LEVEL SECURITY;
ALTER TABLE union_clubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;

-- Clubs: Public clubs visible to all, private only to members
CREATE POLICY "Public clubs visible to all" ON clubs
    FOR SELECT USING (is_public = true);

CREATE POLICY "Members can see their clubs" ON clubs
    FOR SELECT USING (
        id IN (SELECT club_id FROM club_members WHERE user_id = auth.uid())
    );

CREATE POLICY "Owners can update their clubs" ON clubs
    FOR UPDATE USING (owner_id = auth.uid());

CREATE POLICY "Authenticated users can create clubs" ON clubs
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Club Members: Members can see other members in their clubs
CREATE POLICY "Members can view club members" ON club_members
    FOR SELECT USING (
        club_id IN (SELECT club_id FROM club_members WHERE user_id = auth.uid())
    );

CREATE POLICY "Users can join clubs" ON club_members
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Tables: Members can see tables in their clubs
CREATE POLICY "Members can view tables" ON tables
    FOR SELECT USING (
        club_id IN (SELECT club_id FROM club_members WHERE user_id = auth.uid())
    );

-- Hands: Players can see hands they participated in
CREATE POLICY "Players can view their hands" ON hands
    FOR SELECT USING (
        players::text LIKE '%' || auth.uid()::text || '%'
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- REAL-TIME PUBLICATIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Enable real-time for key tables
ALTER PUBLICATION supabase_realtime ADD TABLE tables;
ALTER PUBLICATION supabase_realtime ADD TABLE table_seats;
ALTER PUBLICATION supabase_realtime ADD TABLE club_members;

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Function to get club statistics
CREATE OR REPLACE FUNCTION get_club_stats(p_club_id UUID)
RETURNS TABLE (
    member_count BIGINT,
    online_count BIGINT,
    table_count BIGINT,
    total_hands BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        (SELECT COUNT(*) FROM club_members WHERE club_id = p_club_id AND status = 'active'),
        (SELECT COUNT(*) FROM table_seats ts 
         JOIN tables t ON ts.table_id = t.id 
         WHERE t.club_id = p_club_id AND ts.user_id IS NOT NULL),
        (SELECT COUNT(*) FROM tables WHERE club_id = p_club_id AND status != 'closed'),
        (SELECT COUNT(*) FROM hands WHERE club_id = p_club_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to transfer chips (atomic)
CREATE OR REPLACE FUNCTION transfer_chips(
    p_club_id UUID,
    p_from_user_id UUID,
    p_to_user_id UUID,
    p_amount DECIMAL,
    p_type transaction_type,
    p_notes TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_transaction_id UUID;
BEGIN
    -- Deduct from sender (if not system)
    IF p_from_user_id IS NOT NULL THEN
        UPDATE club_members 
        SET chip_balance = chip_balance - p_amount
        WHERE club_id = p_club_id AND user_id = p_from_user_id;
        
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Sender not found in club';
        END IF;
    END IF;
    
    -- Add to receiver
    UPDATE club_members 
    SET chip_balance = chip_balance + p_amount
    WHERE club_id = p_club_id AND user_id = p_to_user_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Receiver not found in club';
    END IF;
    
    -- Record transaction
    INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, type, notes)
    VALUES (p_club_id, p_from_user_id, p_to_user_id, p_amount, p_type, p_notes)
    RETURNING id INTO v_transaction_id;
    
    RETURN v_transaction_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- UPDATED_AT TRIGGER
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clubs_updated_at
    BEFORE UPDATE ON clubs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- TOURNAMENT EXPANSION (Added via Antigravity)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TYPE tournament_player_status AS ENUM ('registered', 'playing', 'eliminated', 'winner');

CREATE TABLE IF NOT EXISTS tournament_players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    username TEXT NOT NULL,
    chips INTEGER DEFAULT 0,
    status tournament_player_status DEFAULT 'registered',
    position INTEGER, -- Finish position
    prize DECIMAL(15, 2),
    rebuys INTEGER DEFAULT 0,
    add_on BOOLEAN DEFAULT FALSE,
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    eliminated_at TIMESTAMPTZ,
    UNIQUE(tournament_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tourn_players_tourn ON tournament_players(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tourn_players_user ON tournament_players(user_id);

-- Add tournament_id to tables
ALTER TABLE tables ADD COLUMN IF NOT EXISTS tournament_id UUID REFERENCES tournaments(id) ON DELETE CASCADE;

-- RLS for Tournament Players
ALTER TABLE tournament_players ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can view tournament players" ON tournament_players
    FOR SELECT USING (true);

CREATE POLICY "Users can register themselves" ON tournament_players
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "System can update tournament players" ON tournament_players
    FOR UPDATE USING (true); -- Simplified for now

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE tournament_players;
ALTER PUBLICATION supabase_realtime ADD TABLE tournaments;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SUCCESS
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN 
    RAISE NOTICE '♠ CLUB ARENA SCHEMA CREATED SUCCESSFULLY';
END $$;
