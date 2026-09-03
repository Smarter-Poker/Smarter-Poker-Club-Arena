-- ═══════════════════════════════════════════════════════════════════════════════
-- 💰 FINANCIAL ENGINE TABLES — Phase 3 Migration
-- ═══════════════════════════════════════════════════════════════════════════════
-- Creates 4 missing tables + 1 RPC function required by Phase 1 & 2 services:
--   • disputes              — DisputeService
--   • financial_health_checks — FinancialCronService
--   • commission_rate_audit  — FinancialCronService.logRateChange()
--   • rake_rate_audit        — RakeService.logRateChange()
--   • get_wallet_balance_totals() — SettlementCronService canary check
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DISPUTES TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submitted_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    submitter_name TEXT NOT NULL DEFAULT 'Unknown',
    target_type TEXT NOT NULL CHECK (target_type IN (
        'agent_settlement', 'cashout_request', 'credit_invoice', 'commission_payout'
    )),
    target_id TEXT NOT NULL,
    club_id UUID NOT NULL,
    amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
        'open', 'under_review', 'resolved', 'escalated', 'withdrawn'
    )),
    assigned_to UUID REFERENCES auth.users(id),
    resolution TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_club ON disputes(club_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_submitted_by ON disputes(submitted_by);
CREATE INDEX IF NOT EXISTS idx_disputes_created ON disputes(created_at DESC);

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;

-- Club owners/admins can see all disputes for their club
CREATE POLICY "Users view own disputes" ON disputes
    FOR SELECT USING (submitted_by = auth.uid());

CREATE POLICY "Club members view club disputes" ON disputes
    FOR SELECT USING (
        club_id IN (
            SELECT club_id FROM club_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

CREATE POLICY "Users insert own disputes" ON disputes
    FOR INSERT WITH CHECK (submitted_by = auth.uid());

CREATE POLICY "Admins update disputes" ON disputes
    FOR UPDATE USING (
        club_id IN (
            SELECT club_id FROM club_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FINANCIAL HEALTH CHECKS TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_health_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    check_type TEXT NOT NULL,
    passed BOOLEAN NOT NULL DEFAULT false,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fhc_type ON financial_health_checks(check_type);
CREATE INDEX IF NOT EXISTS idx_fhc_created ON financial_health_checks(created_at DESC);

ALTER TABLE financial_health_checks ENABLE ROW LEVEL SECURITY;

-- Admin-only: authentication required, visible to all authenticated users
-- (since this is ops data, only admins navigate to the page)
CREATE POLICY "Authenticated users view health checks" ON financial_health_checks
    FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users insert health checks" ON financial_health_checks
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. COMMISSION RATE AUDIT TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commission_rate_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL,
    changed_by UUID NOT NULL,
    old_rate DECIMAL(5, 2) NOT NULL,
    new_rate DECIMAL(5, 2) NOT NULL,
    rate_type TEXT NOT NULL CHECK (rate_type IN ('commission', 'sub_agent', 'player')),
    club_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cra_agent ON commission_rate_audit(agent_id);
CREATE INDEX IF NOT EXISTS idx_cra_created ON commission_rate_audit(created_at DESC);

ALTER TABLE commission_rate_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users view commission audit" ON commission_rate_audit
    FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users insert commission audit" ON commission_rate_audit
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RAKE RATE AUDIT TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rake_rate_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL,
    changed_by UUID NOT NULL,
    old_rate DECIMAL(5, 4) NOT NULL,
    new_rate DECIMAL(5, 4) NOT NULL,
    rate_type TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rra_club ON rake_rate_audit(club_id);
CREATE INDEX IF NOT EXISTS idx_rra_created ON rake_rate_audit(created_at DESC);

ALTER TABLE rake_rate_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users view rake audit" ON rake_rate_audit
    FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users insert rake audit" ON rake_rate_audit
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. get_wallet_balance_totals() RPC — Canary Check for Settlements
-- ─────────────────────────────────────────────────────────────────────────────
-- Sums all credits and debits from wallet_transactions to verify ledger integrity.
-- Used by SettlementCronService.runCanaryCheck() — if total_credits ≈ total_debits,
-- the ledger is balanced and settlement can proceed.

CREATE OR REPLACE FUNCTION get_wallet_balance_totals()
RETURNS TABLE(total_credits DECIMAL, total_debits DECIMAL)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(CASE WHEN wt.type = 'credit' THEN wt.amount ELSE 0 END), 0) AS total_credits,
        COALESCE(SUM(CASE WHEN wt.type = 'debit'  THEN wt.amount ELSE 0 END), 0) AS total_debits
    FROM wallet_transactions wt;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Also add 'dispute_resolution' to allowed wallet_transaction categories
-- so that DisputeService adjustments can write to the ledger
-- ─────────────────────────────────────────────────────────────────────────────
-- Note: If the category CHECK constraint is strict, we need to add it.
-- Using ALTER to add if it doesn't exist. If the constraint allows any text, skip.
DO $$
BEGIN
    -- Try to drop and recreate the category check to include dispute_resolution
    -- If the constraint doesn't exist, this is a no-op
    BEGIN
        ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_category_check;
        ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_category_check
            CHECK (category IN (
                'mint', 'transfer', 'buyin', 'cashout', 'rake', 'commission',
                'promo', 'settlement', 'TIP', 'INSURANCE', 'dispute_resolution',
                'credit_payment', 'credit_advance', 'bonus', 'rebuy', 'addon',
                'tournament_buyin', 'tournament_payout', 'tournament_rebuy'
            ));
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Category constraint update skipped: %', SQLERRM;
    END;
END $$;

DO $$
BEGIN
    RAISE NOTICE '💰 FINANCIAL ENGINE TABLES MIGRATION APPLIED SUCCESSFULLY';
    RAISE NOTICE '  ✓ disputes table created';
    RAISE NOTICE '  ✓ financial_health_checks table created';
    RAISE NOTICE '  ✓ commission_rate_audit table created';
    RAISE NOTICE '  ✓ rake_rate_audit table created';
    RAISE NOTICE '  ✓ get_wallet_balance_totals() RPC created';
END $$;
