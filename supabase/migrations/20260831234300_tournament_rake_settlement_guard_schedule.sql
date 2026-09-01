-- Schedule the tournament rake settlement guard, hourly at :19.
--
-- pg_cron, beside the sibling money-integrity audits (tourney_money_conservation
-- at :12, spin_fairness_check at :44, rake-attribution-drift-audit at :47,
-- tournament_chip_conservation at :49, spin_unpaid_check at :50). Pure SQL with
-- no HTTP surface, so Open Claw would need a net-new pages/api/cron/ file, which
-- World Hub CLAUDE.md 11.3 bans outright.
--
-- :19 had no hourly job on it. It also sits well clear of the :25-:32
-- maintenance trough where hand throughput measurably dips, and clear of :52,
-- where rake-repair-unbanked already runs -- this check reports, that one
-- repairs, and there is no reason for them to contend.
--
-- The 30-minute grace is not arbitrary. Settlement normally lands at or before
-- the moment ended_at is stamped (2,485 spins in the 24h before this shipped,
-- max lag under half a second), and the engine's own sweep runs every 10
-- minutes, so anything still unsettled at 30 minutes has had three chances.
--
-- The advisory lock is the house pattern: pg_cron will start a second copy of a
-- job whose previous run is still going.
DO $$
BEGIN
  PERFORM cron.unschedule('tournament_rake_settlement_check_hourly')
    WHERE EXISTS (SELECT 1 FROM cron.job
                   WHERE jobname = 'tournament_rake_settlement_check_hourly');

  PERFORM cron.schedule(
    'tournament_rake_settlement_check_hourly',
    '19 * * * *',
    $job$
    SELECT CASE
             WHEN pg_try_advisory_lock(hashtext('tournament_rake_settlement_check'))
               THEN (SELECT public.fn_tournament_rake_settlement_check(30, 7)::text)
             ELSE 'skipped: previous run still holding the lock'
           END;
    $job$);
END $$;

-- Prove the job exists and is active rather than trusting cron.schedule.
DO $$
DECLARE v_sched text; v_active boolean;
BEGIN
  SELECT schedule, active INTO v_sched, v_active
    FROM cron.job WHERE jobname = 'tournament_rake_settlement_check_hourly';
  IF v_sched IS NULL THEN
    RAISE EXCEPTION 'tournament_rake_settlement_check_hourly was not scheduled';
  END IF;
  IF v_sched <> '19 * * * *' THEN
    RAISE EXCEPTION 'tournament_rake_settlement_check_hourly is on % not 19 * * * *', v_sched;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'tournament_rake_settlement_check_hourly is scheduled but inactive';
  END IF;
END $$;
