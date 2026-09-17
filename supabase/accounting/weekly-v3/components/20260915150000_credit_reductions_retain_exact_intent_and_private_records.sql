-- SOURCE ONLY / UNAPPLIED / UNRUN. Component37 after the preserved36.
-- Exact accepted credit reductions extend the original credit writer and
-- existing invoice/Messenger/notification authority. No chip payment is implied.
-- Native loader, role, concurrency and compatible application checks required.
-- Maintained fragments and exact assembly are bound in credit-reduction-v1.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='300s';
SELECT pg_advisory_xact_lock(hashtextextended('accounting-authority-install',0));
-- Fragment preimage-guards.sql
-- SOURCE ONLY / UNRUN. Execute inside one enclosing transaction BEFORE any new objects.
-- Actual retained catalogs are composed with the explicit final36 predecessor;
-- this is not an installed-state hash invented from a source file.
SET LOCAL search_path=public,pg_catalog;
DO $credit_admission$ DECLARE item text;who text;BEGIN
 IF current_user<>'postgres' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'credit_reduction_owner_version_required';END IF;
 FOREACH item IN ARRAY ARRAY['accounting_credit_reduction_operations_v1','accounting_credit_reduction_retirements_v1',
  'accounting_credit_change_documents_v1'] LOOP
  IF to_regclass('public.'||item) IS NOT NULL OR to_regtype('public.'||item) IS NOT NULL
  THEN RAISE EXCEPTION 'credit_reduction_contract_preexists' USING DETAIL='public.'||item;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.agents'::regclass AND attname='credit_control_revision' AND NOT attisdropped)
  OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
   AND (proname LIKE 'fn_credit_reduction_%_v1' OR proname LIKE 'fn_agent_credit_reduction_%_v1'
    OR proname IN('fn_reduce_agent_credit_v1','fn_retire_agent_credit_reduction_v1','fn_agent_credit_control_revision_v1')
    OR proname LIKE 'fn_accounting_credit_change_%_v1' OR proname='fn_accounting_credit_reduction_assert_document'))
 THEN RAISE EXCEPTION 'credit_reduction_contract_preexists';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)')
   AND proowner='postgres'::regrole AND prosecdef AND md5(prosrc)='d1b4797078edc5a08f63fc438d914cbb')
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_accounting_run_observation_v1(uuid,text,uuid,timestamptz,timestamptz)')
   AND proowner='postgres'::regrole AND prosecdef AND md5(prosrc)='6d9debfc281c2e425e5cfc4ec2a35dcc')
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('auth.uid()')
   AND proowner='supabase_auth_admin'::regrole AND md5(pg_get_functiondef(oid))='ea3b41bf29e2ad573067939329aa088e')
 THEN RAISE EXCEPTION 'credit_reduction_requires_preserved36';END IF;
 FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=who AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
   OR pg_has_role(who,'postgres','USAGE') OR pg_has_role(who,'postgres','SET') OR has_schema_privilege(who,'public','CREATE')
   OR (who<>'service_role' AND (EXISTS(SELECT 1 FROM pg_roles WHERE rolname=who AND rolbypassrls)
    OR pg_has_role(who,'service_role','USAGE') OR pg_has_role(who,'service_role','SET')))
  THEN RAISE EXCEPTION 'credit_reduction_unsafe_api_role' USING DETAIL=who;END IF;
 END LOOP;
END $credit_admission$;
LOCK TABLE public.agents,public.credit_assignments IN ACCESS EXCLUSIVE MODE;
DO $credit_functions$ DECLARE expected jsonb;actual jsonb;target oid;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($expected_functions$[{"owner":"postgres","arguments":"p_user_id uuid, p_amount numeric, p_category text DEFAULT 'debit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid","result":"boolean","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, extensions, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.atomic_deduct_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid)","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"ab3d8e4c0baac59e7194319ffceba71e","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric, p_source_type text DEFAULT 'rake_settlement'::text, p_source_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text","result":"void","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)","acl":["postgres=X/postgres","service_role=X/postgres"],"basis":"supabase/accounting/weekly-v3/components/20260914145706_cash_compatibility_calls_share_durable_source_authority.sql literal final36 body","source_md5":"122cb6cb0d40450916640dfa60b8313d"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_accounting_agreement_capture()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"746fab25cd56f6ad761325e7c0d525d5","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_accounting_credit_document_on_insert()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"64b3c2467897361d25e4646613ca6b7d","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"p_agent_id uuid, p_status text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_credit_limit numeric DEFAULT NULL::numeric, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_assigned_by uuid DEFAULT NULL::uuid, p_credit_reason text DEFAULT NULL::text, p_is_prepaid boolean DEFAULT NULL::boolean","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, extensions"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"basis":"supabase/accounting/weekly-v3/components/20260914150500_agent_agreements_preserve_club_scope_and_atomic_role_changes.sql literal final36 body","source_md5":"d35ffecfde82d1d24582d95759ec4ed8"},{"owner":"postgres","arguments":"p_cashout_id uuid, p_agent_user_id uuid, p_agent_note text DEFAULT NULL::text","result":"jsonb","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, extensions"],"effective_execute":{"anon":false,"service_role":false,"authenticated":false},"signature":"public.fn_agent_approve_cashout(uuid,uuid,text)","acl":["postgres=X/postgres"],"full_definition_md5":"78e105b17122b2b7bdd9dfe3df0e8de6","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"31d05a227849bda2a1195594c57b90eb","basis":"retained 14:22:10.194019+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"29e28090d6d7316ff108918f5ca839f1","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"0214036f29a6d121842496c91c7912af","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"c6bb171c71aa0d6022296b29269a016b","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"53ba478533aec762384aa9ac7d63a9b2","basis":"retained 14:22:10.194019+00"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_agents_staff_earn_no_rakeback()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"17346b77ec8f5a1d6d42dca3eb06e061","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_invoice_id uuid, p_amount numeric, p_method text","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_apply_credit_payment(uuid,numeric,text)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"5d01c2dda901644a473057a81dade2a9","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_agent_user_id uuid, p_super_agent_user_id uuid, p_club_id uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_assign_agent_to_super_agent(uuid,uuid,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"13f6d2408d152e7d15a8b3b0bf113a9f","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_ca_autoledger()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"2ff8923b4c2d8fd3d343cf37acce0f2c","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_ca_autoledger_delete()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"c6d7e02df8b654fbccc3e8844418bd01","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_category text, p_from_type text, p_from_entity uuid, p_to_type text, p_to_entity uuid, p_amount numeric, p_club_id uuid, p_idempotency_key text, p_description text","result":"boolean","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_ca_post_leg(text,text,uuid,text,uuid,numeric,uuid,text,text)","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"e6835ba26f6a2fc99c130a8b715c7866","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_ca_record_frozen_pool_deletion()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"09b843d7a8af627f91a9ff05708778b9","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_ca_reject_automated_user_club_row()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"7c73094df30c90f94a78cbbd5d24f504","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"","result":"boolean","language":"sql","security_definer":false,"strict":false,"leakproof":false,"volatility":"s","parallel":"u","config":["search_path=pg_catalog, public, auth"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_caller_is_engine()","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"d9a70f1d932538025e656bfe2b4d091d","basis":"retained 14:22:10.194019+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_user_id uuid DEFAULT NULL::uuid","result":"text","language":"sql","security_definer":true,"strict":false,"leakproof":false,"volatility":"s","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_club_bank_role(uuid,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"b36e67efcfaba2f867d62140322a8ed8","basis":"retained 14:22:10.194019+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_actor uuid, p_target uuid","result":"boolean","language":"sql","security_definer":true,"strict":false,"leakproof":false,"volatility":"s","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_club_cashier_can_transact(uuid,uuid,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"a812c44870554f37cddb36edf600e386","basis":"retained 14:22:10.194019+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_user_id uuid, p_role text, p_actor_user_id uuid DEFAULT NULL::uuid, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_is_prepaid boolean DEFAULT NULL::boolean, p_credit_limit numeric DEFAULT NULL::numeric","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"59e8df8dc16220b5bad8e5f2437241e7","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_user_id uuid, p_club_id uuid, p_role text, p_parent_agent_id uuid, p_commission_rate numeric, p_player_rakeback_rate numeric, p_credit_limit numeric, p_is_prepaid boolean","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, extensions"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_create_agent(uuid,uuid,text,uuid,numeric,numeric,numeric,boolean)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"basis":"supabase/accounting/weekly-v3/components/20260914150500_agent_agreements_preserve_club_scope_and_atomic_role_changes.sql literal final36 body","source_md5":"5a8b6509322398f374f210685056cc89"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_deep_stack_society_cannot_be_deleted_by_accident()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"213a7fa40330c703cb23dc001a99d31e","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_enforce_agent_commission_bounds()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"3e4f5df422b121391cc40f711ae5b5ee","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_user_id uuid, p_role text","result":"uuid","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_ensure_agent_row(uuid,uuid,text)","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"3bd1e0aeed55ae8e56c9e28e8967ae2b","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_user_id uuid, p_club_id uuid","result":"boolean","language":"sql","security_definer":true,"strict":false,"leakproof":false,"volatility":"s","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_ensure_club_wallet(uuid,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"dd462a9943724d4b94fbe683ed364250","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"","result":"boolean","language":"sql","security_definer":false,"strict":false,"leakproof":false,"volatility":"s","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":true,"service_role":true,"authenticated":true},"signature":"public.fn_freeze_bypass_active()","acl":["=X/postgres","anon=X/postgres","authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"2bfad412c70b965fd9d2c72b2ad83310","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"p_agent_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_debt_owed numeric, p_due_date timestamp with time zone","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, extensions"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_generate_credit_invoice(uuid,timestamp with time zone,timestamp with time zone,numeric,timestamp with time zone)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"b0e4603b081f48ce1beb6963e0356c9a","basis":"retained 14:22:10.194019+00"},{"signature":"public.fn_guard_agent_agreement()","arguments":"","result":"trigger","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"68e43754262db190d0725388e6a7f8c7","basis":"supabase/accounting/weekly-v3/components/20260914150500_agent_agreements_preserve_club_scope_and_atomic_role_changes.sql literal staged definition; explicit grants"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_guard_retired_club_mutation()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"b82be212e7ccf2a15637c231861ff993","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_club_id uuid","result":"boolean","language":"sql","security_definer":true,"strict":false,"leakproof":false,"volatility":"s","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_is_club_admin_uid(uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"021940a1e457cf22312eb139d3d05267","basis":"retained 14:22:10.194019+00"},{"owner":"postgres","arguments":"","result":"boolean","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"s","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_is_platform_admin()","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"ed89787c7b832e76a886734e16a27c3d","basis":"retained 14:22:10.194019+00"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_notify_credit_request()","acl":["postgres=X/postgres","service_role=X/postgres"],"basis":"supabase/accounting/weekly-v3/components/20260914164600_credit_request_reviews_share_one_credit_authority.sql literal final36 body","source_md5":"738087390791275a4cdece1527a149a5"},{"owner":"postgres","arguments":"p_invoice_id uuid, p_amount numeric","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_pay_credit_invoice_from_wallet(uuid,numeric)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"7c5e2861fde25856b1cce59b5119770e","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"","result":"boolean","language":"sql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":true,"service_role":true,"authenticated":true},"signature":"public.fn_platform_frozen()","acl":["anon=X/postgres","authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"ec683805e052fceeae74789e82dce4cc","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"p_user_id uuid, p_club_hint uuid DEFAULT NULL::uuid","result":"uuid","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"s","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_player_home_club(uuid,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"bdced39339da2e5ec46404177bab7dc2","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_poker_reject_diamond_hierarchy()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"49037a2bf4322d2a327bc9141a7a7a89","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_invoice_id uuid, p_amount numeric, p_method text, p_operation_id uuid, p_reference text DEFAULT NULL::text","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"3c31d57d2c4f6ecdf388c5157f311e5a","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_refuse_while_frozen()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"3a866372172806a8a69cc3d37413f0cc","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"signature":"public.fn_review_credit_request(uuid,text,numeric,text,uuid)","arguments":"p_request_id uuid, p_decision text, p_approved_amount numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text, p_expected_actor_id uuid DEFAULT NULL::uuid","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public","statement_timeout=30s"],"acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"authenticated":true,"service_role":true},"source_md5":"1e3ff399a303a90c56396a2d5586ba29","basis":"supabase/accounting/weekly-v3/components/20260914164600_credit_request_reviews_share_one_credit_authority.sql literal staged definition; explicit grants"},{"owner":"postgres","arguments":"p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid DEFAULT NULL::uuid","result":"uuid","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"s","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_tournament_club_for_user(uuid,uuid,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"344609ab3cf21094b9e85167bfb6655e","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.guard_agent_wallet_direct_update()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"736aa9e92265453c3015223562108141","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.guard_wallet_balance_write()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"2af2718d22fcf12be394f9239e88e3c7","basis":"retained payment closure14:41:34.710789+00; no final36 literal definition change"},{"owner":"postgres","arguments":"","result":"trigger","language":"plpgsql","security_definer":false,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, extensions"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.sync_agent_wallet_columns()","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"3a3d351dd05b5dc13b525b7eb4635e5c","basis":"retained 14:12:09.241743+00"}]$expected_functions$::jsonb) LOOP
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
  THEN RAISE EXCEPTION 'credit_reduction_function_preimage_changed' USING DETAIL=expected->>'signature';END IF;
 END LOOP;
END $credit_functions$;
DO $credit_relations$ DECLARE captured jsonb;expected jsonb;actual jsonb;tidy jsonb;BEGIN
 WITH selected AS(SELECT c.*,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN('agents','credit_assignments'))
 SELECT (SELECT jsonb_agg(jsonb_build_object(
  'schema',c.nspname,'name',c.relname,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,
  'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'partition',c.relispartition,
  'partition_key',CASE WHEN c.relkind='p' THEN pg_get_partkeydef(c.oid) END,
  'partition_bound',pg_get_expr(c.relpartbound,c.oid),'replica_identity',c.relreplident,'acl',c.relacl,'options',c.reloptions,
  'columns',(SELECT jsonb_agg(jsonb_build_object(
    'name',a.attname,'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
    'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,
    'acl',a.attacl,'collation',CASE WHEN a.attcollation<>0 THEN a.attcollation::regcollation::text END,
    'effective_privileges',(SELECT jsonb_object_agg(api,jsonb_build_object(
      'SELECT',has_column_privilege(api,c.oid,a.attnum,'SELECT'),
      'INSERT',has_column_privilege(api,c.oid,a.attnum,'INSERT'),
      'UPDATE',has_column_privilege(api,c.oid,a.attnum,'UPDATE'),
      'REFERENCES',has_column_privilege(api,c.oid,a.attnum,'REFERENCES')))
      FROM unnest(ARRAY['anon','authenticated','service_role'])api))
    ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,
    'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'deferrable',k.condeferrable,
    'initially_deferred',k.condeferred,'columns',k.conkey,'foreign_columns',k.confkey,
    'referenced_relation',CASE WHEN k.confrelid<>0 THEN k.confrelid::regclass::text END)
    ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ci.relname,'definition',pg_get_indexdef(i.indexrelid),
    'owner',pg_get_userbyid(ci.relowner),'kind',ci.relkind,'unique',i.indisunique,'primary',i.indisprimary,
    'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'immediate',i.indimmediate,
    'replica_identity',i.indisreplident,'clustered',i.indisclustered,'nulls_not_distinct',i.indnullsnotdistinct)
    ORDER BY ci.relname) FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),
    'enabled',t.tgenabled,'internal',t.tgisinternal,'type',t.tgtype,'function',t.tgfoid::regprocedure::text,
    'function_definition',pg_get_functiondef(t.tgfoid),'function_definition_md5',md5(pg_get_functiondef(t.tgfoid)),
    'function_body_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl,
    'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred)
    ORDER BY t.tgname) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=c.oid),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p WHERE p.schemaname=c.nspname AND p.tablename=c.relname),
  'inheritance',(SELECT jsonb_agg(jsonb_build_object('parent',i.inhparent::regclass::text,'child',i.inhrelid::regclass::text,'sequence',i.inhseqno)
    ORDER BY i.inhparent::regclass::text,i.inhrelid::regclass::text) FROM pg_inherits i WHERE c.oid IN(i.inhparent,i.inhrelid)),
  'effective_privileges',(SELECT jsonb_object_agg(api,jsonb_build_object(
    'table',(SELECT jsonb_object_agg(priv,has_table_privilege(api,c.oid,priv)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])priv),
    'any_column',(SELECT jsonb_object_agg(priv,has_any_column_privilege(api,c.oid,priv)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES'])priv)))
    FROM unnest(ARRAY['anon','authenticated','service_role'])api)
 ) ORDER BY c.relname) FROM selected c) INTO captured;
 FOR expected IN SELECT value FROM jsonb_array_elements($expected_relations$[{"acl":["anon=xtm/postgres","authenticated=rxtm/postgres","postgres=arwdDxtm/postgres","service_role=arwdDxtm/postgres"],"rls":true,"kind":"r","name":"agents","owner":"postgres","schema":"public","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","ordinal":1,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"user_id","type":"uuid","default":null,"ordinal":2,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"club_id","type":"uuid","default":null,"ordinal":3,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"membership_id","type":"uuid","default":null,"ordinal":4,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"role","type":"text","default":null,"ordinal":5,"identity":"","not_null":true,"collation":"\"default\"","generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"status","type":"text","default":"'active'::text","ordinal":6,"identity":"","not_null":true,"collation":"\"default\"","generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"parent_agent_id","type":"uuid","default":null,"ordinal":7,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"commission_rate","type":"numeric(5,4)","default":null,"ordinal":8,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"player_rakeback_rate","type":"numeric(5,4)","default":null,"ordinal":9,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"credit_limit","type":"numeric(15,2)","default":"0","ordinal":10,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"credit_used","type":"numeric(15,2)","default":"0","ordinal":11,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"is_prepaid","type":"boolean","default":"false","ordinal":12,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"business_balance","type":"numeric(15,2)","default":"0","ordinal":13,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"player_balance","type":"numeric(15,2)","default":"0","ordinal":14,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"promo_balance","type":"numeric(15,2)","default":"0","ordinal":15,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"total_players","type":"integer","default":"0","ordinal":16,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"active_player_count","type":"integer","default":"0","ordinal":17,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"sub_agent_count","type":"integer","default":"0","ordinal":18,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"weekly_rake_generated","type":"numeric(15,2)","default":"0","ordinal":19,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"lifetime_earnings","type":"numeric(15,2)","default":"0","ordinal":20,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"joined_at","type":"timestamp with time zone","default":"now()","ordinal":21,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"last_active_at","type":"timestamp with time zone","default":null,"ordinal":22,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","ordinal":23,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"updated_at","type":"timestamp with time zone","default":"now()","ordinal":24,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"auto_rakeback_enabled","type":"boolean","default":"true","ordinal":25,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"rakeback_percentage","type":"numeric(5,4)","default":"0.0000","ordinal":26,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"agent_wallet_balance","type":"numeric(18,2)","default":"0","ordinal":28,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"player_wallet_balance","type":"numeric(18,4)","default":"0","ordinal":29,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"promo_wallet_balance","type":"numeric(18,2)","default":"0","ordinal":30,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"lifetime_rake_generated","type":"numeric(18,4)","default":"0","ordinal":31,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}}],"indexes":[{"kind":"i","live":true,"name":"agents_agreement_club_and_id","owner":"postgres","ready":true,"valid":true,"unique":true,"primary":false,"clustered":false,"immediate":true,"definition":"CREATE UNIQUE INDEX agents_agreement_club_and_id ON public.agents USING btree (club_id, id)","replica_identity":false,"nulls_not_distinct":false},{"kind":"i","live":true,"name":"agents_club_id_user_id_key","owner":"postgres","ready":true,"valid":true,"unique":true,"primary":false,"clustered":false,"immediate":true,"definition":"CREATE UNIQUE INDEX agents_club_id_user_id_key ON public.agents USING btree (club_id, user_id)","replica_identity":false,"nulls_not_distinct":false},{"kind":"i","live":true,"name":"agents_pkey","owner":"postgres","ready":true,"valid":true,"unique":true,"primary":true,"clustered":false,"immediate":true,"definition":"CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id)","replica_identity":false,"nulls_not_distinct":false},{"kind":"i","live":true,"name":"idx_agents_club","owner":"postgres","ready":true,"valid":true,"unique":false,"primary":false,"clustered":false,"immediate":true,"definition":"CREATE INDEX idx_agents_club ON public.agents USING btree (club_id)","replica_identity":false,"nulls_not_distinct":false},{"kind":"i","live":true,"name":"idx_agents_parent","owner":"postgres","ready":true,"valid":true,"unique":false,"primary":false,"clustered":false,"immediate":true,"definition":"CREATE INDEX idx_agents_parent ON public.agents USING btree (parent_agent_id)","replica_identity":false,"nulls_not_distinct":false},{"kind":"i","live":true,"name":"idx_agents_user","owner":"postgres","ready":true,"valid":true,"unique":false,"primary":false,"clustered":false,"immediate":true,"definition":"CREATE INDEX idx_agents_user ON public.agents USING btree (user_id)","replica_identity":false,"nulls_not_distinct":false}],"options":null,"policies":[{"cmd":"SELECT","qual":"((user_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'all'::text) OR ((fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'downline'::text) AND fn_club_cashier_can_transact(club_id, ( SELECT auth.uid() AS uid), user_id)))","roles":["authenticated"],"tablename":"agents","permissive":"PERMISSIVE","policyname":"agents_cashier_scoped_read","schemaname":"public","with_check":null},{"cmd":"ALL","qual":"true","roles":["service_role"],"tablename":"agents","permissive":"PERMISSIVE","policyname":"agents_svc","schemaname":"public","with_check":null},{"cmd":"SELECT","qual":"(( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid)))","roles":["authenticated"],"tablename":"agents","permissive":"PERMISSIVE","policyname":"union_overseer_read","schemaname":"public","with_check":null}],"triggers":[{"name":"accounting_agreement_history","definition":"CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, user_id, parent_agent_id, role, status, commission_rate, player_rakeback_rate, is_prepaid ON agents FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()","enabled":"O","internal":false,"type":29,"function":"fn_accounting_agreement_capture()","deferrable":false,"initially_deferred":false},{"name":"guard_agent_wallet_direct_update","definition":"CREATE TRIGGER guard_agent_wallet_direct_update BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION guard_agent_wallet_direct_update()","enabled":"O","internal":false,"type":23,"function":"guard_agent_wallet_direct_update()","deferrable":false,"initially_deferred":false},{"name":"poker_arena_no_hierarchy","definition":"CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()","enabled":"O","internal":false,"type":23,"function":"fn_poker_reject_diamond_hierarchy()","deferrable":false,"initially_deferred":false},{"name":"trg_agents_commission_bounds","definition":"CREATE TRIGGER trg_agents_commission_bounds BEFORE INSERT OR UPDATE OF commission_rate ON agents FOR EACH ROW EXECUTE FUNCTION fn_enforce_agent_commission_bounds()","enabled":"O","internal":false,"type":23,"function":"fn_enforce_agent_commission_bounds()","deferrable":false,"initially_deferred":false},{"name":"trg_agents_human_user_club_only","definition":"CREATE TRIGGER trg_agents_human_user_club_only BEFORE INSERT OR UPDATE OF club_id, user_id ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row()","enabled":"O","internal":false,"type":23,"function":"fn_ca_reject_automated_user_club_row()","deferrable":false,"initially_deferred":false},{"name":"trg_agents_staff_earn_no_rakeback","definition":"CREATE TRIGGER trg_agents_staff_earn_no_rakeback BEFORE INSERT OR UPDATE OF role, commission_rate, player_rakeback_rate ON agents FOR EACH ROW WHEN (COALESCE(new.commission_rate, 0::numeric) <> 0::numeric OR COALESCE(new.player_rakeback_rate, 0::numeric) <> 0::numeric) EXECUTE FUNCTION fn_agents_staff_earn_no_rakeback()","enabled":"O","internal":false,"type":23,"function":"fn_agents_staff_earn_no_rakeback()","deferrable":false,"initially_deferred":false},{"name":"trg_ca_autoledger","definition":"CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF agent_wallet_balance, promo_wallet_balance ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","enabled":"O","internal":false,"type":17,"function":"fn_ca_autoledger()","deferrable":false,"initially_deferred":false},{"name":"trg_ca_autoledger_delete","definition":"CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","enabled":"O","internal":false,"type":11,"function":"fn_ca_autoledger_delete()","deferrable":false,"initially_deferred":false},{"name":"trg_ca_autoledger_insert","definition":"CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON agents FOR EACH ROW WHEN (COALESCE(new.agent_wallet_balance, 0::numeric) <> 0::numeric OR COALESCE(new.promo_wallet_balance, 0::numeric) <> 0::numeric) EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","enabled":"O","internal":false,"type":5,"function":"fn_ca_autoledger()","deferrable":false,"initially_deferred":false},{"name":"trg_deep_stack_agents_are_protected","definition":"CREATE TRIGGER trg_deep_stack_agents_are_protected BEFORE DELETE ON agents FOR EACH ROW WHEN (old.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid) EXECUTE FUNCTION fn_deep_stack_society_cannot_be_deleted_by_accident()","enabled":"O","internal":false,"type":11,"function":"fn_deep_stack_society_cannot_be_deleted_by_accident()","deferrable":false,"initially_deferred":false},{"name":"trg_guard_retired_club_mutation","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()","enabled":"O","internal":false,"type":31,"function":"fn_guard_retired_club_mutation()","deferrable":false,"initially_deferred":false},{"name":"trg_sync_agent_wallets","definition":"CREATE TRIGGER trg_sync_agent_wallets BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION sync_agent_wallet_columns()","enabled":"O","internal":false,"type":19,"function":"sync_agent_wallet_columns()","deferrable":false,"initially_deferred":false},{"name":"zz_guard_agent_agreement","definition":"CREATE TRIGGER zz_guard_agent_agreement BEFORE INSERT OR UPDATE OF id, user_id, club_id, parent_agent_id, role, commission_rate, player_rakeback_rate, credit_limit ON agents FOR EACH ROW EXECUTE FUNCTION fn_guard_agent_agreement()","enabled":"O","internal":false,"type":23,"function":"fn_guard_agent_agreement()","deferrable":false,"initially_deferred":false}],"force_rls":false,"partition":false,"constraints":[{"name":"agents_agent_wallet_balance_nonneg","type":"c","columns":[28],"validated":true,"deferrable":false,"definition":"CHECK (agent_wallet_balance >= 0::numeric)","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"agents_club_id_fkey","type":"f","columns":[3],"validated":true,"deferrable":false,"definition":"FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE","foreign_columns":[1],"initially_deferred":false,"referenced_relation":"clubs"},{"name":"agents_club_id_user_id_key","type":"u","columns":[3,2],"validated":true,"deferrable":false,"definition":"UNIQUE (club_id, user_id)","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"agents_commission_rate_check","type":"c","columns":[8],"validated":true,"deferrable":false,"definition":"CHECK (commission_rate >= 0::numeric AND commission_rate <= 0.70)","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"agents_credit_used_check","type":"c","columns":[11],"validated":true,"deferrable":false,"definition":"CHECK (credit_used >= 0::numeric)","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"agents_parent_in_same_club","type":"f","columns":[3,7],"validated":true,"deferrable":false,"definition":"FOREIGN KEY (club_id, parent_agent_id) REFERENCES agents(club_id, id)","foreign_columns":[3,1],"initially_deferred":false,"referenced_relation":"agents"},{"name":"agents_pkey","type":"p","columns":[1],"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"agents_player_rakeback_rate_check","type":"c","columns":[9],"validated":true,"deferrable":false,"definition":"CHECK (player_rakeback_rate >= 0::numeric AND player_rakeback_rate <= 0.50)","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"agents_promo_wallet_balance_nonneg","type":"c","columns":[30],"validated":true,"deferrable":false,"definition":"CHECK (promo_wallet_balance >= 0::numeric)","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"agents_role_check","type":"c","columns":[5],"validated":true,"deferrable":false,"definition":"CHECK (role = ANY (ARRAY['super_agent'::text, 'agent'::text, 'sub_agent'::text]))","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"agents_status_check","type":"c","columns":[6],"validated":true,"deferrable":false,"definition":"CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text, 'frozen'::text]))","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"check_credit","type":"c","columns":[11,10,12],"validated":true,"deferrable":false,"definition":"CHECK (credit_used <= credit_limit OR is_prepaid = true)","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"chk_player_wallet_balance_is_two_decimal_places","type":"c","columns":[29],"validated":true,"deferrable":false,"definition":"CHECK (player_wallet_balance IS NULL OR player_wallet_balance = round(player_wallet_balance, 2))","foreign_columns":null,"initially_deferred":false,"referenced_relation":null},{"name":"fk_agents_parent","type":"f","columns":[7],"validated":true,"deferrable":false,"definition":"FOREIGN KEY (parent_agent_id) REFERENCES agents(id)","foreign_columns":[1],"initially_deferred":false,"referenced_relation":"agents"},{"name":"fk_agents_user_id_profiles","type":"f","columns":[2],"validated":true,"deferrable":false,"definition":"FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE","foreign_columns":[1],"initially_deferred":false,"referenced_relation":"profiles"}],"inheritance":null,"partition_key":null,"partition_bound":null,"replica_identity":"d","effective_privileges":{"anon":{"table":{"DELETE":false,"INSERT":false,"SELECT":false,"UPDATE":false,"TRIGGER":true,"MAINTAIN":true,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":false,"SELECT":false,"UPDATE":false,"REFERENCES":true}},"service_role":{"table":{"DELETE":true,"INSERT":true,"SELECT":true,"UPDATE":true,"TRIGGER":true,"MAINTAIN":true,"TRUNCATE":true,"REFERENCES":true},"any_column":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true}},"authenticated":{"table":{"DELETE":false,"INSERT":false,"SELECT":true,"UPDATE":false,"TRIGGER":true,"MAINTAIN":true,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}}},{"acl":["anon=rxt/postgres","authenticated=rxt/postgres","postgres=arwdDxtm/postgres","service_role=arwdDxtm/postgres"],"rls":true,"kind":"r","name":"credit_assignments","owner":"postgres","schema":"public","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","ordinal":1,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"agent_id","type":"uuid","default":null,"ordinal":2,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"assigned_by","type":"uuid","default":null,"ordinal":3,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"old_limit","type":"numeric","default":null,"ordinal":4,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"new_limit","type":"numeric","default":null,"ordinal":5,"identity":"","not_null":false,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"reason","type":"text","default":null,"ordinal":6,"identity":"","not_null":false,"collation":"\"default\"","generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","ordinal":7,"identity":"","not_null":true,"collation":null,"generated":"","effective_privileges":{"anon":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true},"service_role":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true},"authenticated":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}}],"indexes":[{"kind":"i","live":true,"name":"credit_assignments_pkey","owner":"postgres","ready":true,"valid":true,"unique":true,"primary":true,"clustered":false,"immediate":true,"definition":"CREATE UNIQUE INDEX credit_assignments_pkey ON public.credit_assignments USING btree (id)","replica_identity":false,"nulls_not_distinct":false}],"options":null,"policies":[{"cmd":"SELECT","qual":"(EXISTS ( SELECT 1\n   FROM agents a\n  WHERE ((a.id = credit_assignments.agent_id) AND ((a.user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1\n           FROM clubs c\n          WHERE ((c.id = a.club_id) AND ((c.owner_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1\n                   FROM club_members cm\n                  WHERE ((cm.club_id = a.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text])))))))))))))","roles":["public"],"tablename":"credit_assignments","permissive":"PERMISSIVE","policyname":"credit_assignments_read","schemaname":"public","with_check":null},{"cmd":"ALL","qual":"true","roles":["service_role"],"tablename":"credit_assignments","permissive":"PERMISSIVE","policyname":"credit_assignments_svc","schemaname":"public","with_check":"true"}],"triggers":null,"force_rls":false,"partition":false,"constraints":[{"name":"credit_assignments_agent_id_fkey","type":"f","columns":[2],"validated":true,"deferrable":false,"definition":"FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE","foreign_columns":[1],"initially_deferred":false,"referenced_relation":"agents"},{"name":"credit_assignments_pkey","type":"p","columns":[1],"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)","foreign_columns":null,"initially_deferred":false,"referenced_relation":null}],"inheritance":null,"partition_key":null,"partition_bound":null,"replica_identity":"d","effective_privileges":{"anon":{"table":{"DELETE":false,"INSERT":false,"SELECT":true,"UPDATE":false,"TRIGGER":true,"MAINTAIN":false,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}},"service_role":{"table":{"DELETE":true,"INSERT":true,"SELECT":true,"UPDATE":true,"TRIGGER":true,"MAINTAIN":true,"TRUNCATE":true,"REFERENCES":true},"any_column":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true}},"authenticated":{"table":{"DELETE":false,"INSERT":false,"SELECT":true,"UPDATE":false,"TRIGGER":true,"MAINTAIN":false,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}}}]$expected_relations$::jsonb) LOOP
  SELECT value INTO actual FROM jsonb_array_elements(captured) WHERE value->>'name'=expected->>'name';
  SELECT jsonb_agg(x ORDER BY x) INTO tidy FROM jsonb_array_elements(actual->'acl')x;
  actual:=jsonb_set(actual,'{acl}',COALESCE(tidy,'null'::jsonb));
  SELECT jsonb_agg(jsonb_build_object('name',t->'name','definition',t->'definition','enabled',t->'enabled',
   'internal',t->'internal','type',t->'type','function',t->'function','deferrable',t->'deferrable',
   'initially_deferred',t->'initially_deferred') ORDER BY t->>'name') INTO tidy
   FROM jsonb_array_elements(actual->'triggers')t WHERE t->'internal'='false'::jsonb;
  actual:=jsonb_set(actual,'{triggers}',COALESCE(tidy,'null'::jsonb));
  IF actual IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'credit_reduction_relation_preimage_changed' USING DETAIL=expected->>'name';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('table',k.conrelid::regclass::text,'name',k.conname,
  'referenced_relation',k.confrelid::regclass::text,'definition',pg_get_constraintdef(k.oid,true),
  'validated',k.convalidated,'deferrable',k.condeferrable,'initially_deferred',k.condeferred)
  ORDER BY k.conrelid::regclass::text,k.conname) INTO actual FROM pg_constraint k
  WHERE k.contype='f' AND k.confrelid IN('public.agents'::regclass,'public.credit_assignments'::regclass);
 IF actual IS DISTINCT FROM $expected_incoming$[{"table":"agents","name":"agents_parent_in_same_club","referenced_relation":"agents","definition":"FOREIGN KEY (club_id, parent_agent_id) REFERENCES agents(club_id, id)","validated":true,"deferrable":false,"initially_deferred":false},{"name":"fk_agents_parent","table":"agents","validated":true,"deferrable":false,"definition":"FOREIGN KEY (parent_agent_id) REFERENCES agents(id)","initially_deferred":false,"referenced_relation":"agents"},{"name":"commission_rate_audit_agent_id_fkey","table":"commission_rate_audit","validated":true,"deferrable":false,"definition":"FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"agents"},{"name":"credit_assignments_agent_id_fkey","table":"credit_assignments","validated":true,"deferrable":false,"definition":"FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"agents"},{"name":"credit_invoices_agent_id_fkey","table":"credit_invoices","validated":true,"deferrable":false,"definition":"FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"agents"},{"name":"player_agent_assignments_agent_id_fkey","table":"player_agent_assignments","validated":true,"deferrable":false,"definition":"FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL","initially_deferred":false,"referenced_relation":"agents"},{"name":"rake_attributions_agent_id_fkey","table":"rake_attributions","validated":true,"deferrable":false,"definition":"FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL","initially_deferred":false,"referenced_relation":"agents"},{"name":"sub_agents_parent_agent_id_fkey","table":"sub_agents","validated":true,"deferrable":false,"definition":"FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"agents"}]$expected_incoming$::jsonb
 THEN RAISE EXCEPTION 'credit_reduction_incoming_foreign_key_changed';END IF;
