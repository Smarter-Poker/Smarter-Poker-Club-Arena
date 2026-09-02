-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902002506; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Adding the rake-distribution ratchet pushed fn_ca_ratchet_watch to 46
-- seconds. This is the third time today an hourly watcher has grown too
-- expensive, so the lesson is written down rather than re-learned: a ratchet
-- reports whether the floor MOVED. It does not need to re-audit an hour of
-- hands to do that.
--
-- The metric is a PERCENTAGE, and ~190 raked hands land every ten minutes,
-- which is a large enough sample for a rate that currently reads 96. Ten
-- minutes costs a sixth of the scan and answers the same question.

CREATE OR REPLACE FUNCTION public.fn_ca_rake_distribution_mismatch_count()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE(
    round(100.0 * count(*) FILTER (
            WHERE COALESCE(l.total, 0) > rr.rake_amount + 0.01)
          / NULLIF(count(*), 0))::int, 0)
    FROM public.rake_records rr
    LEFT JOIN LATERAL (
      SELECT round(sum(amount), 2) AS total
        FROM public.rake_distribution_legs dl
       WHERE dl.leg_key = rr.hand_id
    ) l ON true
   WHERE rr.created_at > now() - interval '10 minutes'
     AND rr.hand_id IS NOT NULL
     AND rr.rake_amount > 0;
$fn$;

COMMENT ON FUNCTION public.fn_ca_rake_distribution_mismatch_count() IS
  'Percent of raked hands in the last TEN MINUTES whose distribution legs sum to more than the rake collected. A rate, not a headcount, sampled over a window big enough to be stable (~190 hands) and small enough to run hourly. Use fn_ca_rake_distribution_mismatch(interval) to read the hands themselves.';

REVOKE ALL ON FUNCTION public.fn_ca_rake_distribution_mismatch_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_distribution_mismatch_count() TO service_role;

UPDATE public.ca_ratchet_baselines
   SET baseline = GREATEST(public.fn_ca_rake_distribution_mismatch_count(), baseline),
       tightened_at = now()
 WHERE ratchet = 'rake_distributed_exceeds_collected_1h';

