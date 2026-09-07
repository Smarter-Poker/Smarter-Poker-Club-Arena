-- CLUB EXPOSURE IS NOT PUBLIC READING
-- =============================================================================
-- fn_union_club_exposure is SECURITY DEFINER, holds EXECUTE through PUBLIC, and
-- never calls auth.uid(). It runs as the owner, past RLS, and returns every
-- member club's running net, exposure, security deposit, stop-loss limit and
-- remaining headroom to a caller with no account. Caught by
-- check-definer-authorization in .husky/pre-push; pre-existing, and
-- re-declaring it in 20260907054009 is what surfaced it.
--
-- It leans on the authorization check inside fn_union_reconciliation_report,
-- which is why it passes a human read and fails the guard: the guard is right.
-- A club's credit headroom is exactly the number a competitor would want.
--
-- Checked before revoking, the same four questions as fn_union_club_invoice:
--   RLS policy helper?        no policy references it
--   view dependency?          none
--   caller in either repo?    none in Club Arena src/ or World Hub pages+src
--   database callers?         fn_union_credit_risk_check and
--                             fn_union_enforce_stop_loss, both SECURITY
--                             DEFINER, so their internal calls resolve against
--                             the owner and are unaffected by these grants.
-- =============================================================================

BEGIN;

REVOKE ALL ON FUNCTION public.fn_union_club_exposure(uuid, timestamp with time zone)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_exposure(uuid, timestamp with time zone)
  TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_union_club_exposure(uuid, timestamp with time zone)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_union_club_exposure(uuid, timestamp with time zone)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_union_club_exposure is still executable by anon or authenticated';
  END IF;

  IF NOT has_function_privilege('service_role',
       'public.fn_union_club_exposure(uuid, timestamp with time zone)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on fn_union_club_exposure';
  END IF;

  -- The enforcement path must still work: it is SECURITY DEFINER, so the
  -- revoke above must not have broken it.
  PERFORM public.fn_union_enforce_stop_loss('fade0000-0000-0000-0000-000000000001');
END
$assert$;

COMMIT;
