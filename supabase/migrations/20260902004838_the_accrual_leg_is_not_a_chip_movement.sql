-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902004838; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- After the_club_share_comes_from_the_rake_treasury_weekly, the two legs no
-- longer mean the same thing:
--
--   union_rake / chip_treasury -> a real credit; chips arrive here
--   club_accumulator           -> an ACCRUAL record of what the club earned
--                                 toward Friday's settlement; no chips move
--
-- So "the legs must sum to the rake" stopped being the right invariant the
-- moment the ruling was applied, and the detector kept firing on hands that
-- are now correct - 34 of 44 in the two minutes after the fix. A detector that
-- reports a defect that has been fixed is the same disease as one that misses
-- a real defect: both teach people to stop reading it.
--
-- Verified before rewriting it, over 25 seconds of live play: club_wallets
-- moved 0.00 while the union rake wallet took 3.35 against 4.25 collected.
-- One destination, as ruled.
--
-- The invariant now measures the money: the legs that MOVE chips must sum to
-- the rake taken from the pot. The accrual leg is excluded by name.

CREATE OR REPLACE FUNCTION public.fn_ca_rake_distribution_mismatch(
  p_window interval DEFAULT '60 minutes'::interval
)
RETURNS TABLE(hand_id uuid, rake numeric, distributed numeric, excess numeric, legs bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT rr.hand_id,
         round(rr.rake_amount, 2),
         COALESCE(l.total, 0),
         round(COALESCE(l.total, 0) - rr.rake_amount, 2),
         COALESCE(l.n, 0)
    FROM public.rake_records rr
    LEFT JOIN LATERAL (
      SELECT round(sum(amount), 2) AS total, count(*) AS n
        FROM public.rake_distribution_legs dl
       WHERE dl.leg_key = rr.hand_id
         -- club_accumulator accrues the club's weekly share; it moves no chips
         AND dl.leg <> 'club_accumulator'
    ) l ON true
   WHERE rr.created_at > now() - p_window
     AND rr.hand_id IS NOT NULL
     AND rr.rake_amount > 0
     AND COALESCE(l.total, 0) > rr.rake_amount + 0.01
   ORDER BY COALESCE(l.total, 0) - rr.rake_amount DESC;
$fn$;

COMMENT ON FUNCTION public.fn_ca_rake_distribution_mismatch(interval) IS
  'Hands where the CHIP-MOVING rake legs sum to more than the rake taken from the pot. club_accumulator is excluded: since the 2026-09-02 ruling it records the club share accruing toward the weekly settlement and moves no chips. Whatever the split, the legs that move money must sum to the rake.';

REVOKE ALL ON FUNCTION public.fn_ca_rake_distribution_mismatch(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_distribution_mismatch(interval) TO service_role;

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
         AND dl.leg <> 'club_accumulator'
    ) l ON true
   WHERE rr.created_at > now() - interval '10 minutes'
     AND rr.hand_id IS NOT NULL
     AND rr.rake_amount > 0;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_rake_distribution_mismatch_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_distribution_mismatch_count() TO service_role;

UPDATE public.ca_ratchet_baselines
   SET baseline = public.fn_ca_rake_distribution_mismatch_count(),
       tightened_at = now(),
       note = 'PERCENT of raked hands whose CHIP-MOVING legs sum to more than the rake collected. Was ~96 while atomic_distribute_rake banked the same rake to both club_wallets and the rake treasury; Dan ruled 2026-09-02 that the club share is paid weekly from the treasury, the per-hand credit was removed, and club_wallets went flat on live traffic. Baseline 0: any rise means a rake is being banked twice again.'
 WHERE ratchet = 'rake_distributed_exceeds_collected_1h';

