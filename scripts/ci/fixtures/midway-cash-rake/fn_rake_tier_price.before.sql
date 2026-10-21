CREATE OR REPLACE FUNCTION public.fn_rake_tier_price(p_bb numeric)
 RETURNS TABLE(rake_percent numeric, rake_cap numeric, bbj_fee_bb numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT t.rake_percent,
         CASE WHEN p_bb > 0
              THEN LEAST(t.rake_cap, round(p_bb * public.fn_unscheduled_cap_bb(), 2))
              ELSE t.rake_cap END,
         t.bbj_fee_bb
    FROM public.ca_rake_tier t
   WHERE t.max_bb IS NULL OR p_bb <= t.max_bb
   ORDER BY t.max_bb ASC NULLS LAST
   LIMIT 1;
$function$
