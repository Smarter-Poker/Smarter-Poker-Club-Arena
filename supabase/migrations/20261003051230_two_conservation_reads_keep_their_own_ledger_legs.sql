-- ===========================================================================
--  TWO CONSERVATION READS KEEP THEIR OWN LEDGER LEGS
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-03. Read from cron.job_run_details and timed
-- read-only against production between 04:55 and 05:14 UTC.
--
-- ca-conservation-sweep-hourly (job 233, :52, SET statement_timeout '600s')
-- runs fn_ca_conservation_sweep(): 30 checks in one statement. In the 30 runs
-- to 04:00 UTC it took 114-376 s, and the 22:52 run of 2026-10-02 was
-- cancelled at 600 s inside fn_bbj_conservation_check's epoch read. Two reads
-- of chip_ledger (8.49M rows, 3.9 GB heap) were nearly all of it. Inside a
-- PL/pgSQL or SQL function each runs serially, and both walked
-- idx_chip_ledger_created_at with a heap fetch for every row in the window:
--
--   fn_bbj_conservation_check, the epoch identity:
--     WHERE (to_type = 'bbj_pool' OR from_type = 'bbj_pool')
--       AND created_at > <first bbj baseline, 2026-09-04 21:17>
--     7.1M rows since the epoch fetched to keep 3,553,232 bbj legs (~61 s in
--     the sweep). Every other read in the function measured 9-224 ms.
--
--   fn_chip_drift_since_baseline (read by fn_chip_integrity_report, the
--   sweep's first check):
--     WHERE club_id IS NOT NULL AND created_at >= <min ca_chip_baseline.taken_at,
--       2026-08-27 01:08> AND (to_type = 'player_wallet' OR from_type = 'player_wallet')
--     t0 comes from a subquery, so the plan is a created_at range scan over
--     ~8.4M rows to keep 1.49M player legs: 55.8 s measured at 05:08.
--
-- WHAT CHANGES. Two partial indexes whose predicate is exactly each read's
-- own leg filter, carrying every column the read uses, so each read is one
-- index-only scan of its own legs. No function body, schedule, grant or
-- constraint changes, so every row each check covered is still covered and
-- each verdict is computed by the same SQL:
--
--   idx_chip_ledger_bbj_pool_legs (230 MB): the epoch read is an Index Only
--     Scan, 3.02 s serial with a cold cache (25,378 pages read, 13,450 heap
--     fetches); the whole fn_bbj_conservation_check 4.5 s, healthy true,
--     drift_from_baseline -9.82.
--   idx_chip_ledger_player_wallet_legs (172 MB): fn_chip_drift_since_baseline
--     1.8 s (was 55.8 s), the same 670 drifting memberships, worst 103,747.97.
--
-- WRITE COST. One more index entry per bbj leg (~120k a day) and per player
-- leg (~40k a day), on a table taking ~450k inserts a day that already
-- carries 27 indexes.
--
-- HOW IT WAS APPLIED. Each CREATE INDEX CONCURRENTLY below ran in production
-- as the whole command of a one-shot pg_cron job, as in 20261003031000:
-- job 403 (05:06:00-05:07:04, 64.1 s) and job 404 (05:12:00-05:13:04,
-- 64.1 s), both 'CREATE INDEX', both unscheduled afterwards. pg_cron connects
-- as postgres and gets the role's 2-minute statement_timeout, so for the
-- seconds around each start `ALTER ROLE postgres IN DATABASE postgres SET
-- statement_timeout = '15min'` was in force (05:05:36-05:06:17 and
-- 05:11:39-05:12:12) and was then RESET; pg_db_role_setting has no
-- postgres/postgres row again (verified after each). The transaction below
-- therefore finds both built; it is the assertion of the end state and the
-- replay form for a database that has not run the preamble.
--
-- @live-proof: (SELECT count(*) = 2 AND bool_and(indisvalid AND indisready AND indislive) FROM pg_index WHERE indexrelid IN (to_regclass('public.idx_chip_ledger_bbj_pool_legs'), to_regclass('public.idx_chip_ledger_player_wallet_legs')))
-- ===========================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_bbj_pool_legs
  ON public.chip_ledger USING btree (created_at) INCLUDE (amount, to_type, from_type)
  WHERE ((to_type = 'bbj_pool'::text) OR (from_type = 'bbj_pool'::text));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_player_wallet_legs
  ON public.chip_ledger USING btree (created_at)
  INCLUDE (club_id, to_type, from_type, to_entity_id, from_entity_id, amount)
  WHERE ((club_id IS NOT NULL) AND ((to_type = 'player_wallet'::text) OR (from_type = 'player_wallet'::text)));

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Both indexes exist, are valid, and are exactly the definitions the two
-- reads were measured against. An INVALID leftover of a cancelled concurrent
-- build is refused by name.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.idx_chip_ledger_bbj_pool_legs',
       'CREATE INDEX idx_chip_ledger_bbj_pool_legs ON public.chip_ledger USING btree (created_at) INCLUDE (amount, to_type, from_type) WHERE ((to_type = ''bbj_pool''::text) OR (from_type = ''bbj_pool''::text))'),
      ('public.idx_chip_ledger_player_wallet_legs',
       'CREATE INDEX idx_chip_ledger_player_wallet_legs ON public.chip_ledger USING btree (created_at) INCLUDE (club_id, to_type, from_type, to_entity_id, from_entity_id, amount) WHERE ((club_id IS NOT NULL) AND ((to_type = ''player_wallet''::text) OR (from_type = ''player_wallet''::text)))')
    ) AS x(ix, def)
  LOOP
    IF to_regclass(r.ix) IS NULL THEN
      RAISE EXCEPTION 'conservation_leg_indexes: % is missing; build it CONCURRENTLY first', r.ix
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indexrelid = to_regclass(r.ix)
         AND i.indrelid = 'public.chip_ledger'::regclass
         AND i.indisvalid AND i.indisready AND i.indislive
         AND pg_get_indexdef(i.indexrelid) = r.def
    ) THEN
      RAISE EXCEPTION 'conservation_leg_indexes: % is invalid or not the expected definition; drop the INVALID leftover CONCURRENTLY and rebuild it', r.ix
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$post$;

COMMIT;