END $credit_relations$;

-- Fragment payment-closure-guards.sql
-- SOURCE ONLY / UNRUN. Complete facts from the bounded14:41 payment-closure
-- capture, before any successor mutations, inside the same enclosing transaction.
-- No claim is made about uncaptured constraints/indexes or further dynamic/delegate closure.
SET LOCAL search_path=public,pg_catalog;
LOCK TABLE public.credit_invoices,public.credit_payments,public.wallets IN ACCESS EXCLUSIVE MODE;
DO $credit_payment_closure$ DECLARE captured jsonb;actual jsonb;expected jsonb;tidy jsonb;BEGIN
 WITH rels AS(SELECT c.*,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN('credit_invoices','credit_payments','wallets'))
 SELECT (SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,
  'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl,'options',c.reloptions,
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
    'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl)
    ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),
    'enabled',t.tgenabled,'type',t.tgtype,'function',t.tgfoid::regprocedure::text,'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred)
    ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname),
  'effective_privileges',(SELECT jsonb_object_agg(api,jsonb_build_object('table',(SELECT jsonb_object_agg(priv,has_table_privilege(api,c.oid,priv))
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])priv),
   'any_column',(SELECT jsonb_object_agg(priv,has_any_column_privilege(api,c.oid,priv))
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES'])priv))) FROM unnest(ARRAY['anon','authenticated','service_role'])api)
  ) ORDER BY c.relname) FROM rels c) INTO captured;
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"acl":["anon=rxt/postgres","authenticated=rxt/postgres","postgres=arwdDxtm/postgres","service_role=arwdDxtm/postgres"],"rls":true,"kind":"r","name":"credit_invoices","owner":"postgres","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","ordinal":1,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"agent_id","type":"uuid","default":null,"ordinal":2,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"period_start","type":"timestamp with time zone","default":null,"ordinal":3,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"period_end","type":"timestamp with time zone","default":null,"ordinal":4,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"debt_owed","type":"numeric","default":"0","ordinal":5,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"amount_paid","type":"numeric","default":"0","ordinal":6,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"amount_remaining","type":"numeric","default":"0","ordinal":7,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"status","type":"text","default":"'pending'::text","ordinal":8,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"due_date","type":"timestamp with time zone","default":null,"ordinal":9,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","ordinal":10,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"paid_at","type":"timestamp with time zone","default":null,"ordinal":11,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"void_reason","type":"text","default":null,"ordinal":12,"identity":"","not_null":false,"generated":""}],"options":null,"policies":[{"cmd":"SELECT","qual":"(agent_id IN ( SELECT a.id\n   FROM agents a\n  WHERE (a.user_id = ( SELECT auth.uid() AS uid))))","roles":["public"],"tablename":"credit_invoices","permissive":"PERMISSIVE","policyname":"credit_invoices_select_own","schemaname":"public","with_check":null}],"triggers":[{"name":"accounting_credit_invoice_document","type":5,"enabled":"O","function":"fn_accounting_credit_document_on_insert()","deferrable":false,"definition":"CREATE TRIGGER accounting_credit_invoice_document AFTER INSERT ON credit_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_credit_document_on_insert()","initially_deferred":false},{"name":"trg_guard_retired_club_mutation","type":31,"enabled":"O","function":"fn_guard_retired_club_mutation()","deferrable":false,"definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON credit_invoices FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()","initially_deferred":false}],"force_rls":false,"effective_privileges":{"anon":{"table":{"DELETE":false,"INSERT":false,"SELECT":true,"UPDATE":false,"TRIGGER":true,"MAINTAIN":false,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}},"service_role":{"table":{"DELETE":true,"INSERT":true,"SELECT":true,"UPDATE":true,"TRIGGER":true,"MAINTAIN":true,"TRUNCATE":true,"REFERENCES":true},"any_column":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true}},"authenticated":{"table":{"DELETE":false,"INSERT":false,"SELECT":true,"UPDATE":false,"TRIGGER":true,"MAINTAIN":false,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}}},{"acl":["anon=rxt/postgres","authenticated=rxt/postgres","postgres=arwdDxtm/postgres","service_role=arwdDxtm/postgres"],"rls":true,"kind":"r","name":"credit_payments","owner":"postgres","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","ordinal":1,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"invoice_id","type":"uuid","default":null,"ordinal":2,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"amount","type":"numeric","default":null,"ordinal":3,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"payment_method","type":"text","default":null,"ordinal":4,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"transaction_id","type":"text","default":null,"ordinal":5,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","ordinal":6,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"operation_id","type":"uuid","default":null,"ordinal":7,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"payer_user_id","type":"uuid","default":null,"ordinal":8,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"payment_reference","type":"text","default":null,"ordinal":9,"identity":"","not_null":false,"generated":""}],"options":null,"policies":[{"cmd":"SELECT","qual":"(invoice_id IN ( SELECT ci.id\n   FROM (credit_invoices ci\n     JOIN agents a ON ((a.id = ci.agent_id)))\n  WHERE (a.user_id = ( SELECT auth.uid() AS uid))))","roles":["public"],"tablename":"credit_payments","permissive":"PERMISSIVE","policyname":"credit_payments_select_own","schemaname":"public","with_check":null}],"triggers":[{"name":"accounting_credit_payment_document","type":5,"enabled":"O","function":"fn_accounting_credit_document_on_insert()","deferrable":false,"definition":"CREATE TRIGGER accounting_credit_payment_document AFTER INSERT ON credit_payments FOR EACH ROW EXECUTE FUNCTION fn_accounting_credit_document_on_insert()","initially_deferred":false}],"force_rls":false,"effective_privileges":{"anon":{"table":{"DELETE":false,"INSERT":false,"SELECT":true,"UPDATE":false,"TRIGGER":true,"MAINTAIN":false,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}},"service_role":{"table":{"DELETE":true,"INSERT":true,"SELECT":true,"UPDATE":true,"TRIGGER":true,"MAINTAIN":true,"TRUNCATE":true,"REFERENCES":true},"any_column":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true}},"authenticated":{"table":{"DELETE":false,"INSERT":false,"SELECT":true,"UPDATE":false,"TRIGGER":true,"MAINTAIN":false,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":false,"SELECT":true,"UPDATE":false,"REFERENCES":true}}}},{"acl":["anon=arwdxtm/postgres","authenticated=arwdxtm/postgres","postgres=arwdDxtm/postgres","service_role=arwdDxtm/postgres"],"rls":true,"kind":"r","name":"wallets","owner":"postgres","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","ordinal":1,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"user_id","type":"uuid","default":null,"ordinal":2,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"wallet_type","type":"text","default":null,"ordinal":3,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"balance","type":"numeric(15,2)","default":"0","ordinal":4,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"locked_balance","type":"numeric(15,2)","default":"0","ordinal":5,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"updated_at","type":"timestamp with time zone","default":"now()","ordinal":6,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","ordinal":7,"identity":"","not_null":false,"generated":""}],"options":null,"policies":[{"cmd":"ALL","qual":"true","roles":["service_role"],"tablename":"wallets","permissive":"PERMISSIVE","policyname":"Service role full access wallets","schemaname":"public","with_check":"true"},{"cmd":"INSERT","qual":null,"roles":["public"],"tablename":"wallets","permissive":"PERMISSIVE","policyname":"Users can insert own wallets","schemaname":"public","with_check":"(user_id = ( SELECT auth.uid() AS uid))"},{"cmd":"SELECT","qual":"(( SELECT auth.uid() AS uid) = user_id)","roles":["public"],"tablename":"wallets","permissive":"PERMISSIVE","policyname":"Users can read own wallets","schemaname":"public","with_check":null}],"triggers":[{"name":"trg_guard_wallets_balance_ins","type":7,"enabled":"O","function":"guard_wallet_balance_write()","deferrable":false,"definition":"CREATE TRIGGER trg_guard_wallets_balance_ins BEFORE INSERT ON wallets FOR EACH ROW WHEN (new.balance IS NOT NULL AND new.balance <> 0::numeric) EXECUTE FUNCTION guard_wallet_balance_write()","initially_deferred":false},{"name":"trg_guard_wallets_balance_upd","type":19,"enabled":"O","function":"guard_wallet_balance_write()","deferrable":false,"definition":"CREATE TRIGGER trg_guard_wallets_balance_upd BEFORE UPDATE OF balance ON wallets FOR EACH ROW WHEN (new.balance IS DISTINCT FROM old.balance) EXECUTE FUNCTION guard_wallet_balance_write()","initially_deferred":false},{"name":"zz_ca_record_frozen_pool_deletion","type":11,"enabled":"O","function":"fn_ca_record_frozen_pool_deletion()","deferrable":false,"definition":"CREATE TRIGGER zz_ca_record_frozen_pool_deletion BEFORE DELETE ON wallets FOR EACH ROW EXECUTE FUNCTION fn_ca_record_frozen_pool_deletion()","initially_deferred":false},{"name":"zz_freeze_guard","type":31,"enabled":"O","function":"fn_refuse_while_frozen()","deferrable":false,"definition":"CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('balance')","initially_deferred":false}],"force_rls":false,"effective_privileges":{"anon":{"table":{"DELETE":true,"INSERT":true,"SELECT":true,"UPDATE":true,"TRIGGER":true,"MAINTAIN":true,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true}},"service_role":{"table":{"DELETE":true,"INSERT":true,"SELECT":true,"UPDATE":true,"TRIGGER":true,"MAINTAIN":true,"TRUNCATE":true,"REFERENCES":true},"any_column":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true}},"authenticated":{"table":{"DELETE":true,"INSERT":true,"SELECT":true,"UPDATE":true,"TRIGGER":true,"MAINTAIN":true,"TRUNCATE":false,"REFERENCES":true},"any_column":{"INSERT":true,"SELECT":true,"UPDATE":true,"REFERENCES":true}}}}]$expected$::jsonb) LOOP
  SELECT value INTO actual FROM jsonb_array_elements(captured) WHERE value->>'name'=expected->>'name';
  SELECT jsonb_agg(x ORDER BY x) INTO tidy FROM jsonb_array_elements(actual->'acl')x;
  actual:=jsonb_set(actual,'{acl}',COALESCE(tidy,'null'::jsonb));
  IF actual IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'credit_reduction_payment_closure_changed' USING DETAIL=expected->>'name';END IF;
 END LOOP;
END $credit_payment_closure$;

-- Fragment lock-order-successor.sql
-- SOURCE ONLY / UNRUN. Seven existing caller lock-order amendments only.
-- Load after complete preimage guards, within the enclosing post36 transaction.
-- Existing authentication, formulas, delegates, returns, and grants are retained.
SET LOCAL search_path=public,pg_catalog;
DO $credit_lock_preimages$ DECLARE expected jsonb;actual jsonb;target oid;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($expected_functions$[{"owner":"postgres","arguments":"p_club_id uuid, p_user_id uuid, p_role text, p_actor_user_id uuid DEFAULT NULL::uuid, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_is_prepaid boolean DEFAULT NULL::boolean, p_credit_limit numeric DEFAULT NULL::numeric","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"59e8df8dc16220b5bad8e5f2437241e7","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_agent_user_id uuid, p_super_agent_user_id uuid, p_club_id uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_assign_agent_to_super_agent(uuid,uuid,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"13f6d2408d152e7d15a8b3b0bf113a9f","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_user_id uuid, p_role text","result":"uuid","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_ensure_agent_row(uuid,uuid,text)","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"3bd1e0aeed55ae8e56c9e28e8967ae2b","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"0214036f29a6d121842496c91c7912af","basis":"retained 14:12:09.241743+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"53ba478533aec762384aa9ac7d63a9b2","basis":"retained 14:22:10.194019+00"},{"owner":"postgres","arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)","acl":["postgres=X/postgres","service_role=X/postgres"],"full_definition_md5":"c6bb171c71aa0d6022296b29269a016b","basis":"retained 14:12:09.241743+00"},{"signature":"public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)","arguments":"p_action text, p_club_id uuid, p_cashout_id uuid, p_amount numeric, p_expected_actor_id uuid, p_op_id uuid, p_note text DEFAULT NULL::text","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"1e07ffe61af347db3f356afdb57e55c4","basis":"supabase/accounting/weekly-v3/components/20260914164700_cashier_cashout_documents_share_the_existing_invoice_authority.sql exact corrected33 composite-membership body/header/private ACL; unchanged34\u201336"}]$expected_functions$::jsonb) LOOP
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
  THEN RAISE EXCEPTION 'credit_reduction_lock_preimage_changed' USING DETAIL=expected->>'signature';END IF;
 END LOOP;
