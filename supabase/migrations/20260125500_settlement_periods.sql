-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 SETTLEMENT PERIODS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS settlement_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID REFERENCES clubs(id) ON DELETE CASCADE,
    union_id UUID REFERENCES unions(id) ON DELETE CASCADE,
    period_number INTEGER NOT NULL,
    year INTEGER NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'processing', 'settled', 'disputed')),
    total_rake_collected DECIMAL(15, 2) DEFAULT 0,
    total_bbj_contributions DECIMAL(15, 2) DEFAULT 0,
    total_player_winnings DECIMAL(15, 2) DEFAULT 0,
    total_player_losses DECIMAL(15, 2) DEFAULT 0,
    total_hands_dealt INTEGER DEFAULT 0,
    settled_at TIMESTAMPTZ,
    settled_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_periods_club ON settlement_periods(club_id);
CREATE INDEX IF NOT EXISTS idx_settlement_periods_union ON settlement_periods(union_id);
CREATE INDEX IF NOT EXISTS idx_settlement_periods_dates ON settlement_periods(start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_settlement_periods_status ON settlement_periods(status);

-- RLS
ALTER TABLE settlement_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Club members can view settlement periods" ON settlement_periods
    FOR SELECT USING (
        club_id IN (SELECT club_id FROM club_members WHERE user_id = auth.uid())
    );

-- Create initial period for existing clubs
INSERT INTO settlement_periods (
    club_id,
    period_number,
    year,
    start_at,
    end_at,
    status
)
SELECT 
    id,
    1,
    EXTRACT(YEAR FROM NOW())::INTEGER,
    DATE_TRUNC('week', NOW()),
    DATE_TRUNC('week', NOW()) + INTERVAL '6 days 23 hours 59 minutes 59 seconds',
    'open'
FROM clubs
WHERE id NOT IN (SELECT DISTINCT club_id FROM settlement_periods WHERE club_id IS NOT NULL)
ON CONFLICT DO NOTHING;

DO $$ BEGIN RAISE NOTICE '🔧 SETTLEMENT PERIODS TABLE CREATED'; END $$;
