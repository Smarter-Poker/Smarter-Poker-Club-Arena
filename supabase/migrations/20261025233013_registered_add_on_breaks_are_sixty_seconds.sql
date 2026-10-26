-- 20261025233013_registered_add_on_breaks_are_sixty_seconds.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-25 18:26 CT, verbatim: "ADD ON BREAK SHOULD ONLY BE 60 SECONDS,
-- UNLESS IT HAPPENS TO BE AT THE SAME TIME AS THE :55 BREAK, THEN ITS 5
-- MINUTES, THEY ARE NOT THE SAME BREAK... MAKE THAT ADJUSTMENT AS WELL PLEASE"
--
-- Every Midway event with an add-on was spawned with a five-minute add-on
-- break (withMidwayStructure, 2026-10-20). Sunday Funday Happy Hour (Midway
-- Union) paused all 16 tables from 23:11:24 to 23:16:24 UTC, ten minutes after
-- its :55 break, and it read to the owner as a second freeze. The engine now
-- spawns one minute (PR #8093). This applies the same ruling to the events
-- already on the board that have not opened their add-on.
--
-- 1. fn_guard_managed_game_lifecycle refuses any change to addon_break_minutes
--    once a player has registered. Root may now set it to exactly 1 on a
--    pre-start (ANNOUNCED or REGISTERING) event while app.addon_break_rule is
--    on, the same narrow shape as the level-clock, bounty-rebuy and mystery
--    exceptions. No other key and no other value passes.
-- 2. Those events take 1. Running events are left as they are: their manager
--    has already read the window length, and changing it under a live clock
--    would misplace the break. Entry price, chips, cost and every money term
--    are untouched; a shorter pause takes nothing from any entrant.
-- 3. Schedule configs that carry addonBreakMinutes 5 carry 1, so the board,
--    the spawn and the event all say the same thing.

-- @live-proof: position('app.addon_break_rule' IN pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '45s';

DO $guard$
DECLARE
  sig constant regprocedure := 'public.fn_guard_managed_game_lifecycle()'::regprocedure;
  d text;
  a constant text := E'        -- THE PROVISIONAL LADDER FOLLOWS THE FIELD (Dan 2026-10-21): until the';
BEGIN
  d := pg_get_functiondef(sig);
  IF position('app.addon_break_rule' IN d) > 0 THEN RETURN; END IF;
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'fn_guard_managed_game_lifecycle changed shape; add-on break rule not installed';
  END IF;
  EXECUTE replace(d, a,
    E'        -- Root may set a pre-start event''s add-on break to sixty seconds (Dan\n'
    || E'        -- 2026-10-25: "ADD ON BREAK SHOULD ONLY BE 60 SECONDS"). Only this key,\n'
    || E'        -- only to 1; every other protected field still runs below.\n'
    || E'        CONTINUE WHEN v_key = ''addon_break_minutes''\n'
    || E'          AND current_user = ''postgres''\n'
    || E'          AND COALESCE(current_setting(''app.addon_break_rule'', true), '''') = ''on''\n'
    || E'          AND NEW.addon_break_minutes = 1\n'
    || E'          AND upper(COALESCE(OLD.status, '''')) IN (''ANNOUNCED'', ''REGISTERING'');\n'
    || a);
END
$guard$;

SELECT set_config('app.addon_break_rule', 'on', true);

UPDATE public.tournaments t
   SET addon_break_minutes = 1
 WHERE COALESCE(t.add_on_available, false)
   AND upper(COALESCE(t.status, '')) IN ('ANNOUNCED', 'REGISTERING')
   AND NOT COALESCE(t.addon_period_triggered, false)
   AND COALESCE(t.addon_break_minutes, 1) <> 1;

UPDATE public.tournament_schedules s
   SET config = s.config || jsonb_build_object('addonBreakMinutes', 1),
       updated_at = now()
 WHERE s.config ? 'addonBreakMinutes'
   AND (s.config->>'addonBreakMinutes') = '5';

DO $assert$
DECLARE
  v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.tournaments t
   WHERE COALESCE(t.add_on_available, false)
     AND upper(COALESCE(t.status, '')) IN ('ANNOUNCED', 'REGISTERING')
     AND NOT COALESCE(t.addon_period_triggered, false)
     AND COALESCE(t.addon_break_minutes, 1) <> 1;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'pre-start add-on events still above sixty seconds: %', v_left;
  END IF;
END
$assert$;

COMMIT;
