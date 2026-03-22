-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: assigned_date column must be TEXT, not DATE
-- Weekly keys ("W2026-03-17") and monthly keys ("M2026-3") are NOT valid DATE
-- values. PostgreSQL rejects INSERTs for non-DATE strings, causing weekly/monthly
-- challenges to silently fail. Daily challenges ("2026-03-22") worked by luck
-- because YYYY-MM-DD is a valid DATE string.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Change column type from DATE to TEXT (preserving existing data)
ALTER TABLE user_daily_challenges
ALTER COLUMN assigned_date TYPE TEXT USING assigned_date::TEXT;

-- Update default (DATE default is CURRENT_DATE, now use text format)
ALTER TABLE user_daily_challenges
ALTER COLUMN assigned_date SET DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD');

-- Recreate the composite unique constraint and index (type change may invalidate)
-- Drop and recreate index on (user_id, assigned_date)
DROP INDEX IF EXISTS idx_user_daily_challenges_user_date;
CREATE INDEX IF NOT EXISTS idx_user_daily_challenges_user_date
ON user_daily_challenges(user_id, assigned_date);
