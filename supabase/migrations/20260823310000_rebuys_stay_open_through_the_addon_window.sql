-- ===========================================================================
-- REBUYS STAY OPEN THROUGH THE ADD-ON WINDOW, AND BOTH CLOSE WHEN THE ENGINE
-- SAYS THEY DO (2026-08-23)
--
-- Dan, binding: "rebuys are open until level 8 ... but there is an add on
-- period of 1 minute ... rebuys and add on's stay open for that last minute.
-- If there is no add ons and rebuys stop after level 8, the second level 9
-- starts, registration is closed and prizepool is finalized."
--
-- Two defects in the deployed process_tournament_rebuy, both on a money path.
--
-- 1. THE REBUY WINDOW ENDED WHERE THE ADD-ON WINDOW BEGAN.
--    The rebuy branch capped at COALESCE(rebuy_levels, late_reg_levels), while
--    the add-on branch ran from that same cap to cap + addon_levels. So the
--    add-on period - the one moment a short stack most wants to reload - was
--    exactly when rebuys stopped being available. It also contradicted the
--    engine, which deliberately DEFERS prize-pool finalization until the
--    add-on window closes (TournamentManagerBase.advanceBlindLevel skips the
--    late-reg finalization when add_on_available, and finalizeAfterAddOn runs
--    at cap + addon_levels) precisely because money is still arriving.
--
-- 2. BOTH GATES WERE OFF BY ONE, IN THE PERMISSIVE DIRECTION.
--    `v_level > v_cap` on a 0-BASED column. tournaments.current_level is an
--    index into blind_structure - TournamentManagerBase.currentLevel starts at
--    0 and indexes the array directly - so "through level N" is indices
--    0..N-1 and the cutoff is index N. `>` therefore kept both windows open
--    for one whole level past the point the engine had closed them, taking
--    money for a rebuy after the engine had already finalized the prize pool
--    and recalculated every eliminated player's prize against it. This is the
--    same off-by-one that 20260823300000 fixed in fn_register_for_tournament;
--    it lives in this function twice more.
--
-- After this migration all four gates agree on one instant:
--
--   engine   isLateRegClosed / finalizeAfterAddOn   currentLevel >= cap
--   register fn_register_for_tournament             current_level <  cap
--   rebuy    process_tournament_rebuy               v_level      <  close
--   add-on   process_tournament_rebuy               v_level      <  cap + addon
--
-- WHY THIS PATCHES RATHER THAN REDEFINES
--
-- The body of process_tournament_rebuy is NOT in this repo. Its own recording
-- migration says so: 20260724d_tourney_audit_sweep4_rebuy_windows.sql states
-- "Full function body lives in the applied migration ...; this file records it
-- for the repo." Re-pasting 14,634 characters of wallet debiting, bounty
-- handling, seat sync and idempotency keys from a description would be an
-- invention, not a migration. So this rewrites the LIVE definition in place
-- after asserting each target appears exactly once.
--
-- (That recording file is also stale in a second way: it documents the rebuy
-- gate as "level < cap" when the deployed code says `> v_cap`. Trust the
-- database, which is what this migration reads.)
--
-- ROLLBACK: re-apply the previous body from the remote migration history
-- (tourney_audit_sweep4_rebuy_window_enforcement).
-- ===========================================================================

BEGIN;

DO $$
DECLARE
  v_src  text;
  v_out  text;
  v_hits integer;

  -- The add-on branch: correct cap, wrong comparison.
  c_addon_from constant text :=
    'IF v_cap > 0 AND v_level > v_cap THEN' || E'\n' ||
    '      RAISE EXCEPTION ''Add-on period has closed (level % > %)'', v_level, v_cap; END IF;';
  c_addon_to constant text :=
    'IF v_cap > 0 AND v_level >= v_cap THEN' || E'\n' ||
    '      RAISE EXCEPTION ''Add-on period has closed (level % of %)'', v_level, v_cap; END IF;';

  -- The rebuy branch: the cap stops short of the add-on window, and the same
  -- comparison bug. Both are fixed together because the cap is computed on the
  -- line directly above the comparison.
  c_rebuy_from constant text :=
    'v_cap := COALESCE(NULLIF(v_t.rebuy_levels,0), NULLIF(v_t.late_reg_levels,0), 0);' || E'\n' ||
    '    IF v_cap > 0 AND v_level > v_cap THEN' || E'\n' ||
    '      RAISE EXCEPTION ''Rebuy period has closed (level % > %)'', v_level, v_cap; END IF;';
  c_rebuy_to constant text :=
    'v_cap := COALESCE(NULLIF(v_t.rebuy_levels,0), NULLIF(v_t.late_reg_levels,0), 0);' || E'\n' ||
    '    IF v_cap > 0 AND COALESCE(v_t.add_on_available,false) THEN' || E'\n' ||
    '      v_cap := v_cap + COALESCE(NULLIF(v_t.addon_levels,0),1); END IF;' || E'\n' ||
    '    IF v_cap > 0 AND v_level >= v_cap THEN' || E'\n' ||
    '      RAISE EXCEPTION ''Rebuy period has closed (level % of %)'', v_level, v_cap; END IF;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'process_tournament_rebuy'
   ORDER BY length(pg_get_functiondef(p.oid)) DESC
   LIMIT 1;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'process_tournament_rebuy not found - schema drift, aborting';
  END IF;

  -- Idempotent: a re-run over an already-patched body is a no-op.
  IF position(c_rebuy_to IN v_src) > 0 THEN
    RAISE NOTICE 'process_tournament_rebuy already carries the engine-matched windows - nothing to do';
    RETURN;
  END IF;

  -- Each target must appear EXACTLY once. The two comparisons are textually
  -- identical, which is why each pattern carries its own RAISE message: a bare
  -- comparison would match both branches and silently patch the wrong one.
  v_hits := (length(v_src) - length(replace(v_src, c_addon_from, ''))) / length(c_addon_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 add-on gate, found % - refusing to patch blind', v_hits;
  END IF;
  v_hits := (length(v_src) - length(replace(v_src, c_rebuy_from, ''))) / length(c_rebuy_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 rebuy gate, found % - refusing to patch blind', v_hits;
  END IF;

  v_out := replace(v_src, c_addon_from, c_addon_to);
  v_out := replace(v_out, c_rebuy_from, c_rebuy_to);

  EXECUTE v_out;
END $$;

-- Post-condition: no permissive `>` gate survives, and the rebuy branch now
-- reaches the end of the add-on window.
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'process_tournament_rebuy'
   ORDER BY length(pg_get_functiondef(p.oid)) DESC
   LIMIT 1;

  IF position('v_level > v_cap' IN v_src) > 0 THEN
    RAISE EXCEPTION 'post-check failed: a permissive > gate is still present';
  END IF;
  IF (length(v_src) - length(replace(v_src, 'v_level >= v_cap', '')))
     / length('v_level >= v_cap') <> 2 THEN
    RAISE EXCEPTION 'post-check failed: expected exactly two >= gates (rebuy and add-on)';
  END IF;
  IF position('COALESCE(v_t.add_on_available,false)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'post-check failed: the rebuy window does not reach the add-on window';
  END IF;
END $$;

COMMIT;
