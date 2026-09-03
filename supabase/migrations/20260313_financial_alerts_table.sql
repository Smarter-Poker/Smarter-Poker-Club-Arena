-- ═══════════════════════════════════════════════════════════════════════════════
-- 🚨 FINANCIAL ALERTS TABLE — Phase 7 Migration
-- ═══════════════════════════════════════════════════════════════════════════════
-- Creates the financial_alerts table used by FinancialAlertService.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS financial_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    context JSONB DEFAULT '{}',
    resolved BOOLEAN NOT NULL DEFAULT false,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for dashboard queries
CREATE INDEX IF NOT EXISTS idx_financial_alerts_resolved ON financial_alerts(resolved) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_financial_alerts_severity ON financial_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_financial_alerts_created ON financial_alerts(created_at DESC);

-- RLS
ALTER TABLE financial_alerts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'financial_alerts' AND policyname = 'financial_alerts_all') THEN
    CREATE POLICY financial_alerts_all ON financial_alerts FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
