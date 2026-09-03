-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: Ensure rakeback_periods has 'rakeback_earned' column
-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 20260125100 created rakeback_periods with 'rakeback_amount',
-- but all code references 'rakeback_earned'. Add the correct column if missing.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE rakeback_periods ADD COLUMN IF NOT EXISTS rakeback_earned DECIMAL(15, 2) DEFAULT 0;

-- If the old column exists, copy data from it to the new one (one-time backfill)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rakeback_periods' AND column_name = 'rakeback_amount'
  ) THEN
    UPDATE rakeback_periods
    SET rakeback_earned = COALESCE(rakeback_amount, 0)
    WHERE rakeback_earned = 0 AND rakeback_amount > 0;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: Add auto_settlement columns to unions and clubs
-- ═══════════════════════════════════════════════════════════════════════════════
-- SettlementPage reads/writes unions.auto_settlement and clubs.auto_settlement,
-- but no migration creates these columns.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE unions ADD COLUMN IF NOT EXISTS auto_settlement BOOLEAN DEFAULT FALSE;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS auto_settlement BOOLEAN DEFAULT FALSE;
