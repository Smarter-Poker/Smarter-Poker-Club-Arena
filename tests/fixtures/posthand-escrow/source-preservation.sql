DO $test$DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure);
 definition:=replace(definition,'DECLARE v_posthand_original jsonb; a public.hand_atomic_commits%ROWTYPE;','DECLARE a public.hand_atomic_commits%ROWTYPE;');
 definition:=replace(definition,E' v_posthand_original:=smarter_private.posthand_escrow_certified_evidence(p_table_id,p_hand_number);\n IF v_posthand_original IS NOT NULL THEN RETURN v_posthand_original;END IF;\n','');
 IF md5(definition)<>'d713d072b45e30b81cc52ef90ae77f6b' THEN RAISE EXCEPTION 'ordinary financial clauses changed outside explicit qualified class';END IF;
 IF md5(pg_get_functiondef('smarter_private.horse_cash_retention_accounting_ready(uuid,bigint)'::regprocedure))<>'508d86122924b351e8b04a588f8bc894'
 OR md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))<>'379f83a598ff822ce30f25647bcf9bd1' THEN RAISE EXCEPTION 'private retention owner source changed';END IF;
 IF has_function_privilege('anon','public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text)','EXECUTE')
 OR has_table_privilege('service_role','smarter_private.posthand_escrow_certificates','SELECT')
 OR has_table_privilege('anon','smarter_private.posthand_escrow_certificates','SELECT')
 OR has_table_privilege('authenticated','smarter_private.posthand_escrow_certificates','SELECT')
 OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='smarter_private.posthand_escrow_certificates'::regclass AND relrowsecurity AND relowner='postgres'::regrole)
 THEN RAISE EXCEPTION 'posthand original certificate role/RLS authority differs';END IF;
 RAISE NOTICE 'PASS every other financial clause byte-identical; original private retention/source preserved; private RLS/writer ACL exact';
END $test$;
