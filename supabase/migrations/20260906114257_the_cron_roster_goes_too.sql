-- THE CRON ROSTER GOES TOO.
--
-- Dan: "WE AREN'T USING ANY CRONS TO 'MONITOR OR FIX' THATS A BANDAID, NOT A
-- HARD CODED SOLUTION" and "I WANT NOTHING BUT CODE BASE FIXES FOR ANY AND ALL
-- CHIP DRIFT ISSUES."
--
-- I removed the two bomb repair sweeps when he said that, and left behind the
-- thing I had built to watch over them: ca_expected_cron_jobs, a roster of every
-- scheduled job, and ca-cron-roster-watch-hourly, an hourly job that compares
-- the roster against cron.job and files an incident for anything missing.
--
-- It is a monitoring cron. It exists because a repair cron had vanished. The
-- repair crons are gone and the loss they were repairing is fixed in the write
-- itself, so this now watches over nothing, and it is exactly the shape of thing
-- Dan just said we do not add. It goes.
--
-- THE FINDING UNDERNEATH IT IS REAL AND IS KEPT IN PROSE, because deleting the
-- mechanism should not delete what it taught: migration 20260831112020 is
-- recorded as APPLIED in supabase_migrations.schema_migrations, and the cron job
-- it created - bomb-multi-winner-repair-hourly - was simply not in cron.job any
-- more. Something removes scheduled jobs that a migration created, and nothing
-- in the estate can currently see that happen, because every cron check measures
-- jobs that RUN AND FAIL and a job that no longer exists never fails.
--
-- That is written up in docs/changelog/2026-09-06-the-323-open-drift-incidents.md
-- and carried in the roadmap. If it costs us again, the answer is still not a
-- watcher cron - it is that whatever needs to happen every hour should not be a
-- cron in the first place.

BEGIN;

DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-cron-roster-watch-hourly') THEN
    PERFORM cron.unschedule('ca-cron-roster-watch-hourly');
  END IF;
END $unsched$;

DROP FUNCTION IF EXISTS public.fn_ca_cron_roster_watch();
DROP TABLE IF EXISTS public.ca_expected_cron_jobs;

-- Anything it managed to file before now goes with it.
UPDATE public.ca_drift_incidents
   SET status='resolved', resolved_at=now(),
       correction_ref='migration 20260906114257_the_cron_roster_goes_too',
       root_cause='Filed by a monitoring cron that has since been removed; it watched over repair crons that no longer exist because the loss they repaired is now fixed in the write itself.',
       resolution='Closed 2026-09-06 with the detector that raised it. Dan ruled that no cron '
         || 'monitors or repairs chip drift - the fix belongs in the write. The finding it was '
         || 'built around (a cron job created by an applied migration had vanished) is kept in '
         || 'docs/changelog/2026-09-06-the-323-open-drift-incidents.md.'
 WHERE status <> 'resolved' AND source = 'fn_ca_cron_roster_watch';

DELETE FROM public.ca_detector_registry WHERE source = 'fn_ca_cron_roster_watch';

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='ca-cron-roster-watch-hourly') THEN
    RAISE EXCEPTION 'the roster watch cron is still scheduled';
  END IF;
  IF to_regclass('public.ca_expected_cron_jobs') IS NOT NULL THEN
    RAISE EXCEPTION 'ca_expected_cron_jobs still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname ILIKE '%bomb%') THEN
    RAISE EXCEPTION 'a bomb repair cron is back';
  END IF;
  RAISE NOTICE 'CRON_ROSTER_REMOVED no watcher, no repair sweeps';
END $assert$;

COMMIT;
