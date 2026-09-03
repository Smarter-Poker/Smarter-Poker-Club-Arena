-- ============================================================================
-- 💸 RAKEBACK SYSTEM — Tables & Functions
-- Provides player rakeback tracking and payouts
-- ============================================================================

-- Rakeback periods table
CREATE TABLE IF NOT EXISTS rakeback_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    rake_generated DECIMAL(15,2) DEFAULT 0,
    rakeback_rate DECIMAL(5,4) DEFAULT 0.15, -- 15% default
    rakeback_earned DECIMAL(15,2) DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_rakeback_periods_user 
ON rakeback_periods(user_id, period_start DESC);

-- Enable RLS
ALTER TABLE rakeback_periods ENABLE ROW LEVEL SECURITY;

-- Users can view their own rakeback
DROP POLICY IF EXISTS rakeback_periods_select ON rakeback_periods;
CREATE POLICY rakeback_periods_select ON rakeback_periods
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Function to calculate rakeback for a period
CREATE OR REPLACE FUNCTION fn_calculate_rakeback(
    p_user_id UUID,
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_total_rake DECIMAL(15,2) := 0;
    v_rakeback_rate DECIMAL(5,4) := 0.15;
    v_rakeback_earned DECIMAL(15,2) := 0;
    v_vip_level INTEGER := 1;
BEGIN
    -- Get VIP level for rate calculation
    SELECT COALESCE(vip_level, 1) INTO v_vip_level
    FROM profiles WHERE id = p_user_id;
    
    -- Calculate rate based on VIP level (5% base + 2.5% per level)
    v_rakeback_rate := 0.05 + (v_vip_level * 0.025);
    IF v_rakeback_rate > 0.50 THEN
        v_rakeback_rate := 0.50; -- Cap at 50%
    END IF;
    
    -- Calculate total rake from hand history (placeholder)
    -- In production, this would sum from game_hands or similar
    v_total_rake := 0;
    
    v_rakeback_earned := v_total_rake * v_rakeback_rate;
    
    -- Insert or update rakeback period
    INSERT INTO rakeback_periods (user_id, period_start, period_end, rake_generated, rakeback_rate, rakeback_earned)
    VALUES (p_user_id, p_period_start, p_period_end, v_total_rake, v_rakeback_rate, v_rakeback_earned)
    ON CONFLICT (user_id, period_start) DO UPDATE SET
        rake_generated = EXCLUDED.rake_generated,
        rakeback_rate = EXCLUDED.rakeback_rate,
        rakeback_earned = EXCLUDED.rakeback_earned,
        updated_at = NOW();
    
    RETURN json_build_object(
        'success', true,
        'rake_generated', v_total_rake,
        'rakeback_rate', v_rakeback_rate,
        'rakeback_earned', v_rakeback_earned
    );
END;
$$;

-- Add unique constraint for upsert
ALTER TABLE rakeback_periods 
DROP CONSTRAINT IF EXISTS rakeback_periods_user_period_unique;
ALTER TABLE rakeback_periods
ADD CONSTRAINT rakeback_periods_user_period_unique UNIQUE (user_id, period_start);
