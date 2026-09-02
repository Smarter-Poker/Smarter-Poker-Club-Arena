-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831195428; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Move the Spin fairness guard from :28 to :44.
--
-- :28 was a bad pick and the data says so. Normalising every minute against
-- its own hour's throughput over 16 hours of production:
--
--   minute 26-32   0.79 - 0.91 of the hour's average hand rate
--   minute 33-49   0.99 - 1.23
--
-- Minutes 25 to 32 are a pre-existing MAINTENANCE TROUGH, not something this
-- job caused: club-rake-rollup-catchup (:25), sp_prune_hand_state_snapshots
-- (:26, :31), hand-history-compact (:30) and hand-history-compact-vacuum (:32)
-- all land there, and hand_history is 3.6 GB. The dip is measurably DEEPER in
-- the hours before this job existed (0.791 at :28) than after it (0.912), so
-- the guard is not the cause -- but an hourly scan of `tournaments` has no
-- business adding to a window the database is already struggling through.
--
-- :44 is free of any existing pg_cron job and runs at 1.13x the hour's average
-- throughput. It also keeps this clear of the other audit cluster (:45 bbj
-- rollup, :47 rake attribution, :50 spin_unpaid_check).
--
-- The job itself is unchanged: same function, same 7-day window, same advisory
-- lock. Measured cost 2.2s to 7.6s per run.
DO $$
BEGIN
  PERFORM cron.unschedule('spin_fairness_check_hourly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'spin_fairness_check_hourly');

  PERFORM cron.schedule(
    'spin_fairness_check_hourly',
    '44 * * * *',
    $job$
    SELECT CASE
             WHEN pg_try_advisory_lock(hashtext('spin_fairness_check'))
               THEN (SELECT public.fn_spin_fairness_check(7)::text)
             ELSE 'skipped: previous run still holding the lock'
           END,
           pg_advisory_unlock(hashtext('spin_fairness_check'));
    $job$);
END $$;

DO $$
DECLARE
  v_sched  text;
  v_active boolean;
BEGIN
  SELECT schedule, active INTO v_sched, v_active
    FROM cron.job WHERE jobname = 'spin_fairness_check_hourly';

  IF v_sched IS NULL THEN
    RAISE EXCEPTION 'spin_fairness_check_hourly did not re-register in cron.job';
  END IF;
  IF v_sched <> '44 * * * *' THEN
    RAISE EXCEPTION 'spin_fairness_check_hourly registered with schedule %, expected 44 * * * *', v_sched;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'spin_fairness_check_hourly re-registered but is not active';
  END IF;

  -- Nothing else may share the minute, or the move just builds a new cluster.
  IF EXISTS (SELECT 1 FROM cron.job
              WHERE jobname <> 'spin_fairness_check_hourly'
                AND schedule = '44 * * * *') THEN
    RAISE EXCEPTION 'another job already runs at :44';
  END IF;
END $$;
