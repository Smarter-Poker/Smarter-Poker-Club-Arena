-- ═══════════════════════════════════════════════════════════════════════════
--  AND AN INDEX FOR THE RANGE IT READS
--  Club Operations upgrade, phase 7 of 8. Companion to 20260905042100.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_ca_rake_by_agent` now reads `rake_attributions` grouped by player for
-- the days not yet rolled up, instead of calling `fn_rake_shares_for_record`
-- once per raked hand. That change needs no lock and shipped on its own.
--
-- This is the index that makes the read cheap rather than merely cheaper, and
-- it is applied INSIDE THE :55 MAINTENANCE FREEZE: `rake_attributions` gets a
-- row per player per raked hand, so the engine writes it constantly, and a
-- plain CREATE INDEX holds a lock that blocks those writers for the length of
-- its scan (1,131,048 rows / 456 MB). During the freeze every table is parked
-- at a hand boundary and nothing is writing, which is what the window is for
-- (CLAUDE.md 13). CREATE INDEX CONCURRENTLY cannot run inside the single
-- transaction a migration must be.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';

CREATE INDEX IF NOT EXISTS idx_rake_attributions_club_created
  ON public.rake_attributions (club_id, created_at)
  INCLUDE (player_id, rake_amount);

COMMENT ON INDEX public.idx_rake_attributions_club_created IS
  'Serves the live edge of fn_ca_rake_by_agent: the per-player rake for days not yet in club_rake_rollup_complete, grouped in one range scan instead of one fn_rake_shares_for_record call per raked hand (61,156 on the busiest club, 29.7 seconds).';


DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='rake_attributions'
       AND indexname='idx_rake_attributions_club_created'
  ) THEN
    RAISE EXCEPTION 'the live edge has no index to read';
  END IF;
END $$;

COMMIT;
