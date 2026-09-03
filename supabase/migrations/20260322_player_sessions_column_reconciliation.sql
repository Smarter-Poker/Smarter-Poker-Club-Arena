-- ================================================
-- Reconciliation: ensure player_sessions has ALL columns
-- queried by the application code (PlayerStatsPage,
-- SessionHistory, BankrollTracker).
--
-- Problem: Multiple migrations define player_sessions
-- with different column sets. The earliest (20260314)
-- uses net_result/buy_in_total/cash_out_total, but the
-- app queries profit_loss/buy_in/cash_out/duration_minutes/date.
-- This migration ensures ALL columns exist regardless
-- of which CREATE TABLE ran first.
-- ================================================

ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE;
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS profit_loss NUMERIC(18,4) DEFAULT 0;
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS duration_minutes INTEGER DEFAULT 0;
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS buy_in NUMERIC(18,4) DEFAULT 0;
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS cash_out NUMERIC(18,4) DEFAULT 0;

-- Also ensure index on user_id exists
CREATE INDEX IF NOT EXISTS idx_player_sessions_user_id ON player_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_player_sessions_date ON player_sessions(date);

-- Ensure RLS is enabled and basic policy exists
ALTER TABLE player_sessions ENABLE ROW LEVEL SECURITY;

-- Select policy: users can read their own sessions
DO $$ BEGIN
    CREATE POLICY ps_select_own ON player_sessions FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Insert policy: users can insert their own sessions
DO $$ BEGIN
    CREATE POLICY ps_insert_own ON player_sessions FOR INSERT WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Update policy: users can update their own sessions
DO $$ BEGIN
    CREATE POLICY ps_update_own ON player_sessions FOR UPDATE USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
