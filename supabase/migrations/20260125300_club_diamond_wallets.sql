-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 CLUB DIAMOND WALLETS FOR SETTLEMENT
-- ═══════════════════════════════════════════════════════════════════════════════

-- Club Diamond Wallets (for Settlement page)
CREATE TABLE IF NOT EXISTS club_diamond_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    balance DECIMAL(15, 2) DEFAULT 0,
    pending_in DECIMAL(15, 2) DEFAULT 0,
    pending_out DECIMAL(15, 2) DEFAULT 0,
    total_deposited DECIMAL(15, 2) DEFAULT 0,
    total_withdrawn DECIMAL(15, 2) DEFAULT 0,
    last_transaction_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(club_id)
);

CREATE INDEX IF NOT EXISTS idx_club_diamond_wallets_club ON club_diamond_wallets(club_id);

-- RLS policies
ALTER TABLE club_diamond_wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Club members can view club diamond wallets" ON club_diamond_wallets
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM club_members WHERE club_id = club_diamond_wallets.club_id AND user_id = auth.uid())
    );

-- Create wallet for existing clubs
INSERT INTO club_diamond_wallets (club_id, balance)
SELECT id, 0 FROM clubs
WHERE id NOT IN (SELECT club_id FROM club_diamond_wallets)
ON CONFLICT DO NOTHING;

-- Initialize club_financial_summary for existing clubs
INSERT INTO club_financial_summary (
    club_id, 
    period_start, 
    period_end, 
    total_rake, 
    total_rakeback, 
    agent_fees, 
    net_revenue,
    hands_played,
    active_players
)
SELECT 
    id,
    DATE_TRUNC('week', NOW())::DATE,
    (DATE_TRUNC('week', NOW()) + INTERVAL '6 days')::DATE,
    0, 0, 0, 0, 0, 0
FROM clubs
WHERE id NOT IN (SELECT club_id FROM club_financial_summary)
ON CONFLICT DO NOTHING;

DO $$ BEGIN RAISE NOTICE '🔧 CLUB DIAMOND WALLETS CREATED + BACKFILLED'; END $$;
