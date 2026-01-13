-- ═══════════════════════════════════════════════════════════════════════════════
-- 🗓️ SETTLEMENT CYCLE — Weekly Financial Settlement System
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Club Arena Settlement Engine
-- Manages weekly settlement cycles for agents and clubs
--
-- Features:
-- - Weekly settlement periods (Monday 00:00 UTC to Sunday 23:59 UTC)
-- - Agent commission calculations
-- - Club revenue distribution
-- - Audit trail for all settlements
--
-- Created: 2026-01-13
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- SETTLEMENT PERIODS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS settlement_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_number INTEGER NOT NULL,
    year INTEGER NOT NULL,
    start_at TIMESTAMP WITH TIME ZONE NOT NULL,
    end_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'settled', 'disputed')),
    
    -- Aggregate totals for the period
    total_rake_collected DECIMAL(18, 4) DEFAULT 0,
    total_bbj_contributions DECIMAL(18, 4) DEFAULT 0,
    total_player_winnings DECIMAL(18, 4) DEFAULT 0,
    total_player_losses DECIMAL(18, 4) DEFAULT 0,
    total_hands_dealt INTEGER DEFAULT 0,
    
    -- Settlement execution
    settled_at TIMESTAMP WITH TIME ZONE,
    settled_by UUID REFERENCES profiles(id),
    
    -- Constraints
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    UNIQUE(year, period_number)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- AGENT SETTLEMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id UUID NOT NULL REFERENCES settlement_periods(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    
    -- Revenue breakdown
    total_rake_generated DECIMAL(18, 4) NOT NULL DEFAULT 0,
    commission_rate DECIMAL(5, 4) NOT NULL DEFAULT 0.10, -- 10% default
    commission_earned DECIMAL(18, 4) NOT NULL DEFAULT 0,
    
    -- Credit adjustments
    total_credit_extended DECIMAL(18, 4) DEFAULT 0,
    total_credit_repaid DECIMAL(18, 4) DEFAULT 0,
    credit_balance_delta DECIMAL(18, 4) DEFAULT 0,
    
    -- Player activity
    active_players INTEGER DEFAULT 0,
    new_players INTEGER DEFAULT 0,
    churned_players INTEGER DEFAULT 0,
    
    -- Final settlement
    net_settlement DECIMAL(18, 4) NOT NULL DEFAULT 0,
    settlement_method TEXT DEFAULT 'wallet_transfer',
    settlement_notes TEXT,
    
    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'disputed')),
    approved_at TIMESTAMP WITH TIME ZONE,
    approved_by UUID REFERENCES profiles(id),
    paid_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    UNIQUE(period_id, agent_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUB SETTLEMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS club_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id UUID NOT NULL REFERENCES settlement_periods(id),
    club_id UUID NOT NULL REFERENCES clubs(id),
    
    -- Revenue metrics
    total_rake_collected DECIMAL(18, 4) NOT NULL DEFAULT 0,
    total_jackpot_contributions DECIMAL(18, 4) DEFAULT 0,
    total_promo_costs DECIMAL(18, 4) DEFAULT 0,
    
    -- Player metrics
    unique_players INTEGER DEFAULT 0,
    total_hands_dealt INTEGER DEFAULT 0,
    total_buy_ins DECIMAL(18, 4) DEFAULT 0,
    total_cash_outs DECIMAL(18, 4) DEFAULT 0,
    
    -- Expense breakdown
    platform_fee DECIMAL(18, 4) DEFAULT 0,
    agent_commissions DECIMAL(18, 4) DEFAULT 0,
    marketing_spend DECIMAL(18, 4) DEFAULT 0,
    
    -- Net results
    gross_revenue DECIMAL(18, 4) NOT NULL DEFAULT 0,
    net_revenue DECIMAL(18, 4) NOT NULL DEFAULT 0,
    
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'finalized', 'disputed')),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    UNIQUE(period_id, club_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PLAYER WEEKLY SNAPSHOTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS player_weekly_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id UUID NOT NULL REFERENCES settlement_periods(id),
    player_id UUID NOT NULL REFERENCES profiles(id),
    club_id UUID REFERENCES clubs(id),
    
    -- Session metrics
    hands_played INTEGER DEFAULT 0,
    sessions_count INTEGER DEFAULT 0,
    total_time_played_minutes INTEGER DEFAULT 0,
    
    -- Financial metrics
    total_buy_ins DECIMAL(18, 4) DEFAULT 0,
    total_cash_outs DECIMAL(18, 4) DEFAULT 0,
    total_rake_paid DECIMAL(18, 4) DEFAULT 0,
    total_jackpot_contributions DECIMAL(18, 4) DEFAULT 0,
    net_profit_loss DECIMAL(18, 4) DEFAULT 0,
    
    -- Performance metrics
    vpip DECIMAL(5, 2) DEFAULT 0, -- Voluntarily Put money In Pot %
    pfr DECIMAL(5, 2) DEFAULT 0,  -- Pre-Flop Raise %
    af DECIMAL(5, 2) DEFAULT 0,   -- Aggression Factor
    wtsd DECIMAL(5, 2) DEFAULT 0, -- Went To ShowDown %
    
    -- Bonuses and rewards
    rakeback_earned DECIMAL(18, 4) DEFAULT 0,
    bonus_claimed DECIMAL(18, 4) DEFAULT 0,
    xp_earned INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    UNIQUE(period_id, player_id, club_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- SETTLEMENT AUDIT LOG
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS settlement_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id UUID NOT NULL REFERENCES settlement_periods(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL, -- 'agent', 'club', 'player', 'period'
    entity_id UUID NOT NULL,
    
    old_value JSONB,
    new_value JSONB,
    change_reason TEXT,
    
    performed_by UUID REFERENCES profiles(id),
    performed_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    ip_address INET,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_settlement_periods_status ON settlement_periods(status);
CREATE INDEX IF NOT EXISTS idx_settlement_periods_dates ON settlement_periods(start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_agent_settlements_period ON agent_settlements(period_id);
CREATE INDEX IF NOT EXISTS idx_agent_settlements_agent ON agent_settlements(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_settlements_status ON agent_settlements(status);

CREATE INDEX IF NOT EXISTS idx_club_settlements_period ON club_settlements(period_id);
CREATE INDEX IF NOT EXISTS idx_club_settlements_club ON club_settlements(club_id);

CREATE INDEX IF NOT EXISTS idx_player_snapshots_period ON player_weekly_snapshots(period_id);
CREATE INDEX IF NOT EXISTS idx_player_snapshots_player ON player_weekly_snapshots(player_id);
CREATE INDEX IF NOT EXISTS idx_player_snapshots_club ON player_weekly_snapshots(club_id);

CREATE INDEX IF NOT EXISTS idx_settlement_audit_period ON settlement_audit_log(period_id);
CREATE INDEX IF NOT EXISTS idx_settlement_audit_entity ON settlement_audit_log(entity_type, entity_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE settlement_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_weekly_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_audit_log ENABLE ROW LEVEL SECURITY;

-- Settlement periods: Admin only
CREATE POLICY settlement_periods_admin ON settlement_periods
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE id = auth.uid()
            AND role IN ('admin', 'super_admin')
        )
    );

-- Agent settlements: Agent can view their own
CREATE POLICY agent_settlements_self ON agent_settlements
    FOR SELECT USING (
        agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
        OR EXISTS (
            SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
        )
    );

-- Club settlements: Club owner can view their own
CREATE POLICY club_settlements_owner ON club_settlements
    FOR SELECT USING (
        club_id IN (SELECT id FROM clubs WHERE owner_id = auth.uid())
        OR EXISTS (
            SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
        )
    );

-- Player snapshots: Player can view their own
CREATE POLICY player_snapshots_self ON player_weekly_snapshots
    FOR SELECT USING (
        player_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
        )
    );

-- Audit log: Admin only
CREATE POLICY settlement_audit_admin ON settlement_audit_log
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
        )
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Get current settlement period
CREATE OR REPLACE FUNCTION get_current_settlement_period()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    period_id UUID;
    period_num INTEGER;
    period_year INTEGER;
    period_start TIMESTAMP WITH TIME ZONE;
    period_end TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Calculate current week's Monday 00:00 UTC
    period_start := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    period_end := period_start + INTERVAL '7 days' - INTERVAL '1 second';
    period_year := EXTRACT(YEAR FROM period_start);
    period_num := EXTRACT(WEEK FROM period_start);
    
    -- Try to get existing period
    SELECT id INTO period_id
    FROM settlement_periods
    WHERE year = period_year AND period_number = period_num;
    
    -- Create if not exists
    IF period_id IS NULL THEN
        INSERT INTO settlement_periods (year, period_number, start_at, end_at, status)
        VALUES (period_year, period_num, period_start, period_end, 'open')
        RETURNING id INTO period_id;
    END IF;
    
    RETURN period_id;
END;
$$;

-- Close settlement period and begin processing
CREATE OR REPLACE FUNCTION close_settlement_period(p_period_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Verify period exists and is open
    IF NOT EXISTS (
        SELECT 1 FROM settlement_periods
        WHERE id = p_period_id AND status = 'open'
    ) THEN
        RAISE EXCEPTION 'Period does not exist or is not open';
    END IF;
    
    -- Update status to processing
    UPDATE settlement_periods
    SET status = 'processing', updated_at = now()
    WHERE id = p_period_id;
    
    -- Log the action
    INSERT INTO settlement_audit_log (period_id, action, entity_type, entity_id, new_value, performed_by)
    VALUES (p_period_id, 'PERIOD_CLOSED', 'period', p_period_id, '{"status": "processing"}'::jsonb, auth.uid());
    
    RETURN TRUE;
END;
$$;

-- Calculate agent commission for a period
CREATE OR REPLACE FUNCTION calculate_agent_settlement(
    p_period_id UUID,
    p_agent_id UUID
)
RETURNS DECIMAL
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_rake_generated DECIMAL := 0;
    v_commission_rate DECIMAL;
    v_commission DECIMAL;
    v_credit_delta DECIMAL := 0;
    v_net_settlement DECIMAL;
BEGIN
    -- Get agent's commission rate
    SELECT COALESCE(commission_rate, 0.10) INTO v_commission_rate
    FROM agents WHERE id = p_agent_id;
    
    -- Calculate total rake from agent's players during this period
    -- This would join with player activity tables when implemented
    SELECT COALESCE(SUM(rake_paid), 0) INTO v_rake_generated
    FROM player_weekly_snapshots pws
    JOIN profiles p ON pws.player_id = p.id
    WHERE pws.period_id = p_period_id
    AND p.referred_by_agent = p_agent_id;
    
    -- Calculate commission
    v_commission := v_rake_generated * v_commission_rate;
    
    -- Calculate net settlement (commission - outstanding credits)
    v_net_settlement := v_commission - v_credit_delta;
    
    -- Upsert agent settlement record
    INSERT INTO agent_settlements (
        period_id, agent_id, total_rake_generated, commission_rate,
        commission_earned, credit_balance_delta, net_settlement
    )
    VALUES (
        p_period_id, p_agent_id, v_rake_generated, v_commission_rate,
        v_commission, v_credit_delta, v_net_settlement
    )
    ON CONFLICT (period_id, agent_id) DO UPDATE SET
        total_rake_generated = EXCLUDED.total_rake_generated,
        commission_earned = EXCLUDED.commission_earned,
        net_settlement = EXCLUDED.net_settlement,
        updated_at = now();
    
    RETURN v_net_settlement;
END;
$$;

-- Finalize settlement period
CREATE OR REPLACE FUNCTION finalize_settlement_period(p_period_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Verify period is in processing state
    IF NOT EXISTS (
        SELECT 1 FROM settlement_periods
        WHERE id = p_period_id AND status = 'processing'
    ) THEN
        RAISE EXCEPTION 'Period is not in processing state';
    END IF;
    
    -- Update all pending agent settlements to approved
    UPDATE agent_settlements
    SET status = 'approved', approved_at = now(), approved_by = auth.uid()
    WHERE period_id = p_period_id AND status = 'pending';
    
    -- Update all pending club settlements to finalized
    UPDATE club_settlements
    SET status = 'finalized', updated_at = now()
    WHERE period_id = p_period_id AND status = 'pending';
    
    -- Mark period as settled
    UPDATE settlement_periods
    SET status = 'settled', settled_at = now(), settled_by = auth.uid(), updated_at = now()
    WHERE id = p_period_id;
    
    -- Log the action
    INSERT INTO settlement_audit_log (period_id, action, entity_type, entity_id, new_value, performed_by)
    VALUES (p_period_id, 'PERIOD_FINALIZED', 'period', p_period_id, '{"status": "settled"}'::jsonb, auth.uid());
    
    RETURN TRUE;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Auto-update timestamps
CREATE OR REPLACE FUNCTION update_settlement_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_settlement_periods_timestamp
    BEFORE UPDATE ON settlement_periods
    FOR EACH ROW EXECUTE FUNCTION update_settlement_timestamp();

CREATE TRIGGER update_agent_settlements_timestamp
    BEFORE UPDATE ON agent_settlements
    FOR EACH ROW EXECUTE FUNCTION update_settlement_timestamp();

CREATE TRIGGER update_club_settlements_timestamp
    BEFORE UPDATE ON club_settlements
    FOR EACH ROW EXECUTE FUNCTION update_settlement_timestamp();

-- ═══════════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE settlement_periods IS 'Weekly settlement period definitions';
COMMENT ON TABLE agent_settlements IS 'Agent commission settlements per period';
COMMENT ON TABLE club_settlements IS 'Club revenue settlements per period';
COMMENT ON TABLE player_weekly_snapshots IS 'Player activity snapshots for settlement calculations';
COMMENT ON TABLE settlement_audit_log IS 'Immutable audit trail for all settlement actions';

COMMENT ON FUNCTION get_current_settlement_period IS 'Gets or creates the current weekly settlement period';
COMMENT ON FUNCTION close_settlement_period IS 'Closes an open period and begins processing';
COMMENT ON FUNCTION calculate_agent_settlement IS 'Calculates commission for a specific agent in a period';
COMMENT ON FUNCTION finalize_settlement_period IS 'Finalizes all settlements and closes the period';
