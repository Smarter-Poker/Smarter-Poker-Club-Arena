CREATE OR REPLACE FUNCTION public.fn_union_pnl_linked_cash_outcomes(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(table_id uuid, hand_number bigint, game_scope jsonb, evidence jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ BEGIN PERFORM 1 FROM public.union_pnl_cash_outcome_link_resolutions LIMIT 0; IF NOT EXISTS(SELECT FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.union_pnl_cash_outcome_link_resolutions'::regclass AND c.conname='union_pnl_cash_outcome_link_resolutions_check' AND c.contype='c' AND c.convalidated AND pg_catalog.pg_get_constraintdef(c.oid)='CHECK ((proof_md5 = md5((proof)::text)))') OR (SELECT count(*)FROM pg_catalog.pg_attribute WHERE attrelid='public.union_pnl_cash_outcome_link_resolutions'::regclass AND attname IN('proof','proof_md5')AND attnotnull AND NOT attisdropped)<>2 THEN RAISE EXCEPTION 'linked_proof_contract_changed';END IF; RETURN QUERY EXECUTE $query$
 SELECT r.table_id,r.hand_number,r.game_scope,r.evidence
 FROM public.union_pnl_cash_outcome_link_resolutions r
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=r.table_id AND o.hand_number=r.hand_number
 WHERE r.game_scope->>'game_union_id'=$1::text AND o.recognized_at>=$2 AND o.recognized_at<$3
  AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text)
  
$query$ USING p_union_id,p_start,p_end;END $function$
