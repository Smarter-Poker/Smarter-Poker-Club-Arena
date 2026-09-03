-- 20260823050000_stagger_maintenance_jobs_off_the_same_minute.sql
--
-- Fixes a defect introduced by 20260823010000 / 20260823020000.
--
-- Those migrations gave each maintenance job an advisory-lock overlap guard,
-- which stops a job overlapping ITSELF. It does not stop two DIFFERENT jobs
-- starting on the same second and contending for the same disk.
--
-- The schedules chosen were */5 (snapshots prune), */10 (hand_history prune)
-- and */30 (self-test), so they align every 10 minutes and all three align
-- every 30. Measured on production:
--
--   02:20:00  snapshots prune  2.1 s   hand_history prune   7.0 s
--   02:30:00  snapshots prune 65.6 s   hand_history prune  78.3 s   selftest 26.9 s
--            ^ all three started at 02:30:00, and every duration blew up 10-30x
--
-- Same work, same batch sizes, an order of magnitude slower purely from
-- self-inflicted contention. That is the same failure mode as the outage this
-- whole series is fixing, at smaller scale, and it was mine.
--
-- Fix: offsets so no two jobs ever share a start minute.
--   hand_history prune : minute 3,13,23,33,43,53   (every 10 min)
--   snapshots prune    : minute 1,6,11,...,56      (every 5 min)
--   self-test          : minute 7,37               (every 30 min)
-- No minute appears in more than one list. Cadence and batch sizes unchanged.

DO $mig$
DECLARE
  v_hh   bigint;
  v_snap bigint;
  v_self bigint;
BEGIN
  SELECT jobid INTO v_hh   FROM cron.job WHERE jobname = 'sp_prune_hand_history_10m';
  SELECT jobid INTO v_snap FROM cron.job WHERE jobname = 'sp_prune_hand_state_snapshots_2m';
  SELECT jobid INTO v_self FROM cron.job WHERE jobname = 'db-saturation-selftest';

  IF v_hh IS NULL OR v_snap IS NULL OR v_self IS NULL THEN
    RAISE EXCEPTION 'expected all three maintenance jobs to exist (hh=% snap=% self=%)',
      v_hh, v_snap, v_self;
  END IF;

  PERFORM cron.alter_job(v_hh,   schedule := '3,13,23,33,43,53 * * * *');
  PERFORM cron.alter_job(v_snap, schedule := '1,6,11,16,21,26,31,36,41,46,51,56 * * * *');
  PERFORM cron.alter_job(v_self, schedule := '7,37 * * * *');
END $mig$;

-- Post-apply assertion: no start-minute may be shared by two of these jobs.
DO $assert$
DECLARE
  v_dupes int;
BEGIN
  WITH mins AS (
    SELECT j.jobname,
           unnest(string_to_array(split_part(j.schedule, ' ', 1), ','))::int AS m
      FROM cron.job j
     WHERE j.jobname IN ('sp_prune_hand_history_10m',
                         'sp_prune_hand_state_snapshots_2m',
                         'db-saturation-selftest')
  )
  SELECT count(*) INTO v_dupes
    FROM (SELECT m FROM mins GROUP BY m HAVING count(DISTINCT jobname) > 1) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION '% start-minute(s) are shared by more than one maintenance job', v_dupes;
  END IF;
END $assert$;

-- ROLLBACK (reintroduces the contention - do not use)
--   select cron.alter_job((select jobid from cron.job where jobname='sp_prune_hand_history_10m'),        schedule := '*/10 * * * *');
--   select cron.alter_job((select jobid from cron.job where jobname='sp_prune_hand_state_snapshots_2m'), schedule := '*/5 * * * *');
--   select cron.alter_job((select jobid from cron.job where jobname='db-saturation-selftest'),           schedule := '*/30 * * * *');
