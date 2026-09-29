-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904184236; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904184236   (the stamp IS the apply time, UTC: 2026-09-04 18:42:36)
--   name        the_cron_fleet_is_on_a_gauge
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2820 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904184236 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_cron_fleet_health
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_cron_fleet_health(p_window_minutes integer DEFAULT 60)
RETURNS TABLE (
  pg_cron_jobs            bigint,
  pg_cron_active          bigint,
  pg_cron_runs            bigint,
  pg_cron_failures        bigint,
  openclaw_jobs           bigint,
  openclaw_stale          bigint,
  openclaw_worst_silence_minutes numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, cron, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM cron.job),
    (SELECT count(*) FROM cron.job WHERE active),
    (SELECT count(*) FROM cron.job_run_details
      WHERE start_time > now() - make_interval(mins => greatest(p_window_minutes, 1))),
    (SELECT count(*) FROM cron.job_run_details
      WHERE start_time > now() - make_interval(mins => greatest(p_window_minutes, 1))
        AND status <> 'succeeded'),
    (SELECT count(*) FROM public.v_openclaw_job_staleness),
    (SELECT count(*) FROM public.v_openclaw_job_staleness WHERE is_stale),
    (SELECT round(max(silent_minutes), 1) FROM public.v_openclaw_job_staleness)
$$;

COMMENT ON FUNCTION public.fn_cron_fleet_health(integer) IS
  'pg_cron and Open Claw fleet health for the engine Prometheus gauges. Measures FAILURES and SILENCE, both unambiguous. Deliberately does not report "never run": cron.job records no creation time, so a NULL last_run cannot be told apart from a job not yet due - which is why fn_uncollected_entry_check could sit in financial_alerts saying its own silence means nothing. On 2026-09-04 four Open Claw jobs were stale, the worst silent for 18.3 days, and v_openclaw_job_staleness had been computing that with nothing reading it.';

REVOKE ALL ON FUNCTION public.fn_cron_fleet_health(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_cron_fleet_health(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_cron_fleet_health(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cron_fleet_health(integer) TO service_role;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_cron_fleet_health(60);

  IF r IS NULL OR r.pg_cron_jobs IS NULL THEN
    RAISE EXCEPTION 'post-condition failed: fn_cron_fleet_health returned no row';
  END IF;

  IF r.pg_cron_jobs < 50 THEN
    RAISE EXCEPTION
      'post-condition failed: only % pg_cron jobs visible; 125 were live when this was written.', r.pg_cron_jobs;
  END IF;

  IF r.openclaw_jobs < 10 THEN
    RAISE EXCEPTION
      'post-condition failed: only % Open Claw jobs visible; 69 were live when this was written.', r.openclaw_jobs;
  END IF;

  RAISE NOTICE 'cron fleet: % pg_cron jobs (% active), % runs / % failures in 60m; % Open Claw jobs, % stale, worst silence % min.',
    r.pg_cron_jobs, r.pg_cron_active, r.pg_cron_runs, r.pg_cron_failures,
    r.openclaw_jobs, r.openclaw_stale, r.openclaw_worst_silence_minutes;
END $$;