END $credit_lock_preimages$;

-- Exact captured predecessor plus the single early mutex insertion.
CREATE OR REPLACE FUNCTION public.fn_club_set_member_role(p_club_id uuid, p_user_id uuid, p_role text, p_actor_user_id uuid DEFAULT NULL::uuid, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_is_prepaid boolean DEFAULT NULL::boolean, p_credit_limit numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor      uuid;
  v_old_role   text;
  v_actor_role text;
  v_allowed    text[];
  v_downline   int;
  v_agent_id   uuid;
  v_parent     uuid;
  v_set_upline boolean := false;
  v_is_agent   boolean;
  v_is_staff   boolean;
  v_comm       numeric;
  v_rake       numeric;
  v_prepaid    boolean;
  v_limit      numeric;
  v_have_row   boolean := false;
  v_fresh      boolean;
  v_cap_comm   numeric;
  v_cap_rake   numeric;
  v_cap_limit  numeric;
  v_float      numeric;
  v_owed       numeric;
  v_commission numeric;
  v_keeps_wallet boolean;
  v_club_name  text;
  v_label      text;
BEGIN
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  -- IDENTITY. auth.uid() is the ONLY identity a browser can establish; it is
  -- NULL for anon, and a NULL here used to mean "believe p_actor_user_id".
  -- A caller-supplied actor is now accepted from a trusted backend only.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    IF COALESCE(auth.role(), 'service_role') = 'service_role'
       AND p_actor_user_id IS NOT NULL THEN
      v_actor := p_actor_user_id;
    ELSE
      RETURN jsonb_build_object('success', false, 'error', 'actor identity required');
    END IF;
  END IF;

  IF p_role IS NULL OR p_role NOT IN
     ('co_owner','admin','super_agent','agent','sub_agent','player') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role: ' || COALESCE(p_role,'null'));
  END IF;

  v_is_agent := p_role IN ('super_agent','agent','sub_agent');
  v_is_staff := p_role IN ('co_owner','admin');

  IF NOT v_is_agent
     AND (COALESCE(p_commission_rate, 0) <> 0 OR COALESCE(p_player_rakeback_rate, 0) <> 0) THEN
    RETURN jsonb_build_object('success', false,
      'error', CASE WHEN v_is_staff
                    THEN 'co owners and admins receive no rakeback, so no rate may be set for one'
                    ELSE 'only an agent role carries a commission or rakeback rate' END);
  END IF;

  -- Funding belongs to an agent role. Sending it with a demotion to player, or
  -- with a promotion to staff, is a caller mistake worth naming rather than
  -- quietly ignoring: it usually means the wrong role reached this call.
  IF NOT v_is_agent AND (p_is_prepaid IS NOT NULL OR p_credit_limit IS NOT NULL) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'only an agent role is funded prepaid or on a credit line');
  END IF;

  SELECT role INTO v_old_role FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
     AND status IN ('active','approved')
   FOR UPDATE;

  IF v_old_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'target is not a member of this club');
  END IF;

  IF v_old_role = p_role THEN
    RETURN jsonb_build_object('success', true, 'unchanged', true, 'role', p_role);
  END IF;

  v_allowed := fn_club_grantable_roles(p_club_id, v_actor, p_user_id);
  IF NOT (p_role = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not permitted to set this role',
      'allowed', COALESCE(to_jsonb(v_allowed), '[]'::jsonb));
  END IF;

  SELECT role INTO v_actor_role FROM club_members
   WHERE club_id = p_club_id AND user_id = v_actor AND status IN ('active','approved');

  IF fn_club_role_rank(v_old_role) > fn_club_role_rank(p_role)
     AND v_old_role IN ('super_agent','agent','sub_agent') THEN
    SELECT count(*) INTO v_downline FROM club_members
     WHERE club_id = p_club_id AND agent_id = p_user_id;
    IF v_downline > 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'this member still has ' || v_downline || ' player'
                 || CASE WHEN v_downline = 1 THEN '' ELSE 's' END
                 || ' reporting to them. Move them to another agent first.',
        'downline_count', v_downline);
    END IF;
  END IF;

  v_set_upline := v_actor_role IN ('super_agent','agent')
                  AND p_role IN ('agent','sub_agent');

  -- ---------------------------------------------------------------------------
  -- A DEMOTION MUST NOT STRAND MONEY
  -- ---------------------------------------------------------------------------
  -- Every role except 'player' may hold an agent wallet - Dan, 2026-08-31:
  -- "OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS." So moving an
  -- agent up to co-owner, or sideways to another agent tier, strands nothing:
  -- the wallet goes with them and they can still spend it.
  --
  -- Becoming a PLAYER is the one move that takes the wallet away.
  -- fn_club_bank_role then returns 'player', fn_agent_wallet_send refuses them
  -- outright, and fn_agent_wallet_claim_back with it - so whatever the row still
  -- holds becomes chips nobody can move and nobody is watching. 67 of the 111
  -- active agents hold float today, 6,726,000 chips between them.
  --
  -- The remedy already exists and is named in the refusal:
  -- fn_club_bank_claim_back pulls the float back into the club bank, keyed on an
  -- op_id and written to the ledger, and any owner, co-owner, admin or super
  -- agent may run it. A debt is not sweepable and must be settled instead -
  -- fn_apply_credit_payment pays credit_used down when the invoice is paid.
  v_keeps_wallet := p_role <> 'player';

  -- PHASE 7. What the club still owes this person, from the ledger the claim
  -- path settles - rather than from the agents column that migration drops,
  -- which nothing ever wrote. It said 26,859.87 across 5 agents on a day the
  -- ledger held 408,809.59 across 114, so 109 of those 114 were reported to the
  -- person changing their role as owed nothing at all. One partial-index lookup
  -- (agent_commissions_unsettled_idx).
  -- reads the ledger directly: this function has already authorized its
  -- actor through fn_club_grantable_roles above, and it is SECURITY DEFINER,
  -- so it does not need the guarded caller-facing RPC's door. That RPC now
  -- admits only self, club admin and above, an agent ancestor, or the
  -- service role, and THIS report must not be able to fail on it. Same
  -- SELECT, same partial index (agent_commissions_unsettled_idx).
  SELECT COALESCE(SUM(ac.amount), 0)::numeric INTO v_commission
    FROM public.agent_commissions ac
   WHERE ac.club_id = p_club_id
     AND ac.user_id = p_user_id
     AND ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at);

  -- v_old_role was checked against the three AGENT tiers here, which missed the
  -- people phase 2 deliberately gave wallets to. A co-owner or an admin holds an
  -- agent wallet by design - Dan: "OWNERS AND CO OWNERS CAN AND SHOULD HAVE
  -- AGENT WALLETS" - so demoting one straight to player took the wallet away
  -- with the float still in it, which is the exact defect this phase exists to
  -- stop. Any role that is not already 'player' can be holding one.
  IF NOT v_keeps_wallet AND v_old_role <> 'player' THEN
    SELECT COALESCE(a.agent_wallet_balance, 0), COALESCE(a.credit_used, 0)
      INTO v_float, v_owed
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;

    IF COALESCE(v_float, 0) > 0 OR COALESCE(v_owed, 0) > 0 THEN
      -- Name only what is actually outstanding. "holds 5,000 chips and owes
      -- 0.00" invites somebody to go looking for a debt that is not there.
      RETURN jsonb_build_object('success', false, 'needs_settlement', true,
        'error', 'this member cannot become a player yet: '
                 || CASE WHEN COALESCE(v_float, 0) > 0 AND COALESCE(v_owed, 0) > 0
                         THEN 'their agent wallet still holds '
                              || trim(to_char(v_float, 'FM999,999,999,990.00'))
                              || ' chips, and they still owe '
                              || trim(to_char(v_owed, 'FM999,999,999,990.00'))
                              || '. Claim the chips back into the club bank and settle the debt first.'
                         WHEN COALESCE(v_float, 0) > 0
                         THEN 'their agent wallet still holds '
                              || trim(to_char(v_float, 'FM999,999,999,990.00'))
                              || ' chips. Claim them back into the club bank first, '
                              || 'because a player cannot spend an agent wallet.'
                         ELSE 'they still owe '
                              || trim(to_char(v_owed, 'FM999,999,999,990.00'))
                              || ' on their credit line. Settle the invoice first.'
                    END,
        'agent_wallet_balance', COALESCE(v_float, 0),
        'credit_used', COALESCE(v_owed, 0),
        'unclaimed_commission', COALESCE(v_commission, 0));
    END IF;
  END IF;

  IF v_is_agent THEN
    SELECT a.commission_rate, a.player_rakeback_rate, a.is_prepaid, a.credit_limit
      INTO v_comm, v_rake, v_prepaid, v_limit
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;
    v_have_row := FOUND;

    -- B-01, Dan 2026-08-31: FORCE A FRESH CHOICE.
    --
    -- A member whose current club role is not an agent tier is being PROMOTED.
    -- Their agents row may still hold the commission, rakeback and credit line
    -- they carried before they were demoted, and a commercial term nobody has
    -- re-agreed does not come back by default - "getting this wrong costs
    -- money" was the whole of the question put to Dan. So on a promotion every
    -- term is taken from this call and from nowhere else.
    --
    -- Re-GRADING an existing agent (agent to super agent) is a different act:
    -- their terms are live, not stale, and carrying them forward when the
    -- caller sends nothing is what every existing caller already relies on.
    v_fresh := v_old_role NOT IN ('super_agent','agent','sub_agent');

    IF v_fresh THEN
      v_comm    := p_commission_rate;
      v_rake    := p_player_rakeback_rate;
      v_prepaid := p_is_prepaid;
      v_limit   := p_credit_limit;
    ELSE
      v_comm    := COALESCE(p_commission_rate, v_comm);
      v_rake    := COALESCE(p_player_rakeback_rate, v_rake);
      v_prepaid := COALESCE(p_is_prepaid, v_prepaid);
      v_limit   := COALESCE(p_credit_limit, v_limit);
    END IF;

    IF v_comm IS NULL OR v_rake IS NULL THEN
      RETURN jsonb_build_object('success', false, 'needs_rates', true,
        'error', 'a commission rate and a player rakeback rate must be chosen when granting an agent role');
    END IF;
    IF v_comm < 0 OR v_comm > 0.70 THEN
      RETURN jsonb_build_object('success', false, 'error', 'the commission rate must be between 0 and 0.70');
    END IF;
    IF v_rake < 0 OR v_rake > 0.50 THEN
      RETURN jsonb_build_object('success', false, 'error', 'the player rakeback rate must be between 0 and 0.50');
    END IF;
    IF v_rake > v_comm THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the player rakeback rate cannot exceed the commission rate it is paid out of');
    END IF;

    -- Dan, 2026-08-31: "WHEN A AGENT IS PROMOTED ... THEY ALSO NEED TO BE
    -- ASSIGNED 'PRE PAID' OR CREDIT LINE, (AND IF SO, THEN HOW MUCH)".
    -- Before this, every promotion hardcoded credit_limit 0 and left is_prepaid
    -- at its column default of false, which is the one combination that can
    -- send nothing at all: not prepaid, and no line to draw on. Three agents
    -- are in exactly that state on production today.
    IF v_prepaid IS NULL THEN
      RETURN jsonb_build_object('success', false, 'needs_funding', true,
        'error', 'choose prepaid or a credit line when granting an agent role');
    END IF;
    IF v_prepaid THEN
      IF COALESCE(v_limit, 0) <> 0 THEN
        RETURN jsonb_build_object('success', false,
          'error', 'a prepaid agent carries no credit line, so the limit must be 0');
      END IF;
      v_limit := 0;
    ELSE
      IF v_limit IS NULL THEN
        RETURN jsonb_build_object('success', false, 'needs_funding', true,
          'error', 'a credit agent needs a credit limit');
      END IF;
      IF v_limit <= 0 THEN
        RETURN jsonb_build_object('success', false,
          'error', 'a credit line must be greater than 0, or the agent should be prepaid');
      END IF;
    END IF;

    IF v_set_upline THEN
      SELECT id, commission_rate, player_rakeback_rate, credit_limit
        INTO v_parent, v_cap_comm, v_cap_rake, v_cap_limit
        FROM agents WHERE club_id = p_club_id AND user_id = v_actor;
    ELSIF v_have_row THEN
      SELECT p.commission_rate, p.player_rakeback_rate, p.credit_limit
        INTO v_cap_comm, v_cap_rake, v_cap_limit
        FROM agents a JOIN agents p ON p.id = a.parent_agent_id
       WHERE a.club_id = p_club_id AND a.user_id = p_user_id;
    END IF;

    IF v_cap_comm IS NOT NULL AND v_comm > v_cap_comm THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the commission rate cannot exceed the upline rate of ' || v_cap_comm);
    END IF;
    IF v_cap_rake IS NOT NULL AND v_rake > v_cap_rake THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the player rakeback rate cannot exceed the upline rate of ' || v_cap_rake);
    END IF;
    -- An upline cannot lend downward what it does not itself hold.
    IF v_cap_limit IS NOT NULL AND v_limit > v_cap_limit THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the credit limit cannot exceed the upline limit of ' || v_cap_limit);
    END IF;
  END IF;

  PERFORM set_config('app.club_role_change', 'on', true);

  UPDATE club_members
     SET role                = p_role,
         agent_id            = CASE WHEN v_set_upline THEN v_actor ELSE agent_id END,
         player_rakeback_pct = CASE WHEN v_is_staff THEN 0 ELSE player_rakeback_pct END,
         rakeback_rate       = CASE WHEN v_is_staff THEN 0 ELSE rakeback_rate END,
         commission_rate     = CASE WHEN v_is_staff THEN 0 ELSE commission_rate END,
         updated_at          = now()
   WHERE club_id = p_club_id AND user_id = p_user_id;

  PERFORM set_config('app.club_role_change', '', true);

  IF v_is_agent THEN
    SELECT id INTO v_agent_id FROM agents
     WHERE club_id = p_club_id AND user_id = p_user_id;

    IF v_agent_id IS NOT NULL THEN
      UPDATE agents
         SET role = p_role, status = 'active',
             parent_agent_id = COALESCE(v_parent, parent_agent_id),
             commission_rate = v_comm, player_rakeback_rate = v_rake,
             is_prepaid = v_prepaid, credit_limit = v_limit,
             updated_at = now()
       WHERE id = v_agent_id;
    ELSE
      INSERT INTO agents (club_id, user_id, role, status, parent_agent_id,
                          commission_rate, player_rakeback_rate,
                          is_prepaid, credit_limit, credit_used)
      VALUES (p_club_id, p_user_id, p_role, 'active', v_parent, v_comm, v_rake,
              v_prepaid, v_limit, 0)
      RETURNING id INTO v_agent_id;
    END IF;
  ELSE
    -- Suspend the row only when the member can no longer hold a wallet. A
    -- promotion to co-owner or admin used to suspend it too, which contradicted
    -- the rule that staff hold agent wallets and left the club bank funding a
    -- row marked inactive.
    -- Active while they can hold a wallet, suspended when they cannot. Keyed on
    -- the role they are BECOMING, for the same reason the guard above is: a
    -- co-owner demoted to player left an ACTIVE agents row behind, so a player
    -- still read as an agent - fn_player_rakeback_rate joins that row on
    -- status = 'active'.
    UPDATE agents
       SET status = CASE WHEN p_role = 'player' AND v_old_role <> 'player'
                         THEN 'suspended' ELSE status END,
           commission_rate      = CASE WHEN v_is_staff THEN 0 ELSE commission_rate END,
           player_rakeback_rate = CASE WHEN v_is_staff THEN 0 ELSE player_rakeback_rate END,
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  INSERT INTO audit_trail (actor_id, actor_role, action, target_type, target_id,
                           club_id, before_state, after_state, reason)
  VALUES (v_actor, COALESCE(v_actor_role, 'platform_admin'), 'set_member_role',
          'club_member', p_user_id, p_club_id,
          jsonb_build_object('role', v_old_role),
          jsonb_build_object('role', p_role, 'upline_set', v_set_upline,
                             'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
                             'is_prepaid', v_prepaid, 'credit_limit', v_limit,
                             'funding_rechosen', COALESCE(v_fresh, false)),
          'Role changed via fn_club_set_member_role');

  -- ---------------------------------------------------------------------------
  -- TELL THE PERSON IT HAPPENED
  -- ---------------------------------------------------------------------------
  -- Until now the only announcement was masterBus.emit('MEMBER_ROLE_CHANGED'),
  -- a browser-local event. It reaches the tabs of whoever performed the change
  -- and nobody else, so the person whose role actually changed found out when a
  -- button appeared or vanished. notifications is the estate's real channel:
  -- 11,362 rows, four RLS policies, rendered by NotificationDropdown, the
  -- header store and NotificationsPage.
  --
  -- Failing to notify must never fail the role change. The role is the fact;
  -- the notice is a courtesy, and a courtesy that can roll back a promotion is
  -- worse than no courtesy at all.
  SELECT name INTO v_club_name FROM clubs WHERE id = p_club_id;
  v_label := CASE p_role
               WHEN 'co_owner' THEN 'Co Owner'
               WHEN 'admin' THEN 'Admin'
               WHEN 'super_agent' THEN 'Super Agent'
               WHEN 'agent' THEN 'Agent'
               WHEN 'sub_agent' THEN 'Sub Agent'
               ELSE 'Player'
             END;
  BEGIN
    PERFORM public.fn_raise_notification(
      p_user_id,
      'club_role_changed',
      'Your Role Changed In ' || COALESCE(v_club_name, 'Your Club'),
      'You Are Now ' || v_label || '.'
        || CASE WHEN v_is_agent
                THEN ' Your Commission Is ' || trim(to_char(v_comm * 100, 'FM990.00'))
                     || ' Percent And Your Player Rakeback Is '
                     || trim(to_char(v_rake * 100, 'FM990.00')) || ' Percent.'
                     || CASE WHEN v_prepaid THEN ' You Are Prepaid.'
                             ELSE ' Your Credit Line Is '
                                  || trim(to_char(v_limit, 'FM999,999,999,990.00')) || ' Chips.'
                        END
                ELSE '' END,
      '/clubs/' || p_club_id::text,
      jsonb_build_object(
        'club_id', p_club_id, 'old_role', v_old_role, 'new_role', p_role,
        'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
        'is_prepaid', v_prepaid, 'credit_limit', v_limit));
  EXCEPTION WHEN OTHERS THEN
    -- Swallowed on purpose, and only here. The role change is already durable.
    NULL;
  END;

  RETURN jsonb_build_object('success', true, 'old_role', v_old_role, 'new_role', p_role,
    'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
    'is_prepaid', v_prepaid, 'credit_limit', v_limit,
    -- Commission the CLUB owes THEM. It does not block the demotion: the agents
    -- row survives with the figure intact, so nothing is lost by moving the
    -- role, and there is no payout path to send them to yet (phase 6 builds
    -- one). Blocking here would strand the club, not the money. Reported so the
    -- caller can say it out loud rather than discover it later.
    'unclaimed_commission', COALESCE(v_commission, 0),
    'reports_to', CASE WHEN v_set_upline THEN v_actor ELSE NULL END);
END;
$function$;

