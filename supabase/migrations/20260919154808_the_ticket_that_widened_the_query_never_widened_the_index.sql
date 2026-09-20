-- 20260919154808_the_ticket_that_widened_the_query_never_widened_the_index
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-19 15:48:08 UTC.
-- Applied to production as schema_migrations version 20260919154533.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- Three scheduled jobs were `critical` in fn_ca_cron_health(), meaning they
-- had run and never once succeeded:
--
--   tourney_money_conservation_hourly       12 * * * *     24 runs, 0 ok
--   ca-pay-backed-payout-shortfalls-hourly  26 * * * *     24 runs, 0 ok
--   tourney_money_conservation_deep_daily   25 3 * * *      1 run,  0 ok
--
-- All three died on `canceling statement due to statement timeout` inside
-- fn_tournament_conservation_delta. cron.job_run_details puts their last
-- successes within minutes of each other on 2026-09-12: 09:12, 09:26, 03:25.
--
-- 2026-09-12 is the day the seat_income term learned about tickets. It went
-- from
--
--   WHERE sp.source = 'satellite_seat'
-- to
--   WHERE sp.source IN ('satellite_seat', 'satellite_ticket')
--
-- and nobody widened idx_tournament_payouts_satellite_target, whose predicate
-- still read `WHERE source = 'satellite_seat'`. A partial index whose
-- predicate does not cover the query's predicate cannot be used AT ALL; the
-- planner cannot prove the rows it needs are in there. EXPLAIN showed
-- `Parallel Seq Scan on tournament_payouts`: all 161,772 rows, 176 MB, per
-- tournament, 200 tournaments per hourly run.
--
-- Nothing was wrong with the arithmetic. Three money-conservation jobs simply
-- stopped being affordable, and produced no verdict for seven days.
--
-- WHAT THIS DOES, and what it is not enough on its own
--
-- It widens the predicate to match today's query, which fixes today's query.
-- It does NOT stop the next widening doing this again, which is why
-- 20260919155648 follows immediately and removes the predicate entirely. This
-- file is kept rather than squashed because it is what production applied.
--
-- @live-proof: (SELECT count(*) = 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'idx_tournament_payouts_satellite_target' AND c.relkind = 'i')
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';

-- The index predicate must cover the query's predicate, or it is not an index.
DROP INDEX IF EXISTS public.idx_tournament_payouts_satellite_target;

CREATE INDEX idx_tournament_payouts_satellite_target
  ON public.tournament_payouts ((metadata->>'satellite_target_id'))
  INCLUDE (amount, tournament_id, "position")
  WHERE source IN ('satellite_seat', 'satellite_ticket');

COMMENT ON INDEX public.idx_tournament_payouts_satellite_target IS
  'Serves fn_tournament_conservation_delta''s seat_income term. The predicate must list every source that term matches: it was WHERE source = ''satellite_seat'' while the query asked for IN (''satellite_seat'',''satellite_ticket''), so the planner could not use it at all and read all 161,772 rows per tournament.';

DO $verify$
DECLARE
  v_plan text := '';
  r      record;
  v_t0   timestamptz;
  v_ms   numeric;
  v_n    integer;
BEGIN
  FOR r IN EXECUTE $q$
    EXPLAIN SELECT sum(sp.amount) FROM public.tournament_payouts sp
     WHERE sp.source IN ('satellite_seat','satellite_ticket')
       AND sp.metadata->>'satellite_target_id' = '00000000-0000-0000-0000-000000000000'
  $q$ LOOP
    v_plan := v_plan || r."QUERY PLAN" || E'\n';
  END LOOP;

  IF position('Seq Scan on tournament_payouts' in v_plan) > 0 THEN
    RAISE EXCEPTION 'failed: the satellite target lookup is still a sequential scan: %', v_plan;
  END IF;
  IF position('idx_tournament_payouts_satellite_target' in v_plan) = 0 THEN
    RAISE EXCEPTION 'failed: the widened index is not the one chosen: %', v_plan;
  END IF;

  -- And the function the three dead jobs call is affordable again. The hourly
  -- job budgets 120s for 200 tournaments, so 50 must be comfortably inside it.
  v_t0 := clock_timestamp();
  SELECT count(*) INTO v_n FROM (
    SELECT public.fn_tournament_conservation_delta(t.id)
      FROM public.tournaments t
     WHERE t.ended_at IS NOT NULL
     ORDER BY t.ended_at DESC
     LIMIT 50) s;
  v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;
  RAISE NOTICE 'conservation delta over % tournaments took % ms', v_n, round(v_ms);
  IF v_ms > 30000 THEN
    RAISE EXCEPTION 'failed: still % ms for 50 tournaments, which will not fit the job budget', round(v_ms);
  END IF;
END
$verify$;

COMMIT;
