-- Schedule the Spin fairness guard, hourly at :28.
--
-- pg_cron, beside the ten sibling money-integrity audits (spin_unpaid_check at
-- :50, rake-attribution-drift-audit at :47, tourney_money_conservation at :12,
-- union-integrity-sweep at :35). This is pure SQL with no HTTP surface, so
-- Open Claw would require a net-new pages/api/cron/ file, which World Hub
-- CLAUDE.md 11.3 bans outright.
--
-- :28 is unused by any existing job -- the audits are deliberately spread
-- across the hour so they never contend for the same buffers. The check costs
-- ~2.5s: three index scans of tournaments on idx_tournaments_variant, all
-- buffer hits, measured 2026-08-31.
--
-- The advisory lock is the house pattern: pg_cron will happily start a second
-- copy of a job whose previous run is still going. An overlap should be
-- impossible at 2.5s, but "should be impossible" is how refresh-player-stats
-- learned to take this lock too.
DO $$
BEGIN
  PERFORM cron.unschedule('spin_fairness_check_hourly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'spin_fairness_check_hourly');

  PERFORM cron.schedule(
    'spin_fairness_check_hourly',
    '28 * * * *',
    $job$
    SELECT CASE
             WHEN pg_try_advisory_lock(hashtext('spin_fairness_check'))
               THEN (SELECT public.fn_spin_fairness_check(7)::text)
             ELSE 'skipped: previous run still holding the lock'
           END,
           pg_advisory_unlock(hashtext('spin_fairness_check'));
    $job$);
END $$;

-- A schedule that silently did not register is the failure this whole class of
-- job is made of -- the Open Claw dispatcher once drifted six jobs behind the
-- repo because deploy-openclaw.sh had never once succeeded, and nobody knew.
DO $$
DECLARE
  v_sched  text;
  v_active boolean;
BEGIN
  SELECT schedule, active INTO v_sched, v_active
    FROM cron.job WHERE jobname = 'spin_fairness_check_hourly';

  IF v_sched IS NULL THEN
    RAISE EXCEPTION 'spin_fairness_check_hourly did not register in cron.job';
  END IF;
  IF v_sched <> '28 * * * *' THEN
    RAISE EXCEPTION 'spin_fairness_check_hourly registered with schedule %, expected 28 * * * *', v_sched;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'spin_fairness_check_hourly registered but is not active';
  END IF;
END $$;
