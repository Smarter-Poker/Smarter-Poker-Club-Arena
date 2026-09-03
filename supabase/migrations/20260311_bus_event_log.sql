-- ═══════════════════════════════════════════════════════════════════════════════
--  Bus Event Log — Supabase table for critical MasterBus event audit trail
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bus_event_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_bus_event_log_type ON public.bus_event_log(event_type);
CREATE INDEX IF NOT EXISTS idx_bus_event_log_created ON public.bus_event_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bus_event_log_user ON public.bus_event_log(user_id);

-- RLS: Users can read their own events, service role can do everything
ALTER TABLE public.bus_event_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own events" ON public.bus_event_log
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own events" ON public.bus_event_log
    FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- Auto-cleanup: delete events older than 7 days (run via cron or scheduled function)
-- This is a policy, not auto-executed. Run: DELETE FROM bus_event_log WHERE created_at < now() - interval '7 days';

COMMENT ON TABLE public.bus_event_log IS 'Audit trail for critical MasterBus events (BALANCE_UPDATED, CLUB_JOINED, etc.)';
