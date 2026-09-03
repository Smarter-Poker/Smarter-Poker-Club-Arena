-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: Recreate the UNIQUE constraint on (user_id, challenge_id, assigned_date)
--
-- The original 051_daily_challenges.sql created:
--   UNIQUE(user_id, challenge_id, assigned_date)
-- on a DATE column. When 20260322_fix_assigned_date_type.sql converted
-- assigned_date from DATE → TEXT, the unique constraint was NOT recreated.
-- The index was recreated, but an INDEX is NOT a UNIQUE CONSTRAINT.
--
-- Without this constraint, the upsert with
--   onConflict: 'user_id,challenge_id,assigned_date'
-- will fail (Supabase returns a 409 or ignores the conflict clause),
-- allowing duplicate challenge rows for the same user+challenge+date.
-- ═══════════════════════════════════════════════════════════════════════════════

-- First, clean up any duplicate rows that may have been created between
-- the type change migration and this fix. Keep only the earliest row.
DELETE FROM user_daily_challenges a
USING user_daily_challenges b
WHERE a.user_id = b.user_id
  AND a.challenge_id = b.challenge_id
  AND a.assigned_date = b.assigned_date
  AND a.created_at > b.created_at;

-- Drop the old regular index (will be replaced by unique index)
DROP INDEX IF EXISTS idx_user_daily_challenges_user_date;

-- Recreate as a UNIQUE constraint (creates implicit unique index)
ALTER TABLE user_daily_challenges
ADD CONSTRAINT uq_user_daily_challenges_user_challenge_date
UNIQUE (user_id, challenge_id, assigned_date);

-- Recreate the user+date lookup index (the unique constraint above covers
-- user_id+challenge_id+assigned_date, but queries typically filter by
-- user_id+assigned_date only, so a separate 2-column index is still needed)
CREATE INDEX IF NOT EXISTS idx_user_daily_challenges_user_date
ON user_daily_challenges(user_id, assigned_date);
