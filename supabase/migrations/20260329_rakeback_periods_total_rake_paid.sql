-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX 164: Add total_rake_paid column to rakeback_periods
-- ═══════════════════════════════════════════════════════════════════════════════
-- RakebackEngine.settleRakeback() inserts rows with total_rake_paid,
-- but this column was never added to the rakeback_periods table.
-- Without it, every rakeback settlement insert would fail.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE rakeback_periods ADD COLUMN IF NOT EXISTS total_rake_paid DECIMAL(15, 2) DEFAULT 0;

-- Backfill from rake_generated for any existing rows
UPDATE rakeback_periods
SET total_rake_paid = COALESCE(rake_generated, 0)
WHERE total_rake_paid = 0 AND rake_generated > 0;

DO $$ BEGIN RAISE NOTICE '✅ rakeback_periods.total_rake_paid column added (FIX 164)'; END $$;
