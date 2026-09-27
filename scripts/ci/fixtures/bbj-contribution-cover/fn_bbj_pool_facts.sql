CREATE OR REPLACE FUNCTION public.fn_bbj_pool_facts(p_pool_id uuid)
 RETURNS TABLE(hands_contributed bigint, total_contributed numeric, first_contribution_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COUNT(*)::bigint,
         ROUND(COALESCE(SUM(amount), 0), 2),
         MIN(created_at)
  FROM public.bbj_contributions
  WHERE pool_id = p_pool_id;
$function$
