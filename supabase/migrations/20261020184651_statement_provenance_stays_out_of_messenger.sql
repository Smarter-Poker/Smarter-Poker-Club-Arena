-- Original invoice provenance stays on the document, never in Messenger delivery copies.
-- @live-proof: md5(pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure))='24cffb644a4ccad0daf4de38cbc20887' AND md5(pg_get_functiondef('public.fn_messenger_message_page(uuid,uuid,timestamp with time zone,uuid,integer)'::regprocedure))='dbf4643e5bf076d4a8923fa7c167658e' AND md5(pg_get_functiondef('public.fn_messenger_search_messages(uuid,uuid[],text,integer)'::regprocedure))='18a3e870828691932112ebb24539994d'
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $patch$
DECLARE d text; p regprocedure;
BEGIN
 p:='public.fn_deliver_accounting_invoice(uuid)'::regprocedure;
 IF md5(pg_get_functiondef(p)) IS DISTINCT FROM '8419aac1cd0ed1e30ac68621fb95823d' THEN RAISE EXCEPTION 'statement_delivery_preimage_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=p AND proowner='postgres'::regrole AND prosecdef AND provolatile='v' AND proconfig=ARRAY['search_path=public'] AND ARRAY(SELECT x::text FROM unnest(proacl)x ORDER BY 1)=ARRAY(SELECT x::text FROM unnest('{postgres=X/postgres,service_role=X/postgres}'::aclitem[])x ORDER BY 1)) THEN RAISE EXCEPTION 'statement_delivery_authority_changed'; END IF;
 d:=pg_get_functiondef(p);
 IF (length(d)-length(replace(d,'''lines'',inv.breakdown-ARRAY[''source_ledger_ids'',''private_bank_ledger_ids'']','')))/length('''lines'',inv.breakdown-ARRAY[''source_ledger_ids'',''private_bank_ledger_ids'']')<>1 THEN RAISE EXCEPTION 'statement_delivery_fragment_changed'; END IF;
 EXECUTE replace(d,$old$'lines',inv.breakdown-ARRAY['source_ledger_ids','private_bank_ledger_ids']$old$,$new$'lines',inv.breakdown-ARRAY['source_ledger_ids','private_bank_ledger_ids','standalone_bank_ledger_ids','standalone_bank_mint_ids']$new$);
 IF md5(pg_get_functiondef(p)) IS DISTINCT FROM '24cffb644a4ccad0daf4de38cbc20887' THEN RAISE EXCEPTION 'statement_delivery_postimage_required'; END IF;
 p:='public.fn_messenger_message_page(uuid,uuid,timestamp with time zone,uuid,integer)'::regprocedure;
 IF md5(pg_get_functiondef(p)) IS DISTINCT FROM 'fa1d6d8d1f40d51d3ff023b9b9a60879' THEN RAISE EXCEPTION 'statement_delivery_preimage_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=p AND proowner='postgres'::regrole AND prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public'] AND ARRAY(SELECT x::text FROM unnest(proacl)x ORDER BY 1)=ARRAY(SELECT x::text FROM unnest('{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'::aclitem[])x ORDER BY 1)) THEN RAISE EXCEPTION 'statement_delivery_authority_changed'; END IF;
 d:=pg_get_functiondef(p);
 IF (length(d)-length(replace(d,' #- ''{lines,private_bank_ledger_ids}''::text[] #- ''{lines,source_ledger_ids}''::text[]','')))/length(' #- ''{lines,private_bank_ledger_ids}''::text[] #- ''{lines,source_ledger_ids}''::text[]')<>1 THEN RAISE EXCEPTION 'statement_delivery_fragment_changed'; END IF;
 EXECUTE replace(d,$old$ #- '{lines,private_bank_ledger_ids}'::text[] #- '{lines,source_ledger_ids}'::text[]$old$,$new$ #- '{lines,private_bank_ledger_ids}'::text[] #- '{lines,source_ledger_ids}'::text[] #- '{lines,standalone_bank_ledger_ids}'::text[] #- '{lines,standalone_bank_mint_ids}'::text[]$new$);
 IF md5(pg_get_functiondef(p)) IS DISTINCT FROM 'dbf4643e5bf076d4a8923fa7c167658e' THEN RAISE EXCEPTION 'statement_delivery_postimage_required'; END IF;
 p:='public.fn_messenger_search_messages(uuid,uuid[],text,integer)'::regprocedure;
 IF md5(pg_get_functiondef(p)) IS DISTINCT FROM '2a72b3863c46f8b7d5e0c3b6a7585e29' THEN RAISE EXCEPTION 'statement_delivery_preimage_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=p AND proowner='postgres'::regrole AND prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public'] AND ARRAY(SELECT x::text FROM unnest(proacl)x ORDER BY 1)=ARRAY(SELECT x::text FROM unnest('{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'::aclitem[])x ORDER BY 1)) THEN RAISE EXCEPTION 'statement_delivery_authority_changed'; END IF;
 d:=pg_get_functiondef(p);
 IF (length(d)-length(replace(d,' #- ''{lines,private_bank_ledger_ids}''::text[] #- ''{lines,source_ledger_ids}''::text[]','')))/length(' #- ''{lines,private_bank_ledger_ids}''::text[] #- ''{lines,source_ledger_ids}''::text[]')<>1 THEN RAISE EXCEPTION 'statement_delivery_fragment_changed'; END IF;
 EXECUTE replace(d,$old$ #- '{lines,private_bank_ledger_ids}'::text[] #- '{lines,source_ledger_ids}'::text[]$old$,$new$ #- '{lines,private_bank_ledger_ids}'::text[] #- '{lines,source_ledger_ids}'::text[] #- '{lines,standalone_bank_ledger_ids}'::text[] #- '{lines,standalone_bank_mint_ids}'::text[]$new$);
 IF md5(pg_get_functiondef(p)) IS DISTINCT FROM '18a3e870828691932112ebb24539994d' THEN RAISE EXCEPTION 'statement_delivery_postimage_required'; END IF;
END $patch$;
-- Preserve existing service-only writer and authenticated private-reader authority.
REVOKE ALL ON FUNCTION public.fn_deliver_accounting_invoice(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer),public.fn_messenger_search_messages(uuid,uuid[],text,integer) FROM PUBLIC,anon;
COMMIT;
