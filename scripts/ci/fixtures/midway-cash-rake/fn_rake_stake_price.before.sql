CREATE OR REPLACE FUNCTION public.fn_rake_stake_price(p_bb numeric, p_sb numeric DEFAULT NULL::numeric)
 RETURNS TABLE(rake_percent numeric, rake_cap numeric, bbj_fee_bb numeric, scheduled boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT s.rake_percent, s.rake_cap, s.bbj_fee_bb, true
    FROM public.ca_rake_schedule s
   WHERE s.source = 'engine_mirror'
     AND abs(s.bb - p_bb) < 0.001
     AND (p_sb IS NULL OR abs(s.sb - p_sb) < 0.001)
   ORDER BY s.sb
   LIMIT 1;
$function$
