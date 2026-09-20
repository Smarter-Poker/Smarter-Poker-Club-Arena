-- SOURCE ONLY / UNRUN. Exact post36 private readers; no alternate delivery authority.
-- Guard source bodies, headers, direct/effective grants before any rewrite.
DO $credit_reader_preimage$ DECLARE r record;who text;BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)','ef257fa1e068f020f06bceaa69a913dd','TABLE(id uuid, conversation_id uuid, sender_id uuid, content text, message_type text, media_metadata jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, is_deleted boolean, is_edited boolean, profiles jsonb)',3,true),
  ('public.fn_messenger_search_messages(uuid,uuid[],text,integer)','1abc215663e15d9d30b37209aab49b61','TABLE(id uuid, conversation_id uuid, sender_id uuid, content text, created_at timestamp with time zone, message_type text, media_metadata jsonb)',1,true),
  ('public.fn_messenger_invoice_visible_to(uuid,uuid)','2c309c90c6d11fd8cbb849d657b47091','boolean',0,false)
) AS expected(signature,body_md5,result,defaults,retset) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc x JOIN pg_language l ON l.oid=x.prolang WHERE x.oid=to_regprocedure(r.signature)
   AND md5(x.prosrc)=r.body_md5 AND x.proowner='postgres'::regrole AND x.prosecdef AND x.provolatile='s'
   AND x.proconfig=ARRAY['search_path=public'] AND x.prokind='f' AND l.lanname='plpgsql'
   AND NOT x.proisstrict AND NOT x.proleakproof AND x.proparallel='u' AND x.pronargdefaults=r.defaults
   AND x.proretset=r.retset AND pg_get_function_result(x.oid)=r.result
   AND pg_get_function_arguments(x.oid)=CASE r.signature
    WHEN 'public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)' THEN 'p_user_id uuid, p_conversation_id uuid, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50'
    WHEN 'public.fn_messenger_search_messages(uuid,uuid[],text,integer)' THEN 'p_user_id uuid, p_conversation_ids uuid[], p_query text, p_limit integer DEFAULT 50'
    ELSE 'p_invoice_id uuid, p_user_id uuid' END)
   OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc x,LATERAL unnest(x.proacl)a WHERE x.oid=to_regprocedure(r.signature))
    IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[]
  THEN RAISE EXCEPTION 'credit_reader_preimage_changed' USING DETAIL=r.signature;END IF;
  FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(who,r.signature,'EXECUTE') IS DISTINCT FROM (who<>'anon')
   THEN RAISE EXCEPTION 'credit_reader_preimage_effective_access_changed' USING DETAIL=who||':'||r.signature;END IF;
  END LOOP;
 END LOOP;
END $credit_reader_preimage$;

