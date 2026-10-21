CREATE OR REPLACE FUNCTION public.fn_rake_cap_for_dealt(p_full_cap numeric, p_players_dealt integer, p_seats integer DEFAULT NULL::integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
           WHEN p_players_dealt >= r.short_handed_max_players + 1 THEN p_full_cap
           WHEN p_players_dealt >= r.short_handed_max_players     THEN
             CASE WHEN p_seats IS NULL OR p_seats <= 0 OR p_seats >= r.short_handed_min_seats
                  THEN round(p_full_cap * r.short_handed_cap_factor, 2)
                  ELSE p_full_cap END
           WHEN p_players_dealt >= 2                              THEN round(p_full_cap * r.heads_up_cap_factor, 2)
           ELSE p_full_cap
         END
    FROM public.ca_rake_rules r
   WHERE r.id = 1;
$function$
