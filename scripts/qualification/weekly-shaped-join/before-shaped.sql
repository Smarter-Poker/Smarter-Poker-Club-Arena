CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_shaped_hands(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS SETOF union_pnl_cash_outcomes
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY WITH candidates AS MATERIALIZED (
   SELECT q.* FROM public.union_pnl_cash_outcomes q
   WHERE q.game_scope->>'game_union_id'=p_union_id::text AND q.recognized_at>=p_start AND q.recognized_at<p_end
    AND (q.evidence->>'status' IS DISTINCT FROM 'ready' OR q.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
     OR q.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR q.evidence->'game_scope' IS DISTINCT FROM q.game_scope)
  ) SELECT o.* FROM candidates o
   WHERE (SELECT CASE WHEN h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end
    THEN h.shaped ELSE false END FROM public.union_pnl_cash_outcome_touches h
    WHERE h.table_id=o.table_id AND h.hand_number=o.hand_number) IS TRUE;
 ELSE
  RETURN QUERY SELECT o.* FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
   AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
    OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);
 END IF;
END $function$
