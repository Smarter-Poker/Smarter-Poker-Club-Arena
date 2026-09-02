-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902163300; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Reverting idx_tournaments_spin_created, applied minutes ago in
-- the_unpaid_settlement_scan_stops_reading_every_spin_too.
--
-- It was meant to serve the candidates CTE of fn_spin_unpaid_settlements
-- (2342ms of the 3741ms fn_spin_metrics spends per /metrics scrape). Measured
-- after applying it, the planner REFUSED it and chose a sequential scan:
--
--   Seq Scan on tournaments  634ms, 12,560 buffers, Rows Removed 61,491
--
-- which is correct of it. `created_at > now() - 24h` selects ~3,196 of 64,687
-- rows, and random heap access for 5% of a 12,560-block table costs about what
-- reading the whole table sequentially costs. An index the planner will not
-- use is pure write amplification on a table taking thousands of inserts a day.
--
-- Keeping the earlier idx_tournaments_spin_unbooked_scan, which IS adopted and
-- did move its query 877ms -> 252ms. The difference is that one has a
-- selective status predicate AND its ordering matches the range filter.
--
-- The remaining ~3.7s per scrape is not an indexing problem, so it should not
-- be attacked with another index. Filed for a real fix.
--
-- ROLLBACK: re-create the index from the migration named above.

drop index if exists public.idx_tournaments_spin_created;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname='public' AND indexname='idx_tournaments_spin_created') THEN
    RAISE EXCEPTION 'idx_tournaments_spin_created still present after drop';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND indexname='idx_tournaments_spin_unbooked_scan') THEN
    RAISE EXCEPTION 'the index that DOES work was dropped by mistake';
  END IF;
  RAISE NOTICE 'reverted; idx_tournaments_spin_unbooked_scan retained';
END $$;
