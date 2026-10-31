CREATE OR REPLACE FUNCTION public.fn_ca_diamond_register_vs_supply()
 RETURNS TABLE(register_net numeric, meter_total numeric, player_diamonds numeric, house_diamonds numeric, difference numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH r AS (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) AS net
               FROM public.ca_mint_ledger WHERE asset = 'diamonds'),
       p AS (SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0)::numeric AS held FROM public.profiles),
       h AS (SELECT COALESCE(SUM(COALESCE(balance, 0)), 0)::numeric AS held FROM public.ca_diamond_house)
  SELECT round(r.net, 2), round(p.held + h.held + public.fn_ca_arena_diamonds(), 2), round(p.held, 2), round(h.held, 2),
         round(p.held + h.held + public.fn_ca_arena_diamonds() - r.net, 2)
    FROM r, p, h;
$function$

