-- BUG 019 DB cleanup: prior 2-hour stale-cancel code path in server/src/index.ts
-- nuked 133 MTTs over the past week without setting ended_at. Backfill ended_at so
-- audit/UI can close them out.
--
-- Code fix (same commit) bumps threshold to 12h + checks hand_history for recent
-- activity before cancelling + sets ended_at on future cancellations.

UPDATE tournaments
SET ended_at = COALESCE(started_at, created_at) + INTERVAL '2 hours',
    updated_at = NOW()
WHERE status = 'CANCELLED'
  AND ended_at IS NULL
  AND started_at IS NOT NULL
  AND created_at > NOW() - INTERVAL '30 days';
