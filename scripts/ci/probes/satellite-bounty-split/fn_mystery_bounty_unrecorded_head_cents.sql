CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_unrecorded_head_cents(p_tournament_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Heads earned by a bust the hand commit has proven (knockout candidate
  -- 'pending') that the claim door has not yet recorded (player still
  -- 'playing'). Same head expression as fn_claim_bounty_legacy_candidate_20260907
  -- and fn_collect_bounty, so the reserve is exactly what will be collected.
  SELECT COALESCE(sum(round(COALESCE(NULLIF(tp.current_bounty,0),
                                     t.bounty_amount, 0) * 100)), 0)::bigint
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'playing'
     AND EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.tournament_id = tp.tournament_id
          AND c.eliminated_user_id = tp.user_id
          AND c.state = 'pending');
$function$
