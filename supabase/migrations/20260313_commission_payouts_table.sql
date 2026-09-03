-- ═══════════════════════════════════════════════════════════════════════════════
-- 💼 COMMISSION PAYOUTS TABLE — Missing Table Fix (Sweep 4)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Required by CommissionService (approvePayout, executePayout, getCommissionHistory)
-- and FinancialExportService (fetchCommissionHistory).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS commission_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    period_id TEXT,
    gross_rake DECIMAL(15, 2) NOT NULL DEFAULT 0,
    commission_earned DECIMAL(15, 2) NOT NULL DEFAULT 0,
    paid_to_downlines DECIMAL(15, 2) NOT NULL DEFAULT 0,
    net_payout DECIMAL(15, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'approved', 'paid', 'cancelled'
    )),
    approved_by UUID REFERENCES auth.users(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comm_payouts_agent ON commission_payouts(agent_id);
CREATE INDEX IF NOT EXISTS idx_comm_payouts_status ON commission_payouts(status);
CREATE INDEX IF NOT EXISTS idx_comm_payouts_created ON commission_payouts(created_at DESC);

ALTER TABLE commission_payouts ENABLE ROW LEVEL SECURITY;

-- Agents can view their own payouts
CREATE POLICY "Agents view own payouts" ON commission_payouts
    FOR SELECT USING (agent_id = auth.uid());

-- Admins can view all payouts
CREATE POLICY "Admins view all payouts" ON commission_payouts
    FOR SELECT USING (
        auth.uid() IN (
            SELECT user_id FROM club_members WHERE role IN ('owner', 'admin')
        )
    );

-- Service role can insert/update (via RPC or admin actions)
CREATE POLICY "Service insert payouts" ON commission_payouts
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Admins update payouts" ON commission_payouts
    FOR UPDATE USING (
        auth.uid() IN (
            SELECT user_id FROM club_members WHERE role IN ('owner', 'admin')
        )
    );