-- Exact captured predecessor plus the single early mutex insertion.
CREATE OR REPLACE FUNCTION public.fn_assign_agent_to_super_agent(p_agent_user_id uuid, p_super_agent_user_id uuid, p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_agent uuid; v_super uuid;
BEGIN
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  IF NOT public.fn_is_any_union_overseer(auth.uid()) AND NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT id INTO v_agent FROM agents WHERE user_id = p_agent_user_id AND club_id = p_club_id;
  SELECT id INTO v_super FROM agents WHERE user_id = p_super_agent_user_id AND club_id = p_club_id;
  IF v_agent IS NULL OR v_super IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_or_super_agent_not_found');
  END IF;
  IF v_agent = v_super THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_cannot_report_to_itself');
  END IF;
  -- No cycles: the proposed parent must not already sit beneath this agent.
  IF EXISTS (
    WITH RECURSIVE up AS (
      SELECT id, parent_agent_id FROM agents WHERE id = v_super
      UNION ALL
      SELECT a.id, a.parent_agent_id FROM agents a JOIN up ON up.parent_agent_id = a.id
    ) SELECT 1 FROM up WHERE id = v_agent
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'would_create_cycle');
  END IF;

  UPDATE agents SET parent_agent_id = v_super, updated_at = now() WHERE id = v_agent;
  UPDATE agents SET role = 'super_agent', updated_at = now()
   WHERE id = v_super AND COALESCE(role,'agent') <> 'super_agent';

  RETURN jsonb_build_object('success', true, 'agent_id', v_agent, 'super_agent_id', v_super);
END $function$;

-- Exact captured predecessor plus the single early mutex insertion.
CREATE OR REPLACE FUNCTION public.fn_ensure_agent_row(p_club_id uuid, p_user_id uuid, p_role text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id    uuid;
  v_union uuid;
  v_min   numeric;
  v_role  text;
  v_staff boolean;
begin
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  if v_id is not null then
    return v_id;
  end if;

  -- agents.role CHECK still admits only the three agent tiers, so a staff
  -- wallet holder is stored as 'super_agent'. The data lies about who holds the
  -- wallet; club_members.role is the truth and every rule reads it. Recorded as
  -- P3 debt for phase 7, not fixed here, because relaxing that CHECK is a table
  -- lock on agents and this migration deliberately takes none.
  v_role := case when p_role in ('super_agent', 'agent', 'sub_agent') then p_role
                 else 'super_agent' end;

  v_staff := exists (
    select 1 from club_members cm
     where cm.club_id = p_club_id and cm.user_id = p_user_id
       and cm.role in ('co_owner', 'admin'));

  select coalesce(uc.union_id, c.union_id) into v_union
    from clubs c
    left join union_clubs uc on uc.club_id = c.id
   where c.id = p_club_id
   limit 1;

  -- A rate nobody chose is the bug phase 0 removed from the promotion path.
  -- Staff earn nothing by law, so minting them at the union minimum invented a
  -- commission AND tripped the band on the way back down to zero.
  v_min := case when v_staff then 0
                when v_union is null then 0
                else public.fn_union_setting(v_union, 'min_agent_commission', 0) end;

  -- Prepaid with no line: a wallet that appears because somebody was sent chips
  -- must not also arrive able to borrow. A credit line is granted deliberately,
  -- through the promotion screen or the agent panel, never as a side effect.
  insert into agents (user_id, club_id, role, status,
                      agent_wallet_balance, promo_wallet_balance,
                      commission_rate, player_rakeback_rate,
                      credit_limit, credit_used, is_prepaid)
  values (p_user_id, p_club_id, v_role, 'active', 0, 0, v_min, 0, 0, 0, true)
  on conflict (user_id, club_id) do nothing;

  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  return v_id;
end
$function$;

-- Exact captured predecessor plus the single early mutex insertion.
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  if auth.uid() is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Send');
  end if;
  return public.fn_agent_wallet_send_phase2_core_20260831(
    p_club_id,p_to_user_id,p_amount,p_destination,p_reason,p_op_id
  );
end
$function$;

-- Exact captured predecessor plus the single early mutex insertion.
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_phase2_core_20260831(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_op_id uuid := coalesce(p_op_id,gen_random_uuid());
  v_destination text := lower(coalesce(p_destination,'player_wallet'));
  v_prior record;
  v_replay_destination text;
  v_actor_role text;
  v_target_role text;
  v_first uuid;
  v_second uuid;
begin
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  if v_actor is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_club_id is null or p_to_user_id is null or p_to_user_id=v_actor then
    return jsonb_build_object('success',false,'error','Choose Another Active Member');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1e9 or p_amount<>round(p_amount,2) then
    return jsonb_build_object('success',false,'error','Enter A Valid Send Amount');
  end if;
  if v_destination not in ('player_wallet','agent_wallet') then
    return jsonb_build_object('success',false,'error','Unknown Destination Wallet');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-send:'||p_club_id::text||':'||v_actor::text||':'||v_op_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));

  select ct.* into v_prior from public.chip_transactions ct
   where ct.club_id=p_club_id and ct.transaction_type='agent_wallet_send'
     and ct.from_user_id=v_actor and ct.metadata->>'op_id'=v_op_id::text limit 1;
  if found then
    v_replay_destination := case
      when coalesce(v_prior.metadata->>'recipient_role','') in
        ('owner','co_owner','admin','super_agent','agent','sub_agent')
      then 'agent_wallet' else v_destination end;
    if v_prior.to_user_id is distinct from p_to_user_id
       or v_prior.amount is distinct from p_amount
       or coalesce(v_prior.metadata->>'destination','') is distinct from v_replay_destination then
      return jsonb_build_object('success',false,
        'error','That Retry Key Belongs To A Different Agent Wallet Send');
    end if;
    return jsonb_build_object(
      'success',true,'replayed',true,'transaction_id',v_prior.id,'amount',v_prior.amount,
      'destination',v_prior.metadata->>'destination',
      'agent_wallet_after',(v_prior.metadata->>'agent_wallet_after')::numeric,
      'recipient_balance_after',(v_prior.metadata->>'recipient_balance_after')::numeric,
      'credit_drawn',coalesce((v_prior.metadata->>'credit_drawn')::numeric,0),
      'credit_used_after',(v_prior.metadata->>'credit_used_after')::numeric,
      'credit_limit',(v_prior.metadata->>'credit_limit')::numeric);
  end if;

  -- Ownership and both membership rows stay locked through the core operation.
  -- A concurrent role revocation, downline reassignment, or member deletion
  -- must complete before or after this send, never between its checks and debit.
  perform 1 from public.clubs where id=p_club_id for update;
  if not found then return jsonb_build_object('success',false,'error','That Club Could Not Be Found'); end if;
  if v_actor<p_to_user_id then v_first:=v_actor; v_second:=p_to_user_id;
  else v_first:=p_to_user_id; v_second:=v_actor; end if;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_first for update;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_second for update;

  v_actor_role:=public.fn_club_bank_role(p_club_id,v_actor);
  select role into v_target_role from public.club_members
   where club_id=p_club_id and user_id=p_to_user_id
     and coalesce(status,'active') in ('active','approved');
  if v_actor_role is null
     or v_actor_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success',false,'error','Your Cashier Authority Is No Longer Active');
  end if;
  if v_target_role is null then
    return jsonb_build_object('success',false,'error','Recipient Is Not An Active Member Of This Club');
  end if;
  if not public.fn_club_cashier_can_transact(p_club_id,v_actor,p_to_user_id) then
    return jsonb_build_object('success',false,'error','That Member Is Not In Your Downline');
  end if;

  -- Agent recipients always receive agent float; bind the replay fingerprint
  -- to the effective destination, not a caller-controlled label.
  if v_target_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    v_destination:='agent_wallet';
  end if;

  return public.fn_agent_wallet_send_core_20260830(
    p_club_id,p_to_user_id,p_amount,v_destination,p_reason,v_op_id);
end
$function$;

-- Exact captured predecessor plus the single early mutex insertion.
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_core_20260830(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_context jsonb;
  v_setting text;
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_agent_id     uuid;
  v_float_before numeric;
  v_float_after  numeric;
  v_is_prepaid   boolean;
  v_credit_limit numeric;
  v_credit_used  numeric;
  v_credit_after numeric;
  v_shortfall    numeric := 0;
  v_headroom     numeric;
  v_to_role      text;
  v_to_agent_id  uuid;
  v_to_after     numeric;
  v_tx_id        uuid;
  v_until        timestamptz;
begin
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false,
      'error', 'Chips Move In Hundredths At Most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('player_wallet', 'agent_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;
  if p_to_user_id = v_actor then
    return jsonb_build_object('success', false,
      'error', 'You Cannot Send Chips To Yourself');
  end if;

  if not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false,
      'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest = 'agent_wallet'
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if v_to_role in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    v_dest := 'agent_wallet';
  end if;

  select a.id, coalesce(a.agent_wallet_balance, 0),
         coalesce(a.is_prepaid, true),
         coalesce(a.credit_limit, 0), coalesce(a.credit_used, 0)
    into v_agent_id, v_float_before, v_is_prepaid, v_credit_limit, v_credit_used
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Has Not Been Funded Yet');
  end if;

  -- THE CREDIT LINE. Dan, 2026-08-31: "IF THEY GO BELOW THE CREDIT LIMIT, THEY
  -- MUST 'SQUARE UP' OR PRE PAY FOR CHIPS FOR THE REST OF THE WEEK." So the
  -- limit caps the debt outstanding, not the amount ever borrowed: an agent
  -- draws credit_limit - credit_used, and paying an invoice frees it again
  -- (fn_apply_credit_payment pays credit_used down, phase 1).
  if v_float_before < p_amount then
    v_shortfall := round(p_amount - v_float_before, 2);

    -- A prepaid agent, and an agent with no line at all, get the plain answer
    -- about their wallet. Talking about a credit line to somebody who has none
    -- is the sort of message that sends a person looking for a setting.
    if v_is_prepaid or v_credit_limit <= 0 then
      return jsonb_build_object('success', false,
        'error', 'Your Agent Wallet Only Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00')) || ' Chips',
        'balance', v_float_before, 'requested', p_amount,
        'prepaid', v_is_prepaid);
    end if;

    v_headroom := v_credit_limit - v_credit_used;
    if v_shortfall > v_headroom then
      return jsonb_build_object('success', false,
        'error', 'Your Wallet Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00'))
                 || ' Chips And Your Credit Line Has '
                 || trim(to_char(greatest(v_headroom, 0), 'FM999,999,999,990.00'))
                 || ' Left. Square Up Your Invoice Or Add Chips To Send This Much.',
        'balance', v_float_before, 'requested', p_amount,
        'credit_limit', v_credit_limit, 'credit_used', v_credit_used,
        'credit_available', greatest(v_headroom, 0),
        'shortfall', v_shortfall);
    end if;
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): an agent wallet send is ONE `agent_send`
  -- row from the sender's float to the wallet that receives it, keyed and
  -- correlated on the op. Verified on 2026-09-01 14:23:18 (10,000.00 to a
  -- player) the undeclared journal was `adjustment agent_wallet ->
  -- settlement_suspense` plus `adjustment table_stack -> player_wallet`. The
  -- agents trigger is skipped for both float writes: a player recipient's
  -- club_members trigger writes the row with the sender's float as its
  -- counterparty; an agent recipient (both sides in `agents`) gets the row
  -- posted explicitly below. When the credit line covers a shortfall the
  -- float only pays p_amount - v_shortfall, so the draw is its own
  -- `credit_draw credit_facility -> agent_wallet` row for the difference and
  -- the send row still carries the whole amount. Never a refusal.
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_agents']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_settlement','',true);
  perform public.fn_ca_declare_ledger('agent_send', 'agent_wallet', v_actor, null,
    'agent_send:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);
  if v_shortfall > 0 then
    perform public.fn_ca_post_leg('credit_draw', 'credit_facility', v_actor, 'agent_wallet', v_actor,
      v_shortfall, p_club_id, 'agent_send:credit:' || v_op_id::text,
      'Agent credit line covers the shortfall of an agent wallet send (fn_agent_wallet_send_core_20260830)');
  end if;

  -- The wallet pays what it can and the line covers the rest, so the balance
  -- lands on exactly zero rather than going negative.
  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - (p_amount - v_shortfall),
         credit_used          = coalesce(credit_used, 0) + v_shortfall,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_to_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_to_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning agent_wallet_balance into v_to_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_send', 'agent_wallet', v_actor, 'agent_wallet', p_to_user_id,
      p_amount, p_club_id, 'agent_send:' || v_op_id::text,
      'Agent wallet send to a downline agent wallet (fn_agent_wallet_send_core_20260830)');
  end if;

  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;

  v_until := now() + interval '10 minutes';

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'agent_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'agent_wallet_before', v_float_before,
       'agent_wallet_after', v_float_after,
       'recipient_balance_after', v_to_after,
       'claimed_back', 0,
       -- What was borrowed to make this send, and how much of that borrowing
       -- has since been handed back. The claim back reads both.
       'credit_drawn', v_shortfall,
       'credit_repaid', 0,
       'credit_used_after', v_credit_after,
       'credit_limit', v_credit_limit,
       'clawback_window_minutes', 10),
     v_float_after, v_until)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'agent_wallet_before', v_float_before,
    'agent_wallet_after', v_float_after,
    'recipient_balance_after', v_to_after,
    'credit_drawn', v_shortfall,
    'credit_used_after', v_credit_after,
    'credit_limit', v_credit_limit,
    'reversible_until', v_until);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_send'
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
end
$function$;

