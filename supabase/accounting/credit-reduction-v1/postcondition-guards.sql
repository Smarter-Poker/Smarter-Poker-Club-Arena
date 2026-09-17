-- SOURCE ONLY / UNRUN. Core postconditions after all root document fragments
-- in the same enclosing transaction. Root must also assert its exact document,
-- delivery, reader definitions and guards; this fragment cannot admit alone.
SET LOCAL search_path=public,pg_catalog;
DO $credit_installed_functions$ DECLARE expected jsonb;actual jsonb;target oid;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($expected_functions$[{"signature":"public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean)","arguments":"p_agent_id uuid, p_status text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_credit_limit numeric DEFAULT NULL::numeric, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_assigned_by uuid DEFAULT NULL::uuid, p_credit_reason text DEFAULT NULL::text, p_is_prepaid boolean DEFAULT NULL::boolean","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, extensions"],"acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"authenticated":true,"service_role":true},"source_md5":"9180c45b9e2b6b41995258659546c038","basis":"admin-writer-successor.sql"},{"signature":"public.fn_agent_credit_control_revision_v1()","arguments":"","result":"trigger","owner":"postgres","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"ad43ab5c2eb812d7c0d983a4f5e8eff2","basis":"private-contract.sql"},{"signature":"public.fn_agent_credit_reduction_receipt_v1(uuid,uuid,uuid)","arguments":"p_expected_actor_id uuid, p_operation_id uuid, p_club_id uuid","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["authenticated=X/postgres","postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":true,"service_role":false},"source_md5":"034ec1cd10bc1cc9fa0b9ba341e64857","basis":"server-functions.sql"},{"signature":"public.fn_agent_credit_reduction_snapshot_v1(uuid,uuid,uuid)","arguments":"p_expected_actor_id uuid, p_club_id uuid, p_target_user_id uuid","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["authenticated=X/postgres","postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":true,"service_role":false},"source_md5":"df0f0d7cce9a8d6dbbba850dd826c4b8","basis":"server-functions.sql"},{"signature":"public.fn_credit_reduction_immutable_v1()","arguments":"","result":"trigger","owner":"postgres","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"3dee20395e977fc4cd9c3bd87ea8d7a0","basis":"private-contract.sql"},{"signature":"public.fn_credit_reduction_lock_current_manager_v1(uuid,uuid)","arguments":"p_actor uuid, p_club uuid","result":"void","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"basis":"server-functions.sql","source_md5":"5c777ff7338ba5d29b3463dafbc39727"},{"signature":"public.fn_credit_reduction_lock_v1(uuid,uuid,uuid)","arguments":"p_actor uuid, p_operation uuid, p_club uuid","result":"void","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"ef4c1edd6198798b916dfb0a061ad62e","basis":"server-functions.sql"},{"signature":"public.fn_credit_reduction_observe_v1(uuid,uuid,uuid)","arguments":"p_actor uuid, p_operation uuid, p_club uuid","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"858d34be108254f4b7fb0ebe2de146ca","basis":"server-functions.sql"},{"signature":"public.fn_credit_reduction_receipt_payload_v1(uuid)","arguments":"p_receipt_id uuid","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"46ba3ce82db524c1c80b5aaedeff7425","basis":"server-functions.sql"},{"signature":"public.fn_credit_reduction_retirement_payload_v1(uuid)","arguments":"p_retirement_id uuid","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"ea46855da5882e04b385967b4f35df19","basis":"server-functions.sql"},{"signature":"public.fn_credit_reduction_terminal_exclusive_v1()","arguments":"","result":"trigger","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"b77c0ecd14f6586230511865b72e435f","basis":"private-contract.sql"},{"signature":"public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text)","arguments":"p_expected_actor_id uuid, p_operation_id uuid, p_club_id uuid, p_agent_id uuid, p_target_user_id uuid, p_requested_reduction numeric, p_expected_credit_limit numeric, p_expected_credit_used numeric, p_expected_is_prepaid boolean, p_expected_revision bigint, p_reason text DEFAULT NULL::text","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["authenticated=X/postgres","postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":true,"service_role":false},"source_md5":"2921345d6b7eda01404fc77e2e130c29","basis":"server-functions.sql"},{"signature":"public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)","arguments":"p_expected_actor_id uuid, p_operation_id uuid, p_club_id uuid","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=pg_catalog, public"],"acl":["authenticated=X/postgres","postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":true,"service_role":false},"source_md5":"7ef3a5839666732fb2e6f39fd653b8a6","basis":"server-functions.sql"}]$expected_functions$::jsonb) LOOP
  target:=to_regprocedure(expected->>'signature');
  IF target IS NULL THEN RAISE EXCEPTION 'credit_reduction_function_missing' USING DETAIL=expected->>'signature';END IF;
  SELECT jsonb_build_object('owner',pg_get_userbyid(p.proowner),'arguments',pg_get_function_arguments(p.oid),
   'result',pg_get_function_result(p.oid),'language',l.lanname,'security_definer',p.prosecdef,'strict',p.proisstrict,
   'leakproof',p.proleakproof,'volatility',p.provolatile,'parallel',p.proparallel,'config',p.proconfig,
   'acl',(SELECT jsonb_agg(x::text ORDER BY x::text) FROM unnest(p.proacl)x),
   'effective_execute',(SELECT jsonb_object_agg(api,has_function_privilege(api,p.oid,'EXECUTE')) FROM unnest(ARRAY['anon','authenticated','service_role'])api))
   INTO actual FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=target AND p.prokind='f';
  IF actual IS DISTINCT FROM expected-ARRAY['signature','full_definition_md5','source_md5','basis']
   OR (expected ? 'full_definition_md5' AND (SELECT md5(pg_get_functiondef(target))) IS DISTINCT FROM expected->>'full_definition_md5')
   OR (expected ? 'source_md5' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=target) IS DISTINCT FROM expected->>'source_md5')
  THEN RAISE EXCEPTION 'credit_reduction_installed_function_mismatch' USING DETAIL=expected->>'signature';END IF;
 END LOOP;
