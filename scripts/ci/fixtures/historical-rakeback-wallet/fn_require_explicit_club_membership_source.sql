CREATE OR REPLACE FUNCTION public.fn_require_explicit_club_membership_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_source text := COALESCE(current_setting('app.club_membership_source', true), '');
BEGIN
  IF v_source NOT IN ('join_club', 'club_owner_create', 'union_owner_membership') THEN
    RAISE EXCEPTION 'MEMBERSHIP_REQUIRES_JOIN: Club Members Can Only Be Added Through Join A Club'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
;
