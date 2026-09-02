-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831202716; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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
