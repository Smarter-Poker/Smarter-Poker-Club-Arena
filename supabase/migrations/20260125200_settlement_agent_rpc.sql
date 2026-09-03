-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 MISSING RPC FUNCTIONS FOR SETTLEMENT AND AGENTS
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. GET CURRENT SETTLEMENT PERIOD
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_current_settlement_period()
RETURNS TABLE (
    id UUID,
    club_id UUID,
    period_start DATE,
    period_end DATE,
    status TEXT,
    total_rake DECIMAL,
    total_rakeback DECIMAL,
    agent_fees DECIMAL,
    net_revenue DECIMAL
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    -- Return current period (most recent that is pending)
    RETURN QUERY
    SELECT 
        cfs.id,
        cfs.club_id,
        cfs.period_start,
        cfs.period_end,
        'pending'::TEXT as status,
        cfs.total_rake,
        cfs.total_rakeback,
        cfs.agent_fees,
        cfs.net_revenue
    FROM club_financial_summary cfs
    WHERE cfs.period_end >= CURRENT_DATE
    ORDER BY cfs.period_start DESC
    LIMIT 1;
    
    -- If no current period found, return empty set
    RETURN;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. GET CLUB AGENTS (for AgentManagementPage)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_club_agents(p_club_id UUID)
RETURNS TABLE (
    id UUID,
    user_id UUID,
    club_id UUID,
    role TEXT,
    status TEXT,
    commission_rate DECIMAL,
    player_rakeback_rate DECIMAL,
    credit_limit DECIMAL,
    total_players INTEGER,
    lifetime_earnings DECIMAL,
    display_name TEXT,
    avatar_url TEXT,
    joined_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.id,
        a.user_id,
        a.club_id,
        a.role,
        a.status,
        a.commission_rate,
        a.player_rakeback_rate,
        a.credit_limit,
        a.total_players,
        a.lifetime_earnings,
        COALESCE(p.display_name, p.username, 'Unknown') as display_name,
        p.avatar_url,
        a.created_at as joined_at
    FROM agents a
    LEFT JOIN profiles p ON a.user_id = p.id
    WHERE a.club_id = p_club_id
    ORDER BY a.created_at DESC;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. GET SETTLEMENT PERIODS (for SettlementPage)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_settlement_periods(p_entity_id UUID, p_entity_type TEXT DEFAULT 'club')
RETURNS TABLE (
    id UUID,
    entity_id UUID,
    period_start DATE,
    period_end DATE,
    total_rake DECIMAL,
    total_rakeback DECIMAL,
    agent_fees DECIMAL,
    net_revenue DECIMAL,
    status TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    SELECT 
        cfs.id,
        cfs.club_id as entity_id,
        cfs.period_start,
        cfs.period_end,
        cfs.total_rake,
        cfs.total_rakeback,
        cfs.agent_fees,
        cfs.net_revenue,
        'completed'::TEXT as status,
        cfs.created_at
    FROM club_financial_summary cfs
    WHERE cfs.club_id = p_entity_id
    ORDER BY cfs.period_start DESC
    LIMIT 20;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. ENSURE AGENTS TABLE HAS ALL REQUIRED COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE agents ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'agent';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5,4) DEFAULT 0.10;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS player_rakeback_rate DECIMAL(5,4) DEFAULT 0.10;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(15,2) DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS total_players INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS lifetime_earnings DECIMAL(15,2) DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

DO $$ BEGIN RAISE NOTICE '🔧 SETTLEMENT + AGENT RPC FUNCTIONS CREATED'; END $$;
