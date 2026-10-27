CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_hand_lines(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS TABLE(hand_accepted_rake text, hand_participants jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT h.accepted_rake,
   CASE WHEN h.shaped AND cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_touch(h) ELSE h.participants END
   FROM public.union_pnl_cash_outcome_touches h
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(h.table_id,h.hand_number)
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end;
 ELSE
  RETURN QUERY SELECT o.evidence->>'accepted_rake',
   CASE WHEN cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_participants(o) ELSE o.evidence->'participants' END
   FROM public.union_pnl_cash_outcomes o
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(o.table_id,o.hand_number)
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end;
 END IF;
END $function$
