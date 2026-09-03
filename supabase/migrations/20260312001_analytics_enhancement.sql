-- =======================================================================================
-- MIGRATION: 20260312001_analytics_enhancement.sql
-- DESCRIPTION: Adds hands_won + total_profit to player_position_stats for AnalyticsDashboard,
--              and session_history table for SessionStatsService persistence.
-- =======================================================================================

-- 1. Add hands_won and total_profit columns to player_position_stats
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='player_position_stats' AND column_name='hands_won') THEN
        ALTER TABLE public.player_position_stats ADD COLUMN hands_won INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='player_position_stats' AND column_name='total_profit') THEN
        ALTER TABLE public.player_position_stats ADD COLUMN total_profit NUMERIC(12,2) DEFAULT 0.00;
    END IF;
END $$;


-- 2. Session History — Persists completed cash game sessions for analytics and review
CREATE TABLE IF NOT EXISTS public.session_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    table_id UUID NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ended_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    duration_minutes INTEGER DEFAULT 0,
    initial_stack NUMERIC(12,2) DEFAULT 0,
    final_stack NUMERIC(12,2) DEFAULT 0,
    buy_in_total NUMERIC(12,2) DEFAULT 0,
    profit_loss NUMERIC(12,2) DEFAULT 0,
    hands_played INTEGER DEFAULT 0,
    hands_won INTEGER DEFAULT 0,
    vpip_percent NUMERIC(5,2) DEFAULT 0,
    pfr_percent NUMERIC(5,2) DEFAULT 0,
    big_blind NUMERIC(12,2) DEFAULT 0,
    bb_won NUMERIC(8,2) DEFAULT 0,
    trajectory JSONB DEFAULT '[]'::jsonb
);

-- Index for fast queries by user
CREATE INDEX IF NOT EXISTS idx_session_history_user_date
    ON public.session_history(user_id, ended_at DESC);

-- RLS
ALTER TABLE public.session_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own sessions"
    ON public.session_history FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Services can insert sessions"
    ON public.session_history FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "God mode can read all sessions"
    ON public.session_history FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'god'
        )
    );
