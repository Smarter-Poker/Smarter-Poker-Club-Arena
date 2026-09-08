-- 20260908004420_a_player_states_a_date_of_birth_once_and_the_platform_refuse.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (store readiness, phase 3 - the age gate):
--
-- The audit: "Zero matches for any age or DOB pattern in src/. A simulated-
-- gambling app rated 17+ or 18+ with only a dismissible localStorage checkbox
-- will not clear age-rating review on either store."
--
-- The World Hub's signup already asks a full date of birth and refuses under
-- 18, writing profiles.birthday and birth_year through user metadata. Two
-- gaps remain: accounts created before birthday existed (1,189 of 1,192
-- profiles have no birthday; 1,003 have a year only), and the app's own
-- in-app signup (Club Arena AuthPage, native only). This function is the one
-- place a date of birth is written from the client:
--
--   - the caller states THEIR OWN date of birth (auth.uid()), once. A
--     birthday already on the profile is never changed by this path - a
--     player cannot age themselves up after the fact - and a re-submission
--     of the same date is a no-op success.
--   - under 18 is refused, and nothing is written: the client signs the
--     player out. Recording the date would be recording a minor's data.
--   - a plausible date only: not in the future, not before 1900.
--   - age_verified / age_verified_at are set with it, so the gate has one
--     column to read (src/components/legal/AgeGate.tsx).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_set_my_birthday(p_birthday date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_existing date;
  v_age int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF p_birthday IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing');
  END IF;
  IF p_birthday > CURRENT_DATE OR p_birthday < DATE '1900-01-01' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'implausible');
  END IF;

  SELECT birthday INTO v_existing FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  END IF;

  -- Stated once. The same date again is a no-op; a different one is refused.
  IF v_existing IS NOT NULL THEN
    IF v_existing = p_birthday THEN
      RETURN jsonb_build_object('ok', true, 'already_set', true, 'age_verified', true);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_set');
  END IF;

  v_age := date_part('year', age(CURRENT_DATE, p_birthday))::int;
  IF v_age < 18 THEN
    -- Nothing written: refusing is the whole point, and a minor's date of
    -- birth is not something to keep.
    RETURN jsonb_build_object('ok', false, 'reason', 'under_18');
  END IF;

  UPDATE public.profiles
     SET birthday = p_birthday,
         birth_year = COALESCE(birth_year, date_part('year', p_birthday)::int),
         age_verified = true,
         age_verified_at = now(),
         updated_at = now()
   WHERE id = v_uid;

  RETURN jsonb_build_object('ok', true, 'age_verified', true);
END;
$function$;

COMMENT ON FUNCTION public.fn_set_my_birthday(date) IS
  'The one client path that writes a date of birth: the caller''s own, once, refused under 18 (nothing written), refused if already set to a different date. Sets age_verified.';

REVOKE ALL ON FUNCTION public.fn_set_my_birthday(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_set_my_birthday(date) TO authenticated, service_role;

COMMIT;
