-- 20261021220920_lock_tournament_level_clocks.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-21, verbatim: "TOURNAMENT LEVELS CAN NEVER EVER BE A 'RANGE'.
-- ALL TOURNAMENTS NEED TO HAVE SET MINUTE BLIND LEVELS. TURBOS AND FREE ROLLS
-- 5 MINUTE LEVELS, STANDARD TOURNAMENTS AND BOUNTY TOURNAMENTS 8 MINUTE
-- LEVELS, DEEP STACK TOURNAMENTS 10 MINUTE LEVELS. EVERY LEVEL MUST BE LOCKED
-- IN AND DEFINED AND NEVER RANDOM. ... BACK LOG FIXES TO ANY FUTURE SCHEDULED
-- TOURNAMENTS. (THIS DOES NOT EFFECT SPINS OR SIT N GO'S)"
--
-- The cause, read from rows: the engine's MTT presets are tapered ladders
-- (blindLadder.ts durationForLevel): STANDARD opens at 10 and settles at 5,
-- TURBO 4 -> 2, DEEPSTACK 12 -> 6, the Diamond Free Buy 6 -> 5. 181 of 254
-- registering MTTs and all 27 registering satellites carried a mixed clock,
-- which the lobby printed as "10 Min Opening - 5-10 Min Range".
--
-- 1. fn_ca_locked_level_minutes: the one rule, mirrored line for line by
--    server/src/tournament/lockedLevelClock.ts (pinned by
--    tests/tournament-levels-are-locked.law.test.ts). First match wins:
--      free entry, or named Free Buy / Freeroll ............... 5
--      named Turbo / Hyper (not a satellite) .................. 5
--      named Deep (not a satellite) ........................... 10
--      bounty / PKO / mystery / knockout format ............... 8
--      authored opening clock <= 5 ............................ 5
--      authored opening clock >= 12, or already locked at 10 .. 10
--      otherwise .............................................. 8
-- 2. tournaments_lock_level_clock: BEFORE INSERT (and BEFORE UPDATE OF
--    blind_structure while the event has not started) every playable level of
--    an MTT or satellite is written with that one clock. It runs before
--    tournaments_new_mtt_blind_contract, so blind_speed/is_turbo are derived
--    from the locked ladder. Late registration that was derived from the
--    authored clock is re-derived from the locked one. Spins and Sit & Gos are
--    never touched. This is the write path itself, not a repair job: the
--    engine creators now write locked rows, and the trigger makes it
--    impossible for any other creator to publish a range.
-- 3. Every not-yet-started MTT/satellite is re-written through the trigger,
--    and Free Buys keep Dan's one hour of late registration (twelve 5-minute
--    levels, rebuys through the same level).
-- 4. Schedule configs that carry an explicit blindStructure are locked too,
--    so the source of each future occurrence states the clock it will run.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_ca_locked_level_minutes(
  p_name text,
  p_entry numeric,
  p_bounty boolean,
  p_satellite boolean,
  p_structure jsonb
) RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  n text := lower(COALESCE(p_name, ''));
  sat boolean := COALESCE(p_satellite, false) OR lower(COALESCE(p_name, '')) ~ 'satellite';
  r jsonb;
  mins numeric;
  secs numeric;
  opening numeric;
  uniform boolean := true;
BEGIN
  IF (p_entry IS NOT NULL AND p_entry = 0) OR n ~ 'free ?buy|free ?roll' THEN RETURN 5; END IF;
  IF NOT sat AND n ~ 'turbo|hyper' THEN RETURN 5; END IF;
  IF NOT sat AND n ~ 'deep' THEN RETURN 10; END IF;
  IF COALESCE(p_bounty, false) OR (NOT sat AND n ~ 'bounty|pko|knockout') THEN RETURN 8; END IF;
  IF p_structure IS NOT NULL AND jsonb_typeof(p_structure) = 'array' THEN
    FOR r IN SELECT value FROM jsonb_array_elements(p_structure) LOOP
      IF jsonb_typeof(r) <> 'object' OR r->'isBreak' = 'true'::jsonb THEN CONTINUE; END IF;
      mins := public.fn_ca_blind_contract_number(
        COALESCE(NULLIF(r->'durationMinutes', 'null'::jsonb), r->'duration_minutes'));
      secs := public.fn_ca_blind_contract_number(r->'duration');
      mins := CASE WHEN mins > 0 THEN mins WHEN secs > 0 THEN secs / 60 ELSE NULL END;
      IF mins IS NULL THEN CONTINUE; END IF;
      IF opening IS NULL THEN opening := mins;
      ELSIF mins <> opening THEN uniform := false;
      END IF;
    END LOOP;
  END IF;
  IF opening IS NULL THEN RETURN 8; END IF;
  IF opening <= 5 THEN RETURN 5; END IF;
  IF opening >= 12 OR (uniform AND opening = 10) THEN RETURN 10; END IF;
  RETURN 8;
