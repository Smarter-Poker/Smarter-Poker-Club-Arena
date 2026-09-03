-- ═══════════════════════════════════════════════════════════════════════════
-- THE RAKE ALARM HAD BLIND SPOTS BETWEEN ITS TIERS (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
-- Found by probing fn_effective_rake_cap while mirroring today's new schedule
-- rows into ca_rake_schedule. It is a defect in the alarm, not in the rake.
--
-- `ca_rake_tier` mirrors STAKES_TIERS, and each row carries min_bb and max_bb
-- copied from that table's `blindRange` documentation. fn_effective_rake_cap
-- then resolved a tier with BOTH bounds:
--
--     WHERE p_bb >= t.min_bb AND (t.max_bb IS NULL OR p_bb <= t.max_bb)
--
-- But getTierForBB in TypeScript is an UPPER-BOUND CASCADE with no floor and
-- no gaps:
--
--     if (bb <= 0.2)  nano;   if (bb <= 0.8) micro;  if (bb <= 3)  small;
--     if (bb <= 8)    mid;    if (bb <= 40)  high;   return nosebleeds;
--
-- The seeded min_bb values leave holes between every pair of tiers — nano ends
-- at 0.2 and micro starts at 0.3, small ends at 3.0 and mid starts at 3.5, mid
-- ends at 8.0 and high starts at 9.0, high ends at 40 and nosebleeds starts at
-- 41 — plus everything below 0.1. A stake in any hole matched NO tier and the
-- function returned NULL.
--
-- WHY THAT MATTERS: fn_rake_law_violations tests over_cap as
-- `WHERE cap IS NOT NULL AND rake > cap + 0.005`. A NULL cap is not a caught
-- violation, it is a SKIPPED one. The alarm was silently not watching those
-- stakes at all — and an alarm with a hole in it is worse than a missing
-- alarm, because it reports "no violations" for a stake it never examined.
--
-- Measured before the fix: fn_effective_rake_cap returned NULL for big blinds
-- 0.07, 0.25, 0.9, 3.2, 8.5 and 40.5, every one of which getTierForBB prices
-- without hesitation. No live table sits on those stakes today, which is why
-- nothing had gone wrong yet.
--
-- THE FIX: resolve the tier the way the TypeScript does — the narrowest tier
-- whose upper bound still covers the stake, and nosebleeds (max_bb NULL) for
-- anything above them all. min_bb stays in the table as documentation of the
-- published range; it is no longer part of the resolution, because it never
-- was in the code this table mirrors.
--
-- APPLIED TO PRODUCTION 2026-08-31 via Supabase MCP apply_migration
-- (migration name: the_rake_alarm_had_blind_spots_between_its_tiers), then
-- verified by re-probing every hole.
--
-- ROLLBACK: restore the two-bound WHERE clause from
--   20260831160000_the_rake_alarm_learns_the_new_schedule_rows.sql.

CREATE OR REPLACE FUNCTION public.fn_effective_rake_cap(p_sb numeric, p_bb numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT s.rake_cap FROM public.ca_rake_schedule s
      WHERE s.sb = p_sb AND s.bb = p_bb),
    -- getTierForBB: the narrowest tier whose ceiling still covers this stake;
    -- max_bb IS NULL is the open top end and sorts last.
    (SELECT LEAST(t.rake_cap, round(p_bb * public.fn_unscheduled_cap_bb(), 2))
       FROM public.ca_rake_tier t
      WHERE t.max_bb IS NULL OR p_bb <= t.max_bb
      ORDER BY t.max_bb ASC NULLS LAST
      LIMIT 1)
  );
$$;

-- Post-apply assertions. IS DISTINCT FROM, not <>, so a NULL result FAILS
-- rather than quietly satisfying the check — which is exactly how the
-- previous version of this migration's assertion missed the hole it was
-- meant to catch.
DO $$
DECLARE
  r record;
BEGIN
  -- Every hole between the tiers, and below the lowest one, now prices.
  FOR r IN SELECT unnest(ARRAY[0.07, 0.25, 0.9, 3.2, 8.5, 40.5, 0.011]::numeric[]) AS bb
  LOOP
    IF public.fn_effective_rake_cap(r.bb / 2, r.bb) IS NULL THEN
      RAISE EXCEPTION 'big blind % still resolves to no cap', r.bb;
    END IF;
  END LOOP;

  -- Published stakes are untouched by this change.
  IF public.fn_effective_rake_cap(1, 2) IS DISTINCT FROM 5.0 THEN
    RAISE EXCEPTION '1/2 moved: %', public.fn_effective_rake_cap(1, 2);
  END IF;
  IF public.fn_effective_rake_cap(25, 50) IS DISTINCT FROM 20.00 THEN
    RAISE EXCEPTION '25/50 moved: %', public.fn_effective_rake_cap(25, 50);
  END IF;
  IF public.fn_effective_rake_cap(0.05, 0.10) IS DISTINCT FROM 1.50 THEN
    RAISE EXCEPTION '0.05/0.10 moved: %', public.fn_effective_rake_cap(0.05, 0.10);
  END IF;

  -- And an unscheduled stake is held to the ladder's proportion, not a flat
  -- tier cap: 0.07 x 15 BB = 1.05, well under the Nano tier's flat 3.00.
  IF public.fn_effective_rake_cap(0.03, 0.07) IS DISTINCT FROM 1.05 THEN
    RAISE EXCEPTION 'unscheduled 0.03/0.07 should cap at 1.05, got %',
      public.fn_effective_rake_cap(0.03, 0.07);
  END IF;
END $$;