END $credit_installed_functions$;

DO $credit_installed_schema$ DECLARE relation_name text;api text;priv text;target oid;actual jsonb;expected jsonb;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.agents'::regclass AND a.attname='credit_control_revision' AND NOT a.attisdropped
   AND a.atttypid='bigint'::regtype AND a.attnotnull AND a.attidentity='' AND a.attgenerated=''
   AND pg_get_expr(d.adbin,d.adrelid)='0')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid='public.agents'::regclass
   AND k.conname='agents_credit_control_revision_nonnegative' AND k.contype='c' AND k.convalidated
   AND pg_get_constraintdef(k.oid,true)='CHECK (credit_control_revision >= 0)')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.agents'::regclass
   AND t.tgname='zzzz_credit_control_revision_v1' AND t.tgfoid='public.fn_agent_credit_control_revision_v1()'::regprocedure
   AND t.tgtype=23 AND t.tgenabled='O' AND NOT t.tgisinternal AND NOT t.tgdeferrable AND t.tgqual IS NULL AND t.tgargs=''::bytea
   AND t.tgattr=''::int2vector)
 THEN RAISE EXCEPTION 'credit_reduction_revision_install_unconfirmed';END IF;
 FOREACH relation_name IN ARRAY ARRAY['accounting_credit_reduction_operations_v1','accounting_credit_reduction_retirements_v1'] LOOP
  target:=to_regclass('public.'||relation_name);
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=target AND relowner='postgres'::regrole AND relkind='r'
   AND relrowsecurity AND NOT relforcerowsecurity AND NOT relispartition)
   OR EXISTS(SELECT 1 FROM pg_inherits WHERE target IN(inhrelid,inhparent))
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=target)
   OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=target AND contype='f')
  THEN RAISE EXCEPTION 'credit_reduction_private_schema_unconfirmed' USING DETAIL=relation_name;END IF;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
   pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,a.attacl) ORDER BY a.attnum) INTO actual
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=target AND a.attnum>0 AND NOT a.attisdropped;
  expected:=$private_columns${"accounting_credit_reduction_operations_v1":[["id","uuid",true,null,"","",null],["contract_version","smallint",true,null,"","",null],["actor_user_id","uuid",true,null,"","",null],["operation_id","uuid",true,null,"","",null],["club_id","uuid",true,null,"","",null],["agent_id","uuid",true,null,"","",null],["target_user_id","uuid",true,null,"","",null],["action","text",true,null,"","",null],["requested_reduction","numeric(15,2)",true,null,"","",null],["reason","text",false,null,"","",null],["assignment_reason","text",true,null,"","",null],["before_limit","numeric(15,2)",true,null,"","",null],["after_limit","numeric(15,2)",true,null,"","",null],["credit_used","numeric(15,2)",true,null,"","",null],["before_prepaid","boolean",true,null,"","",null],["after_prepaid","boolean",true,null,"","",null],["before_revision","bigint",true,null,"","",null],["after_revision","bigint",true,null,"","",null],["applied_reduction","numeric(15,2)",true,null,"","",null],["assignment_id","uuid",false,null,"","",null],["document_id","uuid",false,null,"","",null],["invoice_id","uuid",false,null,"","",null],["recorded_at","timestamp with time zone",true,null,"","",null]],"accounting_credit_reduction_retirements_v1":[["id","uuid",true,null,"","",null],["contract_version","smallint",true,null,"","",null],["actor_user_id","uuid",true,null,"","",null],["operation_id","uuid",true,null,"","",null],["club_id","uuid",true,null,"","",null],["retired_at","timestamp with time zone",true,null,"","",null]]}$private_columns$::jsonb->relation_name;
  IF actual IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=target)
   OR (SELECT reloptions FROM pg_class WHERE oid=target) IS NOT NULL
   OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl)a WHERE c.oid=target)
     IS DISTINCT FROM ARRAY['postgres=arwdDxtm/postgres']::text[]
  THEN RAISE EXCEPTION 'credit_reduction_private_columns_unconfirmed' USING DETAIL=relation_name;END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid=target AND contype<>'t')<>(CASE WHEN relation_name='accounting_credit_reduction_operations_v1' THEN 22 ELSE 5 END)
   OR (SELECT count(*) FROM pg_constraint WHERE conrelid=target AND contype='c')<>(CASE WHEN relation_name='accounting_credit_reduction_operations_v1' THEN 17 ELSE 3 END)
   OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=target AND contype<>'t' AND (NOT convalidated OR condeferrable OR condeferred OR conislocal IS DISTINCT FROM true))
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=target AND contype='p' AND conkey=ARRAY[1]::smallint[])
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=target AND contype='u' AND conkey=ARRAY[3,4]::smallint[])
   OR (SELECT count(*) FROM pg_index WHERE indrelid=target)<>(CASE WHEN relation_name='accounting_credit_reduction_operations_v1' THEN 5 ELSE 2 END)
   OR EXISTS(SELECT 1 FROM pg_index WHERE indrelid=target AND (NOT indisunique OR NOT indisvalid OR NOT indisready OR NOT indislive OR NOT indimmediate OR indnullsnotdistinct))
   OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=target AND NOT tgisinternal)<>(CASE WHEN relation_name='accounting_credit_reduction_operations_v1' THEN 4 ELSE 2 END)
  THEN RAISE EXCEPTION 'credit_reduction_private_constraints_unconfirmed' USING DETAIL=relation_name;END IF;
  -- PostgreSQL records user-defined constraint triggers as contype='t'.
  -- Keep their exact authority separate from the ordinary table constraints.
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid=target AND contype='t')<>
    (CASE WHEN relation_name='accounting_credit_reduction_operations_v1' THEN 2 ELSE 1 END)
   OR EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=target AND c.contype='t'
    AND (NOT c.convalidated OR NOT c.condeferrable OR NOT c.condeferred OR NOT c.conislocal OR c.coninhcount<>0
     OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgconstraint=c.oid AND t.tgrelid=target
      AND t.tgname=c.conname AND NOT t.tgisinternal AND t.tgtype=5 AND t.tgenabled='O'
      AND t.tgdeferrable AND t.tginitdeferred AND t.tgqual IS NULL AND t.tgargs=''::bytea AND t.tgattr=''::int2vector
      AND ((relation_name='accounting_credit_reduction_operations_v1'
        AND c.conname='credit_reduction_operation_exclusive_v1'
        AND t.tgfoid='public.fn_credit_reduction_terminal_exclusive_v1()'::regprocedure)
       OR (relation_name='accounting_credit_reduction_operations_v1'
        AND c.conname='zz_accounting_credit_change_deferred_v1'
        AND t.tgfoid='public.fn_accounting_credit_change_deferred_v1()'::regprocedure)
       OR (relation_name='accounting_credit_reduction_retirements_v1'
        AND c.conname='credit_reduction_retirement_exclusive_v1'
        AND t.tgfoid='public.fn_credit_reduction_terminal_exclusive_v1()'::regprocedure)))))
  THEN RAISE EXCEPTION 'credit_reduction_terminal_constraints_unconfirmed' USING DETAIL=relation_name;END IF;
  IF relation_name='accounting_credit_reduction_operations_v1' AND (
   NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=target AND contype='u' AND conkey=ARRAY[20]::smallint[])
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=target AND contype='u' AND conkey=ARRAY[21]::smallint[])
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=target AND contype='u' AND conkey=ARRAY[22]::smallint[]))
  THEN RAISE EXCEPTION 'credit_reduction_private_receipt_identity_unconfirmed';END IF;
  FOREACH api IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
    IF has_table_privilege(api,target,priv) THEN
     RAISE EXCEPTION 'credit_reduction_private_access_unconfirmed' USING DETAIL=relation_name||'.'||api||'.'||priv;END IF;
   END LOOP;
   FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
    IF has_any_column_privilege(api,target,priv) THEN
     RAISE EXCEPTION 'credit_reduction_private_access_unconfirmed' USING DETAIL=relation_name||'.'||api||'.'||priv;END IF;
   END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=target AND NOT t.tgisinternal AND t.tgenabled='O'
   AND t.tgtype=58 AND t.tgfoid='public.fn_credit_reduction_immutable_v1()'::regprocedure AND NOT t.tgdeferrable
   AND t.tgqual IS NULL AND t.tgargs=''::bytea AND t.tgattr=''::int2vector)
   OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=target AND NOT t.tgisinternal AND t.tgenabled='O'
    AND t.tgtype=5 AND t.tgfoid='public.fn_credit_reduction_terminal_exclusive_v1()'::regprocedure
    AND t.tgdeferrable AND t.tginitdeferred AND t.tgqual IS NULL AND t.tgargs=''::bytea AND t.tgattr=''::int2vector)
  THEN RAISE EXCEPTION 'credit_reduction_private_trigger_unconfirmed' USING DETAIL=relation_name;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.accounting_credit_reduction_operations_v1'::regclass
   AND t.tgname='accounting_credit_change_on_operation_v1' AND t.tgtype=5 AND NOT t.tgisinternal
   AND t.tgfoid='public.fn_accounting_credit_change_on_operation_v1()'::regprocedure AND t.tgenabled='O' AND NOT t.tgdeferrable
   AND t.tgqual IS NULL AND t.tgargs=''::bytea AND t.tgattr=''::int2vector)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.accounting_credit_reduction_operations_v1'::regclass
   AND t.tgname='zz_accounting_credit_change_deferred_v1' AND t.tgtype=5 AND NOT t.tgisinternal
   AND t.tgfoid='public.fn_accounting_credit_change_deferred_v1()'::regprocedure AND t.tgenabled='O'
   AND t.tgdeferrable AND t.tginitdeferred AND t.tgqual IS NULL AND t.tgargs=''::bytea AND t.tgattr=''::int2vector)
 THEN RAISE EXCEPTION 'credit_reduction_document_integration_missing';END IF;
END $credit_installed_schema$;
