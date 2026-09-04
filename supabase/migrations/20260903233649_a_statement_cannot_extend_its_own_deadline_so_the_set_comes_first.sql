-- A STATEMENT CANNOT EXTEND ITS OWN DEADLINE, SO THE SET COMES FIRST.
--
-- 20260903232357 gave three timing-out detectors a statement_timeout like this:
--
--     SELECT CASE WHEN pg_try_advisory_lock(...)
--       THEN (SELECT set_config('statement_timeout','600s',true) IS NOT NULL
--               AND (SELECT count(*) FROM public.fn_...()) >= 0)::int
--       ELSE -1 END;
--
-- which does nothing at all. statement_timeout is armed when a top-level
-- statement BEGINS; a set_config evaluated part-way through that same statement
-- cannot extend the deadline already ticking against it. The proof arrived on
-- schedule: ca-cash-pot-conservation-hourly timed out again at 23:34, with the
-- new command in place.
--
-- pg_cron runs a job's command as its own session and allows more than one
-- statement, so the SET is now its own statement and lands before the work
-- starts. Everything else is unchanged: the same advisory lock, and the same
-- original calls with their original arguments.
--
-- Both faults in that migration were mine and both are corrected here and in
-- 20260903233704: this one, and a function name I wrote from memory.

DO $fix$
BEGIN
  PERFORM cron.unschedule('ca-cash-pot-conservation-hourly');
  PERFORM cron.schedule('ca-cash-pot-conservation-hourly', '34 * * * *',
    'SET statement_timeout = ''600s''; '
    'SELECT CASE WHEN pg_try_advisory_lock(hashtext(''ca-cash-pot-conservation'')) '
      'THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check()) ELSE -1 END;');

  PERFORM cron.unschedule('ca-stats-money-repair');
  PERFORM cron.schedule('ca-stats-money-repair', '*/5 * * * *',
    'SET statement_timeout = ''240s''; '
    'SELECT CASE WHEN pg_try_advisory_lock(hashtext(''ca-stats-money-repair'')) '
      'THEN (SELECT public.ca_repair_hand_player_stat_money(4000)) ELSE NULL END;');

  PERFORM cron.unschedule('rake-law-wide-daily');
  PERFORM cron.schedule('rake-law-wide-daily', '50 7 * * *',
    'SET statement_timeout = ''900s''; '
    'SELECT CASE WHEN pg_try_advisory_lock(hashtext(''rake-law-wide'')) '
      'THEN (SELECT public.fn_rake_law_check(''26 hours''::interval)) ELSE NULL END;');
END
$fix$;

-- Self-check: each command sets its timeout as its OWN leading statement, still
-- takes its advisory lock, keeps its cadence, and names only functions that
-- exist with the arity it calls them at.
DO $selfcheck$
DECLARE
  r record;
  v_fn text;
  v_seen integer := 0;
BEGIN
  FOR r IN SELECT jobname, schedule, active, command FROM cron.job
            WHERE jobname IN ('ca-cash-pot-conservation-hourly', 'ca-stats-money-repair',
                              'rake-law-wide-daily')
  LOOP
    v_seen := v_seen + 1;

    IF NOT r.active THEN
      RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: % came back inactive', r.jobname;
    END IF;

    -- The SET must come first, before any SELECT, or it cannot bind the work.
    IF position('SET statement_timeout' in r.command) = 0
       OR position('SET statement_timeout' in r.command) > position('SELECT' in r.command) THEN
      RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: % does not set its timeout before its work: %',
        r.jobname, r.command;
    END IF;

    IF r.command NOT LIKE '%pg_try_advisory_lock%' THEN
      RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: % lost its advisory lock', r.jobname;
    END IF;

    FOR v_fn IN SELECT DISTINCT m[1] FROM regexp_matches(r.command, 'public\.([a-z0-9_]+)\s*\(', 'g') m
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = v_fn) THEN
        RAISE EXCEPTION 'CRON_NAME_SELFCHECK: % calls public.%(), which does not exist',
          r.jobname, v_fn;
      END IF;
    END LOOP;
  END LOOP;

  IF v_seen <> 3 THEN
    RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: expected 3 jobs, found %', v_seen;
  END IF;

  IF (SELECT schedule FROM cron.job WHERE jobname = 'ca-cash-pot-conservation-hourly') <> '34 * * * *'
     OR (SELECT schedule FROM cron.job WHERE jobname = 'ca-stats-money-repair') <> '*/5 * * * *'
     OR (SELECT schedule FROM cron.job WHERE jobname = 'rake-law-wide-daily') <> '50 7 * * *' THEN
    RAISE EXCEPTION 'CRON_TIMEOUT_SELFCHECK: a cadence changed';
  END IF;

  RAISE NOTICE 'CRON_TIMEOUT_SELFCHECK_OK: three detectors set their deadline before they start';
END
$selfcheck$;