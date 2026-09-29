CREATE OR REPLACE FUNCTION public.fn_get_club_creation_eligibility()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  SELECT count(*) INTO v_count
    FROM public.club_members
   WHERE user_id = v_uid AND status IN ('active', 'approved');
  RETURN jsonb_build_object(
    'membership_count', v_count,
    'limit', 4,
    'remaining', GREATEST(0, 4 - v_count),
    'can_create', v_count < 4
  );
END;
$function$
