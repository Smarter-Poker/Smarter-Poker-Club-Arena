-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260415220359 "bug_019_backfill_orphaned_tournament_ended_at"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 086343429bcc3b72f57b8554566b7d77 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 019 DB cleanup: the prior 2h-stale-cancel code path nuked 133 MTTs over the
-- past week without setting ended_at. Backfill ended_at = started_at + 2h (the
-- approximate cancel-time based on the old policy) so audit/UI can close them out.
UPDATE tournaments
SET ended_at = COALESCE(started_at, created_at) + INTERVAL '2 hours',
    updated_at = NOW()
WHERE status = 'CANCELLED'
  AND ended_at IS NULL
  AND started_at IS NOT NULL
  AND created_at > NOW() - INTERVAL '30 days';

-- Audit: how many rows were touched
SELECT COUNT(*)::text AS orphaned_tournaments_fixed
FROM tournaments
WHERE status = 'CANCELLED' AND ended_at IS NOT NULL
  AND updated_at > NOW() - INTERVAL '5 minutes';
