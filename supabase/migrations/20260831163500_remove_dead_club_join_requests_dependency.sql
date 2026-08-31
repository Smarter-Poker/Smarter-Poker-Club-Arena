-- club_members is the authoritative join-request record. Production no longer
-- has the legacy club_join_requests shadow table, but the Phase 3 trigger and
-- cancellation RPC still referenced it. Every club creation inserts an active
-- owner membership, firing that trigger and rolling the entire create back
-- with 42P01.

DROP TRIGGER IF EXISTS trg_sync_club_join_request ON public.club_members;
DROP FUNCTION IF EXISTS public.fn_sync_club_join_request();

CREATE OR REPLACE FUNCTION public.fn_cancel_club_join_request(p_club_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_deleted integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  DELETE FROM public.club_members
   WHERE club_id = p_club_id
     AND user_id = v_uid
     AND status = 'pending';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cancel_club_join_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cancel_club_join_request(uuid) TO authenticated, service_role;

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'public.club_members'::regclass
       AND tgname = 'trg_sync_club_join_request'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'The dead club_join_requests sync trigger still exists';
  END IF;

  IF position(
       'club_join_requests' IN
       pg_get_functiondef('public.fn_cancel_club_join_request(uuid)'::regprocedure)
     ) > 0 THEN
    RAISE EXCEPTION 'The cancellation RPC still references club_join_requests';
  END IF;
END;
$assert$;
