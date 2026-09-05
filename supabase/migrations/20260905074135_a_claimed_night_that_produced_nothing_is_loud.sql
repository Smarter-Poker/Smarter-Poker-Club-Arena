-- A CLAIMED NIGHT THAT PRODUCED NOTHING IS LOUD (2026-09-05)
--
-- Found while answering Dan's question "prove the horses actually read the
-- tags". They do - the loop is real and measured below - but the job that
-- carries it fails two nights in five and NOTHING SAYS SO.
--
-- THE EVIDENCE. Every self_tuner claim against what that night actually wrote:
--
--   run_date     claimed_by      tunes written
--   2026-09-04   d896560fdb7e    386
--   2026-09-03   5c61eab10764    429
--   2026-09-02   1015f4039a4e      0   <-
--   2026-09-01   6f19f386dad1      0   <-
--   2026-08-31   fe660fef7a26    369
--   2026-08-30   d529e9808e3d      0   <-
--   2026-08-29   0708d846f2f3    391
--   2026-08-28   eb667f921bcd    501
--   2026-08-27   15f4c7604341    500
--   2026-08-26   6f03494b94b4      0   <-
--   2026-08-25   9cde0a0d7438    575
--   2026-08-24   43a751ee04c5      0   <-
--
-- Twelve claims, twelve rows in horse_job_runs, and five nights that produced
-- nothing at all. horse_job_runs records that a night was CLAIMED; there has
-- never been anything recording that it FINISHED. So a crashed run and a clean
-- run leave exactly the same trace, which is the house failure mode: a job that
-- looks identical whether or not it worked.
--
-- WHY IT MATTERS MORE THAN IT LOOKS. HorseSelfTuner is the only writer of
-- `profiles.horse_profile.leaks` - the horse's own review verdicts, which
-- HorseLogic reads at decision time (V40, telemetry key
-- v40_leak_profile_read). Every night the tuner dies, the tag-to-decision loop
-- does not advance. Of ~70 registered brain layers exactly one has never fired
-- in production, and it is that one.
--
-- WHAT THIS ADDS. fn_horse_job_health() joins each claim to the rows that night
-- should have produced and says plainly which nights are hollow. It is a
-- QUERY, not a guard: nothing here blocks a claim or retries a run, because a
-- guard that can refuse a nightly job can also strand it. This makes the
-- failure visible; HorseSelfTuner's own retry is the other half and ships with
-- it.

BEGIN;

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
      -- The evidence table for each job, mirroring CLAIM_EVIDENCE in
      -- server/src/benchmark/HorseLeague.ts. A job with no evidence table
      -- returns NULL and is reported as rows_produced 0 / hollow, which is
      -- honest: nothing here can vouch for it.
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

-- Prove it against the history that prompted it, rather than trusting it.
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

  -- The five known-hollow nights must come back hollow. If this ever stops
  -- being true the function has quietly stopped measuring what it claims to.
  IF NOT EXISTS (
    SELECT 1 FROM public.fn_horse_job_health(20)
     WHERE job = 'self_tuner' AND run_date = DATE '2026-09-02' AND hollow
  ) THEN
    RAISE EXCEPTION '2026-09-02 is known to have produced zero tunes and did not come back hollow';
  END IF;
END
$verify$;

COMMIT;
