-- ═══════════════════════════════════════════════════════════════════════════════
-- FINANCIAL ALERTS TABLE — March 11, 2026
-- Ops visibility for critical money flow errors (e.g. rollback failures)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS financial_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    context JSONB DEFAULT '{}'::jsonb,
    resolved BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- Index for querying unresolved open alerts
CREATE INDEX IF NOT EXISTS idx_financial_alerts_unresolved ON financial_alerts (resolved) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_financial_alerts_created_at ON financial_alerts (created_at DESC);

-- Read access for ops/admins only
ALTER TABLE financial_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view alerts"
    ON financial_alerts FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM admin_users WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Service role can insert alerts"
    ON financial_alerts FOR INSERT
    WITH CHECK (true); -- RPCs run as SECURITY DEFINER or server-side can insert

CREATE POLICY "Admins can update resolve status"
    ON financial_alerts FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM admin_users WHERE user_id = auth.uid()
        )
    );
