-- =========================================================================
-- THE INVENTORY READERS KEEP THEIR MEMORY ON ONE PROCESS
-- ============================================================================
--
-- WHY
--
-- Production Postgres stopped three times on 2026-10-03 (16:34, 19:50 and
-- 20:18 UTC, the last a 44-minute VM hang). Memory exhaustion of the 32 GB
-- VM is the most probable cause; see
-- docs/changelog/2026-10-03-the-database-keeps-memory-headroom.md.
--
-- The two union P&L inventory readers run with work_mem = 256MB and index
-- scans off, so they read about 1M events per six-hour layer (7.8M per week)
-- through hash and sort nodes. Each hash node may take
-- work_mem x hash_mem_multiplier (2), and a Parallel Hash multiplies that by
-- every participant: with parallel workers, one hash node could take 1.5-2.5 GB,
-- and the plans have several. They run from the weekly close (job 272) next to
-- the other analytic crons.
--
-- THE FIX
--
-- Both functions keep enable_indexscan = off (the reason is in their body:
-- bitmap reads in physical order are ~5x faster than index scans on a cold
-- week) and get:
--   work_mem = 64MB                       (was 256MB)
--   max_parallel_workers_per_gather = 0   (was the global 2, earlier 4)
-- so one call holds at most a few hundred MB on one process, and anything
-- larger spills to temp files instead of RAM. A planner setting cannot change
-- a query's result. Body, owner, grants, search_path and volatility are
-- unchanged.
--
-- MEASURED ON PRODUCTION 2026-10-03 22:47-23:00 UTC. A pg_temp copy with the
-- new settings was run against the live function. Results were compared as an
-- md5 over every returned row, sorted.
--
--   fn_union_pnl_inventory_layer_state(base 09-28 07:00, boundary 10-03 18:00)
--     layer 10-03 12:00-18:00: 65,394 rows, identical hash; 45.3 s live (cold) vs 29.9 s capped
--     layer 10-03 06:00-12:00: 70,048 rows, identical hash;
--       warm runs: live 23.4 s and 32.1 s; capped 27.9 s and 28.0 s
--   fn_union_pnl_inventory_state(09-28 07:00, 09-28 13:00):
--     518,346 rows, identical hash; live 12.8 s and 13.5 s; capped 14.1 s and 14.9 s
--
-- No ledger, wallet or chip row is involved: these are read-only reporting
-- readers.
-- ============================================================================

-- @live-proof: (SELECT bool_and('work_mem=64MB' = ANY (proconfig) AND 'max_parallel_workers_per_gather=0' = ANY (proconfig) AND 'enable_indexscan=off' = ANY (proconfig)) FROM pg_proc WHERE oid IN ('public.fn_union_pnl_inventory_state(timestamp with time zone,timestamp with time zone)'::regprocedure, 'public.fn_union_pnl_inventory_layer_state(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)'::regprocedure))

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER FUNCTION public.fn_union_pnl_inventory_state(timestamp with time zone, timestamp with time zone)
  SET work_mem = '64MB';
ALTER FUNCTION public.fn_union_pnl_inventory_state(timestamp with time zone, timestamp with time zone)
  SET max_parallel_workers_per_gather = 0;
ALTER FUNCTION public.fn_union_pnl_inventory_layer_state(timestamp with time zone, timestamp with time zone, timestamp with time zone, timestamp with time zone)
  SET work_mem = '64MB';
ALTER FUNCTION public.fn_union_pnl_inventory_layer_state(timestamp with time zone, timestamp with time zone, timestamp with time zone, timestamp with time zone)
  SET max_parallel_workers_per_gather = 0;

DO $assert$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.proconfig AS cfg FROM pg_proc p
     WHERE p.oid IN ('public.fn_union_pnl_inventory_state(timestamp with time zone,timestamp with time zone)'::regprocedure,
                     'public.fn_union_pnl_inventory_layer_state(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)'::regprocedure)
  LOOP
    IF NOT ('work_mem=64MB' = ANY (r.cfg))
       OR NOT ('max_parallel_workers_per_gather=0' = ANY (r.cfg))
       OR NOT ('enable_indexscan=off' = ANY (r.cfg))
       OR NOT ('search_path=public, pg_temp' = ANY (r.cfg)) THEN
      RAISE EXCEPTION '% config is not as intended: %', r.fn, r.cfg;
    END IF;
  END LOOP;
END
$assert$;

COMMIT;
