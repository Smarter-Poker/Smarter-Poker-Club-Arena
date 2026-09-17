-- SOURCE ONLY / UNRUN. Run within the one successor transaction after all fragments.
DO $credit_document_postconditions$
DECLARE expected jsonb;target oid;who text;col text;actual jsonb;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($pins$[{"signature":"public.fn_accounting_credit_change_immutable_v1()","md5":"e52fcbd89007bef2df9019a17cb9385a","returns":"trigger","argument_names":null,"security_definer":false,"config":["search_path=pg_catalog"]},{"signature":"public.fn_accounting_credit_change_payload_v1(uuid)","md5":"d69ab1877cc2a92a43f2b823f619abe3","returns":"jsonb","argument_names":["p_document_id"],"security_definer":true,"config":["datestyle=iso,ymd","search_path=public","timezone=utc"]},{"signature":"public.fn_accounting_credit_change_contract_v1(uuid)","md5":"73a0e5343d9004f3dc088b79df8a74f1","returns":"jsonb","argument_names":["p_invoice_id"],"security_definer":true,"config":["datestyle=iso,ymd","search_path=public","timezone=utc"]},{"signature":"public.fn_accounting_credit_change_body_v1(uuid,text)","md5":"656363b1938b4ce522b5cc4a8414c4b4","returns":"text","argument_names":["p_document_id","p_invoice_number"],"security_definer":true,"config":["search_path=public"]},{"signature":"public.fn_accounting_credit_reduction_assert_document(uuid)","md5":"05f6a673ad86acccf43d42c87a38d08c","returns":"jsonb","argument_names":["p_operation_receipt_id"],"security_definer":true,"config":["datestyle=iso,ymd","search_path=public","timezone=utc"]},{"signature":"public.fn_accounting_credit_change_on_operation_v1()","md5":"895a34b7a4a100c6c34c6fcef2ee9ae7","returns":"trigger","argument_names":null,"security_definer":true,"config":["datestyle=iso,ymd","search_path=public","timezone=utc"]},{"signature":"public.fn_accounting_credit_change_deferred_v1()","md5":"714f4d682b5c547aa6ffc86d418a6bb4","returns":"trigger","argument_names":null,"security_definer":true,"config":["search_path=public"]}]$pins$::jsonb) LOOP
  target:=to_regprocedure(expected->>'signature');
  IF target IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
    AND prosecdef=(expected->>'security_definer')::boolean AND md5(prosrc)=expected->>'md5'
    AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND prokind='f' AND provolatile='v'
    AND NOT proisstrict AND NOT proleakproof AND proparallel='u' AND NOT proretset AND pronargdefaults=0
    AND prorettype=(expected->>'returns')::regtype
    AND COALESCE(to_jsonb(proargnames),'null'::jsonb)=expected->'argument_names'
    AND (SELECT jsonb_agg(value ORDER BY value) FROM (SELECT lower(regexp_replace(c,'[[:space:]]','','g')) AS value FROM unnest(proconfig)c)x)=expected->'config')
   OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=target)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::text[]
  THEN RAISE EXCEPTION 'credit_change_helper_postcondition_changed' USING DETAIL=expected->>'signature';END IF;
  FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(who,target,'EXECUTE') THEN RAISE EXCEPTION 'credit_change_helper_exposed' USING DETAIL=who||':'||(expected->>'signature');END IF;
  END LOOP;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.accounting_credit_change_documents_v1'::regclass
  AND relkind='r' AND relowner='postgres'::regrole AND relrowsecurity AND NOT relforcerowsecurity AND reloptions IS NULL)
  OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl)a WHERE c.oid='public.accounting_credit_change_documents_v1'::regclass)
   IS DISTINCT FROM ARRAY['postgres=arwdDxtm/postgres']::text[]
 THEN RAISE EXCEPTION 'credit_change_private_table_changed';END IF;
 SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
  pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,a.attacl) ORDER BY a.attnum) INTO actual
 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid='public.accounting_credit_change_documents_v1'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $columns$[["id","uuid",true,null,"","",null],["invoice_id","uuid",true,null,"","",null],["operation_receipt_id","uuid",true,null,"","",null],["issuer_name","text",true,null,"","",null],["recipient_name","text",true,null,"","",null],["audience_user_ids","uuid[]",true,null,"","",null],["issued_at","timestamp with time zone",true,null,"","",null]]$columns$::jsonb
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.accounting_credit_change_documents_v1'::regclass)
  OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class='public.accounting_credit_change_documents_v1'::regclass)
 THEN RAISE EXCEPTION 'credit_change_private_shape_changed';END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.accounting_credit_change_documents_v1'::regclass)<>5
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.accounting_credit_change_documents_v1'::regclass
    AND contype='p' AND conkey=ARRAY[1]::smallint[] AND convalidated AND NOT condeferrable)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.accounting_credit_change_documents_v1'::regclass
    AND contype='u' AND conkey=ARRAY[2]::smallint[] AND convalidated AND NOT condeferrable)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.accounting_credit_change_documents_v1'::regclass
    AND contype='u' AND conkey=ARRAY[3]::smallint[] AND convalidated AND NOT condeferrable)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.accounting_credit_change_documents_v1'::regclass
    AND contype='f' AND conname='credit_change_document_invoice_fk' AND conkey=ARRAY[2]::smallint[]
    AND confrelid='public.settlement_invoices'::regclass AND confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.settlement_invoices'::regclass AND attname='id')]::smallint[]
    AND confupdtype='a' AND confdeltype='a' AND confmatchtype='s' AND convalidated AND condeferrable AND condeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.accounting_credit_change_documents_v1'::regclass
    AND contype='c' AND conname='credit_change_document_audience_nonempty' AND convalidated
    AND pg_get_constraintdef(oid)='CHECK ((cardinality(audience_user_ids) > 0))')
 THEN RAISE EXCEPTION 'credit_change_private_constraints_changed';END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.accounting_credit_change_documents_v1'::regclass AND NOT tgisinternal)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.accounting_credit_change_documents_v1'::regclass
   AND tgname='credit_change_document_immutable_v1' AND tgfoid='public.fn_accounting_credit_change_immutable_v1()'::regprocedure
   AND tgtype=58 AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred
   AND tgqual IS NULL AND tgnargs=0 AND tgattr=''::int2vector)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.accounting_credit_reduction_operations_v1'::regclass
   AND tgname='accounting_credit_change_on_operation_v1' AND tgfoid='public.fn_accounting_credit_change_on_operation_v1()'::regprocedure
   AND tgtype=5 AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred
   AND tgqual IS NULL AND tgnargs=0 AND tgattr=''::int2vector)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.accounting_credit_reduction_operations_v1'::regclass
   AND tgname='zz_accounting_credit_change_deferred_v1' AND tgfoid='public.fn_accounting_credit_change_deferred_v1()'::regprocedure
   AND tgtype=5 AND tgenabled='O' AND NOT tgisinternal AND tgdeferrable AND tginitdeferred
   AND tgqual IS NULL AND tgnargs=0 AND tgattr=''::int2vector)
 THEN RAISE EXCEPTION 'credit_change_document_trigger_changed';END IF;
 FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(who,'public.accounting_credit_change_documents_v1','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN')
  THEN RAISE EXCEPTION 'credit_change_private_table_exposed' USING DETAIL=who;END IF;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='public.accounting_credit_change_documents_v1'::regclass AND attnum>0 AND NOT attisdropped LOOP
   IF has_column_privilege(who,'public.accounting_credit_change_documents_v1',col,'SELECT,INSERT,UPDATE,REFERENCES')
   THEN RAISE EXCEPTION 'credit_change_private_column_exposed' USING DETAIL=who||':'||col;END IF;
  END LOOP;
 END LOOP;
END $credit_document_postconditions$;
