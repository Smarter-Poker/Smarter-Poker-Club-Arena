-- Batch compact receipt identities once, then rejoin the unchanged blocked pointer bag.
-- No receipt/work mutation, new index, accounting guard, or lifetime change.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $guard$
DECLARE p pg_proc%ROWTYPE;
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'cash_refusal_scope_set_install_frozen'; END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) <> '294935a386ce126757330f577631dafe'
 OR p.proowner <> 'postgres'::regrole OR p.proacl::text <> '{postgres=X/postgres}'
 OR NOT p.prosecdef OR p.provolatile <> 's' OR p.proconfig <> ARRAY['search_path=public']::text[]
 OR p.proisstrict OR p.proparallel <> 'u' THEN
 RAISE EXCEPTION 'cash_refusal_scope_set_preimage_changed'; END IF;
END $guard$;
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
;

REVOKE ALL ON FUNCTION public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
DO $verify$
DECLARE p pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) <> 'b4ca57c875ff41b0879bcbadc7bcbb63'
 OR p.proowner <> 'postgres'::regrole OR p.proacl::text <> '{postgres=X/postgres}'
 OR NOT p.prosecdef OR p.provolatile <> 's' OR p.proconfig <> ARRAY['search_path=public']::text[]
 OR p.proisstrict OR p.proparallel <> 'u' THEN
 RAISE EXCEPTION 'cash_refusal_scope_set_postimage_changed'; END IF;
END $verify$;
COMMIT;
