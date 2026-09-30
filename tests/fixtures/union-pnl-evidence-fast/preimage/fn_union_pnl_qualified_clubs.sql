CREATE FUNCTION public.fn_union_pnl_qualified_clubs(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE proof jsonb;
BEGIN
 proof:=public.fn_union_pnl_evidence_report(p_union_id,p_start,p_end);
 IF proof->'report_version' IS DISTINCT FROM '1'::jsonb OR proof->>'status' IS DISTINCT FROM 'ready'
  OR proof->'basis_certified' IS DISTINCT FROM 'true'::jsonb OR proof->'issues' IS DISTINCT FROM '[]'::jsonb THEN
  RAISE EXCEPTION 'union_pnl_basis_uncertified' USING ERRCODE='55000',DETAIL=COALESCE((proof->'issues')::text,'missing proof');
 END IF;
 RETURN proof;
END $$
