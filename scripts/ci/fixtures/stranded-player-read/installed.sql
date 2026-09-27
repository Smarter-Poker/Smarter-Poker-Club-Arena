CREATE OR REPLACE FUNCTION public.fn_ca_stranded_tournament_players()
 RETURNS TABLE(tournament_id uuid, tournament_name text, stranded_players bigint, stranded_chips numeric, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH stranded AS (
    SELECT t.id, t.name, p.user_id,
           (SELECT s.stack
              FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
             ORDER BY s.left_at DESC NULLS FIRST
             LIMIT 1) AS last_stack
      FROM public.tournaments t
      JOIN public.tournament_players p ON p.tournament_id = t.id
     WHERE t.status = 'RUNNING'
       AND p.status <> 'eliminated'
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND s.left_at IS NULL)
  )
  SELECT s.id, s.name, count(*), round(sum(s.last_stack), 2),
         count(*) || ' player(s) are still in this event holding '
           || round(sum(s.last_stack), 2) || ' chips and are seated at no table, so they '
           || 'cannot be dealt a hand and their chips are outside every reader that '
           || 'counts open seats' AS detail
    FROM stranded s
   WHERE COALESCE(s.last_stack, 0) > 0
   GROUP BY s.id, s.name
   ORDER BY 4 DESC
$function$
