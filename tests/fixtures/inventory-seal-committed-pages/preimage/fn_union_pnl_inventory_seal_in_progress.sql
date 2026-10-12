CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_seal_in_progress()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 -- A split seal of the current week's boundary has started and not finished.
 SELECT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=public.fn_union_week_start(now()))
   AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=public.fn_union_week_start(now()))
$function$
;

