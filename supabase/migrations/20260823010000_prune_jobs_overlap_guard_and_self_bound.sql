-- 20260823010000_prune_jobs_overlap_guard_and_self_bound.sql
--
-- Companion to 20260822230941_autovacuum_tuning_hot_write_tables.sql. That one
-- fixed the damage (nothing was reclaiming dead tuples). This one fixes the
-- thing doing the damage.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG WITH THE TWO PRUNE JOBS
-- ─────────────────────────────────────────────────────────────────────────────
-- job 117  sp_prune_hand_history_10m        */5  * * * *   sp_prune_hand_history(4000)
-- job 119  sp_prune_hand_state_snapshots_2m */2  * * * *   sp_prune_hand_state_snapshots(5000)
--
-- 1. NO OVERLAP GUARD. Scheduled every 5 and every 2 minutes while single runs
--    took 38-155 s. pg_cron will happily start a second copy of a job whose
--    previous run is still going, so copies stacked and pinned the disk. The
--    house already had the fix for this — job 76 grew an advisory-lock guard on
--    2026-08-16 — but it was never applied to these two.
--
-- 2. NO SELF-BOUND, SO RUNS ROLLED BACK. A run that exceeded the 2 min role
--    statement_timeout was cancelled. sp_prune_hand_history does its work as
--    UPDATE-then-DELETE in ONE statement, so a cancelled run committed nothing
--    while still leaving up to p_batch dead tuples behind. Verified on
--    production: 400,000 sampled hand_history rows had has_human set on ZERO of
--    them. The job had been running every 5 minutes and had never pruned a row.
--
--    cron.job_run_details for job 117 showed the two failure shapes together:
--      23:05  failed     00:00:10  "job startup timeout"   <- could not even connect
--      23:00  succeeded  00:01:41
--      22:55  failed     00:00:10  "job startup timeout"
--      22:45  succeeded  00:01:37
--
-- Together: manufacture garbage forever, reclaim nothing, get slower each run.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FIX
-- ─────────────────────────────────────────────────────────────────────────────
-- a) pg_try_advisory_lock overlap guard, matching the job-76 house pattern. The
--    lock is session-scoped and released when the run ends, including on error,
--    so it cannot wedge the schedule the way a table-based lock can.
-- b) SET LOCAL statement_timeout = 30s inside the run, so ONE run can never
--    monopolise I/O again regardless of how the data grows. This is the
--    backstop: even if a future change makes the prune slow again, it is capped.
-- c) Batch sizes measured to finish well inside that cap, so work COMMITS
--    instead of rolling back.
-- d) Cadence halved, because a run that actually commits does not need to be
--    retried every other minute.
--
-- MEASURED ON PRODUCTION AFTER THE AUTOVACUUM FIX, BEFORE CHOOSING BATCHES:
--   sp_prune_hand_history(1000)        ->  1,000 rows in  3.0 s
--   sp_prune_hand_history(5000)        ->  3,399 rows in 11.0 s
--   sp_prune_hand_state_snapshots(2000)->  2,000 rows in  5.5 s
-- 11 s against a 30 s cap leaves ~3x headroom.
--
-- Idempotent: jobs are looked up by name, and cron.alter_job is a no-op-safe
-- upsert of the fields given. Retention semantics are UNCHANGED — this migration
-- does not touch either prune function, only how they are scheduled and bounded.

DO $$
DECLARE
  v_job_hh   bigint;
  v_job_snap bigint;
BEGIN
  SELECT jobid INTO v_job_hh   FROM cron.job WHERE jobname = 'sp_prune_hand_history_10m';
  SELECT jobid INTO v_job_snap FROM cron.job WHERE jobname = 'sp_prune_hand_state_snapshots_2m';

  IF v_job_hh IS NULL THEN
    RAISE EXCEPTION 'cron job sp_prune_hand_history_10m not found - refusing to continue';
  END IF;
  IF v_job_snap IS NULL THEN
    RAISE EXCEPTION 'cron job sp_prune_hand_state_snapshots_2m not found - refusing to continue';
  END IF;

  PERFORM cron.alter_job(
    v_job_hh,
    schedule := '*/10 * * * *',
    active   := true,
    command  := $cmd$
select case
         when pg_try_advisory_lock(hashtext('sp-prune-hand-history'))
           then (select set_config('statement_timeout','30s',true) is not null
                    and public.sp_prune_hand_history(5000) >= 0)::text
         else 'skipped: previous run still in progress'
       end;
$cmd$);

  PERFORM cron.alter_job(
    v_job_snap,
    schedule := '*/5 * * * *',
    active   := true,
    command  := $cmd$
select case
         when pg_try_advisory_lock(hashtext('sp-prune-hand-state-snapshots'))
           then (select set_config('statement_timeout','30s',true) is not null
                    and public.sp_prune_hand_state_snapshots(2000) >= 0)::text
         else 'skipped: previous run still in progress'
       end;
$cmd$);
END $$;

-- Post-apply assertions: both jobs must be active, guarded, and self-bounded.
-- An unguarded prune is what took the platform down, so a silent partial apply
-- must fail loudly rather than look like success.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT jobname, active, command
      FROM cron.job
     WHERE jobname IN ('sp_prune_hand_history_10m', 'sp_prune_hand_state_snapshots_2m')
  LOOP
    IF NOT r.active THEN
      RAISE EXCEPTION 'prune job % is not active', r.jobname;
    END IF;
    IF r.command NOT LIKE '%pg_try_advisory_lock%' THEN
      RAISE EXCEPTION 'prune job % has no overlap guard', r.jobname;
    END IF;
    IF r.command NOT LIKE '%statement_timeout%' THEN
      RAISE EXCEPTION 'prune job % has no statement_timeout self-bound', r.jobname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM cron.job
       WHERE jobname IN ('sp_prune_hand_history_10m','sp_prune_hand_state_snapshots_2m')) <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 prune jobs';
  END IF;
END $$;

-- ROLLBACK (restores the pre-incident configuration - do not use)
--   select cron.alter_job(
--     (select jobid from cron.job where jobname='sp_prune_hand_history_10m'),
--     schedule := '*/5 * * * *',
--     command  := 'select public.sp_prune_hand_history(4000)');
--   select cron.alter_job(
--     (select jobid from cron.job where jobname='sp_prune_hand_state_snapshots_2m'),
--     schedule := '*/2 * * * *',
--     command  := 'select public.sp_prune_hand_state_snapshots(5000)');
