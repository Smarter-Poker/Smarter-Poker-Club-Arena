-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔐 ADD resolved_by TO financial_alerts — Audit Trail Improvement
-- ═══════════════════════════════════════════════════════════════════════════════
-- Tracks which admin resolved each financial alert for accountability.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE financial_alerts
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES auth.users(id);
