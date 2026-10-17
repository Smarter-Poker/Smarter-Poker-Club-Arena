CREATE OR REPLACE FUNCTION public.fn_ca_tournament_unit_cents(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id
       AND c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
  ) THEN 100 ELSE 1 END;
$function$
