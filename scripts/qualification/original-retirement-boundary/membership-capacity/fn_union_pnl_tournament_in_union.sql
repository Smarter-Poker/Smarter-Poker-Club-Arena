CREATE OR REPLACE FUNCTION public.fn_union_pnl_tournament_in_union(p_tournament_id text, p_union_id uuid, p_projected boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN EXISTS(SELECT 1 FROM public.union_pnl_inventory_touches t WHERE t.source_name='tournaments'
   AND t.row_id=CASE WHEN p_tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_tournament_id::uuid END
   AND t.row_id::text=p_tournament_id
   AND t.union_id=p_union_id::text);
 END IF;
 RETURN EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
  AND t.row_id=CASE WHEN p_tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_tournament_id::uuid END
  AND t.row_id::text=p_tournament_id
  AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text);
END $function$;
