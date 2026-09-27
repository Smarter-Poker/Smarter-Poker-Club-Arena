-- The hourly BBJ meter keeps its opening-balance proof but reads only each
-- pool's labelled legs. Production 2026-09-27: the 120s cron timeout occurs
-- in this SELECT. EXPLAIN for two active pools chose a broad created_at scan
-- (estimated costs 401119 / 413624), while a third pool used entity indexes
-- (785). These are planner estimates, not measured production durations.
-- Splitting the OR alone still scanned broadly. Two narrow partial indexes
-- make the existing OR query locate only this pool's labelled legs. Financial
-- fields remain heap reads: unbounded labels must never become B-tree values.
-- The function stays byte-identical: aggregation, baseline/interval boundaries,
-- label precedence, rounding, snapshot writes, privileges and schedule stay unchanged.
-- No new observer, baseline reset, financial correction or timeout increase.
--
-- Online statements are intentionally separate from the verification migration:
-- never hold SHARE on the hot ledger for a regular index build. The owner
-- uses lock_timeout=180s and statement_timeout=360s for each build, checks
-- runway before :50 for EACH build and exact valid/ready index readback.
-- The separate short verification migration runs only after both builds finish. Unknown/failed builds require durable readback, not retry.

CREATE INDEX CONCURRENTLY IF NOT EXISTS chip_ledger_bbj_to_pool_meter
  ON public.chip_ledger (to_entity_id, created_at)
  WHERE to_type = 'bbj_pool'
    AND (to_label LIKE 'bbj_pools.%' OR from_label LIKE 'bbj_pools.%');

CREATE INDEX CONCURRENTLY IF NOT EXISTS chip_ledger_bbj_from_pool_meter
  ON public.chip_ledger (from_entity_id, created_at)
  WHERE from_type = 'bbj_pool'
    AND (to_label LIKE 'bbj_pools.%' OR from_label LIKE 'bbj_pools.%');

