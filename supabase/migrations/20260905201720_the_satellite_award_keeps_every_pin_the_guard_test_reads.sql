-- 20260905201720_the_satellite_award_keeps_every_pin_the_guard_test_reads.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 5 gate, 2026-09-05):
--
-- server/src/tournament/satelliteDoubleQualification.guard.test.ts reads the
-- LATEST migration that defines FUNCTION public.fn_award_satellite_seat and
-- expects, in that same file, the post-apply assertion that the off-by-one
-- level guard cannot come back. 20260905195011 re-created the function (a
-- cash entrant who wins a seat is paid the seat in cash) with the live body,
-- which carries every guard, but without restating that assertion. A mirrored
-- migration is never edited after it is applied, so the assertion is restated
-- here, forward, against the live definition: every pin the guard test reads,
-- asserted in production, so the next rewrite that drops one fails to apply.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_award_satellite_seat' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'FUNCTION public.fn_award_satellite_seat is missing';
  END IF;
  -- the seat gate agrees with the TS gate: a RUNNING target in late reg is open
  IF v_src NOT LIKE '%RUNNING%' OR v_src NOT LIKE '%late_reg_levels%' OR v_src NOT LIKE '%rebuy_levels%' THEN
    RAISE EXCEPTION 'the seat gate no longer reads RUNNING / late_reg_levels / rebuy_levels';
  END IF;
  -- it closes AT the cap, not one level past it
  IF v_src NOT LIKE '%COALESCE(v_t.current_level, 0) >= v_cap%' THEN
    RAISE EXCEPTION 'the level guard is not >= after the rewrite';
  END IF;
  IF v_src LIKE '%COALESCE(v_t.current_level, 0) > v_cap%' THEN
    RAISE EXCEPTION 'the off-by-one level guard survived the rewrite';
  END IF;
  -- it refuses a finalized prize pool
  IF v_src NOT LIKE '%prize_pool_finalized%' OR v_src NOT LIKE '%target_pool_finalized%' THEN
    RAISE EXCEPTION 'the seat gate no longer refuses a finalized prize pool';
  END IF;
  -- it names who seated a deduped winner, and a cash entrant is not an unknown
  IF v_src NOT LIKE '%held_from_this_satellite%' OR v_src NOT LIKE '%source_satellite_id%' THEN
    RAISE EXCEPTION 'the award no longer names who seated a deduped winner';
  END IF;
  IF v_src NOT LIKE '%CASE WHEN NOT v_existing_q THEN false%' THEN
    RAISE EXCEPTION 'a cash entrant who wins a seat is an unknown again';
  END IF;
END $$;

COMMIT;