-- Exact staged cashier transition plus the same early mutex.
CREATE OR REPLACE FUNCTION public.fn_cashier_cashout_transition(p_action text,p_club_id uuid,p_cashout_id uuid,p_amount numeric,
 p_expected_actor_id uuid,p_op_id uuid,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE actor uuid:=auth.uid();actual_role text;kind text;request_status text;v_release_type text;
 note text:=NULLIF(btrim(p_note),'');fingerprint jsonb;prior public.accounting_cashier_events%ROWTYPE;
 r public.cashout_requests%ROWTYPE;s public.chip_escrow%ROWTYPE;h public.accounting_cashier_events%ROWTYPE;
 e public.accounting_cashier_events%ROWTYPE;member public.club_members%ROWTYPE;agent public.agents%ROWTYPE;
 club public.clubs%ROWTYPE;wallet_before numeric;wallet_after numeric;agent_row_id uuid;assigned uuid;
 request_id uuid:=p_cashout_id;escrow_id uuid;event_id uuid:=gen_random_uuid();invoice_id uuid:=gen_random_uuid();tx_id uuid:=gen_random_uuid();leg_id uuid;
 at_time timestamptz:=transaction_timestamp();issue_time timestamptz;leg_count int;rows_written int;persisted numeric;
 tx_type text;tx_note text;tx_from uuid;tx_to uuid;audience uuid[];payload jsonb;result jsonb;wallet_user uuid;
 old_category text:=current_setting('app.ledger_category',true);old_cp text:=current_setting('app.ledger_counterparty',true);
 old_entity text:=current_setting('app.ledger_counterparty_entity',true);old_key text:=current_setting('app.ledger_idempotency_key',true);
 old_settlement text:=current_setting('app.ledger_settlement',true);old_tournament text:=current_setting('app.ledger_tournament',true);
 old_hand text:=current_setting('app.ledger_hand_id',true);old_tournament_id text:=current_setting('app.ledger_tournament_id',true);
BEGIN
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

 IF p_action IS NULL OR p_action NOT IN('hold','approval','release','expiry_refund') OR p_club_id IS NULL OR p_op_id IS NULL
  OR (p_action='hold' AND p_cashout_id IS NOT NULL) OR (p_action<>'hold' AND p_cashout_id IS NULL)
 THEN RAISE EXCEPTION 'cashier_intent_incomplete' USING ERRCODE='22023';END IF;
 IF p_action='expiry_refund' THEN
  IF actor IS NOT NULL OR p_expected_actor_id IS NOT NULL
  THEN RAISE EXCEPTION 'cashier_system_actor_required' USING ERRCODE='42501';END IF;
 ELSE
  IF actor IS NULL OR actor IS DISTINCT FROM p_expected_actor_id
  THEN RAISE EXCEPTION 'cashier_account_changed' USING ERRCODE='42501';END IF;
 END IF;
 IF p_amount IS NULL OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<=0
    OR p_amount>1000000000 OR p_amount<>round(p_amount,2)
 THEN RAISE EXCEPTION 'cashier_invalid_amount' USING ERRCODE='22023';END IF;
 fingerprint:=jsonb_build_object('action',p_action,'actor',actor,'club_id',p_club_id,'cashout_id',p_cashout_id,
   'amount',round(p_amount,2)::text,'note',note);
 PERFORM pg_advisory_xact_lock(hashtextextended('cashout-op:'||COALESCE(actor::text,'system')||':'||p_op_id::text,0));
 -- Hierarchy first: never take a request or wallet row before this scope lock.
 PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));
 SELECT * INTO club FROM public.clubs WHERE id=p_club_id FOR UPDATE;
 IF NOT FOUND OR club.owner_id IS NULL THEN RAISE EXCEPTION 'cashier_club_unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM public.accounting_cashier_events WHERE actor_user_id IS NOT DISTINCT FROM actor AND op_id=p_op_id;
 IF FOUND THEN
  IF prior.operation_fingerprint IS DISTINCT FROM fingerprint
  THEN RAISE EXCEPTION 'cashier_operation_conflict' USING ERRCODE='22023';END IF;
  RETURN public.fn_cashier_operation_receipt(prior.id,true);
 END IF;
 -- Legacy chips alone cannot certify a canonical hold, delivery or replay.
 IF EXISTS(SELECT 1 FROM public.chip_transactions t WHERE t.metadata->>'op_id'=p_op_id::text
   AND t.transaction_type IN('cashout_request_escrow','cashout_approved','cashout_cancelled','cashout_denied','cashout_expired_refund')
   AND (t.from_user_id=actor OR t.to_user_id=actor OR (actor IS NULL AND t.transaction_type='cashout_expired_refund')))
 THEN RAISE EXCEPTION 'cashier_legacy_operation_unverified' USING ERRCODE='23514';END IF;
 IF current_setting('app.ledger_autoskip_club_members',true)='1' OR current_setting('app.ledger_autoskip_agents',true)='1'
 THEN RAISE EXCEPTION 'cashier_journal_is_suppressed' USING ERRCODE='23514';END IF;
 IF p_action='hold' THEN
  SELECT agent_id INTO assigned FROM public.club_members WHERE club_id=p_club_id AND user_id=actor;
  PERFORM public.fn_cashier_lock_authority(p_club_id,actor,actor,COALESCE(assigned,club.owner_id));
  SELECT * INTO member FROM public.club_members WHERE club_id=p_club_id AND user_id=actor FOR UPDATE;
  IF NOT FOUND OR COALESCE(member.status,'active') NOT IN('active','approved')
    OR member.role NOT IN('owner','co_owner','admin','super_agent','agent','sub_agent','player','member')
  THEN RAISE EXCEPTION 'cashier_player_wallet_unavailable' USING ERRCODE='42501';END IF;
  actual_role:=member.role;assigned:=COALESCE(member.agent_id,club.owner_id);
  IF assigned IS NULL OR assigned=actor OR public.fn_club_cashier_can_transact(p_club_id,assigned,actor) IS NOT TRUE
    OR COALESCE(public.fn_club_bank_role(p_club_id,assigned),'') NOT IN('owner','co_owner','admin','super_agent','agent','sub_agent')
  THEN RAISE EXCEPTION 'cashier_assigned_cashier_unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM public.cashout_requests WHERE club_id=p_club_id AND player_id=actor AND status='pending')
  THEN RAISE EXCEPTION 'cashier_pending_request_exists' USING ERRCODE='23514';END IF;
  request_id:=gen_random_uuid();escrow_id:=gen_random_uuid();kind:='hold';request_status:='pending';wallet_user:=actor;
  wallet_before:=member.chip_balance;
 ELSE
  SELECT * INTO r FROM public.cashout_requests WHERE id=p_cashout_id FOR UPDATE;
  IF NOT FOUND OR r.club_id IS DISTINCT FROM p_club_id OR r.amount IS DISTINCT FROM p_amount
  THEN RAISE EXCEPTION 'cashier_request_intent_mismatch' USING ERRCODE='22023';END IF;
  IF r.status IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'cashier_request_already_terminal' USING ERRCODE='23514';END IF;
  SELECT * INTO s FROM public.chip_escrow WHERE cashout_request_id=r.id FOR UPDATE;
  IF NOT FOUND OR s.club_id IS DISTINCT FROM r.club_id OR s.player_id IS DISTINCT FROM r.player_id
    OR s.amount IS DISTINCT FROM r.amount OR s.table_id IS NOT NULL OR s.released_at IS NOT NULL OR s.release_type IS NOT NULL
    OR s.locked_at IS DISTINCT FROM r.created_at
  THEN RAISE EXCEPTION 'cashier_escrow_unverified' USING ERRCODE='23514';END IF;
  SELECT * INTO h FROM public.accounting_cashier_events WHERE cashout_id=r.id AND event_slot='hold';
  IF NOT FOUND THEN RAISE EXCEPTION 'cashier_legacy_hold_unverified' USING ERRCODE='23514';END IF;
  PERFORM public.fn_cashier_operation_receipt(h.id,true);
  escrow_id:=s.id;assigned:=r.agent_id;
  PERFORM public.fn_cashier_lock_authority(p_club_id,actor,r.player_id,assigned);
  IF p_action='expiry_refund' THEN kind:='expiry_refund';actual_role:='system';
  ELSIF p_action='release' AND actor=r.player_id THEN kind:='cancellation';
  ELSE
   actual_role:=public.fn_club_bank_role(p_club_id,actor);
   IF actor=r.player_id OR COALESCE(actual_role,'') NOT IN('owner','co_owner','admin','super_agent','agent','sub_agent')
      OR public.fn_club_cashier_can_transact(p_club_id,actor,r.player_id) IS NOT TRUE
   THEN RAISE EXCEPTION 'cashier_current_authority_required' USING ERRCODE='42501';END IF;
   kind:=CASE p_action WHEN 'approval' THEN 'approval' ELSE 'decline' END;
  END IF;
  request_status:=CASE kind WHEN 'approval' THEN 'approved' WHEN 'cancellation' THEN 'cancelled' WHEN 'decline' THEN 'rejected' ELSE 'expired' END;
  v_release_type:=CASE kind WHEN 'approval' THEN 'completed' ELSE request_status END;
  IF kind='approval' THEN
   agent_row_id:=public.fn_ensure_agent_row(p_club_id,actor,actual_role);
   SELECT * INTO agent FROM public.agents WHERE id=agent_row_id AND club_id=p_club_id AND user_id=actor FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'cashier_destination_wallet_unavailable' USING ERRCODE='23503';END IF;
   wallet_before:=agent.agent_wallet_balance;wallet_user:=actor;
  ELSE
   SELECT * INTO member FROM public.club_members WHERE club_id=p_club_id AND user_id=r.player_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'cashier_refund_wallet_missing' USING ERRCODE='23503';END IF;
   IF kind='cancellation' THEN
    actual_role:=member.role;
    IF actual_role IS NULL OR actual_role NOT IN('owner','co_owner','admin','super_agent','agent','sub_agent','player','member')
    THEN RAISE EXCEPTION 'cashier_player_role_unavailable' USING ERRCODE='42501';END IF;
   END IF;
   wallet_before:=member.chip_balance;wallet_user:=r.player_id;
  END IF;
 END IF;
 IF wallet_before IS NULL OR wallet_before<0 OR wallet_before::text IN('NaN','Infinity','-Infinity') OR wallet_before<>round(wallet_before,2)
   OR (kind='hold' AND wallet_before<p_amount)
 THEN RAISE EXCEPTION 'cashier_wallet_balance_unverified' USING ERRCODE='23514';END IF;
 wallet_after:=wallet_before+CASE WHEN kind='hold' THEN -p_amount ELSE p_amount END;
 -- Ambient unrelated ledger context must never contaminate this custody leg.
 PERFORM set_config('app.ledger_settlement','',true);PERFORM set_config('app.ledger_tournament','',true);
 PERFORM set_config('app.ledger_hand_id','',true);PERFORM set_config('app.ledger_tournament_id','',true);
 PERFORM public.fn_ca_declare_ledger(CASE WHEN kind='hold' THEN 'escrow_hold' ELSE 'escrow_release' END,
  'escrow',escrow_id,NULL,'cashout:'||request_id::text||CASE WHEN kind='hold' THEN ':hold' ELSE ':release' END,NULL);
 IF kind='approval' THEN
  UPDATE public.agents SET agent_wallet_balance=wallet_after,updated_at=at_time WHERE id=agent.id RETURNING agent_wallet_balance INTO persisted;
 ELSE
  UPDATE public.club_members SET chip_balance=wallet_after,updated_at=at_time WHERE club_id=member.club_id AND user_id=member.user_id RETURNING chip_balance INTO persisted;
 END IF;
 GET DIAGNOSTICS rows_written=ROW_COUNT;
 IF rows_written<>1 OR persisted IS DISTINCT FROM wallet_after THEN RAISE EXCEPTION 'cashier_wallet_write_missing' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.ledger_category',COALESCE(old_category,''),true);PERFORM set_config('app.ledger_counterparty',COALESCE(old_cp,''),true);
 PERFORM set_config('app.ledger_counterparty_entity',COALESCE(old_entity,''),true);PERFORM set_config('app.ledger_idempotency_key',COALESCE(old_key,''),true);
 PERFORM set_config('app.ledger_settlement',COALESCE(old_settlement,''),true);PERFORM set_config('app.ledger_tournament',COALESCE(old_tournament,''),true);
 PERFORM set_config('app.ledger_hand_id',COALESCE(old_hand,''),true);PERFORM set_config('app.ledger_tournament_id',COALESCE(old_tournament_id,''),true);
 IF kind='hold' THEN
  INSERT INTO public.cashout_requests(id,club_id,player_id,agent_id,amount,status,player_note,created_at,updated_at)
   VALUES(request_id,p_club_id,actor,assigned,p_amount,'pending',note,at_time,at_time) RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'cashier_request_write_missing' USING ERRCODE='23514';END IF;
  INSERT INTO public.chip_escrow(id,cashout_request_id,club_id,player_id,amount,locked_at)
   VALUES(escrow_id,request_id,p_club_id,actor,p_amount,at_time) RETURNING * INTO s;
  IF NOT FOUND THEN RAISE EXCEPTION 'cashier_escrow_write_missing' USING ERRCODE='23514';END IF;
 ELSE
  UPDATE public.chip_escrow SET released_at=at_time,release_type=v_release_type WHERE id=escrow_id RETURNING * INTO s;
  IF NOT FOUND THEN RAISE EXCEPTION 'cashier_escrow_write_missing' USING ERRCODE='23514';END IF;
  UPDATE public.cashout_requests SET status=request_status,
   agent_note=CASE WHEN kind IN('approval','decline') THEN note ELSE agent_note END,
   acknowledged_at=CASE WHEN kind IN('approval','decline') THEN at_time ELSE NULL END,
   completed_at=CASE WHEN kind='approval' THEN at_time ELSE NULL END,
   cancelled_at=CASE WHEN kind IN('cancellation','decline','expiry_refund') THEN at_time ELSE NULL END,updated_at=at_time
   WHERE id=request_id RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'cashier_request_write_missing' USING ERRCODE='23514';END IF;
 END IF;
 SELECT count(*),(array_agg(id))[1] INTO leg_count,leg_id FROM public.chip_ledger
  WHERE idempotency_key='cashout:'||request_id::text||CASE WHEN kind='hold' THEN ':hold' ELSE ':release' END;
 IF leg_count<>1 THEN RAISE EXCEPTION 'cashier_physical_ledger_missing_or_duplicate' USING ERRCODE='23514';END IF;
 tx_type:=CASE kind WHEN 'hold' THEN 'cashout_request_escrow' WHEN 'approval' THEN 'cashout_approved'
   WHEN 'cancellation' THEN 'cashout_cancelled' WHEN 'decline' THEN 'cashout_denied' ELSE 'cashout_expired_refund' END;
 tx_note:=COALESCE(note,CASE kind WHEN 'hold' THEN 'Cash Out Requested. Chips Held In Escrow'
  WHEN 'approval' THEN 'Cash Out Approved. Escrow Released Into The Agent Wallet'
  WHEN 'cancellation' THEN 'Cash Out Cancelled. Escrow Returned To Player'
  WHEN 'decline' THEN 'Cash Out Declined. Escrow Returned To Player' ELSE 'Stale Cash Out Expired. Escrow Returned To Player' END);
 tx_from:=CASE WHEN kind IN('hold','approval') THEN r.player_id ELSE actor END;
 tx_to:=CASE kind WHEN 'hold' THEN assigned WHEN 'approval' THEN actor ELSE r.player_id END;
 INSERT INTO public.chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,notes,related_cashout_id,metadata,balance_after,created_at)
  VALUES(tx_id,p_club_id,tx_from,tx_to,p_amount,tx_type,tx_note,request_id,
   jsonb_build_object('op_id',p_op_id,'cashier_document_version',1,'event_id',event_id,'assigned_agent_id',assigned,
     'actor_user_id',actor,'actor_role',actual_role),wallet_after,at_time);
 GET DIAGNOSTICS rows_written=ROW_COUNT;
 IF rows_written<>1 THEN RAISE EXCEPTION 'cashier_transaction_write_missing' USING ERRCODE='23514';END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO audience FROM unnest(ARRAY[club.owner_id,r.player_id,
   CASE WHEN kind IN('approval','decline') THEN actor ELSE assigned END]) x;
 IF cardinality(audience)<2 OR EXISTS(SELECT 1 FROM unnest(audience) x WHERE x IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=x))
 THEN RAISE EXCEPTION 'cashier_document_audience_unavailable' USING ERRCODE='23514';END IF;
 issue_time:=clock_timestamp();
 INSERT INTO public.accounting_cashier_events(id,contract_version,cashout_id,escrow_id,source_transaction_id,source_ledger_id,invoice_id,event_slot,event_kind,
  hold_event_id,hold_invoice_id,club_id,player_id,assigned_agent_id,actor_user_id,actor_role,ledger_actor_user_id,
  issuer_representative_id,issuer_name,player_name,audience_user_ids,op_id,operation_fingerprint,accepted_note,transaction_note,amount,
  ledger_from_type,ledger_from_entity_id,ledger_to_type,ledger_to_entity_id,wallet_owner_id,wallet_before,wallet_after,occurred_at,issued_at)
 VALUES(event_id,1,request_id,escrow_id,tx_id,leg_id,invoice_id,CASE WHEN kind='hold' THEN 'hold' ELSE 'terminal' END,kind,
  h.id,h.invoice_id,p_club_id,r.player_id,assigned,actor,actual_role,COALESCE(actor,'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
  club.owner_id,COALESCE(NULLIF(btrim(club.name),''),'Club'),public.fn_notify_display_name(r.player_id),audience,p_op_id,fingerprint,note,tx_note,p_amount,
  CASE WHEN kind='hold' THEN 'player_wallet' ELSE 'escrow' END,CASE WHEN kind='hold' THEN r.player_id ELSE escrow_id END,
  CASE kind WHEN 'hold' THEN 'escrow' WHEN 'approval' THEN 'agent_wallet' ELSE 'player_wallet' END,
  CASE kind WHEN 'hold' THEN escrow_id WHEN 'approval' THEN actor ELSE r.player_id END,wallet_user,wallet_before,wallet_after,at_time,issue_time)
 RETURNING * INTO e;
 IF NOT FOUND THEN RAISE EXCEPTION 'cashier_event_write_missing' USING ERRCODE='23514';END IF;
 payload:=public.fn_cashier_event_payload(e);
 INSERT INTO public.settlement_invoices(id,club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
  gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,source_ledger_id,notes,created_at,updated_at)
 VALUES(invoice_id,p_club_id,'cashier_cashout','club',p_club_id::text,'player',r.player_id::text,p_amount,p_amount,0,
  jsonb_build_object('kind','cashier_cashout','cashier',payload),CASE WHEN kind='hold' THEN 'generated' ELSE 'paid' END,kind<>'hold',
  CASE WHEN kind='hold' THEN NULL ELSE at_time END,leg_id,'Recorded cashier chip custody event.',issue_time,issue_time);
 GET DIAGNOSTICS rows_written=ROW_COUNT;
 IF rows_written<>1 THEN RAISE EXCEPTION 'cashier_invoice_write_missing' USING ERRCODE='23514';END IF;
 -- Read stored rows after all triggers; RETURNING alone cannot establish survival.
 IF kind='approval' THEN SELECT agent_wallet_balance INTO persisted FROM public.agents WHERE id=agent.id AND club_id=p_club_id AND user_id=actor;
 ELSE SELECT chip_balance INTO persisted FROM public.club_members WHERE club_id=member.club_id AND user_id=member.user_id AND club_id=p_club_id AND user_id=wallet_user;END IF;
 IF NOT FOUND OR persisted IS DISTINCT FROM wallet_after THEN RAISE EXCEPTION 'cashier_wallet_write_changed' USING ERRCODE='23514';END IF;
 result:=public.fn_cashier_operation_receipt(event_id,false);
 RETURN result;
END $function$;

DO $credit_lock_postconditions$ DECLARE expected jsonb;actual jsonb;target oid;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($expected_functions$[{"owner":"postgres","arguments":"p_club_id uuid, p_user_id uuid, p_role text, p_actor_user_id uuid DEFAULT NULL::uuid, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_is_prepaid boolean DEFAULT NULL::boolean, p_credit_limit numeric DEFAULT NULL::numeric","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"basis":"lock-order-successor.sql; retained full function plus only early mutex","source_md5":"d7a2c0aefc0fce74214735c89d24909c"},{"owner":"postgres","arguments":"p_agent_user_id uuid, p_super_agent_user_id uuid, p_club_id uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_assign_agent_to_super_agent(uuid,uuid,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"basis":"lock-order-successor.sql; retained full function plus only early mutex","source_md5":"c1585a4464c3a32146cedddfe7c4a110"},{"owner":"postgres","arguments":"p_club_id uuid, p_user_id uuid, p_role text","result":"uuid","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_ensure_agent_row(uuid,uuid,text)","acl":["postgres=X/postgres","service_role=X/postgres"],"basis":"lock-order-successor.sql; retained full function plus only early mutex","source_md5":"c072f3ee43b341d5efbe077bcf3a6a9b"},{"owner":"postgres","arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":true},"signature":"public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"],"basis":"lock-order-successor.sql; retained full function plus only early mutex","source_md5":"7a357ba95a8ca4eb13f00f798233d8d4"},{"owner":"postgres","arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)","acl":["postgres=X/postgres","service_role=X/postgres"],"basis":"lock-order-successor.sql; retained full function plus only early mutex","source_md5":"82cc66e55d9d3f2b3e87d08571ea8a15"},{"owner":"postgres","arguments":"p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid","result":"jsonb","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false},"signature":"public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)","acl":["postgres=X/postgres","service_role=X/postgres"],"basis":"lock-order-successor.sql; retained full function plus only early mutex","source_md5":"89019200238a7fe72b807d2a9b364e5a"},{"signature":"public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)","arguments":"p_action text, p_club_id uuid, p_cashout_id uuid, p_amount numeric, p_expected_actor_id uuid, p_op_id uuid, p_note text DEFAULT NULL::text","result":"jsonb","owner":"postgres","language":"plpgsql","security_definer":true,"strict":false,"leakproof":false,"volatility":"v","parallel":"u","config":["search_path=public, pg_temp"],"acl":["postgres=X/postgres"],"effective_execute":{"anon":false,"authenticated":false,"service_role":false},"source_md5":"742cb4ff0a304474e3761b27c13d7dbd","basis":"lock-order-successor.sql; staged33 authority plus only early mutex and CREATE OR REPLACE header"}]$expected_functions$::jsonb) LOOP
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
  THEN RAISE EXCEPTION 'credit_reduction_lock_install_unconfirmed' USING DETAIL=expected->>'signature';END IF;
 END LOOP;
END $credit_lock_postconditions$;

-- Fragment private-contract.sql
-- SOURCE ONLY / UNRUN. Loaded inside the eventual single guarded transaction.
-- No standalone activation. Root document/delivery/reader fragments are required.
ALTER TABLE public.agents ADD COLUMN credit_control_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.agents ADD CONSTRAINT agents_credit_control_revision_nonnegative
 CHECK(credit_control_revision>=0);

CREATE FUNCTION public.fn_agent_credit_control_revision_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.credit_control_revision IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION 'credit_control_revision_is_managed' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NEW.credit_control_revision IS DISTINCT FROM OLD.credit_control_revision THEN
  RAISE EXCEPTION 'credit_control_revision_is_managed' USING ERRCODE='23514';END IF;
 IF ROW(NEW.club_id,NEW.user_id,NEW.credit_limit,NEW.credit_used,NEW.is_prepaid,NEW.status,NEW.role,NEW.parent_agent_id)
    IS DISTINCT FROM ROW(OLD.club_id,OLD.user_id,OLD.credit_limit,OLD.credit_used,OLD.is_prepaid,OLD.status,OLD.role,OLD.parent_agent_id) THEN
  IF OLD.credit_control_revision=9223372036854775807 THEN
   RAISE EXCEPTION 'credit_control_revision_exhausted' USING ERRCODE='22003';END IF;
  NEW.credit_control_revision:=OLD.credit_control_revision+1;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_agent_credit_control_revision_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_agent_credit_control_revision_v1() FROM PUBLIC,anon,authenticated,service_role;
-- Last among the guarded current BEFORE triggers, after agreement validation.
-- Adds no advisory lock to existing financial writers' row-lock paths.
CREATE TRIGGER zzzz_credit_control_revision_v1 BEFORE INSERT OR UPDATE ON public.agents
 FOR EACH ROW EXECUTE FUNCTION public.fn_agent_credit_control_revision_v1();

CREATE TABLE public.accounting_credit_reduction_operations_v1(
 id uuid PRIMARY KEY,contract_version smallint NOT NULL CHECK(contract_version=1),
 actor_user_id uuid NOT NULL,operation_id uuid NOT NULL,club_id uuid NOT NULL,
 agent_id uuid NOT NULL,target_user_id uuid NOT NULL,
 action text NOT NULL CHECK(action='reduce_credit_limit'),
 requested_reduction numeric(15,2) NOT NULL CHECK(requested_reduction>0 AND requested_reduction<=1000000000),
 reason text,assignment_reason text NOT NULL,
 before_limit numeric(15,2) NOT NULL,after_limit numeric(15,2) NOT NULL,
 credit_used numeric(15,2) NOT NULL,before_prepaid boolean NOT NULL,after_prepaid boolean NOT NULL,
 before_revision bigint NOT NULL CHECK(before_revision>=0),after_revision bigint NOT NULL CHECK(after_revision>=0),
 applied_reduction numeric(15,2) NOT NULL,
 assignment_id uuid,document_id uuid,invoice_id uuid,
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 UNIQUE(actor_user_id,operation_id),UNIQUE(assignment_id),UNIQUE(document_id),UNIQUE(invoice_id),
 CHECK(NOT ('00000000-0000-0000-0000-000000000000'::uuid=ANY(ARRAY[id,actor_user_id,operation_id,club_id,agent_id,target_user_id]))),
 CHECK(assignment_id IS NULL OR assignment_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 CHECK(document_id IS NULL OR document_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 CHECK(invoice_id IS NULL OR invoice_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 CHECK(before_limit::text NOT IN('NaN','Infinity','-Infinity') AND before_limit>=0),
 CHECK(after_limit::text NOT IN('NaN','Infinity','-Infinity') AND after_limit>=0),
 CHECK(credit_used::text NOT IN('NaN','Infinity','-Infinity') AND credit_used>=0),
 CHECK(applied_reduction::text NOT IN('NaN','Infinity','-Infinity') AND applied_reduction>=0),
 CHECK(applied_reduction=least(requested_reduction,before_limit) AND after_limit=before_limit-applied_reduction),
 CHECK(assignment_reason=CASE WHEN reason IS NULL OR reason='' THEN 'Credit line reduced' ELSE reason END),
 CHECK((applied_reduction>0 AND NOT before_prepaid AND before_limit>0 AND credit_used<=after_limit
         AND after_prepaid=(after_limit=0) AND after_revision::numeric=before_revision::numeric+1
         AND assignment_id IS NOT NULL AND document_id IS NOT NULL AND invoice_id IS NOT NULL
         AND assignment_id<>document_id AND assignment_id<>invoice_id AND document_id<>invoice_id)
    OR (applied_reduction=0 AND before_limit=0 AND after_limit=0 AND credit_used=0
         AND before_prepaid AND after_prepaid AND before_revision=after_revision
         AND assignment_id IS NULL AND document_id IS NULL AND invoice_id IS NULL))
);
ALTER TABLE public.accounting_credit_reduction_operations_v1 OWNER TO postgres;
ALTER TABLE public.accounting_credit_reduction_operations_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_credit_reduction_operations_v1 FROM PUBLIC,anon,authenticated,service_role;

-- An identity-only cancellation fence, never fabricated original financial intent.
-- No FK to current user/club/agent/audit rows: historical receipts survive deletion.
CREATE TABLE public.accounting_credit_reduction_retirements_v1(
 id uuid PRIMARY KEY,contract_version smallint NOT NULL CHECK(contract_version=1),
 actor_user_id uuid NOT NULL,operation_id uuid NOT NULL,club_id uuid NOT NULL,
 retired_at timestamptz NOT NULL CHECK(isfinite(retired_at)),
 UNIQUE(actor_user_id,operation_id),
 CHECK(NOT ('00000000-0000-0000-0000-000000000000'::uuid=ANY(ARRAY[id,actor_user_id,operation_id,club_id])))
);
ALTER TABLE public.accounting_credit_reduction_retirements_v1 OWNER TO postgres;
ALTER TABLE public.accounting_credit_reduction_retirements_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_credit_reduction_retirements_v1 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_credit_reduction_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'credit_reduction_evidence_is_immutable' USING ERRCODE='23514';END $function$;
ALTER FUNCTION public.fn_credit_reduction_immutable_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_credit_reduction_immutable_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER credit_reduction_operation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.accounting_credit_reduction_operations_v1 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_credit_reduction_immutable_v1();
CREATE TRIGGER credit_reduction_retirement_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.accounting_credit_reduction_retirements_v1 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_credit_reduction_immutable_v1();

-- Keep the final transaction state exclusive even if a later nested trigger
-- attempts to add the opposite terminal record after the wrapper's readback.
CREATE FUNCTION public.fn_credit_reduction_terminal_exclusive_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM public.accounting_credit_reduction_operations_v1 o
   JOIN public.accounting_credit_reduction_retirements_v1 r
    ON r.actor_user_id=o.actor_user_id AND r.operation_id=o.operation_id
   WHERE o.actor_user_id=NEW.actor_user_id AND o.operation_id=NEW.operation_id) THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_credit_reduction_terminal_exclusive_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_credit_reduction_terminal_exclusive_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER credit_reduction_operation_exclusive_v1 AFTER INSERT
 ON public.accounting_credit_reduction_operations_v1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.fn_credit_reduction_terminal_exclusive_v1();
CREATE CONSTRAINT TRIGGER credit_reduction_retirement_exclusive_v1 AFTER INSERT
 ON public.accounting_credit_reduction_retirements_v1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.fn_credit_reduction_terminal_exclusive_v1();

-- Fragment admin-writer-successor.sql
-- SOURCE ONLY / UNRUN. Existing financial writer; added actual row/audit readback only.
CREATE OR REPLACE FUNCTION public.fn_admin_update_agent(p_agent_id uuid, p_status text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_credit_limit numeric DEFAULT NULL::numeric, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_assigned_by uuid DEFAULT NULL::uuid, p_credit_reason text DEFAULT NULL::text, p_is_prepaid boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_club_id uuid; v_user_id uuid; v_parent uuid; v_old_limit numeric; v_parent_limit numeric;
  v_member_role text; v_role_res jsonb;
  v_prepaid_now boolean; v_limit_now numeric; v_used_now numeric;
  v_prepaid_after boolean; v_limit_after numeric;
  v_touches_funding boolean;
  v_written public.agents%ROWTYPE;
  v_assignment public.credit_assignments%ROWTYPE;
BEGIN
  IF p_agent_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'agent id required'); END IF;
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;
  SELECT club_id, user_id, parent_agent_id, credit_limit INTO v_club_id, v_user_id, v_parent, v_old_limit
  FROM agents WHERE id = p_agent_id;
  IF v_club_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'agent not found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||v_club_id::text,0));
  SELECT user_id,parent_agent_id,credit_limit INTO v_user_id,v_parent,v_old_limit FROM public.agents WHERE id=p_agent_id AND club_id=v_club_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','agent scope changed');END IF;
  IF NOT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = v_club_id AND (
      c.owner_id = v_caller
      OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = v_club_id AND cm.user_id = v_caller
                 AND cm.role IN ('owner','co_owner','admin') AND cm.status IN ('active','approved')))
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to manage this club''s agents');
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active','suspended','frozen') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid status'); END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('super_agent','agent','sub_agent') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role'); END IF;
  IF p_credit_limit IS NOT NULL AND (p_credit_limit::text IN ('NaN','Infinity','-Infinity') OR p_credit_limit < 0 OR p_credit_limit <> round(p_credit_limit,2)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'credit_limit must be finite, nonnegative and in whole chip cents'); END IF;
  -- The table CHECK is 0..0.70 and 0..0.50. Validating against 0..100 let a
  -- caller who meant "25%" past this line and into a raw 23514 from Postgres.
  IF p_commission_rate IS NOT NULL AND (p_commission_rate < 0 OR p_commission_rate > 0.70) THEN
    RETURN jsonb_build_object('success', false, 'error', 'commission_rate must be between 0 and 0.70'); END IF;
  IF p_player_rakeback_rate IS NOT NULL AND (p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.50) THEN
    RETURN jsonb_build_object('success', false, 'error', 'player_rakeback_rate must be between 0 and 0.50'); END IF;

  -- ---------------------------------------------------------------------------
  -- THE FUNDING PAIR
  -- ---------------------------------------------------------------------------
  SELECT COALESCE(is_prepaid, false), COALESCE(credit_limit, 0), COALESCE(credit_used, 0)
    INTO v_prepaid_now, v_limit_now, v_used_now
    FROM agents WHERE id = p_agent_id;

  v_touches_funding := (p_is_prepaid IS NOT NULL OR p_credit_limit IS NOT NULL);
  v_prepaid_after   := COALESCE(p_is_prepaid, v_prepaid_now);
  v_limit_after     := COALESCE(p_credit_limit, v_limit_now);

  IF v_touches_funding THEN
    -- Granting a line IS the choice of credit. Refusing here instead would
    -- dead-end every "raise this agent's limit" call against a prepaid agent,
    -- and no screen moves them to credit first.
    IF p_is_prepaid IS NULL AND COALESCE(p_credit_limit, 0) > 0 THEN
      v_prepaid_after := false;
    END IF;

    -- And moving somebody TO prepaid closes the line, for the same reason in
    -- reverse: prepaid and a line cannot both be true.
    IF COALESCE(p_is_prepaid, false) AND p_credit_limit IS NULL THEN
      v_limit_after := 0;
    END IF;

    -- Saying both, and contradicting yourself, is still a mistake worth naming.
    IF v_prepaid_after AND COALESCE(v_limit_after, 0) <> 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'a prepaid agent carries no credit line. Send prepaid on its own, or a credit limit on its own.');
    END IF;

    -- The pair that can send nothing at all.
    IF NOT v_prepaid_after AND COALESCE(v_limit_after, 0) <= 0 THEN
      RETURN jsonb_build_object('success', false, 'needs_funding', true,
        'error', 'an agent on credit needs a limit greater than 0. Set them prepaid instead, or give a limit.');
    END IF;

    -- A debt outlives the line it was drawn against, so the line cannot simply
    -- be taken away while it is still owed.
    IF v_prepaid_after AND v_used_now > 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'this agent still owes ' || trim(to_char(v_used_now, 'FM999,999,999,990.00'))
                 || ' chips on their credit line. Settle the invoice before moving them to prepaid.',
        'credit_used', v_used_now);
    END IF;

    -- Lowering a limit below what has already been drawn violates check_credit
    -- and used to reach the client as a raw 23514 with no explanation.
    IF NOT v_prepaid_after AND v_limit_after < v_used_now THEN
      RETURN jsonb_build_object('success', false,
        'error', 'that limit is below the ' || trim(to_char(v_used_now, 'FM999,999,999,990.00'))
                 || ' chips already drawn. Take a payment first, or set a limit of at least that much.',
        'credit_used', v_used_now, 'requested_limit', v_limit_after);
    END IF;
  END IF;

  IF v_touches_funding AND v_parent IS NOT NULL THEN
    SELECT credit_limit INTO v_parent_limit FROM agents WHERE id = v_parent AND club_id=v_club_id;
    IF v_parent_limit IS NOT NULL AND v_limit_after > v_parent_limit THEN
      RETURN jsonb_build_object('success', false, 'error', 'credit limit cannot exceed parent agent limit');
    END IF;
  END IF;

  SELECT role INTO v_member_role FROM club_members
   WHERE club_id = v_club_id AND user_id = v_user_id;

  -- Dan, B-02, 2026-08-31: OWNERS KEEP EARNING. This list used to include
  -- 'owner', which no rule anywhere else does: trg_agents_staff_earn_no_rakeback
  -- covers co_owner and admin only, and one live owner already holds an active
  -- agents row at 0.30 / 0.20 that this branch would have refused to edit.
  IF v_member_role IN ('co_owner','admin')
     AND (COALESCE(p_commission_rate, 0) <> 0 OR COALESCE(p_player_rakeback_rate, 0) <> 0)
     AND p_role IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'this member is club staff and earns no rakeback. Change their role first.');
  END IF;

  -- The role change goes through the one door, so the grant matrix, the
  -- downline guard, the funding choice and the audit row apply here too. The
  -- RESOLVED funding pair is forwarded, not the raw arguments: the callee
  -- applies the same prepaid-or-a-line rule, and sending it a bare NULL where
  -- this call has already decided would make the two disagree.
  IF p_role IS NOT NULL AND v_member_role IS NOT NULL AND v_member_role <> p_role THEN
    v_role_res := public.fn_club_set_member_role(
      v_club_id, v_user_id, p_role, v_caller,
      p_commission_rate, p_player_rakeback_rate,
      CASE WHEN v_touches_funding THEN v_prepaid_after ELSE NULL END,
      CASE WHEN v_touches_funding THEN v_limit_after   ELSE NULL END);
    IF NOT COALESCE((v_role_res ->> 'success')::boolean, false) THEN
      RAISE EXCEPTION 'agent_role_change_refused' USING ERRCODE='PAG01';
    END IF;
  END IF;

  UPDATE agents SET
    status = COALESCE(p_status, status),
    role = COALESCE(p_role, role),
    credit_limit = CASE WHEN v_touches_funding THEN v_limit_after ELSE credit_limit END,
    commission_rate = COALESCE(p_commission_rate, commission_rate),
    player_rakeback_rate = COALESCE(p_player_rakeback_rate, player_rakeback_rate),
    is_prepaid = CASE WHEN v_touches_funding THEN v_prepaid_after ELSE is_prepaid END,
    updated_at = now()
  WHERE id = p_agent_id RETURNING * INTO v_written;
  IF NOT FOUND OR v_written.id IS DISTINCT FROM p_agent_id
    OR v_written.club_id IS DISTINCT FROM v_club_id OR v_written.user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'credit_admin_agent_write_unconfirmed' USING ERRCODE='23514';
  END IF;
  IF v_touches_funding AND (v_written.credit_limit IS DISTINCT FROM v_limit_after
    OR v_written.is_prepaid IS DISTINCT FROM v_prepaid_after) THEN
    RAISE EXCEPTION 'credit_admin_funding_write_unconfirmed' USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.agents a WHERE a.id=p_agent_id AND to_jsonb(a)=to_jsonb(v_written)) THEN
    RAISE EXCEPTION 'credit_admin_agent_retained_mismatch' USING ERRCODE='23514';
  END IF;

  IF v_touches_funding AND v_limit_after <> COALESCE(v_old_limit, -1) THEN
    INSERT INTO credit_assignments (agent_id, assigned_by, old_limit, new_limit, reason)
    VALUES (p_agent_id, v_caller, v_old_limit, v_limit_after, p_credit_reason)
    RETURNING * INTO v_assignment;
    IF NOT FOUND OR v_assignment.id IS NULL OR v_assignment.agent_id IS DISTINCT FROM p_agent_id
      OR v_assignment.assigned_by IS DISTINCT FROM v_caller
      OR v_assignment.old_limit IS DISTINCT FROM v_old_limit OR v_assignment.new_limit IS DISTINCT FROM v_limit_after
      OR v_assignment.reason IS DISTINCT FROM p_credit_reason OR v_assignment.created_at IS NULL
      OR NOT isfinite(v_assignment.created_at) THEN
      RAISE EXCEPTION 'credit_admin_assignment_write_unconfirmed' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.credit_assignments a WHERE a.id=v_assignment.id AND to_jsonb(a)=to_jsonb(v_assignment)) THEN
      RAISE EXCEPTION 'credit_admin_assignment_retained_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;

  -- Assignment triggers are part of this write; verify the surviving agent after them.
  IF NOT EXISTS(SELECT 1 FROM public.agents a WHERE a.id=p_agent_id AND to_jsonb(a)=to_jsonb(v_written)) THEN
    RAISE EXCEPTION 'credit_admin_agent_retained_mismatch' USING ERRCODE='23514';
  END IF;

  RETURN jsonb_build_object('success', true, 'agent_id', p_agent_id, 'club_id', v_club_id,
    'credit_assignment_id',v_assignment.id,
    'is_prepaid', CASE WHEN v_touches_funding THEN v_prepaid_after ELSE v_prepaid_now END,
    'credit_limit', CASE WHEN v_touches_funding THEN v_limit_after ELSE v_limit_now END);
