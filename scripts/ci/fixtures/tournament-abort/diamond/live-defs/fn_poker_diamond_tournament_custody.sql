-- live_md5 b2a879b0e870447f2734b6179fe5fac3
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_custody(p_tournament_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(sum(balance),0)::bigint FROM public.poker_diamond_custody
   WHERE purpose = 'tournament_entry' AND target_id = p_tournament_id AND state <> 'released';
$function$

