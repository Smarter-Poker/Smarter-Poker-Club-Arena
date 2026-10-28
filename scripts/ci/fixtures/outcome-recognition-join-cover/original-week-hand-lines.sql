CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_hand_lines(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS TABLE(hand_accepted_rake text, hand_participants jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT h.accepted_rake,
   CASE WHEN h.shaped AND cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_touch(h) ELSE COALESCE(gift.evidence->'participants',h.participants) END
   FROM public.union_pnl_cash_outcome_touches h
   LEFT JOIN public.union_pnl_cash_outcomes original ON original.table_id=h.table_id AND original.hand_number=h.hand_number
   LEFT JOIN LATERAL (SELECT CASE WHEN original.evidence->>'status'='blocked' AND original.recognized_at=h.recognized_at AND original.game_scope->>'game_union_id'=h.game_union_id AND original.evidence->>'accepted_rake'=h.accepted_rake AND public.fn_union_pnl_compact_participants(original.evidence->'participants')=h.participants THEN smarter_private.original_treasury_cash_outcome_evidence(to_jsonb(original)) END evidence) gift ON true
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(h.table_id,h.hand_number)
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end;
 ELSE
  RETURN QUERY SELECT COALESCE(gift.evidence,o.evidence)->>'accepted_rake',
   CASE WHEN cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_participants(o) ELSE COALESCE(gift.evidence,o.evidence)->'participants' END
   FROM public.union_pnl_cash_outcomes o
   CROSS JOIN LATERAL (SELECT CASE WHEN o.evidence->>'status'='blocked' THEN smarter_private.original_treasury_cash_outcome_evidence(to_jsonb(o)) END evidence) gift
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(o.table_id,o.hand_number)
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end;
 END IF;
END $function$
