-- ═══════════════════════════════════════════════════════════════════════════════
-- Schema Additions Batch 3: Add missing columns & tables referenced by app code
-- Found by comprehensive audit of all .ts/.tsx files vs actual DB schemas
-- Deploy Date: 2026-03-17
-- Status: APPLIED TO LIVE DB
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. profiles: horse_status + horse_profile (used by HydraService, HorseOrchestrator, HorseLifecycleManager, etc.)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS horse_status varchar DEFAULT 'available';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS horse_profile jsonb DEFAULT '{}'::jsonb;

-- 2. player_position_stats (used by PlayerStatsPage, PlayerStyleRadar, AnalyticsDashboard)
CREATE TABLE IF NOT EXISTS player_position_stats (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL,
    position varchar NOT NULL,
    hands_played integer DEFAULT 0,
    hands_won integer DEFAULT 0,
    total_profit numeric DEFAULT 0,
    vpip_count integer DEFAULT 0,
    pfr_count integer DEFAULT 0,
    three_bet_count integer DEFAULT 0,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);
ALTER TABLE player_position_stats ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY pps_select_own ON player_position_stats FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. player_sessions (used by PlayerStatsPage)
CREATE TABLE IF NOT EXISTS player_sessions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL,
    table_id uuid,
    club_id uuid,
    date date DEFAULT CURRENT_DATE,
    profit_loss numeric DEFAULT 0,
    hands_played integer DEFAULT 0,
    duration_minutes integer DEFAULT 0,
    buy_in numeric DEFAULT 0,
    cash_out numeric DEFAULT 0,
    created_at timestamptz DEFAULT now()
);
ALTER TABLE player_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY ps_select_own ON player_sessions FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. player_notes: add tags column (used by PlayerNotesPanel, PlayerNotes)
ALTER TABLE player_notes ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';

-- 5. wallet_transactions: add balance_after (used by TransactionHistory)
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_after numeric;