EXCEPTION WHEN SQLSTATE 'PAG01' THEN
  -- This block rolls back the agent insert/update and every role-callee write.
  RETURN COALESCE(v_role_res,jsonb_build_object('success',false,'error','role change refused'));
END;
$function$;

-- Fragment document-authority.sql
-- SOURCE ONLY / UNRUN. Fragment for one guarded post36 transaction.
-- Load after the operation schema; install the delivery/reader successor in
-- the same transaction before admitting any operation. No alternate payer.
CREATE TABLE public.accounting_credit_change_documents_v1 (
 id uuid PRIMARY KEY,
 invoice_id uuid NOT NULL UNIQUE,
 operation_receipt_id uuid NOT NULL UNIQUE,
 issuer_name text NOT NULL,
 recipient_name text NOT NULL,
 audience_user_ids uuid[] NOT NULL,
 issued_at timestamptz NOT NULL,
 CONSTRAINT credit_change_document_invoice_fk FOREIGN KEY(invoice_id)
  REFERENCES public.settlement_invoices(id) DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT credit_change_document_audience_nonempty CHECK(cardinality(audience_user_ids)>0)
);
ALTER TABLE public.accounting_credit_change_documents_v1 OWNER TO postgres;
ALTER TABLE public.accounting_credit_change_documents_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_credit_change_documents_v1 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_credit_change_immutable_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 RAISE EXCEPTION 'credit_change_document_is_immutable' USING ERRCODE='23514';
END $function$;
CREATE TRIGGER credit_change_document_immutable_v1 BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.accounting_credit_change_documents_v1 FOR EACH STATEMENT
 EXECUTE FUNCTION public.fn_accounting_credit_change_immutable_v1();

CREATE FUNCTION public.fn_accounting_credit_change_payload_v1(p_document_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE d public.accounting_credit_change_documents_v1%ROWTYPE;
 o public.accounting_credit_reduction_operations_v1%ROWTYPE;
BEGIN
 SELECT * INTO STRICT d FROM public.accounting_credit_change_documents_v1 WHERE id=p_document_id;
 SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1 WHERE id=d.operation_receipt_id;
 IF o.document_id IS DISTINCT FROM d.id OR o.invoice_id IS DISTINCT FROM d.invoice_id
  OR o.assignment_id IS NULL OR o.applied_reduction IS NULL OR o.applied_reduction<=0
  OR o.applied_reduction::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'credit_change_operation_identity_mismatch' USING ERRCODE='23514';END IF;
 -- Only frozen operation facts. No current agent/audit join on historical reads;
 -- the original assignment is verified while the new document is constructed.
 RETURN jsonb_build_object('contract_version',1,'document_id',d.id,'invoice_id',d.invoice_id,
  'operation_receipt_id',o.id,'operation_id',o.operation_id,'assignment_id',o.assignment_id,
  'club_id',o.club_id,'agent_id',o.agent_id,'target_user_id',o.target_user_id,'actor_user_id',o.actor_user_id,
  'event_kind','credit_limit_reduced','display_state','recorded',
  'amount',round(o.applied_reduction,2)::text,'requested_reduction',round(o.requested_reduction,2)::text,
  'applied_reduction',round(o.applied_reduction,2)::text,
  'before_limit',round(o.before_limit,2)::text,'after_limit',round(o.after_limit,2)::text,
  'before_prepaid',o.before_prepaid,'after_prepaid',o.after_prepaid,
  'before_revision',o.before_revision::text,'after_revision',o.after_revision::text,
  'recorded_at',to_char(o.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'issued_at',to_char(d.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'chip_movement_recorded',false,'payable',false,'amount_due','0.00');
END $function$;

CREATE FUNCTION public.fn_accounting_credit_change_contract_v1(p_invoice_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE d public.accounting_credit_change_documents_v1%ROWTYPE;
 o public.accounting_credit_reduction_operations_v1%ROWTYPE;
 i public.settlement_invoices%ROWTYPE;payload jsonb;audience uuid[];
BEGIN
 SELECT * INTO d FROM public.accounting_credit_change_documents_v1 WHERE invoice_id=p_invoice_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_change_document_missing' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM public.accounting_credit_reduction_operations_v1 WHERE id=d.operation_receipt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_change_operation_missing' USING ERRCODE='23514';END IF;
 SELECT array_agg(DISTINCT u ORDER BY u) INTO audience FROM unnest(ARRAY[o.actor_user_id,o.target_user_id])u;
 payload:=public.fn_accounting_credit_change_payload_v1(d.id);
 SELECT * INTO i FROM public.settlement_invoices WHERE id=d.invoice_id;
 IF NOT FOUND OR d.audience_user_ids IS DISTINCT FROM audience OR d.issued_at IS DISTINCT FROM o.recorded_at
  OR i.invoice_type IS DISTINCT FROM 'credit_limit_change' OR i.club_id IS DISTINCT FROM o.club_id
  OR i.from_entity_type IS DISTINCT FROM 'club' OR i.from_entity_id IS DISTINCT FROM o.club_id::text
  OR i.to_entity_type IS DISTINCT FROM 'agent' OR i.to_entity_id IS DISTINCT FROM o.target_user_id::text
  OR i.gross_amount IS DISTINCT FROM o.applied_reduction OR i.net_amount IS DISTINCT FROM o.applied_reduction
  OR i.deductions IS DISTINCT FROM 0 OR i.status IS DISTINCT FROM 'generated'
  OR i.chips_transferred IS DISTINCT FROM false OR i.transferred_at IS NOT NULL OR i.due_at IS NOT NULL
  OR i.chip_transfer_id IS NOT NULL OR i.adjusts_invoice_id IS NOT NULL OR i.period_id IS NOT NULL
  OR i.source_ledger_id IS NOT NULL OR i.source_credit_invoice_id IS NOT NULL OR i.source_credit_payment_id IS NOT NULL
  OR i.overdue_at IS NOT NULL OR i.reminders_sent IS DISTINCT FROM 0 OR i.last_reminder_at IS NOT NULL
  OR i.notes IS NOT NULL OR i.created_at IS DISTINCT FROM d.issued_at
  OR i.invoice_number IS NULL OR i.breakdown IS DISTINCT FROM jsonb_build_object('category','credit_limit_change','credit_change',payload)
 THEN RAISE EXCEPTION 'credit_change_document_contract_mismatch' USING ERRCODE='23514';END IF;
 RETURN payload;
END $function$;

CREATE FUNCTION public.fn_accounting_credit_change_body_v1(p_document_id uuid,p_invoice_number text) RETURNS text
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $function$
DECLARE d public.accounting_credit_change_documents_v1%ROWTYPE;
 o public.accounting_credit_reduction_operations_v1%ROWTYPE;
BEGIN
 SELECT * INTO STRICT d FROM public.accounting_credit_change_documents_v1 WHERE id=p_document_id;
 SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1 WHERE id=d.operation_receipt_id;
 RETURN 'Credit Line Updated '||p_invoice_number||E'\nIssued By: '||d.issuer_name||E'\nFor: '||d.recipient_name
  ||E'\nRequested Reduction: '||to_char(o.requested_reduction,'FM999,999,999,999,990.00')
  ||E'\nApplied Reduction: '||to_char(o.applied_reduction,'FM999,999,999,999,990.00')
  ||E'\nLimit After This Change: '||to_char(o.after_limit,'FM999,999,999,999,990.00')
  ||E'\nFunding After This Change: '||CASE WHEN o.after_prepaid THEN 'Prepaid' ELSE 'Credit' END
  ||E'\nThis records a credit-capacity change. No chips were transferred and no payment is due.';
END $function$;

CREATE FUNCTION public.fn_accounting_credit_reduction_assert_document(p_operation_receipt_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE o public.accounting_credit_reduction_operations_v1%ROWTYPE;
 c public.accounting_credit_change_documents_v1%ROWTYPE;i public.settlement_invoices%ROWTYPE;
 d record;payload jsonb;actual_users uuid[];expected_body text;expected_meta jsonb;
BEGIN
 SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1 WHERE id=p_operation_receipt_id;
 IF o.applied_reduction=0 THEN
  IF o.assignment_id IS NOT NULL OR o.document_id IS NOT NULL OR o.invoice_id IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.accounting_credit_change_documents_v1 WHERE operation_receipt_id=o.id)
  THEN RAISE EXCEPTION 'credit_no_change_document_unexpected' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO c FROM public.accounting_credit_change_documents_v1 WHERE operation_receipt_id=o.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_change_document_missing' USING ERRCODE='23514';END IF;
 payload:=public.fn_accounting_credit_change_contract_v1(c.invoice_id);
 SELECT * INTO STRICT i FROM public.settlement_invoices WHERE id=c.invoice_id;
 expected_body:=public.fn_accounting_credit_change_body_v1(c.id,i.invoice_number);
 SELECT array_agg(recipient_id ORDER BY recipient_id) INTO actual_users FROM public.accounting_invoice_deliveries WHERE invoice_id=c.invoice_id;
 IF actual_users IS DISTINCT FROM c.audience_user_ids OR i.message_sent IS DISTINCT FROM true OR i.message_sent_at IS NULL
 THEN RAISE EXCEPTION 'credit_change_delivery_missing' USING ERRCODE='23514';END IF;
 FOR d IN SELECT a.*,m.conversation_id,m.sender_id,m.content,m.message_type,m.media_metadata,
  n.user_id AS notice_user,n.type AS notice_type,n.data AS notice_data,n.metadata AS notice_metadata,
  n.title AS notice_title,n.message AS notice_message,n.action_url AS notice_url,n.link AS notice_link
  FROM public.accounting_invoice_deliveries a LEFT JOIN public.social_messages m ON m.id=a.message_id
  LEFT JOIN public.notifications n ON n.id=a.notification_id WHERE a.invoice_id=c.invoice_id LOOP
  expected_meta:=jsonb_build_object('kind','accounting_invoice','invoice_id',i.id,'invoice_number',i.invoice_number,
   'club_id',i.club_id,'source_ledger_id',NULL,'source_credit_invoice_id',NULL,'source_credit_payment_id',NULL,
   'amount',i.net_amount,'currency','CHIPS','conversationId',d.conversation_id,'conversation_id',d.conversation_id,
   'status','generated','invoice_type','credit_limit_change','from_entity_type',i.from_entity_type,'from_entity_id',i.from_entity_id,
   'to_entity_type',i.to_entity_type,'to_entity_id',i.to_entity_id,'lines',i.breakdown,'credit_change',payload);
  IF d.delivery_mode IS DISTINCT FROM 'immediate' OR d.sender_id IS DISTINCT FROM o.actor_user_id
   OR d.message_type IS DISTINCT FROM 'invoice' OR d.content IS DISTINCT FROM expected_body
   OR d.media_metadata IS DISTINCT FROM expected_meta OR d.notice_metadata IS DISTINCT FROM expected_meta OR d.notice_data IS DISTINCT FROM expected_meta
   OR d.notice_user IS DISTINCT FROM d.recipient_id OR d.notice_type IS DISTINCT FROM 'accounting_invoice'
   OR d.notice_title IS DISTINCT FROM 'Credit Line Updated · '||i.invoice_number
   OR d.notice_message IS DISTINCT FROM 'Credit capacity reduced: '||to_char(i.net_amount,'FM999,999,999,999,990.00')||'. No payment due.'
   OR d.notice_url IS DISTINCT FROM '/hub/messenger?conversation='||d.conversation_id::text
   OR d.notice_link IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM public.accounting_conversations x WHERE x.conversation_id=d.conversation_id
    AND x.scope_id=o.club_id AND x.issuer_type='club' AND x.issuer_id=o.club_id AND x.sender_id=o.actor_user_id AND x.recipient_id=d.recipient_id)
   OR EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id<>ALL(ARRAY[o.actor_user_id,d.recipient_id]))
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id=d.recipient_id)
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id=o.actor_user_id)
  THEN RAISE EXCEPTION 'credit_change_delivery_mismatch' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Existing deferred push mirroring performs its own exact outbox readback.
 -- Do not require a deferred output before that constraint has actually run.
 RETURN payload;
END $function$;

CREATE FUNCTION public.fn_accounting_credit_change_on_operation_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE intended public.accounting_credit_change_documents_v1%ROWTYPE;
 surviving public.accounting_credit_change_documents_v1%ROWTYPE;invoice_number text;invoice_id uuid;
BEGIN
 IF NEW.applied_reduction=0 THEN
  PERFORM public.fn_accounting_credit_reduction_assert_document(NEW.id);RETURN NEW;
 END IF;
 IF NEW.applied_reduction IS NULL OR NEW.applied_reduction::text IN('NaN','Infinity','-Infinity') OR NEW.applied_reduction<=0
  OR NEW.document_id IS NULL OR NEW.invoice_id IS NULL OR NEW.assignment_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.agents a WHERE a.id=NEW.agent_id AND a.club_id=NEW.club_id AND a.user_id=NEW.target_user_id
   AND a.credit_limit IS NOT DISTINCT FROM NEW.after_limit AND a.credit_used IS NOT DISTINCT FROM NEW.credit_used
   AND a.is_prepaid IS NOT DISTINCT FROM NEW.after_prepaid AND a.credit_control_revision IS NOT DISTINCT FROM NEW.after_revision)
  OR NOT EXISTS(SELECT 1 FROM public.credit_assignments a WHERE a.id=NEW.assignment_id AND a.agent_id=NEW.agent_id
   AND a.assigned_by IS NOT DISTINCT FROM NEW.actor_user_id AND a.old_limit IS NOT DISTINCT FROM NEW.before_limit
   AND a.new_limit IS NOT DISTINCT FROM NEW.after_limit AND a.reason IS NOT DISTINCT FROM NEW.assignment_reason)
 THEN RAISE EXCEPTION 'credit_change_fresh_assignment_unverified' USING ERRCODE='23514';END IF;
 intended.id:=NEW.document_id;intended.invoice_id:=NEW.invoice_id;intended.operation_receipt_id:=NEW.id;
 SELECT name INTO intended.issuer_name FROM public.clubs WHERE id=NEW.club_id;
 SELECT COALESCE(NULLIF(p.display_name,''),NULLIF(p.username,''),u.username,'Member') INTO intended.recipient_name
  FROM public.users u LEFT JOIN public.profiles p ON p.id=u.id WHERE u.id=NEW.target_user_id;
 SELECT array_agg(DISTINCT u ORDER BY u) INTO intended.audience_user_ids FROM unnest(ARRAY[NEW.actor_user_id,NEW.target_user_id])u;
 intended.issued_at:=NEW.recorded_at;
 IF intended.issuer_name IS NULL OR intended.recipient_name IS NULL
  OR EXISTS(SELECT 1 FROM unnest(intended.audience_user_ids)u WHERE u IS NULL OR NOT EXISTS(SELECT 1 FROM public.users p WHERE p.id=u))
 THEN RAISE EXCEPTION 'credit_change_recorded_party_missing' USING ERRCODE='23514';END IF;
 INSERT INTO public.accounting_credit_change_documents_v1 SELECT intended.*;
 SELECT * INTO surviving FROM public.accounting_credit_change_documents_v1 WHERE id=intended.id;
 IF NOT FOUND OR to_jsonb(surviving) IS DISTINCT FROM to_jsonb(intended)
 THEN RAISE EXCEPTION 'credit_change_provenance_write_missing' USING ERRCODE='23514';END IF;
 invoice_number:=public.fn_accounting_next_invoice_number();
 INSERT INTO public.settlement_invoices(id,club_id,invoice_type,invoice_number,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
  gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,due_at,notes,source_ledger_id,created_at)
 VALUES(NEW.invoice_id,NEW.club_id,'credit_limit_change',invoice_number,'club',NEW.club_id::text,'agent',NEW.target_user_id::text,
  NEW.applied_reduction,NEW.applied_reduction,0,jsonb_build_object('category','credit_limit_change','credit_change',public.fn_accounting_credit_change_payload_v1(intended.id)),
  'generated',false,NULL,NULL,NULL,NULL,NEW.recorded_at) RETURNING id INTO invoice_id;
 IF NOT FOUND OR invoice_id IS DISTINCT FROM NEW.invoice_id
 THEN RAISE EXCEPTION 'credit_change_invoice_write_missing' USING ERRCODE='23514';END IF;
 PERFORM public.fn_deliver_accounting_invoice(invoice_id);
 PERFORM public.fn_accounting_credit_reduction_assert_document(NEW.id);
 RETURN NEW;
END $function$;
CREATE TRIGGER accounting_credit_change_on_operation_v1 AFTER INSERT
 ON public.accounting_credit_reduction_operations_v1 FOR EACH ROW
 EXECUTE FUNCTION public.fn_accounting_credit_change_on_operation_v1();

CREATE FUNCTION public.fn_accounting_credit_change_deferred_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 PERFORM public.fn_accounting_credit_reduction_assert_document(NEW.id);RETURN NEW;
END $function$;
-- Sort after document construction even when this named constraint is immediate.
CREATE CONSTRAINT TRIGGER zz_accounting_credit_change_deferred_v1 AFTER INSERT
 ON public.accounting_credit_reduction_operations_v1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.fn_accounting_credit_change_deferred_v1();

ALTER FUNCTION public.fn_accounting_credit_change_immutable_v1() OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_payload_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_contract_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_body_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_reduction_assert_document(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_on_operation_v1() OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_deferred_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_credit_change_immutable_v1(),public.fn_accounting_credit_change_payload_v1(uuid),
 public.fn_accounting_credit_change_contract_v1(uuid),public.fn_accounting_credit_change_body_v1(uuid,text),
 public.fn_accounting_credit_reduction_assert_document(uuid),public.fn_accounting_credit_change_on_operation_v1(),
 public.fn_accounting_credit_change_deferred_v1() FROM PUBLIC,anon,authenticated,service_role;

-- Fragment document-delivery-successor.sql
-- SOURCE ONLY / UNRUN. Same one guarded post36 transaction as the credit
-- operation and document fragments. Extend the existing delivery authority.
DO $credit_delivery_preimages$ DECLARE expected jsonb;target oid;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($pins$[{"name":"fn_deliver_accounting_invoice","predecessor_body_md5":"4e2964d3fa3557af65bc4535c334cbf8","predecessor_definition_source_sha256":"3f089eb9e1830248f9ea79e6c580189fea7e3a33dbdd38c503c2112e291b0ddd"},{"name":"fn_accounting_document_immutable","predecessor_body_md5":"23ddceacaa3fe54294910d40faf46a5d","predecessor_definition_source_sha256":"c690d708a8f501d877ad4d62610013f182f433db1829740b0e939d79e2099e94"},{"name":"fn_mirror_notification_to_push_outbox","predecessor_body_md5":"4cad61d22e819db464e0b5b2c41bb4a5","predecessor_definition_source_sha256":"4e369c226631fd9a6e0ae498f930da71d0cc9e76ce0699ae22bb4c4ebade9a53"}]$pins$::jsonb) LOOP
  target:=to_regprocedure('public.'||(expected->>'name')||CASE WHEN expected->>'name'='fn_deliver_accounting_invoice' THEN '(uuid)' ELSE '()' END);
  IF target IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
    AND prosecdef AND proconfig=ARRAY['search_path=public']::text[] AND md5(prosrc)=expected->>'predecessor_body_md5'
    AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND prokind='f' AND provolatile='v'
    AND NOT proisstrict AND NOT proleakproof AND proparallel='u' AND NOT proretset AND pronargdefaults=0
    AND prorettype=CASE WHEN expected->>'name'='fn_deliver_accounting_invoice' THEN 'jsonb'::regtype ELSE 'trigger'::regtype END
    AND proargnames IS NOT DISTINCT FROM CASE WHEN expected->>'name'='fn_deliver_accounting_invoice' THEN ARRAY['p_invoice_id'] ELSE NULL::text[] END)
   OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=target)
       IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
  THEN RAISE EXCEPTION 'credit_change_delivery_preimage_changed' USING DETAIL=expected->>'name';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass
   AND conname='settlement_invoices_invoice_type_check' AND convalidated
   AND pg_get_constraintdef(oid)=$vocabulary$CHECK ((invoice_type = ANY (ARRAY['union_to_club'::text, 'club_to_agent'::text, 'agent_to_subagent'::text, 'agent_to_player'::text, 'union_club_pnl'::text, 'club_to_union'::text, 'union_weekly_squareup'::text, 'union_weekly_credit_note'::text, 'transaction_receipt'::text, 'club_weekly_accounting'::text, 'cashier_cashout'::text, 'accounting_correction'::text])))$vocabulary$)
 THEN RAISE EXCEPTION 'credit_change_invoice_vocabulary_changed';END IF;
END $credit_delivery_preimages$;
ALTER TABLE public.settlement_invoices DROP CONSTRAINT settlement_invoices_invoice_type_check;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT settlement_invoices_invoice_type_check CHECK(invoice_type=ANY(ARRAY['union_to_club','club_to_agent','agent_to_subagent','agent_to_player','union_club_pnl','club_to_union','union_weekly_squareup','union_weekly_credit_note','transaction_receipt','club_weekly_accounting','cashier_cashout','accounting_correction','credit_limit_change']));

CREATE OR REPLACE FUNCTION public.fn_deliver_accounting_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_variable
DECLARE inv public.settlement_invoices%ROWTYPE; sender uuid; issuer_name text; recipient_name text;
 issuer_kind text; issuer_id uuid; recipient_id uuid; scope_id uuid; page_id uuid; users uuid[]; issuer_users uuid[]; recipient_users uuid[];
 person uuid; conv uuid; msg uuid; note uuid; body text; meta jsonb; count_sent int:=0; n int; line record; cashier public.accounting_cashier_events%ROWTYPE; cashier_payload jsonb; correction public.accounting_correction_documents%ROWTYPE; correction_payload jsonb; credit_change public.accounting_credit_change_documents_v1%ROWTYPE; credit_operation public.accounting_credit_reduction_operations_v1%ROWTYPE; credit_payload jsonb;