END;
$$;

COMMENT ON FUNCTION public.fn_ca_locked_level_minutes(text, numeric, boolean, boolean, jsonb) IS
  'Dan 2026-10-21: every MTT/satellite level runs one fixed clock. Freerolls and turbos 5, standard and bounty 8, deep stack 10. Mirrors server/src/tournament/lockedLevelClock.ts.';

CREATE OR REPLACE FUNCTION public.fn_ca_lock_structure_clock(p_structure jsonb, p_minutes integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN jsonb_typeof(x) <> 'object' OR x->'isBreak' = 'true'::jsonb THEN x
      ELSE (x - 'duration' - 'duration_minutes') || jsonb_build_object('durationMinutes', p_minutes)
    END ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements(p_structure) WITH ORDINALITY AS e(x, ord);
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_lock_level_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  authored jsonb;
  locked jsonb;
  m integer;
  derived boolean := false;
BEGIN
  IF upper(COALESCE(NEW.tournament_type, '')) NOT IN ('MTT', 'SATELLITE')
     OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng') THEN
    RETURN NEW;
  END IF;
  -- A started event keeps the clock its players are already playing.
  IF TG_OP = 'UPDATE' AND upper(COALESCE(NEW.status, ''))
       NOT IN ('REGISTERING', 'ANNOUNCED', 'SCHEDULED', 'PENDING') THEN
    RETURN NEW;
  END IF;
  BEGIN
    authored := NEW.blind_structure::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW; -- unreadable ladders are refused by the blind contract trigger
  END;
  IF authored IS NULL OR jsonb_typeof(authored) <> 'array' OR jsonb_array_length(authored) = 0 THEN
    RETURN NEW;
  END IF;

  m := public.fn_ca_locked_level_minutes(
    NEW.name,
    CASE WHEN NEW.buy_in_amount IS NULL THEN NULL
         ELSE NEW.buy_in_amount + COALESCE(NEW.buy_in_fee, 0) END,
    COALESCE(NEW.is_bounty, false) OR COALESCE(NEW.is_pko, false)
      OR COALESCE(NEW.is_mystery_bounty, false) OR COALESCE(NEW.bounty_amount, 0) > 0
      OR lower(COALESCE(NEW.variant, '')) IN ('bounty', 'progressive_bounty', 'mystery_bounty'),
    upper(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
      OR lower(COALESCE(NEW.variant, '')) = 'satellite',
    authored);
  locked := public.fn_ca_lock_structure_clock(authored, m);
  IF locked = authored THEN RETURN NEW; END IF;

  IF COALESCE(NEW.late_reg_levels, 0) > 0 THEN
    BEGIN
      derived := NEW.late_reg_mins = public.fn_ca_mtt_late_registration_minutes(authored, NEW.late_reg_levels);
    EXCEPTION WHEN OTHERS THEN
      derived := false;
    END;
    IF derived THEN
      NEW.late_reg_mins := public.fn_ca_mtt_late_registration_minutes(locked, NEW.late_reg_levels);
    END IF;
  END IF;
  NEW.blind_structure := locked::text;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tournaments_lock_level_clock ON public.tournaments;
-- Named to sort before tournaments_new_mtt_blind_contract, which derives
-- blind_speed and is_turbo from the (now locked) ladder.
CREATE TRIGGER tournaments_lock_level_clock
  BEFORE INSERT OR UPDATE OF blind_structure ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_lock_level_clock();

-- 3a. A registered event's contract is guarded by fn_guard_managed_game_lifecycle
--     (only the service-role engine may change it). Root gets one narrow,
--     explicit exception, in the same shape as the Diamond late-registration
--     correction already in that guard: inside a session that names this
--     correction, a pre-start event may take its locked clock and the late
--     registration derived from it. Every other protected field still refuses.
DO $guard$
DECLARE
  d text;
  anchor constant text := '        -- Root may correct only the known literal-eight Diamond clock';
  clause constant text :=
'        -- Root may lock a pre-start event''s level clock (Dan 2026-10-21: every
        -- level one fixed clock, never a range). Only the clock and the late
        -- registration it derives; every other protected field still runs below.
        CONTINUE WHEN v_key IN (''blind_structure'', ''late_reg_mins'', ''late_reg_levels'', ''rebuy_levels'')
          AND current_user = ''postgres''
          AND COALESCE(current_setting(''app.lock_level_clock'', true), '''') = ''on''
          AND upper(COALESCE(OLD.status, '''')) IN (''ANNOUNCED'', ''REGISTERING'', ''SCHEDULED'', ''PENDING'');
';
BEGIN
  d := pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure);
  IF position('Root may lock a pre-start event' IN d) > 0 THEN RETURN; END IF;
  IF position(anchor IN d) = 0 THEN
    RAISE EXCEPTION 'fn_guard_managed_game_lifecycle changed shape; level clock exception not installed';
  END IF;
  EXECUTE replace(d, anchor, clause || anchor);
END
$guard$;

SELECT set_config('app.lock_level_clock', 'on', true);

-- 3. Every future (not yet started) MTT and satellite, through the trigger.
UPDATE public.tournaments
   SET blind_structure = blind_structure
 WHERE upper(COALESCE(status, '')) IN ('REGISTERING', 'ANNOUNCED', 'SCHEDULED', 'PENDING')
   AND upper(COALESCE(tournament_type, '')) IN ('MTT', 'SATELLITE')
   AND lower(COALESCE(variant, '')) NOT IN ('spin', 'sng');

-- Free Buys: Dan's one hour of late registration on the 5-minute clock.
UPDATE public.tournaments
   SET late_reg_levels = 12,
       rebuy_levels = CASE WHEN rebuy_levels = late_reg_levels THEN 12 ELSE rebuy_levels END,
       late_reg_mins = 60
 WHERE upper(COALESCE(status, '')) IN ('REGISTERING', 'ANNOUNCED', 'SCHEDULED', 'PENDING')
   AND upper(COALESCE(tournament_type, '')) = 'MTT'
   AND lower(COALESCE(variant, '')) NOT IN ('spin', 'sng')
   AND lower(name) ~ 'free ?buy'
   AND COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0) = 0
   AND (late_reg_levels, late_reg_mins) IS DISTINCT FROM (12, 60);

