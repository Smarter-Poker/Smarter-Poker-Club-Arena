CREATE OR REPLACE FUNCTION public.fn_club_membership_lock(p_user_id uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT pg_advisory_xact_lock(hashtextextended(p_user_id::text, 77431))
$function$
;
