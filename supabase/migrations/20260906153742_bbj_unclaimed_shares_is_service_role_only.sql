-- 20260906153742_bbj_unclaimed_shares_is_service_role_only.sql
--
-- The BBJ settlement worker needs this operational queue, but a browser does
-- not. The phase-two BBJ migration created the SECURITY DEFINER reader without
-- overriding PostgreSQL's default PUBLIC execute grant, which exposed every
-- still-owed jackpot share to authenticated clients. Close that path without
-- changing a single share, wallet, balance, or club setting.

BEGIN;

DO $migration$
BEGIN
  IF to_regprocedure('public.fn_bbj_unclaimed_shares()') IS NULL THEN
    RAISE EXCEPTION 'fn_bbj_unclaimed_shares() is missing; refusing to record a security fix that changed nothing';
  END IF;
END
$migration$;

REVOKE ALL ON FUNCTION public.fn_bbj_unclaimed_shares()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_unclaimed_shares()
  TO service_role;

DO $migration$
BEGIN
  IF has_function_privilege('anon', 'public.fn_bbj_unclaimed_shares()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_bbj_unclaimed_shares()', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'fn_bbj_unclaimed_shares() remains browser-executable';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.fn_bbj_unclaimed_shares()', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_bbj_unclaimed_shares() is no longer executable by the settlement worker';
  END IF;
END
$migration$;

COMMIT;
