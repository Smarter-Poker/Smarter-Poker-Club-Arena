-- live_md5 9ff2bf1983563ce706cfa786f5d0b73e
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_house_available()
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (SELECT h.balance FROM public.ca_diamond_house h WHERE h.id = 1)::bigint
       - public.fn_ca_diamond_earmarks_open(NULL)
$function$

