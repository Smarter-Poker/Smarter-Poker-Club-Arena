-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: tournament_flights
-- DESCRIPTION: Multi-Day Tournament Flight support — stores bagged chip stacks
--              at end of Day 1 and tracks resume status for Day 2.
-- CONTEXT: Required by TournamentOrchestrator.handleMultiDayFlight() and
--          TournamentOrchestrator.scheduleDayTwoStart()
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. tournament_flights table
-- Stores bagged chip counts for multi-day tournaments

CREATE TABLE IF NOT EXISTS public.tournament_flights (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    flight_day INTEGER NOT NULL DEFAULT 1,
    bagged_chips INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'bagged' CHECK (status IN ('bagged', 'resumed', 'eliminated')),
    bagged_at TIMESTAMPTZ DEFAULT now(),
    resumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tournament_id, user_id)
);

-- 2. Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_tournament_flights_tournament
    ON public.tournament_flights(tournament_id, status);

CREATE INDEX IF NOT EXISTS idx_tournament_flights_user
    ON public.tournament_flights(user_id);

-- 3. RLS
ALTER TABLE public.tournament_flights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tournament_flights_select_own"
    ON public.tournament_flights FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "tournament_flights_select_admin"
    ON public.tournament_flights FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
        )
    );

CREATE POLICY "tournament_flights_insert_admin"
    ON public.tournament_flights FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
        )
    );

CREATE POLICY "tournament_flights_update_admin"
    ON public.tournament_flights FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
        )
    );

-- 4. Updated_at trigger
CREATE TRIGGER update_tournament_flights_modtime
    BEFORE UPDATE ON public.tournament_flights
    FOR EACH ROW
    EXECUTE FUNCTION public.moddatetime('updated_at');

-- 5. Also add Day Break support columns to tournaments table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tournaments' AND column_name='day1_ended_at') THEN
        ALTER TABLE public.tournaments ADD COLUMN day1_ended_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tournaments' AND column_name='day2_started_at') THEN
        ALTER TABLE public.tournaments ADD COLUMN day2_started_at TIMESTAMPTZ;
    END IF;
END $$;
