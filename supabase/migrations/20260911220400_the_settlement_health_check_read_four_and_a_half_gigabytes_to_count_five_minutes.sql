-- fn_settlement_health() is the money path's own health reading: how many
-- settlements reached final in the last five minutes, how many failed, how many
-- are stuck. Four alert rules are written against it, one of them an SMS page.
--
-- Measured 2026-09-11: a single call took 6,525 ms. ca_settlements is 4,497 MB
-- across 5.6M rows, and its only index on updated_at is PARTIAL:
--
--   idx_ca_settlements_final_updated_at ON (updated_at) WHERE state = 'final'
--
-- The health check counts final, failed AND stuck, so the partial index cannot
-- serve it and the planner falls back to a sequential scan of the whole table.
-- That is survivable when a person runs the function by hand. It is not
-- survivable on a timer: the collector that publishes these gauges has to call
-- it every minute, and a 4.5 GB scan every minute would evict the buffer cache
-- the live money path depends on. The index is therefore a prerequisite for the
-- collector, not a tuning nicety.
--
-- CONCURRENTLY keeps settlements readable and writable while the index builds.
-- This migration must not be wrapped in an explicit transaction.

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ca_settlements_updated_at
  ON public.ca_settlements (updated_at);

COMMENT ON INDEX public.idx_ca_settlements_updated_at IS
  'Bounds fn_settlement_health() to the window it asks for. The pre-existing partial index covers state = final only, so any query spanning failed or stuck states scanned all 5.6M rows (6.5s measured 2026-09-11).';

-- ROLLBACK (online):
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_ca_settlements_updated_at;
