-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure))='80a4d9307b599fecc5f16874a61f6304')
-- @live-proof: (SELECT count(*)=1 AND bool_and(md5(pg_get_functiondef(oid))='4d7431e0be2290bb7ebf84df286119d4' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb)'))
-- A signed original may have a qualified card-free retained representation.
-- Keep every accounting proof clause; change only its two request hash readers.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE p pg_proc; h pg_proc;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure;
 SELECT * INTO h FROM pg_proc WHERE oid='smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM 'd206687c92bd2e66c94bde8bcb63dbb9'
 OR p.proowner<>'postgres'::regrole OR p.prosecdef
 OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp','TimeZone=UTC']
 OR md5(pg_get_functiondef(h.oid)) IS DISTINCT FROM '1b2960aedb5878428409fafb8242bb06'
 OR h.proowner<>'postgres'::regrole OR NOT h.prosecdef
 OR h.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
 OR h.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
 OR to_regprocedure('public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'SIGNED_CASH_RETAINED_READER_PREIMAGE_CHANGED'; END IF;
END $guard$;
CREATE FUNCTION public.fn_cash_signed_retained_request_matches(p_table uuid,p_number bigint,p_hash text,p_request jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
 SELECT p_table IS NOT NULL AND p_number IS NOT NULL AND p_hash IS NOT NULL AND p_request IS NOT NULL
 AND EXISTS(SELECT 1 FROM public.cash_hand_provenance_receipts p WHERE p.table_id=p_table AND p.hand_number=p_number
  AND p.payload_hash IS NOT DISTINCT FROM p_hash AND p.accepted_request IS NOT DISTINCT FROM p_request
  AND smarter_private.horse_cash_retained_request_matches(p_table,p_number,p_hash,p_request))
$fn$;
ALTER FUNCTION public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb) TO service_role;
DO $reader$
DECLARE source text; metadata jsonb; actual jsonb;
 current_anchor text:='encode(extensions.digest(convert_to(p.accepted_request::text,''UTF8''),''sha256''),''hex'') IS DISTINCT FROM p.payload_hash';
 previous_anchor text:='encode(extensions.digest(convert_to(prev_receipt.accepted_request::text,''UTF8''),''sha256''),''hex'') IS DISTINCT FROM prev_receipt.payload_hash';
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig)
 INTO source,metadata FROM pg_proc WHERE oid='public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure;
 IF (length(source)-length(replace(source,current_anchor,'')))/length(current_anchor)<>1
 OR (length(source)-length(replace(source,previous_anchor,'')))/length(previous_anchor)<>1
 THEN RAISE EXCEPTION 'SIGNED_CASH_RETAINED_READER_ANCHOR_CHANGED'; END IF;
 source:=replace(source,current_anchor,'NOT public.fn_cash_signed_retained_request_matches(p_table_id,p_hand_number,p.payload_hash,p.accepted_request)');
 source:=replace(source,previous_anchor,'NOT public.fn_cash_signed_retained_request_matches(p_table_id,prev_hn,prev_receipt.payload_hash,prev_receipt.accepted_request)');
 EXECUTE source;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual
 FROM pg_proc WHERE oid='public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'SIGNED_CASH_RETAINED_READER_AUTHORITY_CHANGED'; END IF;
END $reader$;
COMMIT;
