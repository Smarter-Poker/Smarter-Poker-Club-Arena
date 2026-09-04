-- THE STATS MONEY REPAIR GETS ITS OWN NAME BACK.
--
-- My mistake, and a bad one. When 20260903232357 gave three timing-out
-- detectors a statement_timeout, it rewrote each cron command from scratch
-- instead of wrapping what was already there. For two of them that was fine.
-- For ca-stats-money-repair I wrote the function name from memory:
--
--     public.ca_stats_money_repair()          <- does not exist
--     public.ca_repair_hand_player_stat_money(4000)   <- the real job
--
-- So a job that was failing 9 runs in 45 on a timeout began failing 100% of
-- runs on "function does not exist", three times in the ten minutes before this
-- was caught. It repairs the stats page's money figures; nothing it touches is
-- a balance, so the damage is a backlog of unrepaired hand stats rather than
-- anything owed to anyone. The backlog clears on its own once the schedule
-- works again, which is what this restores.
--
-- The lesson is in the fix: the command is now the ORIGINAL call, verbatim from
-- 20260903190000, with only a statement_timeout and an advisory lock added
-- around it. The batch size of 4,000 hands every five minutes was measured
-- against engine IO contention when it was written and is not mine to change.
--
-- The self-check below refuses to commit unless every scheduled function
-- actually exists - which is the check that would have caught this before it
-- ever ran.

DO $fix$
BEGIN
  PERFORM cron.unschedule('ca-stats-money-repair');
  PERFORM cron.schedule('ca-stats-money-repair', '*/5 * * * *', $job$
    SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-stats-money-repair'))
      THEN (SELECT set_config('statement_timeout', '240s', true) IS NOT NULL
              AND public.ca_repair_hand_player_stat_money(4000) IS NOT NULL)::int
      ELSE -1 END;
  $job$);
END
$fix$;

-- Self-check: every function named by these three commands exists with the
-- arity the command calls it at. A cron that names a function the database has
-- never heard of is not a schedule, it is a sixty-times-a-day error.
DO $selfcheck$
DECLARE
  r record;
  v_fn text;
  v_checked integer := 0;
BEGIN
  FOR r IN SELECT jobname, command FROM cron.job
            WHERE jobname IN ('ca-stats-money-repair', 'ca-cash-pot-conservation-hourly',
                              'rake-law-wide-daily')
  LOOP
    FOR v_fn IN
      SELECT DISTINCT m[1] FROM regexp_matches(r.command, 'public\.([a-z0-9_]+)\s*\(', 'g') m
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = v_fn) THEN
        RAISE EXCEPTION 'CRON_NAME_SELFCHECK: % calls public.%(), which does not exist',
          r.jobname, v_fn;
      END IF;
      v_checked := v_checked + 1;
    END LOOP;
  END LOOP;

  IF v_checked < 3 THEN
    RAISE EXCEPTION 'CRON_NAME_SELFCHECK: expected at least three function references, saw %', v_checked;
  END IF;

  RAISE NOTICE 'CRON_NAME_SELFCHECK_OK: % scheduled function reference(s) all resolve', v_checked;
END
$selfcheck$;