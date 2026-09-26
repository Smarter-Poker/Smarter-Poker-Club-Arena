-- A COMMITTED CREATE REPLAYS BEFORE MUTABLE ADMISSION.
-- Once (user_id, request_id) names a club, later rollout/cap/name changes may
-- not turn that successful operation into a refusal. Take the per-user lock,
-- return the receipt, and only then evaluate admission for a genuinely new
-- request. The global code-allocation lock remains new-request-only.
-- @live-proof: (SELECT position('SELECT club_id INTO v_existing' in pg_get_functiondef('public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)'::regprocedure)) > 0 AND position('SELECT club_id INTO v_existing' in pg_get_functiondef('public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)'::regprocedure)) < position('IF NOT public.fn_club_creation_open(v_uid)' in pg_get_functiondef('public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)'::regprocedure)))

DO $patch$
DECLARE
  v_fn regprocedure :=
    'public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)'::regprocedure;
  v_old text;
  v_new text;
BEGIN
  v_old := pg_get_functiondef(v_fn);
  IF md5(v_old) <> 'c7c3d085e4cbd08af4f46974eca7ac3b' THEN
    RAISE EXCEPTION 'CREATE_CLUB_REPLAY_PREIMAGE_CHANGED: %', md5(v_old)
      USING ERRCODE = '55000';
  END IF;

  v_new := replace(v_old,
$before_request$  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A creation request ID is required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.fn_club_creation_open(v_uid) THEN
$before_request$,
$after_request$  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A creation request ID is required' USING ERRCODE = '22023';
  END IF;

  PERFORM public.fn_club_membership_lock(v_uid);
  SELECT club_id INTO v_existing
    FROM public.club_creation_requests
   WHERE user_id = v_uid AND request_id = p_request_id;
  IF FOUND THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = v_existing;
    RETURN to_jsonb(v_club);
  END IF;

  IF NOT public.fn_club_creation_open(v_uid) THEN
$after_request$);

  v_new := replace(v_new,
$late_replay$  PERFORM public.fn_club_membership_lock(v_uid);
  PERFORM pg_advisory_xact_lock(77432);

  SELECT club_id INTO v_existing
    FROM public.club_creation_requests
   WHERE user_id = v_uid AND request_id = p_request_id;
  IF FOUND THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = v_existing;
    RETURN to_jsonb(v_club);
  END IF;

  IF EXISTS (SELECT 1 FROM public.clubs WHERE lower(name) = lower(v_name)) THEN
$late_replay$,
$new_request$  PERFORM pg_advisory_xact_lock(77432);

  IF EXISTS (SELECT 1 FROM public.clubs WHERE lower(name) = lower(v_name)) THEN
$new_request$);

  IF v_new = v_old
     OR length(v_new) - length(replace(v_new, 'SELECT club_id INTO v_existing', ''))
        <> length('SELECT club_id INTO v_existing')
     OR strpos(v_new, 'SELECT club_id INTO v_existing')
        > strpos(v_new, 'fn_club_creation_open(v_uid)') THEN
    RAISE EXCEPTION 'CREATE_CLUB_REPLAY_PATCH_DID_NOT_PRODUCE_ONE_EARLY_LOOKUP'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE v_new;
END
$patch$;

REVOKE ALL ON FUNCTION public.fn_create_club_atomic_membership_impl(
  uuid, text, text, text, boolean, boolean, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_create_club_atomic_membership_impl(
  uuid, text, text, text, boolean, boolean, text) IS
  'Private atomic club creation body. A committed request replays under the per-user lock before mutable rollout, validation, cap or allocation checks.';
