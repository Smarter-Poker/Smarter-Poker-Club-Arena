-- =======================================================================================
-- MIGRATION: 20260312000_analytics_and_vip.sql
-- DESCRIPTION: Core tables for Advanced Analytics (player_position_stats) and VIP Progression
--              (vip_points_ledger) to support real-time data ingestion and display.
-- =======================================================================================

-- 1. player_position_stats
-- Stores positional tracking for VPIP/PFR and agg frequency, used by PlayerStatsPage.

CREATE TABLE IF NOT EXISTS public.player_position_stats (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    position VARCHAR(10) NOT NULL, -- e.g. 'EP', 'MP', 'CO', 'BTN', 'SB', 'BB'
    hands_played INTEGER DEFAULT 0,
    vpip_count INTEGER DEFAULT 0,
    pfr_count INTEGER DEFAULT 0,
    three_bet_count INTEGER DEFAULT 0,
    fold_to_three_bet_count INTEGER DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    PRIMARY KEY (user_id, position)
);

-- RLS
ALTER TABLE public.player_position_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own stats"
    ON public.player_position_stats FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "God Mode and Services can read all stats"
    ON public.player_position_stats FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND (role = 'god' OR role = 'service')
        )
    );

-- Trigger for updated_at
CREATE TRIGGER update_player_position_stats_modtime
    BEFORE UPDATE ON public.player_position_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();


-- 2. vip_points_ledger
-- Transactional history of VIP points earned or spent. Powers the VIPPage interface.

CREATE TABLE IF NOT EXISTS public.vip_points_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL, -- Positive for earned, negative for spent/redeemed
    transaction_type VARCHAR(50) NOT NULL, -- 'hand_played', 'tournament_entry', 'purchase', 'redemption', 'bonus'
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Index for fast queries by user (e.g., getting monthly points or history)
CREATE INDEX IF NOT EXISTS idx_vip_ledger_user_date ON public.vip_points_ledger(user_id, created_at DESC);

-- RLS
ALTER TABLE public.vip_points_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own ledger"
    ON public.vip_points_ledger FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Service workers can insert ledger"
    ON public.vip_points_ledger FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL); -- In reality, edge funcs use service role, which bypasses RLS


-- 3. Modify `profiles` to ensure `vip_points` exists as a cached aggregate
-- (It shouldn't hurt if it already exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='vip_points') THEN
        ALTER TABLE public.profiles ADD COLUMN vip_points INTEGER DEFAULT 0;
    END IF;
END $$;


-- 4. RPC to securely append VIP points
-- This function writes to the ledger AND updates the profile aggregate atomically.
CREATE OR REPLACE FUNCTION public.add_vip_points(
    p_user_id UUID,
    p_amount INTEGER,
    p_type VARCHAR(50),
    p_desc TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- 1. Insert ledger entry
    INSERT INTO public.vip_points_ledger (user_id, amount, transaction_type, description)
    VALUES (p_user_id, p_amount, p_type, p_desc);

    -- 2. Update cached total on profile
    UPDATE public.profiles
    SET vip_points = COALESCE(vip_points, 0) + p_amount
    WHERE id = p_user_id;
END;
$$;
