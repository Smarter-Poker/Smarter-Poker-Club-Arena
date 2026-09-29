CREATE OR REPLACE FUNCTION public.fn_satellite_target_is_deliverable(p_target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Mirrors the admission refusal in fn_settle_satellite_tournament_pre_money_path_gate
  -- exactly: every flag must be a known false, and neither Spin spelling.
  -- A missing target is not deliverable either (the authority refuses it).
  SELECT COALESCE((
    SELECT t.is_bounty IS FALSE
       AND t.is_pko IS FALSE
       AND t.is_mystery_bounty IS FALSE
       AND t.is_premium_spin IS FALSE
       AND lower(COALESCE(t.variant, '')) <> 'spin'
       AND upper(COALESCE(t.tournament_type, '')) <> 'SPIN'
      FROM public.tournaments t
     WHERE t.id = p_target_id
  ), false)
$function$

