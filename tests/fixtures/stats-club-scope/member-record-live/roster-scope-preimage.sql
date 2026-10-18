CREATE OR REPLACE FUNCTION public.fn_club_scope_ids(p_club_id uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN coalesce((SELECT is_union FROM public.clubs WHERE id = p_club_id), false)
      THEN (
        SELECT array_agg(DISTINCT x)
        FROM (
          SELECT p_club_id AS x
          UNION SELECT id      FROM public.clubs       WHERE union_id = p_club_id
          UNION SELECT club_id FROM public.union_clubs WHERE union_id = p_club_id
        ) s
        WHERE x IS NOT NULL
      )
    ELSE ARRAY[p_club_id]
  END;
$function$
;
