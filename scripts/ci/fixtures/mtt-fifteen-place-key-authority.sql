CREATE OR REPLACE FUNCTION public.fn_tournament_payout_key_is_place_evidence(p_tournament_id uuid, p_idempotency_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND p_idempotency_key LIKE
           'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
  );
$function$;
