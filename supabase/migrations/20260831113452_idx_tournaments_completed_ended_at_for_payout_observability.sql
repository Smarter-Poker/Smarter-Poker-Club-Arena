-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831113452; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- MTT Phase 2 (observability): the unpaid-prize gauge asks
--   status='COMPLETED' AND ended_at > now() - interval, prize_pool > 0
-- and there is no index for it. Measured on production 2026-08-31 that plan is
-- a Seq Scan over `tournaments` discarding 50,849 rows, 908ms per call. The
-- engine will run this once a minute, so it needs to be an index scan.
--
-- Partial on status='COMPLETED' because that is the only status the query asks
-- about and it keeps the index small. DESC because every caller wants the most
-- recent finishers.
--
-- Additive and reversible: DROP INDEX IF EXISTS idx_tournaments_completed_ended_at;
CREATE INDEX IF NOT EXISTS idx_tournaments_completed_ended_at
  ON public.tournaments (ended_at DESC)
  WHERE status = 'COMPLETED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'tournaments'
      AND indexname = 'idx_tournaments_completed_ended_at'
  ) THEN
    RAISE EXCEPTION 'idx_tournaments_completed_ended_at was not created';
  END IF;
END $$;
