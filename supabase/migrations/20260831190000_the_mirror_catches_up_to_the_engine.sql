-- ═══════════════════════════════════════════════════════════════════════════
-- THE MIRROR CATCHES UP TO THE ENGINE (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
-- The second half of a deliberately two-step change, and it could not be done
-- until now.
--
-- PR #2250 added six rows to RAKE_SCHEDULE and a proportional cap for stakes
-- the schedule does not name. Those two changes were pushed into
-- ca_rake_schedule AHEAD of the code, which was a mistake:
-- 20260831145500_the_alarm_measures_the_engine_not_our_opinion_of_it.sql
-- reversed their effect and was right to. ca_rake_schedule exists so
-- fn_rake_law_violations can judge a hand against the cap the ENGINE applies,
-- and while the deployed engine still had fourteen rows, a mirror carrying
-- twenty would have answered 1.50 for a stake the engine capped at 3.00 and
-- filed 60 correct hands as `over_cap` criticals.
--
-- The six rows were therefore parked as `source = 'proposed'`, excluded from
-- cap resolution, and surfaced by fn_rake_schedule_drift() as a question.
--
-- ── WHY IT IS SAFE NOW: THE ENGINE HAS IT ──────────────────────────────────
--
-- Verified before running this, against the engine itself rather than against
-- the client bundle. The two deploy separately: smarter.poker serves the
-- World Hub bundle (the client), and the engine is its own Hetzner container.
-- Checking the client would have proved nothing.
--
--   curl -s https://engine.smarter.poker/health -> "version":"68d6f906"
--   68d6f906bc = fix(e2e): stabilize final production certification (#2281)
--   git merge-base --is-ancestor 20eac87da1 68d6f906bc  -> true
--   git show 68d6f906bc:server/src/config/RakeConfig.ts
--     | grep -c unscheduledCapFor                        -> 2
--
-- So the running engine carries both the twenty rows and the proportional
-- fallback. The mirror is now the stale half, and leaving it stale would make
-- the alarm too LENIENT in the other direction: it would allow 3.00 at
-- 0.05/0.10 while the engine caps at 1.50, and miss a genuine over-cap hand.
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────────
--
--   1. The six rows become `engine_mirror`, because they now describe what the
--      engine charges, which is the only thing that column means.
--   2. fn_effective_rake_cap's fallback is held to the ladder's own most
--      generous ratio again, mirroring unscheduledCapFor in the engine.
--
-- Everything the 145500 migration got right is kept unchanged: the
-- `source = 'engine_mirror'` filter on the schedule lookup, and the max_bb
-- cascade with NULLS LAST that fixed the tier gaps.
--
-- APPLIED TO PRODUCTION 2026-08-31 via Supabase MCP apply_migration
-- (migration name: the_mirror_catches_up_to_the_engine), then verified by
-- re-reading pg_get_functiondef and re-probing every stake.
--
-- ROLLBACK: set the six rows back to 'proposed' and restore the plain
-- `t.rake_cap` fallback from 20260831145500.

UPDATE public.ca_rake_schedule
   SET source = 'engine_mirror'
 WHERE source = 'proposed';

CREATE OR REPLACE FUNCTION public.fn_effective_rake_cap(p_sb numeric, p_bb numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT s.rake_cap FROM public.ca_rake_schedule s
      WHERE s.sb = p_sb AND s.bb = p_bb AND s.source = 'engine_mirror'),
    -- getTierForBB is an upper-bound cascade with no floor and no gaps, and
    -- unscheduledCapFor then holds the tier's flat dollar cap to the most
    -- generous ratio any published row takes. Both mirrored here.
    (SELECT LEAST(t.rake_cap, round(p_bb * public.fn_unscheduled_cap_bb(), 2))
       FROM public.ca_rake_tier t
      WHERE t.max_bb IS NULL OR p_bb <= t.max_bb
      ORDER BY t.max_bb ASC NULLS LAST
      LIMIT 1)
  );
$$;

-- Post-apply assertions. IS DISTINCT FROM, never <>, so a NULL fails loudly
-- instead of quietly satisfying the check.
DO $$
DECLARE
  v_proposed int;
  v_bound numeric;
BEGIN
  SELECT count(*) INTO v_proposed FROM public.ca_rake_schedule WHERE source <> 'engine_mirror';
  IF v_proposed <> 0 THEN
    RAISE EXCEPTION '% row(s) still parked outside engine_mirror', v_proposed;
  END IF;

  v_bound := public.fn_unscheduled_cap_bb();
  IF v_bound IS DISTINCT FROM 15 THEN
    RAISE EXCEPTION 'derived ratio should be 15 BB, got %', v_bound;
  END IF;

  -- The stake the whole two-step dance was about.
  IF public.fn_effective_rake_cap(0.05, 0.10) IS DISTINCT FROM 1.50 THEN
    RAISE EXCEPTION '0.05/0.10 should now cap at 1.50, got %',
      public.fn_effective_rake_cap(0.05, 0.10);
  END IF;

  -- Stakes that must NOT move.
  IF public.fn_effective_rake_cap(1, 2) IS DISTINCT FROM 5.0 THEN
    RAISE EXCEPTION '1/2 moved: %', public.fn_effective_rake_cap(1, 2);
  END IF;
  IF public.fn_effective_rake_cap(2, 5) IS DISTINCT FROM 7.5 THEN
    RAISE EXCEPTION '2/5 moved: %', public.fn_effective_rake_cap(2, 5);
  END IF;
  IF public.fn_effective_rake_cap(25, 50) IS DISTINCT FROM 20.00 THEN
    RAISE EXCEPTION '25/50 moved: %', public.fn_effective_rake_cap(25, 50);
  END IF;

  -- An unscheduled stake is priced in proportion, and the tier gaps stay shut.
  IF public.fn_effective_rake_cap(0.03, 0.07) IS DISTINCT FROM 1.05 THEN
    RAISE EXCEPTION 'unscheduled 0.03/0.07 should cap at 1.05, got %',
      public.fn_effective_rake_cap(0.03, 0.07);
  END IF;
  IF public.fn_effective_rake_cap(0.45, 0.9) IS NULL THEN
    RAISE EXCEPTION 'a stake in the old nano/micro gap resolves to no cap again';
  END IF;
END $$;
