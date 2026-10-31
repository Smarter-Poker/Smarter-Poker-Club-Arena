CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earmarks_open(p_purpose text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(CASE e.entry WHEN 'open' THEN e.amount ELSE -e.amount END), 0)::bigint
    FROM public.ca_diamond_house_earmarks e
   WHERE p_purpose IS NULL OR e.purpose = p_purpose
$function$

