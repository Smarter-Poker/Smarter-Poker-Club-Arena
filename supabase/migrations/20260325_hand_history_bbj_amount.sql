-- ═══════════════════════════════════════════════════════════════════════════════
-- HAND HISTORY: Add bbj_amount column
-- ═══════════════════════════════════════════════════════════════════════════════
-- Tracks BBJ fee deducted per hand for complete audit trail.
-- Matches the rakeAmount column pattern.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS bbj_amount DECIMAL(12,2) NOT NULL DEFAULT 0;
