CREATE OR REPLACE FUNCTION public.fn_cash_source_refusals_for_period(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE problems jsonb;
BEGIN
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from)
  OR NOT isfinite(p_to) OR p_to<=p_from THEN RAISE EXCEPTION 'invalid_cash_refusal_scope' USING ERRCODE='22023'; END IF;
 -- Read only the receipt's compact indexed identity, scope and time before
 -- fetching its reason. MATERIALIZED keeps the final detail fetch outside
 -- the global blocked queue walk; no status, scope or period test is omitted.
 WITH scoped_refusals AS MATERIALIZED (
  SELECT r.id
  FROM public.accounting_cash_source_work w
  JOIN LATERAL (
   SELECT x.id,x.earned_at,x.scope FROM public.accounting_cash_source_receipts x
   WHERE x.id=w.receipt_id OFFSET 0
  ) r ON true
  WHERE w.status='blocked' AND (NOT isfinite(r.earned_at) OR(r.earned_at>=p_from AND r.earned_at<p_to))
  AND(r.scope->>'kind'='unknown' OR(r.scope->>'kind'='union' AND r.scope->>'id'=p_union_id::text)
   OR(r.scope->>'kind'='club' AND r.scope->>'id'=p_club_id::text))
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('rake_record_id',r.rake_record_id,'reason',r.reason,'scope',r.scope)
  ORDER BY r.rake_record_id),'[]'::jsonb) INTO problems
 FROM scoped_refusals s JOIN public.accounting_cash_source_receipts r ON r.id=s.id;
 RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(problems)=0 THEN 'ready' ELSE 'blocked' END,
  'count',jsonb_array_length(problems),'sources',problems);
END $function$