BEGIN
 SELECT * INTO inv FROM public.settlement_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_invoice_missing' USING ERRCODE='23514'; END IF;
 IF public.fn_accounting_correction_is_unverified(inv.id)
 THEN RAISE EXCEPTION 'historical_correction_document_unverified' USING ERRCODE='23514';END IF;
 IF inv.net_amount IS NULL OR inv.net_amount::text IN('NaN','Infinity','-Infinity') OR inv.net_amount<>round(inv.net_amount,2)
 THEN RAISE EXCEPTION 'invalid_invoice_amount' USING ERRCODE='23514'; END IF;
 issuer_kind:=inv.from_entity_type; issuer_id:=inv.from_entity_id::uuid; recipient_id:=inv.to_entity_id::uuid;
 scope_id:=COALESCE(inv.club_id,issuer_id);
 IF inv.invoice_type='credit_limit_change' THEN
  credit_payload:=public.fn_accounting_credit_change_contract_v1(inv.id);
  SELECT * INTO STRICT credit_change FROM public.accounting_credit_change_documents_v1 WHERE invoice_id=inv.id;
  SELECT * INTO STRICT credit_operation FROM public.accounting_credit_reduction_operations_v1 WHERE id=credit_change.operation_receipt_id;
  users:=credit_change.audience_user_ids;sender:=credit_operation.actor_user_id;
  issuer_kind:='club';issuer_id:=credit_operation.club_id;scope_id:=credit_operation.club_id;
  issuer_name:=credit_change.issuer_name;recipient_name:=credit_change.recipient_name;
 ELSIF inv.invoice_type='accounting_correction' THEN
  SELECT * INTO correction FROM public.accounting_correction_documents WHERE invoice_id=inv.id;
  IF NOT FOUND OR correction.club_id IS DISTINCT FROM inv.club_id OR correction.source_ledger_id IS DISTINCT FROM inv.source_ledger_id
   OR correction.amount IS DISTINCT FROM inv.net_amount OR inv.breakdown IS DISTINCT FROM jsonb_build_object('category','correction','correction',public.fn_accounting_correction_payload(correction))
   OR inv.status IS DISTINCT FROM 'generated' OR inv.chips_transferred IS DISTINCT FROM false OR inv.transferred_at IS NOT NULL OR inv.due_at IS NOT NULL
  THEN RAISE EXCEPTION 'correction_document_delivery_source_unverified' USING ERRCODE='23514';END IF;
  users:=correction.audience_user_ids;sender:=correction.issuer_representative_id;
  issuer_kind:=correction.issuer_type;issuer_id:=correction.issuer_id;scope_id:=correction.club_id;
  issuer_name:=correction.issuer_name;recipient_name:=correction.payee_name;correction_payload:=public.fn_accounting_correction_payload(correction);
 ELSIF inv.invoice_type='cashier_cashout' THEN
  SELECT * INTO cashier FROM public.accounting_cashier_events WHERE invoice_id=inv.id;
  IF NOT FOUND OR cashier.club_id IS DISTINCT FROM inv.club_id OR cashier.source_ledger_id IS DISTINCT FROM inv.source_ledger_id
    OR cashier.amount IS DISTINCT FROM inv.net_amount OR inv.breakdown->'cashier' IS DISTINCT FROM public.fn_cashier_event_payload(cashier)
  THEN RAISE EXCEPTION 'cashier_delivery_event_missing' USING ERRCODE='23514';END IF;
  users:=cashier.audience_user_ids;sender:=cashier.issuer_representative_id;
  issuer_kind:='club';issuer_id:=cashier.club_id;scope_id:=cashier.club_id;
  issuer_name:=cashier.issuer_name;recipient_name:=cashier.player_name;
  cashier_payload:=public.fn_cashier_event_payload(cashier);
 ELSE
 SELECT array_agg(user_id ORDER BY user_id) INTO issuer_users FROM public.fn_accounting_party_users(inv.from_entity_type,issuer_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO recipient_users FROM public.fn_accounting_party_users(inv.to_entity_type,recipient_id);
 IF COALESCE(cardinality(issuer_users),0)=0 OR COALESCE(cardinality(recipient_users),0)=0
 THEN RAISE EXCEPTION 'accounting_invoice_recipient_missing' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO users FROM unnest(issuer_users||recipient_users) x;
 -- Club senders receive one weekly summary; individual payees still get their receipt immediately.
 IF inv.from_entity_type='club' AND inv.to_entity_type IN('agent','player')
    AND inv.source_ledger_id IS NOT NULL AND inv.breakdown->>'category' IN('rakeback','commission') THEN
   users:=recipient_users;
 END IF;
 IF inv.invoice_type IN('union_weekly_squareup','union_weekly_credit_note') THEN
   issuer_kind:='union';issuer_id:=(inv.breakdown->>'union_id')::uuid;
 END IF;
 sender:=CASE WHEN issuer_kind='club' THEN (SELECT owner_id FROM public.clubs WHERE id=issuer_id)
              WHEN issuer_kind='union' THEN (SELECT owner_id FROM public.unions WHERE id=issuer_id)
              ELSE issuer_id END;
 IF sender IS NULL OR NOT sender=ANY(issuer_users||recipient_users) THEN RAISE EXCEPTION 'accounting_invoice_sender_missing' USING ERRCODE='23514'; END IF;
 issuer_name:=CASE WHEN issuer_kind='club' THEN (SELECT name FROM public.clubs WHERE id=issuer_id)
                   WHEN issuer_kind='union' THEN (SELECT name FROM public.unions WHERE id=issuer_id)
                   ELSE (SELECT username FROM public.profiles WHERE id=issuer_id) END;
 recipient_name:=CASE WHEN inv.to_entity_type='club' THEN (SELECT name FROM public.clubs WHERE id=recipient_id)
                      WHEN inv.to_entity_type='union' THEN (SELECT name FROM public.unions WHERE id=recipient_id)
                      ELSE (SELECT username FROM public.profiles WHERE id=recipient_id) END;
 END IF;
 IF inv.invoice_number IS NULL THEN
   UPDATE public.settlement_invoices SET invoice_number=public.fn_accounting_next_invoice_number() WHERE id=inv.id RETURNING invoice_number INTO inv.invoice_number;
 END IF;
 IF inv.invoice_type IN('union_weekly_squareup','union_weekly_credit_note') THEN recipient_name:=(SELECT name FROM public.clubs WHERE id=inv.club_id); END IF;
 body:=CASE WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number||E'\nIssued By: '||COALESCE(issuer_name,inv.from_entity_type)||E'\nFor: '||COALESCE(recipient_name,inv.to_entity_type)
  ||E'\nDirection: '||initcap(inv.from_entity_type)||' To '||initcap(inv.to_entity_type)
  ||E'\nAmount: '||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips'
  ||E'\nStatus: '||initcap(inv.status)
  ||CASE WHEN inv.chips_transferred THEN E'\nTransfer Recorded: '||COALESCE(inv.transferred_at,inv.created_at)::text ELSE '' END
  ||CASE WHEN inv.due_at IS NOT NULL THEN E'\nDue: '||to_char(inv.due_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI')||' Chicago Time' ELSE '' END
  ||CASE WHEN inv.breakdown ? 'period_start' THEN E'\nPeriod: '||(inv.breakdown->>'period_start')||' To '||COALESCE(inv.breakdown->>'period_end','') ELSE '' END
  ||CASE WHEN inv.notes IS NOT NULL THEN E'\n'||inv.notes ELSE '' END;
 FOR line IN SELECT key,value FROM jsonb_each_text(COALESCE(inv.breakdown,'{}'))
   WHERE key IN('rake_generated','rakeback_due','union_fee_kept','players_won','settled_in_chips','eco_amount','presettled','rake_earned','union_rake_earned','private_rake_earned','private_rake_banked','total_rake_funding','rake_received','paid_super_agents','paid_agents','paid_sub_agents','paid_players','total_paid_by_club','retained_by_club','downstream_redistributed','downstream_paid_super_agents','downstream_paid_agents','downstream_paid_sub_agents','downstream_paid_players') ORDER BY key
 LOOP
   IF line.value IS NOT NULL THEN body:=body||E'\n'||initcap(replace(line.key,'_',' '))||': '||to_char(line.value::numeric,'FM999,999,999,999,990.00'); END IF;
 END LOOP;
 IF inv.invoice_type='credit_limit_change' THEN body:=public.fn_accounting_credit_change_body_v1(credit_change.id,inv.invoice_number);
 ELSIF inv.invoice_type='cashier_cashout' THEN body:=public.fn_cashier_document_body(cashier.id,inv.invoice_number);
 ELSIF inv.invoice_type='accounting_correction' THEN body:=public.fn_accounting_correction_document_body(correction.id,inv.invoice_number);END IF;
 meta:=jsonb_build_object('kind','accounting_invoice' ,'invoice_id',inv.id,'invoice_number',inv.invoice_number,
   'club_id',inv.club_id,'source_ledger_id',inv.source_ledger_id,'source_credit_invoice_id',inv.source_credit_invoice_id,
   'source_credit_payment_id',inv.source_credit_payment_id,'amount',inv.net_amount,'currency','CHIPS','conversationId',NULL,'status',inv.status,
   'invoice_type',inv.invoice_type,'from_entity_type',inv.from_entity_type,'from_entity_id',inv.from_entity_id,
   'to_entity_type',inv.to_entity_type,'to_entity_id',inv.to_entity_id,'lines',inv.breakdown-'source_ledger_ids');
 IF inv.invoice_type='credit_limit_change' THEN meta:=meta||jsonb_build_object('credit_change',credit_payload);
 ELSIF inv.invoice_type='cashier_cashout' THEN meta:=meta||jsonb_build_object('cashier',cashier_payload);
 ELSIF inv.invoice_type='accounting_correction' THEN meta:=meta||jsonb_build_object('correction',correction_payload);END IF;
 SELECT id INTO page_id FROM public.social_pages WHERE linked_entity_id=scope_id::text AND linked_entity_type='club' ORDER BY id LIMIT 1;
 FOREACH person IN ARRAY users LOOP
   IF EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=inv.id AND d.recipient_id=person) THEN CONTINUE; END IF;
   -- One private accounting conversation per issuer, sender, scope and recipient.
   PERFORM pg_advisory_xact_lock(hashtextextended('accounting_conversation:'||scope_id::text||':'||issuer_id::text||':'||sender::text||':'||person::text,0));
   SELECT conversation_id INTO conv FROM public.accounting_conversations c
    WHERE c.scope_id=scope_id AND c.issuer_type=issuer_kind AND c.issuer_id=issuer_id AND c.sender_id=sender AND c.recipient_id=person;
   IF conv IS NULL THEN
     INSERT INTO public.social_conversations(is_group,group_name,context_entity_id,context_entity_type)
      VALUES(true,COALESCE(issuer_name,'Account')||' Accounting',page_id,CASE WHEN page_id IS NULL THEN NULL ELSE 'club' END) RETURNING id INTO conv;
     INSERT INTO public.social_conversation_participants(conversation_id,user_id,context_entity_id,context_entity_type)
      SELECT conv,x,page_id,CASE WHEN page_id IS NULL THEN NULL ELSE 'club' END FROM (SELECT DISTINCT unnest(ARRAY[sender,person]) AS x) members;
     INSERT INTO public.accounting_conversations(scope_id,issuer_type,issuer_id,sender_id,recipient_id,conversation_id)
      VALUES(scope_id,issuer_kind,issuer_id,sender,person,conv);
   END IF;
   -- Refuse a conversation whose audience changed instead of leaking invoices.
   IF EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id<>ALL(ARRAY[sender,person]))
      OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id=person)
      OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id=sender)
   THEN RAISE EXCEPTION 'accounting_conversation_audience_changed' USING ERRCODE='23514'; END IF;
   IF inv.invoice_type IN('cashier_cashout','accounting_correction','credit_limit_change') THEN meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);END IF;
   INSERT INTO public.social_messages(conversation_id,sender_id,content,message_type,media_metadata)
    VALUES(conv,sender,body,'invoice',meta) RETURNING id INTO msg;
   UPDATE public.social_conversations SET last_message_at=now(),last_message_preview=left(body,100),updated_at=now() WHERE id=conv;
   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);
   INSERT INTO public.notifications(user_id,type,title,message,data,read,action_url,metadata)
    VALUES(person,'accounting_invoice',CASE WHEN inv.invoice_type='credit_limit_change' THEN 'Credit Line Updated · ' WHEN inv.invoice_type='accounting_correction' THEN 'Correction Recorded · ' WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held · ' WHEN 'approval' THEN 'Cashout Approved · ' ELSE 'Chips Returned · ' END WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number,
     CASE WHEN inv.invoice_type='credit_limit_change' THEN 'Credit capacity reduced: '||to_char(inv.net_amount,'FM999,999,999,999,990.00')||'. No payment due.'
      ELSE CASE WHEN inv.invoice_type='accounting_correction' THEN 'Correction Recorded: ' WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held: ' WHEN 'approval' THEN 'Cashout Approved: ' ELSE 'Chips Returned: ' END WHEN inv.chips_transferred AND inv.breakdown->>'category'='rakeback' THEN 'Rakeback Transfer Recorded: ' WHEN inv.chips_transferred AND inv.breakdown->>'category'='commission' THEN 'Commission Transfer Recorded: ' WHEN inv.chips_transferred THEN 'Transfer Recorded: ' ELSE 'Invoice Issued: ' END||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips' END,
     meta,false,'/hub/messenger?conversation='||conv::text,meta) RETURNING id INTO note;
   INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) VALUES(inv.id,person,msg,note);
   count_sent:=count_sent+1;
 END LOOP;
 SELECT count(*) INTO n FROM public.accounting_invoice_deliveries WHERE invoice_id=inv.id;
 UPDATE public.settlement_invoices SET message_sent=true,message_sent_at=COALESCE(message_sent_at,now()) WHERE id=inv.id;
 RETURN jsonb_build_object('success',true,'invoice_id',inv.id,'delivered',n,'new_deliveries',count_sent);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_accounting_document_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE issued boolean;
BEGIN
 IF TG_TABLE_NAME='settlement_invoices' THEN
   IF OLD.invoice_type='credit_limit_change' AND (TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['message_sent','message_sent_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['message_sent','message_sent_at']))
   THEN RAISE EXCEPTION 'credit_change_document_is_immutable' USING ERRCODE='23514';END IF;
   IF OLD.invoice_type='accounting_correction' AND (TG_OP='DELETE' OR
      ROW(NEW.status,NEW.chips_transferred,NEW.transferred_at,NEW.due_at,NEW.chip_transfer_id,NEW.adjusts_invoice_id,
          NEW.source_credit_invoice_id,NEW.source_credit_payment_id,NEW.overdue_at,NEW.reminders_sent,NEW.last_reminder_at)
      IS DISTINCT FROM ROW(OLD.status,OLD.chips_transferred,OLD.transferred_at,OLD.due_at,OLD.chip_transfer_id,OLD.adjusts_invoice_id,
          OLD.source_credit_invoice_id,OLD.source_credit_payment_id,OLD.overdue_at,OLD.reminders_sent,OLD.last_reminder_at))
   THEN RAISE EXCEPTION 'correction_document_payment_claim_is_immutable' USING ERRCODE='23514';END IF;
   IF OLD.invoice_type='cashier_cashout' AND (TG_OP='DELETE' OR
      ROW(NEW.status,NEW.chips_transferred,NEW.transferred_at) IS DISTINCT FROM
      ROW(OLD.status,OLD.chips_transferred,OLD.transferred_at))
   THEN RAISE EXCEPTION 'cashier_document_phase_is_immutable' USING ERRCODE='23514';END IF;
   issued:=COALESCE(OLD.message_sent,false) OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=OLD.id);
   IF issued AND (TG_OP='DELETE' OR
     ROW(NEW.club_id,NEW.period_id,NEW.invoice_type,NEW.invoice_number,NEW.from_entity_type,NEW.from_entity_id,
         NEW.to_entity_type,NEW.to_entity_id,NEW.gross_amount,NEW.net_amount,NEW.deductions,NEW.breakdown,
         NEW.due_at,NEW.notes,NEW.source_ledger_id,NEW.source_credit_invoice_id,NEW.source_credit_payment_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.club_id,OLD.period_id,OLD.invoice_type,OLD.invoice_number,OLD.from_entity_type,OLD.from_entity_id,
         OLD.to_entity_type,OLD.to_entity_id,OLD.gross_amount,OLD.net_amount,OLD.deductions,OLD.breakdown,
         OLD.due_at,OLD.notes,OLD.source_ledger_id,OLD.source_credit_invoice_id,OLD.source_credit_payment_id,OLD.created_at)
     OR NEW.message_sent IS DISTINCT FROM true)
   THEN RAISE EXCEPTION 'issued_accounting_invoice_is_immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='social_messages' THEN
   issued:=EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE message_id=OLD.id);
   IF issued AND (TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['read_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['read_at','updated_at']))
   THEN RAISE EXCEPTION 'issued_accounting_message_is_immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_mirror_notification_to_push_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE notice public.notifications%ROWTYPE; receipt record; existing public.push_outbox%ROWTYPE;
 v_tag text;v_pending int;state text:='pending';reason text;
 c_max_pending CONSTANT int:=20;c_max_age CONSTANT interval:=interval '30 minutes';
BEGIN
 -- Delivery rows are inserted AFTER their notification. Wait until the whole
 -- transaction is ready to commit before granting the canonical exception.
 IF TG_NAME<>'trg_accounting_push_after_delivery' AND NEW.type='accounting_invoice' THEN RETURN NEW; END IF;
 SELECT * INTO notice FROM public.notifications WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT d.invoice_id,d.recipient_id,d.delivery_mode,m.conversation_id,m.message_type,m.media_metadata,
  i.invoice_number,i.net_amount,i.invoice_type INTO receipt
 FROM public.accounting_invoice_deliveries d JOIN public.settlement_invoices i ON i.id=d.invoice_id
 JOIN public.social_messages m ON m.id=d.message_id WHERE d.notification_id=notice.id;
 IF FOUND THEN
  -- A real receipt foreign key, exact recipient and issued document are
  -- required. Arbitrary accounting-looking JSON cannot bypass normal caps.
  IF receipt.recipient_id IS DISTINCT FROM notice.user_id
   OR notice.data->>'invoice_id' IS DISTINCT FROM receipt.invoice_id::text
   OR notice.data->>'invoice_number' IS DISTINCT FROM receipt.invoice_number
   OR notice.data->'amount' IS DISTINCT FROM to_jsonb(receipt.net_amount)
   OR receipt.message_type IS DISTINCT FROM 'invoice'
   OR receipt.media_metadata->>'invoice_id' IS DISTINCT FROM receipt.invoice_id::text
   OR COALESCE(notice.data->>'conversation_id',notice.data->>'conversationId') IS DISTINCT FROM receipt.conversation_id::text
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=receipt.conversation_id AND p.user_id=notice.user_id)
  THEN RAISE EXCEPTION 'accounting_push_receipt_provenance_invalid' USING ERRCODE='23514'; END IF;
  IF receipt.delivery_mode='weekly_detail' OR notice.type='accounting_invoice_detail' THEN
   state:='skipped';reason:='accounting_archived_detail';
  ELSIF notice.type IS DISTINCT FROM 'accounting_invoice' THEN
   RAISE EXCEPTION 'accounting_push_notification_type_invalid' USING ERRCODE='23514';
  ELSIF notice.data->>'_push' IS NOT NULL THEN
   state:='skipped';reason:='accounting_source_suppressed:'||(notice.data->>'_push');
  ELSIF notice.created_at<now()-c_max_age THEN
   state:='skipped';reason:='accounting_historical_notification';
  END IF;
  SELECT * INTO existing FROM public.push_outbox WHERE accounting_notification_id=notice.id;
  IF FOUND THEN
   IF existing.recipient_user_id IS DISTINCT FROM notice.user_id OR existing.related_entity_id IS DISTINCT FROM notice.id
    OR existing.event IS DISTINCT FROM 'accounting_invoice' THEN RAISE EXCEPTION 'accounting_push_receipt_collision' USING ERRCODE='23514'; END IF;
   IF receipt.invoice_type IN('cashier_cashout','accounting_correction','credit_limit_change') AND ROW(existing.title,existing.body,existing.url,existing.tag) IS DISTINCT FROM
     ROW(left(notice.title,120),left(COALESCE(notice.message,notice.title),500),
       COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),
       'accounting_invoice:'||receipt.conversation_id::text)
   THEN RAISE EXCEPTION 'cashier_push_content_mismatch' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  -- No exception swallowing here. The invoice, message, notification, linked
  -- transfer and durable outbox receipt commit together or all roll back.
  -- Normal dispatcher preference, quiet-hour, device and consent gates remain.
  INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,failure_reason,related_entity_id,accounting_notification_id)
  VALUES(notice.user_id,left(notice.title,120),left(COALESCE(notice.message,notice.title),500),
   COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),
   'accounting_invoice','accounting_invoice:'||receipt.conversation_id::text,state,reason,notice.id,notice.id);
  IF receipt.invoice_type IN('cashier_cashout','accounting_correction','credit_limit_change') AND NOT EXISTS(SELECT 1 FROM public.push_outbox o
    WHERE o.accounting_notification_id=notice.id AND o.related_entity_id=notice.id
      AND o.recipient_user_id=notice.user_id AND o.event='accounting_invoice'
      AND o.status=state AND o.failure_reason IS NOT DISTINCT FROM reason
      AND o.title=left(notice.title,120) AND o.body=left(COALESCE(notice.message,notice.title),500)
      AND o.url=COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub')
      AND o.tag='accounting_invoice:'||receipt.conversation_id::text)
  THEN RAISE EXCEPTION 'cashier_push_receipt_missing' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;

 -- A reserved accounting label with no actual delivery link is invalid,
 -- including a caller that forces this constraint before the link is written.
 -- Fail the transaction rather than silently dropping its accounting push.
 IF notice.type='accounting_invoice' THEN
  RAISE EXCEPTION 'accounting_push_delivery_link_missing' USING ERRCODE='23514';
 END IF;
 IF notice.type='accounting_invoice_detail' THEN RETURN NEW; END IF;
 -- Existing non-accounting notification policy stays intact.
 IF notice.data IS NOT NULL AND notice.data->>'_push' IS NOT NULL THEN RETURN NEW; END IF;
 IF notice.user_id IS NULL OR notice.title IS NULL OR btrim(notice.title)='' THEN RETURN NEW; END IF;
 IF notice.created_at IS NOT NULL AND notice.created_at<now()-c_max_age THEN RETURN NEW; END IF;
 IF notice.type IN('waitlist_seat_open','waitlist_offer_expired','seat_available','waitlist_ready','table_ready') THEN
  v_tag:='seat_offer:'||COALESCE(NULLIF(btrim(COALESCE(notice.data->>'table_id','')),''),notice.id::text);
 ELSIF notice.type IN('system','daily_challenge','venue_alert','bonus','vip','live','poker_news','diamond','achievement') THEN
  v_tag:=notice.type||':'||notice.user_id::text;
 ELSE
  v_tag:=notice.type||':'||COALESCE(NULLIF(btrim(COALESCE(notice.data->>'conversationId','')),''),NULLIF(btrim(COALESCE(notice.data->>'conversation_id','')),''),notice.actor_id::text,notice.id::text);
 END IF;
 BEGIN
  SELECT count(*) INTO v_pending FROM public.push_outbox WHERE recipient_user_id=notice.user_id AND status IN('pending','processing');
  IF v_pending>=c_max_pending THEN RETURN NEW; END IF;
  INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,related_entity_id)
   VALUES(notice.user_id,left(notice.title,120),left(COALESCE(notice.message,notice.title),500),COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),notice.type,v_tag,'pending',notice.id);
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'mirror_notification_to_push_outbox failed for notification %: %',notice.id,SQLERRM;
 END;
 RETURN NEW;
END $function$;

