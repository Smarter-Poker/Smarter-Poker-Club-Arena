-- ═══════════════════════════════════════════════════════════════════════════════
--  COLLUSION TRACKING — Anti-cheat pattern detection storage
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS collusion_tracking (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    player_a        UUID NOT NULL REFERENCES auth.users(id),
    player_b        UUID NOT NULL REFERENCES auth.users(id),
    pattern_type    TEXT NOT NULL CHECK (pattern_type IN ('FOLD_TO_PLAYER', 'CHIP_DUMP', 'COORDINATED_SEATING', 'SOFT_PLAY', 'WIN_RATE_ANOMALY')),
    suspicion_score INTEGER NOT NULL DEFAULT 0 CHECK (suspicion_score >= 0 AND suspicion_score <= 100),
    evidence        JSONB DEFAULT '{}',
    reviewed        BOOLEAN DEFAULT FALSE,
    reviewed_by     UUID REFERENCES auth.users(id),
    reviewed_at     TIMESTAMPTZ,
    action_taken    TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast pair lookups and unreviewed alerts
CREATE INDEX IF NOT EXISTS idx_collusion_players ON collusion_tracking(player_a, player_b);
CREATE INDEX IF NOT EXISTS idx_collusion_score ON collusion_tracking(suspicion_score DESC) WHERE reviewed = FALSE;
CREATE INDEX IF NOT EXISTS idx_collusion_type ON collusion_tracking(pattern_type);
CREATE INDEX IF NOT EXISTS idx_collusion_created ON collusion_tracking(created_at DESC);

-- RLS: Only admins can read collusion data
ALTER TABLE collusion_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read collusion tracking"
    ON collusion_tracking FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'owner', 'super_agent')
        )
    );

CREATE POLICY "Service can insert collusion events"
    ON collusion_tracking FOR INSERT
    WITH CHECK (TRUE);

CREATE POLICY "Admins can update collusion reviews"
    ON collusion_tracking FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'owner')
        )
    );
