-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX BUG #31: Add missing columns to promotions table
-- ═══════════════════════════════════════════════════════════════════════════════
-- The promotions table was created with only basic columns, but PromotionService
-- references many more columns for the full promotion/bonus/deposit-match system.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add the date columns the code uses (code uses start_date/end_date, schema has starts_at/ends_at)
-- We add BOTH sets so queries using either naming convention work
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ;
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;

-- Backfill start_date/end_date from starts_at/ends_at if they exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'promotions' AND column_name = 'starts_at'
  ) THEN
    UPDATE promotions SET start_date = starts_at WHERE start_date IS NULL AND starts_at IS NOT NULL;
    UPDATE promotions SET end_date = ends_at WHERE end_date IS NULL AND ends_at IS NOT NULL;
  END IF;
END $$;

-- Add missing promotion feature columns
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS prize_pool DECIMAL(15, 2) DEFAULT 0;
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS requirements TEXT;
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS max_claims INTEGER;
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS claim_count INTEGER DEFAULT 0;
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS min_deposit DECIMAL(15, 2);
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS bonus_percent DECIMAL(5, 2);
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS wager_requirement DECIMAL(15, 2);

-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX BUG #32: Add missing columns to user_bonuses table
-- ═══════════════════════════════════════════════════════════════════════════════
-- BonusService queries daily_streak and last_daily_claim, but neither exists
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE user_bonuses ADD COLUMN IF NOT EXISTS daily_streak INTEGER DEFAULT 0;
ALTER TABLE user_bonuses ADD COLUMN IF NOT EXISTS last_daily_claim TIMESTAMPTZ;