DO $credit_delivery_postconditions$ DECLARE expected jsonb;target oid;who text;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($pins$[{"signature":"public.fn_deliver_accounting_invoice(uuid)","md5":"ebf53a7a5ed7a0464899b124a83454f8","returns":"jsonb","argument_names":["p_invoice_id"]},{"signature":"public.fn_accounting_document_immutable()","md5":"fc0c5dacdef0018bb77a8f10330f694b","returns":"trigger","argument_names":null},{"signature":"public.fn_mirror_notification_to_push_outbox()","md5":"ff981e4bc83ac67d2614c387f9253d3e","returns":"trigger","argument_names":null}]$pins$::jsonb) LOOP
  target:=to_regprocedure(expected->>'signature');
  IF target IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
    AND prosecdef AND proconfig=ARRAY['search_path=public']::text[] AND md5(prosrc)=expected->>'md5'
    AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND prokind='f' AND provolatile='v'
    AND NOT proisstrict AND NOT proleakproof AND proparallel='u' AND NOT proretset AND pronargdefaults=0
    AND prorettype=(expected->>'returns')::regtype
    AND COALESCE(to_jsonb(proargnames),'null'::jsonb)=expected->'argument_names')
   OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=target)
       IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
  THEN RAISE EXCEPTION 'credit_change_delivery_postcondition_changed' USING DETAIL=expected->>'signature';END IF;
  FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(who,target,'EXECUTE') IS DISTINCT FROM (who='service_role')
   THEN RAISE EXCEPTION 'credit_change_delivery_effective_access_changed' USING DETAIL=who||':'||(expected->>'signature');END IF;
  END LOOP;
 END LOOP;
END $credit_delivery_postconditions$;

-- Fragment reader-successor.sql
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

-- Fragment server-functions.sql
-- SOURCE ONLY / UNRUN. One guarded transaction must also load root's document,
-- delivery and private-reader fragments. The sole funding writer stays
-- fn_admin_update_agent; these functions coordinate intent and retained proof.

CREATE FUNCTION public.fn_credit_reduction_lock_v1(p_actor uuid,p_operation uuid,p_club uuid) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
  RAISE EXCEPTION 'credit_reduction_read_committed_required' USING ERRCODE='25000';END IF;
 IF p_actor IS NULL OR p_actor='00000000-0000-0000-0000-000000000000'::uuid OR auth.uid() IS DISTINCT FROM p_actor THEN
  RAISE EXCEPTION 'credit_reduction_actor_changed' USING ERRCODE='42501';END IF;
 IF p_operation IS NULL OR p_club IS NULL
  OR p_operation='00000000-0000-0000-0000-000000000000'::uuid OR p_club='00000000-0000-0000-0000-000000000000'::uuid THEN
  RAISE EXCEPTION 'credit_reduction_invalid_identity' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club::text,0));
 -- Global actor/operation identity also prevents reusing an operation in a
 -- different club. Existing operations are read only after both locks.
 PERFORM pg_advisory_xact_lock(hashtextextended('credit-reduction:'||p_actor::text||':'||p_operation::text,0));
END $function$;

-- New-change authority is held through the target-row wait and the entire
-- transaction. This is not consulted by historical own receipt/retirement.
CREATE FUNCTION public.fn_credit_reduction_lock_current_manager_v1(p_actor uuid,p_club uuid) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE owner_id uuid;member public.club_members%ROWTYPE;
BEGIN
 IF p_actor IS NULL OR p_actor='00000000-0000-0000-0000-000000000000'::uuid OR auth.uid() IS DISTINCT FROM p_actor THEN
  RAISE EXCEPTION 'credit_reduction_actor_changed' USING ERRCODE='42501';END IF;
 -- Caller already holds the club agreement mutex. Every amended financial
 -- entrypoint acquires that mutex before clubs/member/agent row locks.
 SELECT c.owner_id INTO owner_id FROM public.clubs c WHERE c.id=p_club FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_reduction_not_authorized' USING ERRCODE='42501';END IF;
 IF owner_id=p_actor THEN RETURN;END IF;
 SELECT * INTO member FROM public.club_members WHERE club_id=p_club AND user_id=p_actor FOR SHARE;
 IF NOT FOUND OR member.role NOT IN('owner','co_owner','admin') OR member.role IS NULL
  OR member.status NOT IN('active','approved') OR member.status IS NULL
  OR member.is_active IS DISTINCT FROM true OR member.membership_lifecycle_status IS DISTINCT FROM 'active' THEN
  RAISE EXCEPTION 'credit_reduction_not_authorized' USING ERRCODE='42501';END IF;
END $function$;

CREATE FUNCTION public.fn_credit_reduction_receipt_payload_v1(p_receipt_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE o public.accounting_credit_reduction_operations_v1%ROWTYPE;
BEGIN
 SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1 WHERE id=p_receipt_id;
 RETURN jsonb_build_object('contract_version',1,'receipt_id',o.id,
  'actor_user_id',o.actor_user_id,'operation_id',o.operation_id,'club_id',o.club_id,
  'agent_id',o.agent_id,'target_user_id',o.target_user_id,'action',o.action,
  'requested_reduction',round(o.requested_reduction,2)::text,'reason',o.reason,'assignment_reason',o.assignment_reason,
  'before_limit',round(o.before_limit,2)::text,'after_limit',round(o.after_limit,2)::text,
  'credit_used',round(o.credit_used,2)::text,'before_prepaid',o.before_prepaid,'after_prepaid',o.after_prepaid,
  'before_revision',o.before_revision::text,'after_revision',o.after_revision::text,
  'applied_reduction',round(o.applied_reduction,2)::text,
  'assignment_id',o.assignment_id,'document_id',o.document_id,'invoice_id',o.invoice_id,
  'recorded_at',to_char(o.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'outcome',CASE WHEN o.applied_reduction>0 THEN 'applied' ELSE 'no_change' END,
  'payment_proven',false,'chip_movement_claimed',false,'amount_due_claimed',false);
END $function$;

CREATE FUNCTION public.fn_credit_reduction_retirement_payload_v1(p_retirement_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE r public.accounting_credit_reduction_retirements_v1%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM public.accounting_credit_reduction_retirements_v1 WHERE id=p_retirement_id;
 RETURN jsonb_build_object('contract_version',1,'retirement_id',r.id,
  'actor_user_id',r.actor_user_id,'operation_id',r.operation_id,'club_id',r.club_id,
  'state','retired','retired_at',to_char(r.retired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END $function$;

-- Internal observation after the caller has acquired the club/operation locks.
-- No current agent, assignment or permission joins for an original own receipt.
CREATE FUNCTION public.fn_credit_reduction_observe_v1(p_actor uuid,p_operation uuid,p_club uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE o public.accounting_credit_reduction_operations_v1%ROWTYPE;
 r public.accounting_credit_reduction_retirements_v1%ROWTYPE;result jsonb;
BEGIN
 SELECT * INTO o FROM public.accounting_credit_reduction_operations_v1 WHERE actor_user_id=p_actor AND operation_id=p_operation;
 SELECT * INTO r FROM public.accounting_credit_reduction_retirements_v1 WHERE actor_user_id=p_actor AND operation_id=p_operation;
 IF o.id IS NOT NULL AND r.id IS NOT NULL THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 IF (o.id IS NOT NULL AND o.club_id IS DISTINCT FROM p_club)
  OR (r.id IS NOT NULL AND r.club_id IS DISTINCT FROM p_club) THEN
  RAISE EXCEPTION 'credit_reduction_operation_scope_conflict' USING ERRCODE='23514';END IF;
 result:=jsonb_build_object('contract_version',1,'actor_user_id',p_actor,'operation_id',p_operation,'club_id',p_club,
  'state','absent','replayed',false,'receipt',NULL,'retirement',NULL);
 IF o.id IS NOT NULL THEN
  PERFORM public.fn_accounting_credit_reduction_assert_document(o.id);
  RETURN result||jsonb_build_object('state','recorded','replayed',true,'receipt',public.fn_credit_reduction_receipt_payload_v1(o.id));
 ELSIF r.id IS NOT NULL THEN
  RETURN result||jsonb_build_object('state','retired','replayed',true,'retirement',public.fn_credit_reduction_retirement_payload_v1(r.id));
 END IF;
 RETURN result;
END $function$;

CREATE FUNCTION public.fn_agent_credit_reduction_snapshot_v1(p_expected_actor_id uuid,p_club_id uuid,p_target_user_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE a public.agents%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
  RAISE EXCEPTION 'credit_reduction_read_committed_required' USING ERRCODE='25000';END IF;
 IF p_expected_actor_id IS NULL OR p_expected_actor_id='00000000-0000-0000-0000-000000000000'::uuid
  OR auth.uid() IS DISTINCT FROM p_expected_actor_id THEN
  RAISE EXCEPTION 'credit_reduction_actor_changed' USING ERRCODE='42501';END IF;
 IF p_club_id IS NULL OR p_target_user_id IS NULL
  OR p_club_id='00000000-0000-0000-0000-000000000000'::uuid OR p_target_user_id='00000000-0000-0000-0000-000000000000'::uuid THEN
  RAISE EXCEPTION 'credit_reduction_invalid_identity' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
 PERFORM public.fn_credit_reduction_lock_current_manager_v1(p_expected_actor_id,p_club_id);
 SELECT * INTO STRICT a FROM public.agents WHERE club_id=p_club_id AND user_id=p_target_user_id FOR UPDATE;
 IF a.id='00000000-0000-0000-0000-000000000000'::uuid OR a.credit_limit::text IN('NaN','Infinity','-Infinity') OR a.credit_used::text IN('NaN','Infinity','-Infinity')
  OR a.credit_limit<0 OR a.credit_used<0 OR a.credit_used>a.credit_limit OR a.credit_control_revision<0
  OR a.is_prepaid IS DISTINCT FROM (a.credit_limit=0) THEN
  RAISE EXCEPTION 'credit_reduction_invalid_prior_state' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('contract_version',1,'actor_user_id',p_expected_actor_id,'club_id',p_club_id,
  'agent_id',a.id,'target_user_id',a.user_id,'credit_limit',round(a.credit_limit,2)::text,
  'credit_used',round(a.credit_used,2)::text,'is_prepaid',a.is_prepaid,'control_revision',a.credit_control_revision::text,
  'captured_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END $function$;

CREATE FUNCTION public.fn_reduce_agent_credit_v1(
 p_expected_actor_id uuid,p_operation_id uuid,p_club_id uuid,p_agent_id uuid,p_target_user_id uuid,
 p_requested_reduction numeric,p_expected_credit_limit numeric,p_expected_credit_used numeric,
 p_expected_is_prepaid boolean,p_expected_revision bigint,p_reason text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE prior jsonb;o public.accounting_credit_reduction_operations_v1%ROWTYPE;
 retained public.accounting_credit_reduction_operations_v1%ROWTYPE;
 a public.agents%ROWTYPE;after_agent public.agents%ROWTYPE;assignment public.credit_assignments%ROWTYPE;
 writer jsonb;applied numeric;after_limit numeric;after_prepaid boolean;accepted_reason text;
BEGIN
 -- Validate raw numeric parameters BEFORE assignment to numeric(15,2) fields,
 -- whose typmod would otherwise silently round a malformed fractional cent.
 IF p_agent_id IS NULL OR p_target_user_id IS NULL
  OR p_agent_id='00000000-0000-0000-0000-000000000000'::uuid OR p_target_user_id='00000000-0000-0000-0000-000000000000'::uuid
  OR p_requested_reduction IS NULL
  OR p_requested_reduction::text IN('NaN','Infinity','-Infinity') OR p_requested_reduction<=0
  OR p_requested_reduction>1000000000 OR p_requested_reduction<>round(p_requested_reduction,2)
  OR p_expected_credit_limit IS NULL OR p_expected_credit_used IS NULL
  OR p_expected_credit_limit::text IN('NaN','Infinity','-Infinity') OR p_expected_credit_used::text IN('NaN','Infinity','-Infinity')
  OR p_expected_credit_limit<0 OR p_expected_credit_limit>9999999999999.99
  OR p_expected_credit_used<0 OR p_expected_credit_used>9999999999999.99
  OR p_expected_credit_limit<>round(p_expected_credit_limit,2) OR p_expected_credit_used<>round(p_expected_credit_used,2)
  OR p_expected_is_prepaid IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN
  RAISE EXCEPTION 'credit_reduction_invalid_intent' USING ERRCODE='22023';END IF;
 PERFORM public.fn_credit_reduction_lock_v1(p_expected_actor_id,p_operation_id,p_club_id);
 prior:=public.fn_credit_reduction_observe_v1(p_expected_actor_id,p_operation_id,p_club_id);
 IF prior->>'state'='retired' THEN
  RAISE EXCEPTION 'credit_reduction_operation_retired' USING ERRCODE='23514';END IF;
 IF prior->>'state'='recorded' THEN
  SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1
   WHERE actor_user_id=p_expected_actor_id AND operation_id=p_operation_id;
  IF o.agent_id IS DISTINCT FROM p_agent_id OR o.target_user_id IS DISTINCT FROM p_target_user_id
   OR o.requested_reduction IS DISTINCT FROM p_requested_reduction OR o.before_limit IS DISTINCT FROM p_expected_credit_limit
   OR o.credit_used IS DISTINCT FROM p_expected_credit_used OR o.before_prepaid IS DISTINCT FROM p_expected_is_prepaid
   OR o.before_revision IS DISTINCT FROM p_expected_revision OR o.reason IS DISTINCT FROM p_reason THEN
   RAISE EXCEPTION 'credit_reduction_operation_conflict' USING ERRCODE='23514';END IF;
  RETURN prior;
 END IF;
 IF prior->>'state' IS DISTINCT FROM 'absent' THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 PERFORM public.fn_credit_reduction_lock_current_manager_v1(p_expected_actor_id,p_club_id);
 SELECT * INTO a FROM public.agents WHERE id=p_agent_id AND club_id=p_club_id AND user_id=p_target_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_reduction_target_changed' USING ERRCODE='23514';END IF;
 IF a.id='00000000-0000-0000-0000-000000000000'::uuid OR a.credit_limit::text IN('NaN','Infinity','-Infinity') OR a.credit_used::text IN('NaN','Infinity','-Infinity')
  OR a.credit_limit<0 OR a.credit_used<0 OR a.credit_used>a.credit_limit
  OR a.is_prepaid IS DISTINCT FROM (a.credit_limit=0) THEN
  RAISE EXCEPTION 'credit_reduction_invalid_prior_state' USING ERRCODE='23514';END IF;
 IF a.credit_limit IS DISTINCT FROM p_expected_credit_limit OR a.credit_used IS DISTINCT FROM p_expected_credit_used
  OR a.is_prepaid IS DISTINCT FROM p_expected_is_prepaid OR a.credit_control_revision IS DISTINCT FROM p_expected_revision THEN
  RAISE EXCEPTION 'credit_reduction_state_changed' USING ERRCODE='23514';END IF;
 applied:=least(p_requested_reduction,a.credit_limit);after_limit:=a.credit_limit-applied;after_prepaid:=(after_limit=0);
 accepted_reason:=CASE WHEN p_reason IS NULL OR p_reason='' THEN 'Credit line reduced' ELSE p_reason END;
 after_agent:=a;
 IF applied>0 THEN
  IF a.credit_control_revision=9223372036854775807 THEN
   RAISE EXCEPTION 'credit_control_revision_exhausted' USING ERRCODE='22003';END IF;
  writer:=public.fn_admin_update_agent(p_agent_id=>a.id,p_credit_limit=>after_limit,
   p_assigned_by=>p_expected_actor_id,p_credit_reason=>accepted_reason,p_is_prepaid=>after_prepaid);
  IF jsonb_typeof(writer) IS DISTINCT FROM 'object' OR writer->'success' IS DISTINCT FROM 'true'::jsonb THEN
   -- Preserve the existing writer's debt/child-cap/funding refusal by rolling
   -- back this entire call; a refusal is never a retirement proof.
   RAISE EXCEPTION 'credit_reduction_writer_refused' USING ERRCODE='23514',DETAIL=COALESCE(writer->>'error','writer did not confirm');END IF;
  IF writer->>'agent_id' IS DISTINCT FROM a.id::text OR writer->>'club_id' IS DISTINCT FROM a.club_id::text
   OR writer->>'credit_assignment_id' IS NULL THEN
   RAISE EXCEPTION 'credit_reduction_writer_unconfirmed' USING ERRCODE='23514';END IF;
  SELECT * INTO after_agent FROM public.agents WHERE id=a.id;
  IF NOT FOUND OR after_agent.club_id IS DISTINCT FROM a.club_id OR after_agent.user_id IS DISTINCT FROM a.user_id
   OR after_agent.credit_limit IS DISTINCT FROM after_limit OR after_agent.credit_used IS DISTINCT FROM a.credit_used
   OR after_agent.is_prepaid IS DISTINCT FROM after_prepaid OR after_agent.credit_control_revision IS DISTINCT FROM a.credit_control_revision+1
   OR after_agent.status IS DISTINCT FROM a.status OR after_agent.role IS DISTINCT FROM a.role
   OR after_agent.parent_agent_id IS DISTINCT FROM a.parent_agent_id THEN
   RAISE EXCEPTION 'credit_reduction_writer_unconfirmed' USING ERRCODE='23514';END IF;
  SELECT * INTO assignment FROM public.credit_assignments WHERE id::text=writer->>'credit_assignment_id';
  IF NOT FOUND OR assignment.agent_id IS DISTINCT FROM a.id OR assignment.assigned_by IS DISTINCT FROM p_expected_actor_id
   OR assignment.old_limit IS DISTINCT FROM a.credit_limit OR assignment.new_limit IS DISTINCT FROM after_limit
   OR assignment.reason IS DISTINCT FROM accepted_reason OR assignment.created_at IS NULL OR NOT isfinite(assignment.created_at) THEN
   RAISE EXCEPTION 'credit_reduction_assignment_unconfirmed' USING ERRCODE='23514';END IF;
 END IF;
 o.id:=gen_random_uuid();o.contract_version:=1;o.actor_user_id:=p_expected_actor_id;o.operation_id:=p_operation_id;
 o.club_id:=p_club_id;o.agent_id:=a.id;o.target_user_id:=a.user_id;o.action:='reduce_credit_limit';
 o.requested_reduction:=p_requested_reduction;o.reason:=p_reason;o.assignment_reason:=accepted_reason;
 o.before_limit:=a.credit_limit;o.after_limit:=after_limit;o.credit_used:=a.credit_used;
 o.before_prepaid:=a.is_prepaid;o.after_prepaid:=after_prepaid;o.before_revision:=a.credit_control_revision;
 o.after_revision:=after_agent.credit_control_revision;o.applied_reduction:=applied;
 IF applied>0 THEN o.assignment_id:=assignment.id;o.document_id:=gen_random_uuid();o.invoice_id:=gen_random_uuid();END IF;
 o.recorded_at:=clock_timestamp();
 INSERT INTO public.accounting_credit_reduction_operations_v1 SELECT o.*;
 SELECT * INTO retained FROM public.accounting_credit_reduction_operations_v1 WHERE id=o.id;
 IF NOT FOUND OR to_jsonb(retained) IS DISTINCT FROM to_jsonb(o) THEN
  RAISE EXCEPTION 'credit_reduction_operation_write_unconfirmed' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_credit_reduction_retirements_v1
  WHERE actor_user_id=p_expected_actor_id AND operation_id=p_operation_id) THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 -- Document/notice construction can execute additional triggers. Their late
 -- effects are included in the fresh exact agent/audit postcondition.
 IF NOT EXISTS(SELECT 1 FROM public.agents x WHERE x.id=a.id AND to_jsonb(x)=to_jsonb(after_agent)) THEN
  RAISE EXCEPTION 'credit_reduction_agent_retained_mismatch' USING ERRCODE='23514';END IF;
 IF applied>0 AND NOT EXISTS(SELECT 1 FROM public.credit_assignments x WHERE x.id=assignment.id AND to_jsonb(x)=to_jsonb(assignment)) THEN
  RAISE EXCEPTION 'credit_reduction_assignment_retained_mismatch' USING ERRCODE='23514';END IF;
 PERFORM public.fn_accounting_credit_reduction_assert_document(o.id);
 -- The retained locks prevent concurrent authority changes; this readback
 -- also refuses an authority change made by a nested trigger in this call.
 PERFORM public.fn_credit_reduction_lock_current_manager_v1(p_expected_actor_id,p_club_id);
 RETURN jsonb_build_object('contract_version',1,'state','recorded','actor_user_id',p_expected_actor_id,
  'operation_id',p_operation_id,'club_id',p_club_id,'replayed',false,
  'receipt',public.fn_credit_reduction_receipt_payload_v1(o.id),'retirement',NULL);
END $function$;

CREATE FUNCTION public.fn_agent_credit_reduction_receipt_v1(p_expected_actor_id uuid,p_operation_id uuid,p_club_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
 PERFORM public.fn_credit_reduction_lock_v1(p_expected_actor_id,p_operation_id,p_club_id);
 RETURN public.fn_credit_reduction_observe_v1(p_expected_actor_id,p_operation_id,p_club_id);
END $function$;

CREATE FUNCTION public.fn_retire_agent_credit_reduction_v1(p_expected_actor_id uuid,p_operation_id uuid,p_club_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE prior jsonb;r public.accounting_credit_reduction_retirements_v1%ROWTYPE;
 surviving public.accounting_credit_reduction_retirements_v1%ROWTYPE;
BEGIN
 PERFORM public.fn_credit_reduction_lock_v1(p_expected_actor_id,p_operation_id,p_club_id);
 prior:=public.fn_credit_reduction_observe_v1(p_expected_actor_id,p_operation_id,p_club_id);
 IF prior->>'state' IN('recorded','retired') THEN RETURN prior;END IF;
 IF prior->>'state' IS DISTINCT FROM 'absent' THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 r.id:=gen_random_uuid();r.contract_version:=1;r.actor_user_id:=p_expected_actor_id;
 r.operation_id:=p_operation_id;r.club_id:=p_club_id;r.retired_at:=clock_timestamp();
 INSERT INTO public.accounting_credit_reduction_retirements_v1 SELECT r.*;
 SELECT * INTO surviving FROM public.accounting_credit_reduction_retirements_v1 WHERE id=r.id;
 IF NOT FOUND OR to_jsonb(surviving) IS DISTINCT FROM to_jsonb(r) THEN
  RAISE EXCEPTION 'credit_reduction_retirement_write_unconfirmed' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_credit_reduction_operations_v1
  WHERE actor_user_id=p_expected_actor_id AND operation_id=p_operation_id) THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 RETURN prior||jsonb_build_object('state','retired','replayed',false,'retirement',public.fn_credit_reduction_retirement_payload_v1(r.id));
END $function$;

ALTER FUNCTION public.fn_credit_reduction_lock_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_credit_reduction_lock_current_manager_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_credit_reduction_receipt_payload_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_credit_reduction_retirement_payload_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_credit_reduction_observe_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_agent_credit_reduction_snapshot_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text) OWNER TO postgres;
ALTER FUNCTION public.fn_agent_credit_reduction_receipt_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_credit_reduction_lock_v1(uuid,uuid,uuid),
 public.fn_credit_reduction_lock_current_manager_v1(uuid,uuid),
 public.fn_credit_reduction_receipt_payload_v1(uuid),public.fn_credit_reduction_retirement_payload_v1(uuid),
 public.fn_credit_reduction_observe_v1(uuid,uuid,uuid),
 public.fn_agent_credit_reduction_snapshot_v1(uuid,uuid,uuid),
 public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text),
 public.fn_agent_credit_reduction_receipt_v1(uuid,uuid,uuid),public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_credit_reduction_snapshot_v1(uuid,uuid,uuid),
 public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text),
 public.fn_agent_credit_reduction_receipt_v1(uuid,uuid,uuid),public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)
 TO authenticated;

-- Fragment postcondition-guards.sql
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

-- Fragment document-postconditions.sql
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

COMMIT;
