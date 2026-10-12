CREATE FUNCTION public.fn_union_pnl_cash_outcome_accepted(o public.union_pnl_cash_outcomes)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT o.evidence->'all_players_included' IS NOT DISTINCT FROM 'true'::jsonb
  AND o.evidence->'game_scope' IS NOT DISTINCT FROM o.game_scope
  AND ((o.evidence->>'status' IS NOT DISTINCT FROM 'ready' AND o.evidence->'basis_certified' IS NOT DISTINCT FROM 'true'::jsonb)
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_resolutions r WHERE r.table_id=o.table_id AND r.hand_number=o.hand_number
    AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text)))
$function$
