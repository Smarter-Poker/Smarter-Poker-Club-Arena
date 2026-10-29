DO $cash_owner$DECLARE p pg_proc%ROWTYPE;BEGIN SELECT*INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('fn_cash_source_refusals_for_period(uuid,uuid,timestamp with time zone,timestamp with time zone)');IF pg_get_functiondef(p.oid)IS DISTINCT FROM $cash_def$CREATE OR REPLACE FUNCTION public.fn_cash_source_refusals_for_period(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
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
 WITH blocked_work AS MATERIALIZED (
 SELECT receipt_id FROM public.accounting_cash_source_work WHERE status='blocked'
), receipt_ids AS MATERIALIZED (
 SELECT array_agg(DISTINCT receipt_id) FILTER(WHERE receipt_id IS NOT NULL) AS ids FROM blocked_work
), scoped_receipts AS MATERIALIZED (
 SELECT x.id FROM public.accounting_cash_source_receipts x
 WHERE x.id=ANY((SELECT ids FROM receipt_ids)::uuid[])
 AND (NOT isfinite(x.earned_at) OR(x.earned_at>=p_from AND x.earned_at<p_to))
 AND(x.scope->>'kind'='unknown' OR(x.scope->>'kind'='union' AND x.scope->>'id'=p_union_id::text)
  OR(x.scope->>'kind'='club' AND x.scope->>'id'=p_club_id::text))
), scoped_refusals AS MATERIALIZED (
 SELECT r.id FROM blocked_work w JOIN scoped_receipts r ON r.id=w.receipt_id
)
SELECT COALESCE(jsonb_agg(jsonb_build_object('rake_record_id',r.rake_record_id,'reason',r.reason,'scope',r.scope)
 ORDER BY r.rake_record_id),'[]'::jsonb) INTO problems
FROM scoped_refusals s JOIN public.accounting_cash_source_receipts r ON r.id=s.id;
 RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(problems)=0 THEN 'ready' ELSE 'blocked' END,
  'count',jsonb_array_length(problems),'sources',problems);
END $function$
$cash_def$ OR to_jsonb(p)IS DISTINCT FROM $cash_meta${"oid":"34785794","proacl":["postgres=X/postgres"],"probin":null,"prosrc":"\nDECLARE problems jsonb;\nBEGIN\n IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from)\n  OR NOT isfinite(p_to) OR p_to<=p_from THEN RAISE EXCEPTION 'invalid_cash_refusal_scope' USING ERRCODE='22023'; END IF;\n -- Read only the receipt's compact indexed identity, scope and time before\n -- fetching its reason. MATERIALIZED keeps the final detail fetch outside\n -- the global blocked queue walk; no status, scope or period test is omitted.\n WITH blocked_work AS MATERIALIZED (\n SELECT receipt_id FROM public.accounting_cash_source_work WHERE status='blocked'\n), receipt_ids AS MATERIALIZED (\n SELECT array_agg(DISTINCT receipt_id) FILTER(WHERE receipt_id IS NOT NULL) AS ids FROM blocked_work\n), scoped_receipts AS MATERIALIZED (\n SELECT x.id FROM public.accounting_cash_source_receipts x\n WHERE x.id=ANY((SELECT ids FROM receipt_ids)::uuid[])\n AND (NOT isfinite(x.earned_at) OR(x.earned_at>=p_from AND x.earned_at<p_to))\n AND(x.scope->>'kind'='unknown' OR(x.scope->>'kind'='union' AND x.scope->>'id'=p_union_id::text)\n  OR(x.scope->>'kind'='club' AND x.scope->>'id'=p_club_id::text))\n), scoped_refusals AS MATERIALIZED (\n SELECT r.id FROM blocked_work w JOIN scoped_receipts r ON r.id=w.receipt_id\n)\nSELECT COALESCE(jsonb_agg(jsonb_build_object('rake_record_id',r.rake_record_id,'reason',r.reason,'scope',r.scope)\n ORDER BY r.rake_record_id),'[]'::jsonb) INTO problems\nFROM scoped_refusals s JOIN public.accounting_cash_source_receipts r ON r.id=s.id;\n RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(problems)=0 THEN 'ready' ELSE 'blocked' END,\n  'count',jsonb_array_length(problems),'sources',problems);\nEND ","procost":100,"prokind":"f","prolang":"13573","proname":"fn_cash_source_refusals_for_period","prorows":0,"pronargs":4,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_club_id","p_from","p_to"],"proargtypes":["2950","2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$cash_meta$::jsonb THEN RAISE EXCEPTION 'cash_refusal_owner_changed';END IF;END$cash_owner$;
