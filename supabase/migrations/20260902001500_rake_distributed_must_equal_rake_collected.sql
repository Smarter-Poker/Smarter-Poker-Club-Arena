-- ═══════════════════════════════════════════════════════════════════════════
-- EVERY RAKED HAND DISTRIBUTES ITS RAKE TWICE
--
-- The largest live money defect found in the whole zero-drift sweep, exposed
-- by correcting the supply measure (four_million_chips_were_outside_the_
-- supply_total).
--
-- atomic_distribute_rake writes TWO legs for one hand's rake and credits a
-- REAL balance for each:
--
--   club_accumulator -> club_wallets.chip_balance += (rake - bbj)
--   union_rake       -> union_wallets.rake_wallet += rake     (union game)
--   chip_treasury    -> clubs.chip_treasury      += rake      (club game)
--
-- Both destinations are spendable. club_wallets is not a tally: its
-- transaction log carries 46,991 commission_out rows and 49,590 negative
-- amounts, so agents are paid out of it. union_wallets and clubs.chip_treasury
-- are already inside the supply total.
--
-- MEASURED over 90 minutes on the live floor: rake collected 3,032.55, legs
-- distributed 5,770.40 - distribution exceeds collection by 2,737.85, on 1,629
-- of 1,692 raked hands, at exactly 2.00 legs per hand. 2 x 3,032.55 minus BBJ
-- lands on 5,770. One extra rake, minus BBJ, per raked hand: ~1,762 chips an
-- hour, ~40,000 a day.
--
-- Hand-level settlement was ruled out FIRST: across 1,690 raked hands the
-- winners receive pot minus rake and the net is -293.97, so nothing is created
-- when the pot is paid. The chips appear afterwards, when the same rake is
-- banked in two places.
--
-- THIS MIGRATION DOES NOT CHANGE THE SPLIT. Whether the club's share comes OUT
-- of the union's rake or sits alongside it is a commercial ruling, and
-- rewriting a money path used by every hand on the floor on my own authority
-- is what CLAUDE.md 11.5 forbids. What it does is make the invariant permanent:
--
--     the legs for a hand must SUM to the rake taken from the pot
--
-- which holds whatever split Dan chooses.
-- ═══════════════════════════════════════════════════════════════════════════

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
    ) l ON true
   WHERE rr.created_at > now() - p_window
     AND rr.hand_id IS NOT NULL
     AND rr.rake_amount > 0
     AND COALESCE(l.total, 0) > rr.rake_amount + 0.01
   ORDER BY COALESCE(l.total, 0) - rr.rake_amount DESC;
$fn$;

COMMENT ON FUNCTION public.fn_ca_rake_distribution_mismatch(interval) IS
  'Hands whose rake_distribution_legs sum to MORE than the rake taken from the pot. The legs must sum to the rake whatever the club/union split is.';

REVOKE ALL ON FUNCTION public.fn_ca_rake_distribution_mismatch(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_distribution_mismatch(interval) TO service_role;

-- A RATE, not a headcount. The first version counted mismatching hands per
-- hour; two consecutive reads gave 1,130 and 1,133, because the metric moved
-- with how busy the floor was, and it would have raised an incident on an
-- ordinary busy night. Ten minutes is ~190 raked hands: a stable sample, and a
-- sixth of the scan cost (the watch had grown to 46s; 25s after).
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
  'Percent of raked hands in the last TEN MINUTES whose distribution legs sum to more than the rake collected. A rate, sampled over a window big enough to be stable and small enough to run hourly.';

REVOKE ALL ON FUNCTION public.fn_ca_rake_distribution_mismatch_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_distribution_mismatch_count() TO service_role;

INSERT INTO public.ca_ratchet_baselines (ratchet, baseline, note)
SELECT 'rake_distributed_exceeds_collected_1h',
       public.fn_ca_rake_distribution_mismatch_count(),
       'PERCENT of raked hands whose distribution legs sum to more than the rake collected. atomic_distribute_rake banks the same rake twice. Measured 1,762.57 chips per hour created, ~40k/day. Awaiting Dan''s ruling on the intended club/union split; the invariant holds whatever he chooses.'
ON CONFLICT (ratchet) DO NOTHING;
