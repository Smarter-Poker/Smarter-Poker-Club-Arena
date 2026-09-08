-- ============================================================================
--  THE SNAPSHOT PRUNER RUNS EVERY TWO MINUTES, AS ITS NAME HAS ALWAYS SAID
--
--  sp_prune_hand_state_snapshots_2m was scheduled at 1,6,11,...,56 - every FIVE
--  minutes. With 20260907222000 (completed snapshots kept 6 hours, not 7 days)
--  the pruner has ~3.3 M rows of backlog to drain at ~32,000 rows per 20s
--  run; measured 2026-09-08 01:55 it was clearing ~150k/hour on the 5-minute
--  cadence (contention brings a run below its rolled-back best), i.e. a day
--  to reach steady state. Every two minutes brings that to well under a day
--  and matches the name. Each run is bounded by its own 20s budget, so the
--  extra cadence adds at most ~10 s of work per minute to the database - and
--  only while the backlog lasts; at steady state (~530k rows/day, ~740/run)
--  a run finishes in well under a second.
-- ============================================================================
BEGIN;
SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'sp_prune_hand_state_snapshots_2m'), schedule := '1-59/2 * * * *');
DO $$
BEGIN
  IF (SELECT schedule FROM cron.job WHERE jobname='sp_prune_hand_state_snapshots_2m') <> '1-59/2 * * * *' THEN
    RAISE EXCEPTION 'the snapshot pruner is not on a two-minute cadence';
  END IF;
END $$;
COMMIT;
