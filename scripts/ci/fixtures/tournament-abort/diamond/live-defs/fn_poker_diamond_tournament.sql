CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
       AND c.union_id IS NULL AND t.union_id IS NULL);
$function$

