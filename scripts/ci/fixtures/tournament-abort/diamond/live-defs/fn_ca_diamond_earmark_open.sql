CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earmark_open(p_key text)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(CASE e.entry WHEN 'open' THEN e.amount ELSE -e.amount END), 0)::bigint
    FROM public.ca_diamond_house_earmarks e
   WHERE e.earmark_key = p_key
$function$

