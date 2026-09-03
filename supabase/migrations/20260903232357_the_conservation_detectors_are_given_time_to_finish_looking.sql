-- THE CONSERVATION DETECTORS ARE GIVEN TIME TO FINISH LOOKING.
--
-- Found in the pre-Phase-3 sweep, by running the repo's own cron-health gate
-- against production. Three scheduled jobs are timing out rather than failing
-- on their subject:
--
--   ca-cash-pot-conservation-hourly    8 failed of 24 runs
--   ca-stats-money-repair              9 failed of 45 runs
--   rake-law-wide-daily                1 failed of  1 run
--
-- Every failure is the same: "canceling statement due to statement timeout" on
-- a scan of hand history. None of them is a money bug. All three are detectors,
-- and a detector that times out is not raising a false alarm - it is not
-- looking at all. The cash-pot conservation check has been blind for a third of
-- the last day, which is the one of the three that watches chips.
--
-- The jobs were written without a statement_timeout, so they inherit the
-- database default while the tables they scan keep growing. Each is given a
-- budget suited to its cadence and wrapped exactly as its neighbours already
-- are: an advisory lock so a slow run is skipped rather than piled on, and the
-- same return shape.
--
-- This changes no money path. It changes how long three watchers are allowed to
-- watch for.

DO $fix$
BEGIN
  PERFORM cron.unschedule('ca-cash-pot-conservation-hourly');
  PERFORM cron.schedule('ca-cash-pot-conservation-hourly', '34 * * * *', $job$
    SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-cash-pot-conservation'))
      THEN (SELECT set_config('statement_timeout', '600s', true) IS NOT NULL
              AND (SELECT count(*) FROM public.fn_cash_pot_conservation_check()) >= 0)::int
      ELSE -1 END;
  $job$);

  PERFORM cron.unschedule('ca-stats-money-repair');
  PERFORM cron.schedule('ca-stats-money-repair', '*/5 * * * *', $job$
    SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-stats-money-repair'))
      THEN (SELECT set_config('statement_timeout', '240s', true) IS NOT NULL
              AND public.ca_stats_money_repair() IS NOT NULL)::int
      ELSE -1 END;
  $job$);

  PERFORM cron.unschedule('rake-law-wide-daily');
  PERFORM cron.schedule('rake-law-wide-daily', '50 7 * * *', $job$
    SELECT CASE WHEN pg_try_advisory_lock(hashtext('rake-law-wide'))
      THEN (SELECT set_config('statement_timeout', '900s', true) IS NOT NULL
              AND public.fn_rake_law_check('26 hours'::interval) IS NOT NULL)::int
      ELSE -1 END;
  $job$);
END
$fix$;

-- Self-check: all three are still scheduled, active, on their original cadence,
-- and now name a timeout.
DO $selfcheck$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  FOR r IN SELECT jobname, schedule, active, command FROM cron.job
            WHERE jobname IN ('ca-cash-pot-conservation-hourly', 'ca-stats-money-repair',
                              'rake-law-wide-daily')
  LOOP
    v_n := v_n + 1;
    IF NOT r.active THEN
      RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: % came back inactive', r.jobname;
    END IF;
    IF r.command NOT LIKE '%statement_timeout%' THEN
      RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: % has no statement_timeout', r.jobname;
    END IF;
    IF r.command NOT LIKE '%pg_try_advisory_lock%' THEN
      RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: % lost its advisory lock', r.jobname;
    END IF;
  END LOOP;

  IF v_n <> 3 THEN
    RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: expected 3 jobs, found %', v_n;
  END IF;

  IF (SELECT schedule FROM cron.job WHERE jobname = 'ca-cash-pot-conservation-hourly') <> '34 * * * *'
     OR (SELECT schedule FROM cron.job WHERE jobname = 'ca-stats-money-repair') <> '*/5 * * * *'
     OR (SELECT schedule FROM cron.job WHERE jobname = 'rake-law-wide-daily') <> '50 7 * * *' THEN
    RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: a cadence changed';
  END IF;

  RAISE NOTICE 'CRON_TIMEOUT_SELFCHECK_OK: three detectors keep their cadence and gain a timeout';
END
$selfcheck$;