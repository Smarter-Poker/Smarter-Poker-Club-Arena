-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 COMPLETE MISSING TABLES AND FK FIXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. CLUB FINANCIAL SUMMARY (for Financials page)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS club_financial_summary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_rake DECIMAL(15, 2) DEFAULT 0,
    total_rakeback DECIMAL(15, 2) DEFAULT 0,
    agent_fees DECIMAL(15, 2) DEFAULT 0,
    net_revenue DECIMAL(15, 2) DEFAULT 0,
    hands_played INTEGER DEFAULT 0,
    active_players INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(club_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_club_financial_summary_club ON club_financial_summary(club_id);
CREATE INDEX IF NOT EXISTS idx_club_financial_summary_period ON club_financial_summary(period_start, period_end);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CLUB TRANSACTIONS (for transaction logs)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS club_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN (
        'rake', 'rakeback', 'agent_fee', 'chip_transfer', 'deposit', 'withdrawal',
        'bonus', 'jackpot_contribution', 'jackpot_payout', 'settlement'
    )),
    amount DECIMAL(15, 2) NOT NULL,
    balance_before DECIMAL(15, 2),
    balance_after DECIMAL(15, 2),
    reference_id UUID,
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_club_transactions_club ON club_transactions(club_id);
CREATE INDEX IF NOT EXISTS idx_club_transactions_user ON club_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_club_transactions_type ON club_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_club_transactions_created ON club_transactions(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. BAD BEAT JACKPOTS (for Jackpot tracking)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bad_beat_jackpots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    name TEXT DEFAULT 'Bad Beat Jackpot',
    current_amount DECIMAL(15, 2) DEFAULT 0,
    contribution_rate DECIMAL(5, 4) DEFAULT 0.01, -- 1% of pot
    qualifying_hand TEXT DEFAULT 'quad_jacks', -- minimum hand to trigger
    loser_share DECIMAL(5, 4) DEFAULT 0.50, -- 50% to loser
    winner_share DECIMAL(5, 4) DEFAULT 0.25, -- 25% to winner
    table_share DECIMAL(5, 4) DEFAULT 0.25, -- 25% to table
    is_active BOOLEAN DEFAULT true,
    last_hit_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bad_beat_jackpots_club ON bad_beat_jackpots(club_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. BAD BEAT HISTORY (for hit history)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bad_beat_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jackpot_id UUID NOT NULL REFERENCES bad_beat_jackpots(id) ON DELETE CASCADE,
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    table_id UUID REFERENCES tables(id) ON DELETE SET NULL,
    hand_id UUID,
    winning_amount DECIMAL(15, 2) NOT NULL,
    loser_id UUID REFERENCES profiles(id),
    loser_hand TEXT,
    loser_payout DECIMAL(15, 2),
    winner_id UUID REFERENCES profiles(id),
    winner_hand TEXT,
    winner_payout DECIMAL(15, 2),
    table_payout DECIMAL(15, 2),
    participants JSONB DEFAULT '[]', -- all players at table
    hit_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bad_beat_history_club ON bad_beat_history(club_id);
CREATE INDEX IF NOT EXISTS idx_bad_beat_history_jackpot ON bad_beat_history(jackpot_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. RAKEBACK PERIODS (for Rakeback page)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rakeback_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    rake_generated DECIMAL(15, 2) DEFAULT 0,
    rakeback_rate DECIMAL(5, 4) DEFAULT 0.10, -- 10% default
    rakeback_amount DECIMAL(15, 2) DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired')),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, club_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_rakeback_periods_user ON rakeback_periods(user_id);
CREATE INDEX IF NOT EXISTS idx_rakeback_periods_club ON rakeback_periods(club_id);
CREATE INDEX IF NOT EXISTS idx_rakeback_periods_status ON rakeback_periods(status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. FIX AGENTS FK TO PROFILES 
-- ═══════════════════════════════════════════════════════════════════════════════

-- First ensure agents table has user_id column
ALTER TABLE agents ADD COLUMN IF NOT EXISTS user_id UUID;

-- Drop existing constraint if it exists
DO $$
BEGIN
    ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_user_id_fkey;
    ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_profiles_fkey;
EXCEPTION WHEN undefined_object THEN
    NULL;
END $$;

-- Add FK from agents.user_id to profiles.id
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'user_id') THEN
        ALTER TABLE agents 
        ADD CONSTRAINT agents_profiles_fkey 
        FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
    END IF;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'agents FK may already exist or failed: %', SQLERRM;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. RLS POLICIES FOR NEW TABLES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE club_financial_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bad_beat_jackpots ENABLE ROW LEVEL SECURITY;
ALTER TABLE bad_beat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE rakeback_periods ENABLE ROW LEVEL SECURITY;

-- Financial Summary: Club members can view
CREATE POLICY "Club members can view financial summary" ON club_financial_summary
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM club_members WHERE club_id = club_financial_summary.club_id AND user_id = auth.uid())
    );

-- Club Transactions: Users can view own transactions, admins can view all
CREATE POLICY "Users can view own transactions" ON club_transactions
    FOR SELECT USING (
        user_id = auth.uid() OR
        EXISTS (SELECT 1 FROM club_members WHERE club_id = club_transactions.club_id AND user_id = auth.uid() AND role IN ('owner', 'admin'))
    );

-- Jackpots: Club members can view
CREATE POLICY "Club members can view jackpots" ON bad_beat_jackpots
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM club_members WHERE club_id = bad_beat_jackpots.club_id AND user_id = auth.uid())
    );

-- Jackpot History: Club members can view
CREATE POLICY "Club members can view jackpot history" ON bad_beat_history
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM club_members WHERE club_id = bad_beat_history.club_id AND user_id = auth.uid())
    );

-- Rakeback: Users can view own periods
CREATE POLICY "Users can view own rakeback" ON rakeback_periods
    FOR SELECT USING (user_id = auth.uid());

DO $$ BEGIN RAISE NOTICE '🔧 MISSING TABLES CREATED + FK FIXES APPLIED'; END $$;
