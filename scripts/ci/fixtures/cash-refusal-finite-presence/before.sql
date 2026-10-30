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
 WITH blocked_work AS MATERIALIZED (SELECT receipt_id FROM public.accounting_cash_source_work WHERE status='blocked'), scoped_refusals AS MATERIALIZED (
SELECT x.id FROM blocked_work w JOIN public.accounting_cash_source_receipts x ON x.id=w.receipt_id WHERE (CASE WHEN x.scope->>'kind'='unknown' THEN 'unknown' WHEN x.scope->>'kind' IN ('club','union') AND octet_length(x.scope->>'id')=36 THEN (x.scope->>'kind')||':'||(x.scope->>'id') END)=ANY(ARRAY['unknown','union:'||p_union_id::text,'club:'||p_club_id::text]) AND isfinite(x.earned_at) AND x.earned_at>=p_from AND x.earned_at<p_to
UNION ALL
SELECT x.id FROM blocked_work w JOIN public.accounting_cash_source_receipts x ON x.id=w.receipt_id WHERE (CASE WHEN x.scope->>'kind'='unknown' THEN 'unknown' WHEN x.scope->>'kind' IN ('club','union') AND octet_length(x.scope->>'id')=36 THEN (x.scope->>'kind')||':'||(x.scope->>'id') END)=ANY(ARRAY['unknown','union:'||p_union_id::text,'club:'||p_club_id::text]) AND x.earned_at=ANY(ARRAY['-infinity','infinity']::timestamptz[])
)
SELECT COALESCE(jsonb_agg(jsonb_build_object('rake_record_id',r.rake_record_id,'reason',r.reason,'scope',r.scope)
 ORDER BY r.rake_record_id),'[]'::jsonb) INTO problems
FROM scoped_refusals s JOIN public.accounting_cash_source_receipts r ON r.id=s.id;
 RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(problems)=0 THEN 'ready' ELSE 'blocked' END,
  'count',jsonb_array_length(problems),'sources',problems);
END $function$
