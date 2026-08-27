-- ═══════════════════════════════════════════════════════════════════════════
-- A MINUTES COLUMN STOPS HOLDING A LEVEL COUNT (2026-08-27)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `tournaments.late_reg_mins` is a minutes window. Every writer on the
-- platform — fn_create_tournament, ScheduledTournamentService,
-- TournamentRecurringService, HorseOrchestrator — set it to the LEVEL COUNT,
-- so a 12-level late registration persisted as "12 minutes".
--
-- That was invisible only because of evaluation order. fn_register_for_tournament
-- checks the level window FIRST and falls back to the minutes window only when
-- `late_reg_levels = 0`:
--
--     IF COALESCE(late_reg_levels,0) > 0 THEN  ...levels...
--     ELSIF COALESCE(late_reg_mins,0) > 0 AND started_at IS NOT NULL THEN
--       v_late_open := now() < started_at + make_interval(mins => late_reg_mins)
--
-- So the wrong number sat dormant — until anyone zeroed late_reg_levels on an
-- existing row, at which point registration silently reopened for N minutes
-- off a number that meant levels. Measured today: 1,692 rows carry
-- late_reg_mins = late_reg_levels, and 21 rows already sit in the
-- minutes-window state (all COMPLETED, so no live game was affected).
--
-- The fix is to make the column mean what it says. The level ladder is the
-- only late-reg rule this platform implements, so the minutes window stays as
-- a correct, dormant feature and every writer now stores 0 unless a caller
-- deliberately sends `lateRegistrationMinutes` (no UI does today).
--
-- The client-side writers are fixed in the same commit. Settled history is NOT
-- rewritten — only tournaments still open are backfilled, for the same reason
-- the whole-dollar migration left pre-2026-08-20 rows alone.
--
-- ROLLBACK: restore the previous fn_create_tournament body from
-- 20260827_create_flow_p0_fixes.sql / the live definition, which wrote
-- lateRegistrationLevels into the late_reg_mins slot. The backfill needs no
-- rollback: 0 is the correct value for a level-based tournament.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Stop the RPC writing a level count into the minutes column ──────────
-- Surgical: this rewrites ONLY the late_reg_mins argument of the INSERT,
-- leaving the rest of the 15KB SECURITY DEFINER body untouched. Rewriting the
-- whole function from a dashboard dump to change one line is how a creation
-- path acquires a silent regression.
DO $$
DECLARE
  v_src  text;
  v_new  text;
  v_old  text := E'    COALESCE((p_config->>\'lateRegistrationLevels\')::int, 0),\n'
              || E'    COALESCE((p_config->>\'lateRegistrationLevels\')::int, 0),\n'
              || E'    COALESCE((p_config->>\'lateRegistrationLevels\')::int, 0),';
  v_fix  text := E'    COALESCE((p_config->>\'lateRegistrationLevels\')::int, 0),\n'
              || E'    COALESCE((p_config->>\'lateRegistrationMinutes\')::int, 0),\n'
              || E'    COALESCE((p_config->>\'lateRegistrationLevels\')::int, 0),';
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc WHERE proname = 'fn_create_tournament';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'late_reg_mins: fn_create_tournament not found';
  END IF;

  -- The three consecutive identical lines are late_reg_levels, late_reg_mins,
  -- rebuy_levels, in the column order of the INSERT. The middle one is ours.
  IF position(v_old in v_src) = 0 THEN
    -- Already fixed, or the body changed shape. Either way, do not guess.
    IF position('lateRegistrationMinutes' in v_src) > 0 THEN
      RAISE NOTICE 'late_reg_mins: already fixed, nothing to do';
      RETURN;
    END IF;
    RAISE EXCEPTION 'late_reg_mins: could not locate the three-line late-reg block; fix by hand';
  END IF;

  v_new := replace(v_src, v_old, v_fix);
  EXECUTE v_new;
END $$;

-- ── 2. Backfill OPEN tournaments only. Settled history is left alone. ──────
UPDATE public.tournaments
   SET late_reg_mins = 0
 WHERE status IN ('REGISTERING', 'ANNOUNCED')
   AND COALESCE(late_reg_mins, 0) > 0
   AND COALESCE(late_reg_mins, 0) = COALESCE(late_reg_levels, 0);

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
DECLARE
  v_bad int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'fn_create_tournament'
       AND prosrc LIKE '%lateRegistrationMinutes%'
  ) THEN
    RAISE EXCEPTION 'late_reg_mins: RPC still writes the level count';
  END IF;

  -- The fee logic must have survived the surgical replace untouched.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'fn_create_tournament'
       AND prosrc LIKE '%trunc(v_total%'
  ) THEN
    RAISE EXCEPTION 'late_reg_mins: the fee formula was damaged by the rewrite';
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.tournaments
   WHERE status IN ('REGISTERING', 'ANNOUNCED')
     AND COALESCE(late_reg_mins, 0) > 0
     AND COALESCE(late_reg_mins, 0) = COALESCE(late_reg_levels, 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'late_reg_mins: % open tournaments still carry a level count', v_bad;
  END IF;
END $$;
