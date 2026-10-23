SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS idx_tournaments_spin_unbooked_effective_start
    ON public.tournaments ((COALESCE(started_at, created_at)))
 WHERE variant = 'spin' AND status IN ('RUNNING', 'COMPLETED');
