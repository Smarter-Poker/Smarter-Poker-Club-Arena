-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831232013; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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
