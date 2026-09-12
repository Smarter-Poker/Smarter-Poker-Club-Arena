-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905074151; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905074151   (the stamp IS the apply time, UTC: 2026-09-05 07:41:51)
--   name        a_claimed_night_that_produced_nothing_is_loud
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2628 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905074151 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_horse_job_health
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

CREATE OR REPLACE FUNCTION public.fn_horse_job_health(p_days integer DEFAULT 14)
RETURNS TABLE(
  job text,
  run_date date,
  claimed_by text,
  claimed_at timestamptz,
  rows_produced bigint,
  hollow boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH claims AS (
    SELECT r.job, r.run_date, r.claimed_by, r.claimed_at
      FROM public.horse_job_runs r
     WHERE r.run_date >= (now() AT TIME ZONE 'utc')::date - GREATEST(COALESCE(p_days, 14), 1)
  )
  SELECT c.job,
         c.run_date,
         c.claimed_by,
         c.claimed_at,
         COALESCE(e.n, 0) AS rows_produced,
         COALESCE(e.n, 0) = 0 AS hollow
    FROM claims c
    LEFT JOIN LATERAL (
      SELECT CASE c.job
        WHEN 'self_tuner' THEN
          (SELECT count(*) FROM public.horse_self_tune_log l WHERE l.run_date = c.run_date)
        WHEN 'daily_audit' THEN
          (SELECT count(*) FROM public.horse_daily_audit a WHERE a.day = c.run_date)
        WHEN 'league' THEN
          (SELECT count(*) FROM public.horse_league_results g WHERE g.run_date = c.run_date)
        WHEN 'league_pm' THEN
          (SELECT count(*) FROM public.horse_league_results g WHERE g.run_date = c.run_date)
        WHEN 'claude_daily_analysis' THEN
          (SELECT count(*) FROM public.horse_daily_audit a
            WHERE a.day = c.run_date AND a.agent_analyzed_at IS NOT NULL)
        ELSE NULL
      END AS n
    ) e ON true
   ORDER BY c.run_date DESC, c.job;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_job_health(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_job_health(integer) TO service_role;

COMMENT ON FUNCTION public.fn_horse_job_health(integer) IS
  'Every nightly horse job claim joined to the rows that night actually produced. hollow = claimed and produced nothing, which horse_job_runs alone cannot tell you. Read-only; refuses nothing.';

DO $verify$
DECLARE
  v_hollow integer;
  v_total  integer;
BEGIN
  SELECT count(*) FILTER (WHERE hollow), count(*)
    INTO v_hollow, v_total
    FROM public.fn_horse_job_health(20)
   WHERE job = 'self_tuner';

  IF v_total = 0 THEN
    RAISE EXCEPTION 'fn_horse_job_health returned no self_tuner rows - the join is wrong';
  END IF;

  RAISE NOTICE 'self_tuner: % of % claimed nights produced nothing', v_hollow, v_total;

  IF NOT EXISTS (
    SELECT 1 FROM public.fn_horse_job_health(20)
     WHERE job = 'self_tuner' AND run_date = DATE '2026-09-02' AND hollow
  ) THEN
    RAISE EXCEPTION '2026-09-02 is known to have produced zero tunes and did not come back hollow';
  END IF;
END
$verify$;
