-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905084008; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905084008   (the stamp IS the apply time, UTC: 2026-09-05 08:40:08)
--   name        a_night_that_never_claimed_is_louder_than_a_hollow_one
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3613 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905084008 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_horse_job_health
--     DROP           FUNCTION public.fn_horse_job_health
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

DROP FUNCTION IF EXISTS public.fn_horse_job_health(integer);

CREATE OR REPLACE FUNCTION public.fn_horse_job_health(p_days integer DEFAULT 14)
RETURNS TABLE(
  job text,
  run_date date,
  status text,
  claimed_by text,
  claimed_at timestamptz,
  rows_produced bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH days AS (
    SELECT d::date AS run_date
      FROM generate_series(
             (now() AT TIME ZONE 'utc')::date - GREATEST(COALESCE(p_days, 14), 1),
             (now() AT TIME ZONE 'utc')::date - 1,
             interval '1 day') d
  ),
  jobs(job) AS (
    VALUES ('self_tuner'), ('daily_audit'), ('league'), ('league_pm'),
           ('claude_daily_analysis')
  ),
  expected AS (
    SELECT j.job, d.run_date FROM jobs j CROSS JOIN days d
  )
  SELECT e.job,
         e.run_date,
         CASE
           WHEN r.job IS NULL          THEN 'absent'
           WHEN COALESCE(v.n, 0) = 0   THEN 'hollow'
           ELSE 'ok'
         END AS status,
         r.claimed_by,
         r.claimed_at,
         COALESCE(v.n, 0) AS rows_produced
    FROM expected e
    LEFT JOIN public.horse_job_runs r
      ON r.job = e.job AND r.run_date = e.run_date
    LEFT JOIN LATERAL (
      SELECT CASE e.job
        WHEN 'self_tuner' THEN
          (SELECT count(*) FROM public.horse_self_tune_log l WHERE l.run_date = e.run_date)
        WHEN 'daily_audit' THEN
          (SELECT count(*) FROM public.horse_daily_audit a WHERE a.day = e.run_date)
        WHEN 'league' THEN
          (SELECT count(*) FROM public.horse_league_results g WHERE g.run_date = e.run_date)
        WHEN 'league_pm' THEN
          (SELECT count(*) FROM public.horse_league_results g WHERE g.run_date = e.run_date)
        WHEN 'claude_daily_analysis' THEN
          (SELECT count(*) FROM public.horse_daily_audit a
            WHERE a.day = e.run_date AND a.agent_analyzed_at IS NOT NULL)
        ELSE NULL
      END AS n
    ) v ON true
   ORDER BY e.run_date DESC, e.job;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_job_health(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_job_health(integer) TO service_role;

COMMENT ON FUNCTION public.fn_horse_job_health(integer) IS
  'Every expected nightly horse job night, with status ok / hollow (claimed, produced nothing) / absent (never claimed - a dead scheduler, which iterating the claim table cannot see). Read-only; refuses nothing.';

DO $verify$
DECLARE
  v_absent integer; v_hollow integer; v_ok integer;
BEGIN
  SELECT count(*) FILTER (WHERE status = 'absent'),
         count(*) FILTER (WHERE status = 'hollow'),
         count(*) FILTER (WHERE status = 'ok')
    INTO v_absent, v_hollow, v_ok
    FROM public.fn_horse_job_health(10);
  RAISE NOTICE 'job health over 10 days: % ok, % hollow, % absent', v_ok, v_hollow, v_absent;

  IF NOT EXISTS (SELECT 1 FROM public.fn_horse_job_health(10)
     WHERE job='daily_audit' AND run_date=DATE '2026-09-03' AND status='absent') THEN
    RAISE EXCEPTION 'daily_audit 2026-09-03 never claimed and did not read absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fn_horse_job_health(10)
     WHERE job='self_tuner' AND run_date=DATE '2026-09-02' AND status='hollow') THEN
    RAISE EXCEPTION 'self_tuner 2026-09-02 claimed and produced nothing but did not read hollow';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fn_horse_job_health(10)
     WHERE job='self_tuner' AND run_date=DATE '2026-09-04' AND status='ok') THEN
    RAISE EXCEPTION 'self_tuner 2026-09-04 wrote 386 tunes but did not read ok';
  END IF;
END
$verify$;