DO $credit_readers$ DECLARE signature text;definition text;anchor text;replacement text;BEGIN
 FOREACH signature IN ARRAY ARRAY['public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)',
  'public.fn_messenger_search_messages(uuid,uuid[],text,integer)'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  anchor:=$projection$CASE WHEN legacy.identity IS NOT NULL THEN legacy.identity ELSE
 (COALESCE(m.media_metadata,'{}')-ARRAY['cashier','cashier_verified','correction','correction_verified','correction_unverified','invoice_identity_verified'])
 ||CASE WHEN i.id IS NULL THEN jsonb_build_object('accounting_verified',false,'cashier_verified',false,'correction_verified',false)
 ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
  'status',i.status,'chips_transferred',i.chips_transferred,'invoice_type',i.invoice_type,'source_ledger_id',i.source_ledger_id,'club_id',i.club_id,
  'cashier_verified',i.invoice_type='cashier_cashout','correction_verified',i.invoice_type='accounting_correction')
 ||CASE WHEN i.invoice_type='cashier_cashout' THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'cashier',public.fn_cashier_invoice_contract(i.id))
 WHEN i.invoice_type='accounting_correction' THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'due_at',i.due_at,'transferred_at',i.transferred_at,
  'union_id',(SELECT c.union_id FROM public.accounting_correction_documents c WHERE c.invoice_id=i.id),
  'correction',public.fn_accounting_correction_contract(i.id)) ELSE '{}'::jsonb END END END$projection$;
  replacement:=$projection$CASE WHEN legacy.identity IS NOT NULL THEN legacy.identity
 WHEN i.invoice_type='credit_limit_change' THEN jsonb_build_object(
  'kind','accounting_invoice','accounting_verified',true,'invoice_id',i.id,'invoice_type',i.invoice_type,
  'club_id',i.club_id,'source_ledger_id',NULL,'amount',round(i.net_amount,2)::text,
  'status','generated','chips_transferred',false,'due_at',NULL,'transferred_at',NULL,
  'cashier_verified',false,'correction_verified',false,'credit_change_verified',true,
  'credit_change',public.fn_accounting_credit_change_contract_v1(i.id)) ELSE
 (COALESCE(m.media_metadata,'{}')-ARRAY['cashier','cashier_verified','correction','correction_verified','correction_unverified','invoice_identity_verified','credit_change','credit_change_verified'])
 ||CASE WHEN i.id IS NULL THEN jsonb_build_object('accounting_verified',false,'cashier_verified',false,'correction_verified',false,'credit_change_verified',false)
 ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
  'status',i.status,'chips_transferred',i.chips_transferred,'invoice_type',i.invoice_type,'source_ledger_id',i.source_ledger_id,'club_id',i.club_id,
  'cashier_verified',i.invoice_type='cashier_cashout','correction_verified',i.invoice_type='accounting_correction')
 ||CASE WHEN i.invoice_type='cashier_cashout' THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'cashier',public.fn_cashier_invoice_contract(i.id))
 WHEN i.invoice_type='accounting_correction' THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'due_at',i.due_at,'transferred_at',i.transferred_at,
  'union_id',(SELECT c.union_id FROM public.accounting_correction_documents c WHERE c.invoice_id=i.id),
  'correction',public.fn_accounting_correction_contract(i.id)) ELSE '{}'::jsonb END END END$projection$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'credit_reader_projection_anchor_changed';END IF;
  definition:=replace(definition,anchor,replacement);
  anchor:='CASE WHEN legacy.identity IS NOT NULL THEN ''Correction receipt unavailable.'' ELSE m.content END';replacement:='CASE WHEN legacy.identity IS NOT NULL THEN ''Correction receipt unavailable.'' WHEN i.invoice_type=''credit_limit_change'' THEN ''This records a credit-capacity change. No chips were transferred and no payment is due.'' ELSE m.content END';
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>(CASE WHEN signature LIKE '%search_messages%' THEN 2 ELSE 1 END) THEN RAISE EXCEPTION 'credit_reader_content_anchor_changed';END IF;
  EXECUTE replace(definition,anchor,replacement);
 END LOOP;
 definition:=pg_get_functiondef('public.fn_messenger_invoice_visible_to(uuid,uuid)'::regprocedure);
 anchor:='WHERE i.id=p_invoice_id';replacement:=$visibility$WHERE i.id=p_invoice_id
   AND (i.invoice_type<>'credit_limit_change' OR EXISTS(
    SELECT 1 FROM public.accounting_credit_change_documents_v1 cd
    JOIN public.accounting_invoice_deliveries d ON d.invoice_id=cd.invoice_id
     AND d.recipient_id=p_user_id AND d.delivery_mode='immediate'
    WHERE cd.invoice_id=i.id AND p_user_id=ANY(cd.audience_user_ids)
     AND public.fn_accounting_credit_change_contract_v1(i.id) IS NOT NULL))$visibility$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'credit_reader_visibility_anchor_changed';END IF;
 EXECUTE replace(definition,anchor,replacement);
END $credit_readers$;

DO $credit_reader_postcondition$ DECLARE r record;who text;BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)','2df5d704a97e248ba5fcb371e97579c4','TABLE(id uuid, conversation_id uuid, sender_id uuid, content text, message_type text, media_metadata jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, is_deleted boolean, is_edited boolean, profiles jsonb)',3,true),
  ('public.fn_messenger_search_messages(uuid,uuid[],text,integer)','7b6fc91679124f06c2170ffa35326860','TABLE(id uuid, conversation_id uuid, sender_id uuid, content text, created_at timestamp with time zone, message_type text, media_metadata jsonb)',1,true),
  ('public.fn_messenger_invoice_visible_to(uuid,uuid)','6078ef06b9a076f8376b966001017579','boolean',0,false)
) AS expected(signature,body_md5,result,defaults,retset) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc x JOIN pg_language l ON l.oid=x.prolang WHERE x.oid=to_regprocedure(r.signature)
   AND md5(x.prosrc)=r.body_md5 AND x.proowner='postgres'::regrole AND x.prosecdef AND x.provolatile='s'
   AND x.proconfig=ARRAY['search_path=public'] AND x.prokind='f' AND l.lanname='plpgsql'
   AND NOT x.proisstrict AND NOT x.proleakproof AND x.proparallel='u' AND x.pronargdefaults=r.defaults
   AND x.proretset=r.retset AND pg_get_function_result(x.oid)=r.result
   AND pg_get_function_arguments(x.oid)=CASE r.signature
    WHEN 'public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)' THEN 'p_user_id uuid, p_conversation_id uuid, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50'
    WHEN 'public.fn_messenger_search_messages(uuid,uuid[],text,integer)' THEN 'p_user_id uuid, p_conversation_ids uuid[], p_query text, p_limit integer DEFAULT 50'
    ELSE 'p_invoice_id uuid, p_user_id uuid' END)
   OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc x,LATERAL unnest(x.proacl)a WHERE x.oid=to_regprocedure(r.signature))
    IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[]
  THEN RAISE EXCEPTION 'credit_reader_postcondition_changed' USING DETAIL=r.signature;END IF;
  FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(who,r.signature,'EXECUTE') IS DISTINCT FROM (who<>'anon')
   THEN RAISE EXCEPTION 'credit_reader_postcondition_effective_access_changed' USING DETAIL=who||':'||r.signature;END IF;
  END LOOP;
 END LOOP;
END $credit_reader_postcondition$;
