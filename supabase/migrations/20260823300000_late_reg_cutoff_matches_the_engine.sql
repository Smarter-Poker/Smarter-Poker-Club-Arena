-- ===========================================================================
-- LATE REGISTRATION CLOSES WHEN THE ENGINE SAYS IT CLOSES (2026-08-23)
--
-- Dan: "rebuys are open until level 8 ... if there is no add ons and rebuys
-- stop after level 8, the second level 9 starts, registration is closed and
-- prizepool is finalized."
--
-- tournaments.current_level is written 0-BASED by the engine
-- (TournamentManagerBase.currentLevel starts at 0 and indexes blind_structure
-- directly), so "open through level 8" is indices 0..7, and the cutoff is
-- index 8. The engine has always agreed with Dan:
--
--   TournamentManagerBase.isLateRegClosed()   currentLevel >= late_reg_levels
--   advanceBlindLevel late-reg finalization   currentLevel >= late_reg_levels
--
-- The SQL did not:
--
--   v_late_open := COALESCE(v_t.current_level, 1) <= v_t.late_reg_levels;
--
-- `<=` against a 0-based column keeps registration open through index 8 --
-- one whole level PAST the cutoff -- and the COALESCE default of 1 is a
-- 1-based assumption on the same line. So there was a level-long window in
-- which:
--
--   * the engine had already broadcast late_reg_closed, and every client was
--     showing late registration as closed;
--   * prize_pool had been overwritten with the finalized figure and
--     prize_pool_finalized set true;
--   * recalculateEliminatedPrizes had already paid out against that figure;
--   * and this function still took the buy-in and did
--       prize_pool = prize_pool + v_split.prize
--     on top of the "final" number, so the pool moved after it was final and
--     every prize already calculated was wrong.
--
-- Two changes, both to the gate only:
--
--   1. `COALESCE(current_level, 0) < late_reg_levels` -- the exact instant the
--      engine uses, with a 0-based default to match the column.
--   2. A prize_pool_finalized backstop on BOTH late-reg branches (levels and
--      minutes). Once the pool is final, no entry may move it, whatever the
--      level says. This also covers the minutes-based path, which had no
--      relationship to the engine's finalization at all.
--
-- WHY THIS PATCHES RATHER THAN REDEFINES
--
-- fn_register_for_tournament is 150 lines of money handling -- entry split,
-- wallet deduction, rake row, mystery bounty draw, unique-violation refund
-- race, and (since 20260823270000) immediate late seating. Re-pasting that
-- body to change two lines is how a fix silently drops half a feature; it has
-- already happened twice on this platform (see TournamentFixes.guard.test.ts).
-- This migration therefore rewrites the LIVE definition in place: it reads
-- pg_get_functiondef, asserts each target appears exactly once, substitutes,
-- and re-executes. Anything else in the body is carried through untouched,
-- including concurrent work landing in 20260823270000.
--
-- ROLLBACK: re-run supabase/migrations/20260823270000_late_registration_takes_a_seat.sql
-- (or 20260822100300_fn_register_parity.sql if 270000 has been reverted).
-- ===========================================================================

BEGIN;

DO $$
DECLARE
  v_src   text;
  v_out   text;
  v_hits  integer;

  -- The SELECT ... INTO v_t list, which must start carrying the finalized flag.
  c_select_from constant text :=
    'late_reg_levels, late_reg_mins, current_level, started_at, club_id, name,';
  c_select_to constant text :=
    'late_reg_levels, late_reg_mins, current_level, started_at, club_id, name, prize_pool_finalized,';

  -- The level-based gate: `<=` on a 0-based column, with a 1-based default.
  c_levels_from constant text :=
    'v_late_open := COALESCE(v_t.current_level, 1) <= v_t.late_reg_levels;';
  c_levels_to constant text :=
    'v_late_open := COALESCE(v_t.current_level, 0) < v_t.late_reg_levels'
    || ' AND NOT COALESCE(v_t.prize_pool_finalized, false);';

  -- The minutes-based gate, which never consulted finalization at all.
  c_mins_from constant text :=
    'v_late_open := now() < v_t.started_at + make_interval(mins => v_t.late_reg_mins);';
  c_mins_to constant text :=
    'v_late_open := now() < v_t.started_at + make_interval(mins => v_t.late_reg_mins)'
    || ' AND NOT COALESCE(v_t.prize_pool_finalized, false);';
BEGIN
  -- Guard 0: the column the backstop depends on.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournaments'
       AND column_name = 'prize_pool_finalized'
  ) THEN
    RAISE EXCEPTION 'tournaments.prize_pool_finalized missing - apply 20260308_tournament_bounties_and_columns.sql first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_register_for_tournament'
     AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament(uuid) not found - schema drift, aborting';
  END IF;

  -- Idempotent: a re-run of an already-patched function is a no-op, not a
  -- double substitution.
  IF position(c_levels_to IN v_src) > 0 THEN
    RAISE NOTICE 'fn_register_for_tournament already carries the engine-matched cutoff - nothing to do';
    RETURN;
  END IF;

  -- Guard 1: each target must appear EXACTLY once. Zero means the body has
  -- moved on and this patch would silently do nothing; more than one means the
  -- substitution would hit somewhere it was never reviewed against.
  v_hits := (length(v_src) - length(replace(v_src, c_select_from, ''))) / length(c_select_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 SELECT-list match, found % - refusing to patch blind', v_hits;
  END IF;
  v_hits := (length(v_src) - length(replace(v_src, c_levels_from, ''))) / length(c_levels_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 level-gate match, found % - refusing to patch blind', v_hits;
  END IF;
  v_hits := (length(v_src) - length(replace(v_src, c_mins_from, ''))) / length(c_mins_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 minutes-gate match, found % - refusing to patch blind', v_hits;
  END IF;

  v_out := replace(v_src, c_select_from, c_select_to);
  v_out := replace(v_out, c_levels_from, c_levels_to);
  v_out := replace(v_out, c_mins_from,  c_mins_to);

  EXECUTE v_out;
END $$;

-- Post-condition: the deployed body now closes exactly where the engine does,
-- and neither late-reg branch can move a finalized pool.
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_register_for_tournament'
     AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid';

  IF position('COALESCE(v_t.current_level, 0) < v_t.late_reg_levels' IN v_src) = 0 THEN
    RAISE EXCEPTION 'post-check failed: level gate did not take';
  END IF;
  IF position('<= v_t.late_reg_levels' IN v_src) > 0 THEN
    RAISE EXCEPTION 'post-check failed: the old off-by-one gate is still present';
  END IF;
  -- One backstop per late-reg branch.
  IF (length(v_src) - length(replace(v_src, 'COALESCE(v_t.prize_pool_finalized, false)', '')))
     / length('COALESCE(v_t.prize_pool_finalized, false)') <> 2 THEN
    RAISE EXCEPTION 'post-check failed: expected a finalized-pool backstop on both late-reg branches';
  END IF;
END $$;

COMMIT;
