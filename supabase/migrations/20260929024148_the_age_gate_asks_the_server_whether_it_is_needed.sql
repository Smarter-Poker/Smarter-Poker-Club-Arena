-- THE AGE GATE ASKS THE SERVER WHETHER IT IS NEEDED (2026-09-29).
--
-- The Club Arena app's age gate (src/components/legal/AgeGate.tsx, audit tier
-- 0, Apple 1.1.4 / Play simulated-gambling policy) has NEVER shown to anyone.
-- Found on the first on-device walkthrough, 2026-09-29, with a fresh account
-- whose profile has birthday NULL and age_verified false: the gate should have
-- blocked the app and did not.
--
-- The gate decided by reading two columns of the player's own profile:
--
--     select birthday, age_verified from profiles where id = <me>
--
-- and `age_verified` is one of the columns the profile-privacy lockdown
-- revoked from `authenticated` (with email, phone, every kyc_* and
-- jurisdiction_* column, over_18_attested_at). PostgREST refuses the WHOLE
-- select when any one column is denied - measured from the app's own session:
--
--     select=birthday                 -> 200
--     select=age_verified             -> 403 42501 permission denied
--     select=birthday,age_verified    -> 403 42501 permission denied
--
-- so the gate's read failed for every player, landed in its 'unknown' branch,
-- and that branch rendered nothing. 1,290 of 1,293 profiles have no birthday
-- on file; every one of them walked straight past a compliance gate.
--
-- The fix is not to hand the column back. A client that decides "may this
-- person use the app" by reading table columns is one privacy pass away from
-- breaking again, silently, in the permissive direction. The question moves
-- to the server, which can read what it needs regardless of column grants,
-- and answers only about the caller:
--
--     fn_my_age_gate_status() -> { ok, verified }
--
-- `verified` keeps the original semantics exactly (a birthday on file, OR
-- age_verified set by fn_set_my_birthday / fn_set_age_verified). As of this
-- migration 0 profiles have age_verified without a birthday, so the two
-- readings agree for every player today; keeping the OR means a future KYC
-- path that sets only age_verified is honoured without another change here.
--
-- It is also the prerequisite for revoking `birthday` itself from players:
-- `profiles` rows are readable by every authenticated user, and so is that
-- column, so any signed-in player can currently read or binary-search any
-- other player's exact date of birth. That revoke follows separately, once the
-- World Hub profile editor reads its own birthday through an own-row function
-- as well; doing it first would break profile editing on the live site. After
-- this migration the age gate no longer depends on that column at all.
--
-- SECURITY DEFINER because it must read age_verified, which the caller may
-- not; it consults auth.uid() and returns nothing about any other user.
-- Executable by `authenticated` only - an anonymous visitor has no age to
-- check and no profile to read.

CREATE OR REPLACE FUNCTION public.fn_my_age_gate_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_birthday date;
  v_age_verified boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT birthday, age_verified
    INTO v_birthday, v_age_verified
    FROM public.profiles
   WHERE id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  END IF;

  -- The answer, and only the answer. The date itself never leaves here.
  RETURN jsonb_build_object(
    'ok', true,
    'verified', (v_birthday IS NOT NULL OR COALESCE(v_age_verified, false))
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_my_age_gate_status() IS
  'Club Arena app age gate: does the CALLER still need to state a date of birth? Own row only (auth.uid()); returns {ok, verified}, never the date. 2026-09-29.';

REVOKE ALL ON FUNCTION public.fn_my_age_gate_status() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_my_age_gate_status() TO authenticated, service_role;
