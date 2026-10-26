BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_tournaments_spin_missing_multiplier
    ON public.tournaments ((COALESCE(started_at, created_at)))
 WHERE variant = 'spin' AND status IN ('RUNNING', 'COMPLETED') AND COALESCE(spin_multiplier, 0) <= 0;

COMMIT;
