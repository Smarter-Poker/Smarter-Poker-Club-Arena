CREATE OR REPLACE FUNCTION public.fn_guard_membership_lifecycle_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_allowed boolean := coalesce(
    current_setting('app.club_membership_lifecycle_write', true), ''
  ) IN ('depart', 'rejoin');
BEGIN
  IF OLD.membership_lifecycle_status = 'departed' AND NOT v_allowed THEN
    RAISE EXCEPTION 'MEMBERSHIP_DEPARTED: use the Join Club workflow to return'
      USING ERRCODE = '42501';
  END IF;

  IF (NEW.membership_lifecycle_status, NEW.departed_at, NEW.departed_by, NEW.departure_reason)
       IS DISTINCT FROM
     (OLD.membership_lifecycle_status, OLD.departed_at, OLD.departed_by, OLD.departure_reason)
     AND NOT v_allowed THEN
    RAISE EXCEPTION 'MEMBERSHIP_LIFECYCLE_REQUIRES_RPC'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$
