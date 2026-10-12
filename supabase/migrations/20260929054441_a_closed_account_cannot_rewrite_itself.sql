-- 20260929054441_a_closed_account_cannot_rewrite_itself
--
-- WHY (found 2026-09-29, Close My Account on the Android emulator)
--
-- Closing an account (public.fn_close_account, migration 20260929051751)
-- scrubs the profile, and the World Hub then soft-deletes the Auth user, which
-- removes its sessions. It does not end the ACCESS TOKENS already issued:
-- PostgREST checks a token's signature and expiry, not whether its session
-- still exists, and this project's tokens live for days (the emulator's
-- session had 6.9 of them left). The app on the emulator kept the closed
-- account's session - a supabase-js 2.90 sign-out bug, fixed in the same
-- change - and put the scrubbed profile's Complete Your Profile card on
-- screen, one tap from writing a name and a picture back into the closed
-- profile. Another device still signed in to the same account needs no bug
-- to do that.
--
-- WHAT THIS DOES
--
-- A closed profile cannot be changed by the account itself. An UPDATE of a
-- profile whose status is 'deleted', made with that account's own token
-- (auth.uid() is the row), is refused - directly, or through a definer
-- function acting for the caller. The service role, the database's own jobs
-- and staff tools are unaffected: their auth.uid() is not the row.
--
-- MEASURED FIRST, in rolled-back transactions against production, on the
-- walkthrough account closed from the emulator at 05:34 UTC: its own token
-- could rename it before this trigger and is refused after it (42501); the
-- service role and a definer job still update it; an open profile updated
-- with its own token is untouched.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_a_closed_account_cannot_rewrite_itself()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'ACCOUNT_CLOSED: this account was closed and cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_a_closed_account_cannot_rewrite_itself() IS
  'BEFORE UPDATE on profiles, only for rows whose status is deleted: refuses the change when it is made with the closed account''s own token (auth.uid() = the row). Closing an account does not end access tokens already issued; this keeps the scrubbed profile scrubbed.';

REVOKE ALL ON FUNCTION public.fn_a_closed_account_cannot_rewrite_itself() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_a_closed_account_cannot_rewrite_itself ON public.profiles;
CREATE TRIGGER trg_a_closed_account_cannot_rewrite_itself
BEFORE UPDATE ON public.profiles
FOR EACH ROW
WHEN (OLD.status = 'deleted')
EXECUTE FUNCTION public.fn_a_closed_account_cannot_rewrite_itself();

COMMIT;
