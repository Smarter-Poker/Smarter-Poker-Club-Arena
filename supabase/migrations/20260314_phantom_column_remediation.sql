-- ═══════════════════════════════════════════════════════════════════════════════
-- PHANTOM COLUMN REMEDIATION (March 14, 2026)
-- Adds missing columns to clubs table that are referenced in code
-- ═══════════════════════════════════════════════════════════════════════════════

-- clubs table — game settings columns
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS settlement_lock_until TIMESTAMPTZ;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS card_image_url TEXT;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS active_players INTEGER DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS default_rake_percent NUMERIC(5,2) DEFAULT 5;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS rake_cap NUMERIC(18,4) DEFAULT 3;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS min_buyin_bb INTEGER DEFAULT 20;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS max_buyin_bb INTEGER DEFAULT 200;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS time_bank_seconds INTEGER DEFAULT 30;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS allow_straddle BOOLEAN DEFAULT true;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS allow_run_it_twice BOOLEAN DEFAULT true;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS allow_rabbit_hunt BOOLEAN DEFAULT false;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS logo TEXT;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT false;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS min_buy_in NUMERIC(18,4) DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS max_buy_in NUMERIC(18,4) DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS default_game_type TEXT DEFAULT 'NLHE';
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS allow_insurance BOOLEAN DEFAULT false;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS auto_approve_agents BOOLEAN DEFAULT false;

-- session_history — missing columns used by PerformanceTrends and StakeLevelComparison
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS profit_loss NUMERIC(18,4) DEFAULT 0;
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS big_blind NUMERIC(18,4) DEFAULT 0;
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS duration_minutes INTEGER DEFAULT 0;
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

-- player_position_stats — missing column used by PlayerStyleRadar
ALTER TABLE player_position_stats ADD COLUMN IF NOT EXISTS hands_won INTEGER DEFAULT 0;
