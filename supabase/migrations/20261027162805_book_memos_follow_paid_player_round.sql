-- @live-proof: md5(pg_get_functiondef('public.fn_accounting_close_report_memo_key(uuid,timestamptz,timestamptz)'::regprocedure))='28364d8f001236b1d0aefdf4aa2246fa'
BEGIN;
SET LOCAL lock_timeout='2s';
DO $pre$ BEGIN IF md5(pg_get_functiondef('public.fn_accounting_close_report_memo_key(uuid,timestamptz,timestamptz)'::regprocedure))<>'ce1e8a66821765df65671d22c26e81da'THEN RAISE EXCEPTION 'book_memo_after_r3_preimage_changed';END IF;END $pre$;
CREATE OR REPLACE FUNCTION public.fn_accounting_close_report_memo_key(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, OUT generation text, OUT memo_key text)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
 -- Book memo eligibility follows the completed original player round. This
 -- does not authorize any financial or book transition: the original later
 -- P&L generation, report/source checks and fee-stage guards still decide.
 IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
  WHERE r.scope_kind='union'AND r.scope_id=p_union_id AND r.union_id=p_union_id
   AND r.standalone_club_id IS NULL AND r.period_start=p_start AND r.period_end=p_end
   AND r.round_no=3 AND r.routing_version=3 AND r.completed_at IS NOT NULL
   AND r.source_fingerprint~'^[0-9a-f]{32}$'
   AND r.result->>'success'='true'AND r.result->>'round'='3'
   AND r.result->>'routing_version'='3'AND r.result->>'source_version'='2'
   AND r.result->>'source_contract_version'='3'AND r.result->>'shortfalls'='0'
   AND r.result->>'scope_kind'='union'AND r.result->>'scope_id'=p_union_id::text)THEN
  generation:=NULL;memo_key:=NULL;RETURN;
 END IF;
 IF p_union_id='fade0000-0000-0000-0000-000000000001'::uuid AND p_end>='2026-10-12 07:00:00Z'::timestamptz THEN
  generation:=COALESCE(smarter_private.original_inventory_basis_generation(),'original-inventory-245:unqualified');
 END IF;
 memo_key:=CASE WHEN generation='original-inventory-245:unqualified' THEN NULL
   ELSE COALESCE(generation||'|','')||p_union_id::text||'|'||p_start::text||'|'||p_end::text END;
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_report_memo_key(uuid,timestamptz,timestamptz)FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_report_memo_key(uuid,timestamptz,timestamptz)TO service_role;
DO $post$ BEGIN IF NOT(md5(pg_get_functiondef('public.fn_accounting_close_report_memo_key(uuid,timestamptz,timestamptz)'::regprocedure))='28364d8f001236b1d0aefdf4aa2246fa')THEN RAISE EXCEPTION 'book_memo_after_r3_postimage_changed';END IF;END $post$;
COMMIT;
