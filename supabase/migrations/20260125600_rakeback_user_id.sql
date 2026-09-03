-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 FIX RAKEBACK PERIODS - ADD USER_ID COLUMN
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add user_id column to rakeback_periods if not exists
ALTER TABLE rakeback_periods ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES profiles(id) ON DELETE CASCADE;

-- Create index on user_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_rakeback_periods_user ON rakeback_periods(user_id);

-- Update RLS to allow users to see their own rakeback
DROP POLICY IF EXISTS "Users can view own rakeback" ON rakeback_periods;
CREATE POLICY "Users can view own rakeback" ON rakeback_periods
    FOR SELECT USING (user_id = auth.uid());

DO $$ BEGIN RAISE NOTICE '🔧 RAKEBACK PERIODS USER_ID COLUMN ADDED'; END $$;
