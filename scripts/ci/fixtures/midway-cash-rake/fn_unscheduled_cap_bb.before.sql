CREATE OR REPLACE FUNCTION public.fn_unscheduled_cap_bb()
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(max(s.rake_cap / s.bb), 0)
    FROM public.ca_rake_schedule s
   WHERE s.bb > 0 AND s.source = 'engine_mirror';
$function$
