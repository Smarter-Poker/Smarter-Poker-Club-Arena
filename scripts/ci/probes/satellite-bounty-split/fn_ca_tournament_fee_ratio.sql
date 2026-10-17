CREATE OR REPLACE FUNCTION public.fn_ca_tournament_fee_ratio(p_buy_in numeric, p_buy_in_fee numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN COALESCE(p_buy_in,0) + COALESCE(p_buy_in_fee,0) > 0
         AND COALESCE(p_buy_in_fee,0) > 0
      THEN p_buy_in_fee / (p_buy_in + p_buy_in_fee)
    ELSE 0.1
  END;
$function$
