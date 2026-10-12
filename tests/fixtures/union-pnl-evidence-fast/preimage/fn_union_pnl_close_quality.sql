CREATE OR REPLACE FUNCTION public.fn_union_pnl_close_quality(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE evidence jsonb;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_start<'2026-09-07 07:00:00+00'::timestamptz OR p_end<=p_start OR p_end>statement_timestamp()
  OR p_end-p_start>interval '8 days' THEN
  RETURN jsonb_build_object('status','blocked','reason','pnl_requires_closed_supported_period','issues',jsonb_build_array('invalid_pnl_evidence_period'));
 END IF;
 evidence:=public.fn_union_pnl_evidence_report(p_union_id,p_start,p_end);
 IF evidence->'report_version' IS DISTINCT FROM '1'::jsonb
  OR evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR evidence->'issues' IS DISTINCT FROM '[]'::jsonb THEN
  -- No player identities, source amounts, balances or invoice contents cross
  -- this gate. Callers retain their original authorization before evaluation.
  RETURN jsonb_build_object('status','blocked','reason','union_pnl_basis_uncertified',
   'issues',CASE WHEN jsonb_typeof(evidence->'issues')='array' THEN evidence->'issues'
    ELSE jsonb_build_array('pnl_evidence_contract_missing') END);
 END IF;
 RETURN jsonb_build_object('status','ready','issues','[]'::jsonb);
END $function$
