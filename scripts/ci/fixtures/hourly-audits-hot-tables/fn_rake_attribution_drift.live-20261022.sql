CREATE OR REPLACE FUNCTION public.fn_rake_attribution_drift(p_hours integer DEFAULT 24)
 RETURNS TABLE(hand_id uuid, rake_amount numeric, allocated numeric, difference numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT r.hand_id,
         r.rake_amount,
         COALESCE(SUM(ra.weighted_rake_credit), 0) AS allocated,
         round(r.rake_amount - COALESCE(SUM(ra.weighted_rake_credit), 0), 2) AS difference
    FROM public.rake_records r
    LEFT JOIN public.rake_attributions ra ON ra.hand_id = r.hand_id
   WHERE r.rake_method = 'WEIGHTED_CONTRIBUTED'
     AND r.hand_id IS NOT NULL
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND r.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))
   GROUP BY r.hand_id, r.rake_amount
  HAVING round(r.rake_amount - COALESCE(SUM(ra.weighted_rake_credit), 0), 2) <> 0;
$function$
