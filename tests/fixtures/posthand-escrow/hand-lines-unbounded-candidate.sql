-- Previous unmerged candidate, retained native query counterexample only.
CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_hand_lines(p_union_id uuid,p_start timestamptz,p_end timestamptz,p_projected boolean)
RETURNS TABLE(hand_accepted_rake text,hand_participants jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT h.accepted_rake,
   CASE WHEN h.shaped THEN public.fn_union_pnl_posthand_escrow_touch(h) ELSE h.participants END
   FROM public.union_pnl_cash_outcome_touches h
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end;
 ELSE
  RETURN QUERY SELECT o.evidence->>'accepted_rake',
   CASE WHEN o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
     OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope
    THEN public.fn_union_pnl_posthand_escrow_participants(o) ELSE o.evidence->'participants' END
   FROM public.union_pnl_cash_outcomes o
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end;
 END IF;
END $function$;
