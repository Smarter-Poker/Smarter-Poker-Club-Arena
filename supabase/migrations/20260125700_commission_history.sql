-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 COMMISSION HISTORY TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS commission_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    player_rake_generated DECIMAL(15, 2) DEFAULT 0,
    commission_rate DECIMAL(5, 4) DEFAULT 0,
    commission_earned DECIMAL(15, 2) DEFAULT 0,
    sub_agent_commission DECIMAL(15, 2) DEFAULT 0,
    net_commission DECIMAL(15, 2) DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'disputed')),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commission_history_agent ON commission_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_commission_history_club ON commission_history(club_id);
CREATE INDEX IF NOT EXISTS idx_commission_history_period ON commission_history(period_start, period_end);

-- Enable RLS
ALTER TABLE commission_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view own commission" ON commission_history
    FOR SELECT USING (
        agent_id IN (
            SELECT id FROM agents WHERE user_id = auth.uid()
        )
    );

-- Create get_agent_commission_history RPC function
CREATE OR REPLACE FUNCTION get_agent_commission_history(p_agent_id UUID, p_limit INTEGER DEFAULT 12)
RETURNS TABLE (
    id UUID,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    player_rake_generated DECIMAL,
    commission_rate DECIMAL,
    commission_earned DECIMAL,
    net_commission DECIMAL,
    status TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ch.id,
        ch.period_start,
        ch.period_end,
        ch.player_rake_generated,
        ch.commission_rate,
        ch.commission_earned,
        ch.net_commission,
        ch.status
    FROM commission_history ch
    WHERE ch.agent_id = p_agent_id
    ORDER BY ch.period_end DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$ BEGIN RAISE NOTICE '🔧 COMMISSION HISTORY TABLE AND RPC CREATED'; END $$;