-- 4. Schedule configs with an explicit ladder state the clock they will run.
UPDATE public.tournament_schedules s
   SET config = jsonb_set(s.config, '{blindStructure}',
         public.fn_ca_lock_structure_clock(
           s.config->'blindStructure',
           public.fn_ca_locked_level_minutes(
             COALESCE(s.config->>'name', s.name),
             CASE WHEN s.config ? 'buyIn' THEN public.fn_ca_blind_contract_number(s.config->'buyIn') END,
             COALESCE(public.fn_ca_blind_contract_number(s.config->'bountyAmount'), 0) > 0
               OR lower(COALESCE(s.config->>'type', '')) IN ('bounty', 'progressive_bounty', 'mystery_bounty'),
             lower(COALESCE(s.config->>'type', '')) = 'satellite',
             s.config->'blindStructure'))),
       updated_at = now()
 WHERE jsonb_typeof(s.config->'blindStructure') = 'array'
   AND jsonb_array_length(s.config->'blindStructure') > 0
   AND lower(COALESCE(s.config->>'type', 'mtt')) NOT IN ('spin', 'sng')
   AND s.config->'blindStructure' IS DISTINCT FROM public.fn_ca_lock_structure_clock(
         s.config->'blindStructure',
         public.fn_ca_locked_level_minutes(
           COALESCE(s.config->>'name', s.name),
           CASE WHEN s.config ? 'buyIn' THEN public.fn_ca_blind_contract_number(s.config->'buyIn') END,
           COALESCE(public.fn_ca_blind_contract_number(s.config->'bountyAmount'), 0) > 0
             OR lower(COALESCE(s.config->>'type', '')) IN ('bounty', 'progressive_bounty', 'mystery_bounty'),
           lower(COALESCE(s.config->>'type', '')) = 'satellite',
           s.config->'blindStructure'));

COMMIT;
