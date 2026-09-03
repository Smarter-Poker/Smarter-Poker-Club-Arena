-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902002246; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- EVERY RAKED HAND DISTRIBUTES ITS RAKE TWICE
--
-- This is the leak the corrected supply measure exposed, and it is the largest
-- live money defect found in the whole zero-drift sweep.
--
-- atomic_distribute_rake writes TWO legs for one hand's rake and credits a
-- real balance for each:
--
--   club_accumulator -> club_wallets.chip_balance += (rake - bbj)
--   union_rake       -> union_wallets.rake_wallet += rake        (union game)
--   chip_treasury    -> clubs.chip_treasury      += rake        (club game)
--
-- Both destinations are spendable. club_wallets is not a tally: its
-- transaction log carries 46,991 commission_out rows and 49,590 negative
-- amounts, so agents are paid out of it. union_wallets and clubs.chip_treasury
-- are already inside the supply total.
--
-- MEASURED over 90 minutes on the live floor: rake collected 3,032.55, legs
-- distributed 5,770.40 - the distribution exceeds the collection by 2,737.85,
-- on 1,629 of 1,692 raked hands, at exactly 2.00 legs per hand. 2 x 3,032.55
-- minus BBJ lands on 5,770. One extra rake, minus BBJ, is created per raked
-- hand: roughly 1,800 chips an hour, 40,000 a day.
--
-- Hand-level settlement is NOT the culprit and was ruled out first: across
-- 1,690 raked hands the winners receive pot minus rake and the net is -293.97,
-- so nothing is created when the pot is paid. The chips are created afterwards,
-- when the same rake is banked into two places.
--
-- THIS MIGRATION DOES NOT CHANGE THE SPLIT. Deciding whether the club's share
-- comes OUT of the union's rake or sits alongside it is a commercial ruling,
-- not an engineering one, and rewriting a money path used by every hand on the
-- floor on my own authority is precisely what CLAUDE.md 11.5 forbids. What it
-- does is make the invariant permanent and impossible to lose again:
--
--     the legs for a hand must SUM to the rake taken from the pot
--
-- That holds whatever split Dan chooses. Today it is violated on 96% of raked
-- hands, so the ratchet is seeded at the current count and can only improve.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_rake_distribution_mismatch(
  p_window interval DEFAULT '60 minutes'::interval
)
RETURNS TABLE(hand_id uuid, rake numeric, distributed numeric, excess numeric, legs bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
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
     -- a cent of rounding across legs is not a defect
     AND COALESCE(l.total, 0) > rr.rake_amount + 0.01
   ORDER BY COALESCE(l.total, 0) - rr.rake_amount DESC;
$fn$;

COMMENT ON FUNCTION public.fn_ca_rake_distribution_mismatch(interval) IS
  'Hands whose rake_distribution_legs sum to MORE than the rake taken from the pot. The legs must sum to the rake whatever the club/union split is; today atomic_distribute_rake banks the same rake to both club_wallets and the union rake wallet (or club treasury), creating roughly one extra rake per hand.';

REVOKE ALL ON FUNCTION public.fn_ca_rake_distribution_mismatch(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_distribution_mismatch(interval) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_distribution_mismatch_count()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT count(*)::int FROM public.fn_ca_rake_distribution_mismatch('60 minutes'::interval);
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_rake_distribution_mismatch_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_distribution_mismatch_count() TO service_role;

INSERT INTO public.ca_ratchet_baselines (ratchet, baseline, note)
SELECT 'rake_distributed_exceeds_collected_1h',
       public.fn_ca_rake_distribution_mismatch_count(),
       'Raked hands in the last hour whose distribution legs sum to more than the rake taken from the pot. atomic_distribute_rake banks the same rake twice - club_wallets.chip_balance += rake-bbj AND union_wallets.rake_wallet += rake (or clubs.chip_treasury += rake). Roughly one extra rake per hand, ~1,800/hour. Awaiting Dan''s ruling on the intended club/union split; the invariant holds whatever he chooses. Seeded at the current rate so it can only improve.'
ON CONFLICT (ratchet) DO NOTHING;

