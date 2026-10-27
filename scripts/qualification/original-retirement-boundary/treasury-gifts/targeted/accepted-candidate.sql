CREATE OR REPLACE FUNCTION public.fn_union_pnl_cash_outcome_accepted(o union_pnl_cash_outcomes)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT effective.evidence->'all_players_included' IS NOT DISTINCT FROM 'true'::jsonb
  AND effective.evidence->'game_scope' IS NOT DISTINCT FROM o.game_scope
  AND ((effective.evidence->>'status' IS NOT DISTINCT FROM 'ready' AND effective.evidence->'basis_certified' IS NOT DISTINCT FROM 'true'::jsonb)
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_resolutions r WHERE r.table_id=o.table_id AND r.hand_number=o.hand_number
    AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text))
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes actual
     WHERE actual.table_id=o.table_id AND actual.hand_number=o.hand_number
      AND to_jsonb(actual) IS NOT DISTINCT FROM to_jsonb(o)
      AND smarter_private.posthand_escrow_certified_evidence(o.table_id,o.hand_number) IS NOT NULL))
 FROM LATERAL (SELECT COALESCE(CASE WHEN o.evidence->>'status'='blocked' THEN smarter_private.original_treasury_cash_outcome_evidence(to_jsonb(o)) END,o.evidence) evidence) effective
$function$
