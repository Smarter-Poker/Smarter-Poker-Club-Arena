CREATE OR REPLACE FUNCTION public.fn_freeze_bypass_active()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(current_setting('app.freeze_bypass', TRUE), '') = 'on';
$function$
;
