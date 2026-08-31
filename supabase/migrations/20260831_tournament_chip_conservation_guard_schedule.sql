-- Schedule the tournament chip conservation guard, hourly at :49.
--
-- pg_cron, beside the sibling money-integrity audits (spin_fairness_check at :44,
-- spin_unpaid_check at :50, rake-attribution-drift-audit at :47, rake-law-adherence
-- at :40, tourney_money_conservation at :12). This is pure SQL with no HTTP
-- surface, so Open Claw would need a net-new pages/api/cron/ file, which World Hub
-- CLAUDE.md 11.3 bans outright.
--
-- :49 was one of eleven minutes with no hourly job on it at all (8, 18, 19, 27,
-- 28, 29, 48, 49, 57, 58, 59), and it sits outside the :25-:32 maintenance trough
-- where hand throughput measurably dips. The check is two index scans of
-- tournaments plus the correlated seat counts, ~1.5s over a 6h window measured on
-- 1,317 games, 2026-08-31.
--
-- The advisory lock is the house pattern: pg_cron will happily start a second copy
-- of a job whose previous run is still going.
DO $$
BEGIN
  PERFORM cron.unschedule('tournament_chip_conservation_hourly')
    WHERE EXISTS (SELECT 1 FROM cron.job
                   WHERE jobname = 'tournament_chip_conservation_hourly');

  PERFORM cron.schedule(
    'tournament_chip_conservation_hourly',
    '49 * * * *',
    $job$
    SELECT CASE
             WHEN pg_try_advisory_lock(hashtext('tournament_chip_conservation'))
               THEN (SELECT public.fn_tournament_chip_conservation_check(6)::text)
             ELSE 'skipped: previous run still holding the lock'
           END;
    $job$);
END $$;

-- Prove the job actually exists and is active, rather than trusting cron.schedule.
DO $$
DECLARE v_sched text; v_active boolean;
BEGIN
  SELECT schedule, active INTO v_sched, v_active
    FROM cron.job WHERE jobname = 'tournament_chip_conservation_hourly';
  IF v_sched IS NULL THEN
    RAISE EXCEPTION 'tournament_chip_conservation_hourly was not scheduled';
  END IF;
  IF v_sched <> '49 * * * *' THEN
    RAISE EXCEPTION 'tournament_chip_conservation_hourly is on % not 49 * * * *', v_sched;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'tournament_chip_conservation_hourly is scheduled but inactive';
  END IF;
END $$;
