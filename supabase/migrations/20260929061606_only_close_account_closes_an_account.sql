-- 20260929061606_only_close_account_closes_an_account
--
-- WHY (2026-09-29, the same walkthrough)
--
-- 20260929054441 made a closed profile unchangeable by the account's own
-- token, and the app is learning to sign out any session whose profile says
-- status 'deleted'. But `authenticated` holds UPDATE on profiles.status, so
-- the owner's own token - or a script running in their session - can set
-- 'deleted' on an OPEN profile. Measured on production in a rolled-back
-- transaction: the owner's token marked its own open profile deleted, and
-- then could not put it back (ACCOUNT_CLOSED). One call would lock a player
-- out of their own account.
--
-- WHAT THIS DOES
--
-- A second BEFORE UPDATE trigger on profiles, only for an update that would
-- SET status 'deleted' on a profile that is not closed, refuses it from the
-- owner's own token (auth.uid() is the row). An account is closed by
-- fn_close_account, which the World Hub calls with the service role -
-- auth.uid() is null there - so closing is unaffected, as are staff tools and
-- jobs. No browser code writes profiles.status (Club Arena and World Hub
-- searched), and every profile holds 'active' except the closed ones.
--
-- A new trigger rather than a wider WHEN on the first: recreating that one
-- needs DROP TRIGGER, an ACCESS EXCLUSIVE lock on profiles, which deadlocked
-- against live traffic in the rehearsal. CREATE TRIGGER takes SHARE ROW
-- EXCLUSIVE (reads carry on), bounded by a 3 second lock_timeout.
--
-- MEASURED FIRST, rolled back, against production: the owner's token marking
-- its own open profile deleted is refused (42501 ACCOUNT_CLOSE_REQUIRED); its
-- ordinary edits still apply; a closed profile's own token is still refused;
-- the service role still closes.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.fn_only_close_account_closes_an_account()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'ACCOUNT_CLOSE_REQUIRED: an account is closed only through Close Account'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_only_close_account_closes_an_account() IS
  'BEFORE UPDATE on profiles, only when an update would set status deleted on a profile that is not closed: refuses it from that account''s own token (auth.uid() = the row). fn_close_account, called by the World Hub with the service role, is how an account is closed.';

REVOKE ALL ON FUNCTION public.fn_only_close_account_closes_an_account() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_only_close_account_closes_an_account
BEFORE UPDATE ON public.profiles
FOR EACH ROW
WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
EXECUTE FUNCTION public.fn_only_close_account_closes_an_account();

COMMIT;
