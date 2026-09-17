-- SOURCE ONLY / UNRUN. Additive component33 after the sealed 32-component authority.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
LOCK TABLE public.cashout_requests,public.chip_escrow IN ACCESS EXCLUSIVE MODE;
DO $preimage$ DECLARE actual jsonb; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cashout_approve(uuid,text,uuid)') AND md5(pg_get_functiondef(oid))='702ceb8322f4018595cacb5b140bc29e' AND proowner='postgres'::regrole AND prosecdef) THEN RAISE EXCEPTION 'cashier_writer_preimage_changed' USING DETAIL='fn_cashout_approve(uuid,text,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cashout_release(uuid,text,uuid)') AND md5(pg_get_functiondef(oid))='b916271ddbb494851520e5ac237fc37b' AND proowner='postgres'::regrole AND prosecdef) THEN RAISE EXCEPTION 'cashier_writer_preimage_changed' USING DETAIL='fn_cashout_release(uuid,text,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cashout_request(uuid,numeric,text,uuid)') AND md5(pg_get_functiondef(oid))='b6e9e3bbf4d87df47d5d984f0893f127' AND proowner='postgres'::regrole AND prosecdef) THEN RAISE EXCEPTION 'cashier_writer_preimage_changed' USING DETAIL='fn_cashout_request(uuid,numeric,text,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ensure_agent_row(uuid,uuid,text)') AND md5(pg_get_functiondef(oid))='3bd1e0aeed55ae8e56c9e28e8967ae2b' AND proowner='postgres'::regrole AND prosecdef=true) THEN RAISE EXCEPTION 'cashier_dependency_preimage_changed: fn_ensure_agent_row(uuid,uuid,text)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_expire_stale_cashouts(integer)') AND md5(pg_get_functiondef(oid))='431fdd4e1570acf76f6c5199982be1c3' AND proowner='postgres'::regrole AND prosecdef=true) THEN RAISE EXCEPTION 'cashier_dependency_preimage_changed: fn_expire_stale_cashouts(integer)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_guard_retired_club_mutation()') AND md5(pg_get_functiondef(oid))='b82be212e7ccf2a15637c231861ff993' AND proowner='postgres'::regrole AND prosecdef=true) THEN RAISE EXCEPTION 'cashier_dependency_preimage_changed: fn_guard_retired_club_mutation()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_notify_agent_on_cashout()') AND md5(pg_get_functiondef(oid))='03ad337a54df0e06df003f03fc3f8331' AND proowner='postgres'::regrole AND prosecdef=false) THEN RAISE EXCEPTION 'cashier_dependency_preimage_changed: fn_notify_agent_on_cashout()';END IF;
 IF to_regclass('public.accounting_cashier_events') IS NOT NULL THEN RAISE EXCEPTION 'cashier_event_authority_preexists';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.chip_escrow'::regclass AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity AND NOT relforcerowsecurity) THEN RAISE EXCEPTION 'cashier_escrow_table_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'default',pg_get_expr(d.adbin,d.adrelid),'not_null',a.attnotnull,'identity',a.attidentity::text,'generated',a.attgenerated::text,'acl',a.attacl) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.chip_escrow'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $columns$[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"generated":""},{"acl":null,"name":"cashout_request_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"player_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"amount","type":"numeric(15,2)","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"locked_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":false,"generated":""},{"acl":null,"name":"released_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"release_type","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"club_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"table_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""}]$columns$::jsonb THEN RAISE EXCEPTION 'cashier_escrow_columns_changed';END IF;
 IF (SELECT array_agg(v::text ORDER BY v::text) FROM pg_class c,LATERAL unnest(c.relacl) v WHERE c.oid='public.chip_escrow'::regclass) IS DISTINCT FROM ARRAY['anon=rxt/postgres','authenticated=rxt/postgres','postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::text[] THEN RAISE EXCEPTION 'cashier_escrow_acl_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.cashout_requests'::regclass AND tgname='tr_notify_agent_on_cashout' AND tgenabled='O' AND pg_get_triggerdef(oid,true)='CREATE TRIGGER tr_notify_agent_on_cashout AFTER INSERT ON cashout_requests FOR EACH ROW WHEN (new.status = ''pending''::text) EXECUTE FUNCTION fn_notify_agent_on_cashout()') THEN RAISE EXCEPTION 'cashier_legacy_notice_trigger_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_deliver_accounting_invoice(uuid)') AND md5(prosrc)='9ae8112135c4ce03b6ea4061f7e9d364' AND proowner='postgres'::regrole AND prosecdef) THEN RAISE EXCEPTION 'cashier_requires_exact_preceding_authority: fn_deliver_accounting_invoice';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_messenger_invoice_visible_to(uuid,uuid)') AND md5(prosrc)='9b5448b6368a874b8dab206c686806a4' AND proowner='postgres'::regrole AND prosecdef) THEN RAISE EXCEPTION 'cashier_requires_exact_preceding_authority: fn_messenger_invoice_visible_to';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)') AND md5(prosrc)='4bf8638250b0a342b9c68ee4c33a2cae' AND proowner='postgres'::regrole AND prosecdef) THEN RAISE EXCEPTION 'cashier_private_reader_preimage_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_accounting_document_immutable()'::regprocedure AND md5(prosrc)='3715289673df3dd65078b6161710b207' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'cashier_dependency_preimage_changed' USING DETAIL='fn_accounting_document_immutable';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_mirror_notification_to_push_outbox()'::regprocedure AND md5(prosrc)='3e9d6c7c54182a8e5236b9b347bc54e3' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'cashier_dependency_preimage_changed' USING DETAIL='fn_mirror_notification_to_push_outbox';END IF;
 IF current_user<>'postgres' OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['fn_cashier_reconciliation_inventory','fn_cashier_lock_authority','fn_cashier_event_append_only','fn_cashier_event_payload','fn_cashier_document_body','fn_cashier_invoice_contract','fn_cashier_assert_delivery','fn_cashier_operation_receipt','fn_cashier_cashout_transition','fn_cashout_request_v2','fn_cashout_approve_v2','fn_cashout_release_v2','fn_cashout_operation_receipt_v2'])) THEN RAISE EXCEPTION 'cashier_new_authority_preexists_or_wrong_owner';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_cashout_approve(uuid,text,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_function_acl_changed' USING DETAIL='public.fn_cashout_approve(uuid,text,uuid)';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_cashout_release(uuid,text,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_function_acl_changed' USING DETAIL='public.fn_cashout_release(uuid,text,uuid)';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_cashout_request(uuid,numeric,text,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_function_acl_changed' USING DETAIL='public.fn_cashout_request(uuid,numeric,text,uuid)';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_ensure_agent_row(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_function_acl_changed' USING DETAIL='public.fn_ensure_agent_row(uuid,uuid,text)';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_expire_stale_cashouts(integer)'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_function_acl_changed' USING DETAIL='public.fn_expire_stale_cashouts(integer)';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_guard_retired_club_mutation()'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_function_acl_changed' USING DETAIL='public.fn_guard_retired_club_mutation()';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_notify_agent_on_cashout()'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_function_acl_changed' USING DETAIL='public.fn_notify_agent_on_cashout()';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',conname,'type',contype::text,'validated',convalidated,'deferrable',condeferrable,'initially_deferred',condeferred,'definition',pg_get_constraintdef(oid,true)) ORDER BY conname) INTO actual FROM pg_constraint WHERE conrelid='public.chip_escrow'::regclass;
 IF actual IS DISTINCT FROM $esc_constraints$[{"name":"chip_escrow_cashout_request_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (cashout_request_id) REFERENCES cashout_requests(id) ON DELETE CASCADE","initially_deferred":false},{"name":"chip_escrow_cashout_request_id_key","type":"u","validated":true,"deferrable":false,"definition":"UNIQUE (cashout_request_id)","initially_deferred":false},{"name":"chip_escrow_pkey","type":"p","validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)","initially_deferred":false},{"name":"chip_escrow_player_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (player_id) REFERENCES auth.users(id)","initially_deferred":false},{"name":"chip_escrow_release_type_check","type":"c","validated":true,"deferrable":false,"definition":"CHECK (release_type = ANY (ARRAY['completed'::text, 'cancelled'::text, 'rejected'::text, 'expired'::text]))","initially_deferred":false},{"name":"fk_chip_escrow_player_id_profiles","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (player_id) REFERENCES profiles(id) ON DELETE CASCADE","initially_deferred":false}]$esc_constraints$::jsonb THEN RAISE EXCEPTION 'cashier_escrow_constraints_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',c.relname,'ready',i.indisready,'valid',i.indisvalid,'definition',pg_get_indexdef(i.indexrelid)) ORDER BY c.relname) INTO actual FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='public.chip_escrow'::regclass;
 IF actual IS DISTINCT FROM $esc_indexes$[{"name":"chip_escrow_cashout_request_id_key","ready":true,"valid":true,"definition":"CREATE UNIQUE INDEX chip_escrow_cashout_request_id_key ON public.chip_escrow USING btree (cashout_request_id)"},{"name":"chip_escrow_pkey","ready":true,"valid":true,"definition":"CREATE UNIQUE INDEX chip_escrow_pkey ON public.chip_escrow USING btree (id)"}]$esc_indexes$::jsonb THEN RAISE EXCEPTION 'cashier_escrow_indexes_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd::text,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE r::regrole::text END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE r::regrole::text END) FROM unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) INTO actual FROM pg_policy p WHERE p.polrelid='public.chip_escrow'::regclass;
 IF actual IS DISTINCT FROM $esc_policies$[{"name":"chip_escrow_service_only","check":"true","roles":["service_role"],"using":"true","command":"*","permissive":true},{"name":"escrow_read","check":null,"roles":["PUBLIC"],"using":"(player_id = ( SELECT auth.uid() AS uid))","command":"r","permissive":true},{"name":"escrow_read_scoped","check":null,"roles":["authenticated"],"using":"((player_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1\n   FROM cashout_requests cr\n  WHERE ((cr.id = chip_escrow.cashout_request_id) AND ((cr.agent_id = ( SELECT auth.uid() AS uid)) OR (fn_club_bank_role(cr.club_id) = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text])))))))","command":"r","permissive":true}]$esc_policies$::jsonb THEN RAISE EXCEPTION 'cashier_escrow_policies_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_invoice_type_check' AND convalidated AND pg_get_constraintdef(oid)='CHECK ((invoice_type = ANY (ARRAY[''union_to_club''::text, ''club_to_agent''::text, ''agent_to_subagent''::text, ''agent_to_player''::text, ''union_club_pnl''::text, ''club_to_union''::text, ''union_weekly_squareup''::text, ''union_weekly_credit_note''::text, ''transaction_receipt''::text, ''club_weekly_accounting''::text])))') THEN RAISE EXCEPTION 'cashier_invoice_vocabulary_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_accounting_push_after_delivery' AND tgenabled='O' AND pg_get_triggerdef(oid,true)='CREATE CONSTRAINT TRIGGER trg_accounting_push_after_delivery AFTER INSERT ON notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.type = ''accounting_invoice''::text) EXECUTE FUNCTION fn_mirror_notification_to_push_outbox()') THEN RAISE EXCEPTION 'cashier_required_trigger_changed' USING DETAIL='trg_accounting_push_after_delivery';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.settlement_invoices'::regclass AND tgname='accounting_invoice_immutable' AND tgenabled='O' AND pg_get_triggerdef(oid,true)='CREATE TRIGGER accounting_invoice_immutable BEFORE DELETE OR UPDATE ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_document_immutable()') THEN RAISE EXCEPTION 'cashier_required_trigger_changed' USING DETAIL='accounting_invoice_immutable';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='accounting_message_immutable' AND tgenabled='O' AND pg_get_triggerdef(oid,true)='CREATE TRIGGER accounting_message_immutable BEFORE DELETE OR UPDATE ON social_messages FOR EACH ROW EXECUTE FUNCTION fn_accounting_document_immutable()') THEN RAISE EXCEPTION 'cashier_required_trigger_changed' USING DETAIL='accounting_message_immutable';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_club_bank_role(uuid,uuid)'::regprocedure AND md5(prosrc)='d5a0014edd6ebab23dbb5620ff600117' AND proowner='postgres'::regrole AND prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'cashier_role_authority_changed' USING DETAIL='fn_club_bank_role(uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_club_cashier_can_transact(uuid,uuid,uuid)'::regprocedure AND md5(prosrc)='a0cc4f8ffcd889e40a27053c60630f74' AND proowner='postgres'::regrole AND prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'cashier_role_authority_changed' USING DETAIL='fn_club_cashier_can_transact(uuid,uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_club_cashier_scope(uuid,uuid)'::regprocedure AND md5(prosrc)='e0ba5f6bc7944af287409602a9c233a3' AND proowner='postgres'::regrole AND prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'cashier_role_authority_changed' USING DETAIL='fn_club_cashier_scope(uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_club_is_in_downline(uuid,uuid,uuid)'::regprocedure AND md5(prosrc)='151d7a5a130abe88d53e500a50232322' AND proowner='postgres'::regrole AND prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'cashier_role_authority_changed' USING DETAIL='fn_club_is_in_downline(uuid,uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_club_is_in_downline(uuid,uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='7ef407fa51a823f823a6167e40488e7a') OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_club_is_in_downline(uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_role_authority_attributes_changed' USING DETAIL='fn_club_is_in_downline(uuid,uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_club_bank_role(uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='b36e67efcfaba2f867d62140322a8ed8') OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_club_bank_role(uuid,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_role_authority_attributes_changed' USING DETAIL='fn_club_bank_role(uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_club_cashier_can_transact(uuid,uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='a812c44870554f37cddb36edf600e386') OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_club_cashier_can_transact(uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_role_authority_attributes_changed' USING DETAIL='fn_club_cashier_can_transact(uuid,uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_club_cashier_scope(uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='166dddd19d1419cc8b17861003e0239a') OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_club_cashier_scope(uuid,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_role_authority_attributes_changed' USING DETAIL='fn_club_cashier_scope(uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_approve_cashout_atomic(uuid,uuid,text)') AND md5(pg_get_functiondef(oid))='77e196f9137f0308c74307c2530dc5fc' AND proowner='postgres'::regrole AND NOT prosecdef AND proconfig=ARRAY['search_path=public, extensions']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_approve_cashout_atomic(uuid,uuid,text)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_legacy_route_preimage_changed' USING DETAIL='public.fn_approve_cashout_atomic(uuid,uuid,text)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cancel_cashout_atomic(uuid,uuid,boolean,text)') AND md5(pg_get_functiondef(oid))='6f8eed50bf0e635ea9f474e5249c9eef' AND proowner='postgres'::regrole AND NOT prosecdef AND proconfig=ARRAY['search_path=public, extensions']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_cancel_cashout_atomic(uuid,uuid,boolean,text)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_legacy_route_preimage_changed' USING DETAIL='public.fn_cancel_cashout_atomic(uuid,uuid,boolean,text)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cancel_cashout(uuid,uuid)') AND md5(pg_get_functiondef(oid))='2d2d3ec5aecd36fdc2031f8275289de5' AND proowner='postgres'::regrole AND NOT prosecdef AND proconfig=ARRAY['search_path=public, extensions']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_cancel_cashout(uuid,uuid)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_legacy_route_preimage_changed' USING DETAIL='public.fn_cancel_cashout(uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_request_cashout(uuid,uuid,numeric,text,uuid,text)') AND md5(pg_get_functiondef(oid))='d255f5189a85420a6d8a89656bd88d09' AND proowner='postgres'::regrole AND NOT prosecdef AND proconfig=ARRAY['search_path=public, extensions']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_request_cashout(uuid,uuid,numeric,text,uuid,text)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_legacy_route_preimage_changed' USING DETAIL='public.fn_request_cashout(uuid,uuid,numeric,text,uuid,text)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_deliver_accounting_invoice(uuid)'::regprocedure AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_deliver_accounting_invoice(uuid)'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_existing_authority_access_changed' USING DETAIL='fn_deliver_accounting_invoice(uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_accounting_document_immutable()'::regprocedure AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_accounting_document_immutable()'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_existing_authority_access_changed' USING DETAIL='fn_accounting_document_immutable()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_mirror_notification_to_push_outbox()'::regprocedure AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_mirror_notification_to_push_outbox()'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_existing_authority_access_changed' USING DETAIL='fn_mirror_notification_to_push_outbox()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)'::regprocedure AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_existing_authority_access_changed' USING DETAIL='fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_messenger_invoice_visible_to(uuid,uuid)'::regprocedure AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_messenger_invoice_visible_to(uuid,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'cashier_existing_authority_access_changed' USING DETAIL='fn_messenger_invoice_visible_to(uuid,uuid)';END IF;
END $preimage$;
ALTER TABLE public.settlement_invoices DROP CONSTRAINT settlement_invoices_invoice_type_check;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT settlement_invoices_invoice_type_check CHECK ((invoice_type = ANY (ARRAY['union_to_club'::text, 'club_to_agent'::text, 'agent_to_subagent'::text, 'agent_to_player'::text, 'union_club_pnl'::text, 'club_to_union'::text, 'union_weekly_squareup'::text, 'union_weekly_credit_note'::text, 'transaction_receipt'::text, 'club_weekly_accounting'::text, 'cashier_cashout'::text])));
DROP TRIGGER tr_notify_agent_on_cashout ON public.cashout_requests;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON public.cashout_requests,public.chip_escrow FROM PUBLIC,anon,authenticated,service_role;

-- Document provenance for the existing physical journal, never another ledger.
CREATE TABLE public.accounting_cashier_events (
 id uuid PRIMARY KEY, contract_version smallint NOT NULL CHECK(contract_version=1),
 cashout_id uuid NOT NULL REFERENCES public.cashout_requests(id),
 escrow_id uuid NOT NULL REFERENCES public.chip_escrow(id),
 source_transaction_id uuid NOT NULL UNIQUE REFERENCES public.chip_transactions(id),
 source_ledger_id uuid NOT NULL UNIQUE REFERENCES public.chip_ledger(id),
 invoice_id uuid NOT NULL UNIQUE REFERENCES public.settlement_invoices(id) DEFERRABLE INITIALLY DEFERRED,
 event_slot text NOT NULL CHECK(event_slot IN('hold','terminal')),
 event_kind text NOT NULL CHECK(event_kind IN('hold','approval','cancellation','decline','expiry_refund')),
 hold_event_id uuid REFERENCES public.accounting_cashier_events(id),
 hold_invoice_id uuid REFERENCES public.settlement_invoices(id),
 club_id uuid NOT NULL,player_id uuid NOT NULL,assigned_agent_id uuid NOT NULL,
 actor_user_id uuid,actor_role text NOT NULL CHECK(actor_role IN('owner','co_owner','admin','super_agent','agent','sub_agent','player','member','system')),ledger_actor_user_id uuid NOT NULL,
 issuer_representative_id uuid NOT NULL,issuer_name text NOT NULL,player_name text NOT NULL,
 audience_user_ids uuid[] NOT NULL,op_id uuid NOT NULL,operation_fingerprint jsonb NOT NULL,
 accepted_note text,transaction_note text NOT NULL,
 amount numeric(15,2) NOT NULL CHECK(amount>0 AND amount::text NOT IN('NaN','Infinity','-Infinity')),
 ledger_from_type text NOT NULL,ledger_from_entity_id uuid NOT NULL,
 ledger_to_type text NOT NULL,ledger_to_entity_id uuid NOT NULL,
 wallet_owner_id uuid NOT NULL,wallet_before numeric NOT NULL,wallet_after numeric NOT NULL,
 occurred_at timestamptz NOT NULL,issued_at timestamptz NOT NULL,
 UNIQUE(cashout_id,event_slot),UNIQUE NULLS NOT DISTINCT(actor_user_id,op_id),
 CHECK((event_kind='hold' AND event_slot='hold' AND hold_event_id IS NULL AND hold_invoice_id IS NULL)
    OR (event_kind<>'hold' AND event_slot='terminal' AND hold_event_id IS NOT NULL AND hold_invoice_id IS NOT NULL)),
 CHECK((event_kind='expiry_refund' AND actor_user_id IS NULL AND actor_role='system')
    OR (event_kind<>'expiry_refund' AND actor_user_id IS NOT NULL AND actor_role<>'system')),
 CHECK(issued_at>=occurred_at AND cardinality(audience_user_ids)>=2)
);
ALTER TABLE public.accounting_cashier_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_cashier_events FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_cashier_event_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $function$
BEGIN RAISE EXCEPTION 'cashier_event_is_immutable' USING ERRCODE='23514';END $function$;
REVOKE ALL ON FUNCTION public.fn_cashier_event_append_only() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER cashier_event_append_only BEFORE UPDATE OR DELETE ON public.accounting_cashier_events
 FOR EACH ROW EXECUTE FUNCTION public.fn_cashier_event_append_only();

CREATE FUNCTION public.fn_cashier_event_payload(e public.accounting_cashier_events) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
 SELECT jsonb_build_object('contract_version',1,'event_id',e.id,'invoice_id',e.invoice_id,
  'cashout_id',e.cashout_id,'escrow_id',e.escrow_id,'source_transaction_id',e.source_transaction_id,
  'source_ledger_id',e.source_ledger_id,'club_id',e.club_id,'player_id',e.player_id,
  'assigned_agent_id',e.assigned_agent_id,'issuer_representative_id',e.issuer_representative_id,
  'actor_user_id',e.actor_user_id,'actor_role',e.actor_role,'event_kind',e.event_kind,
  'display_state',CASE e.event_kind WHEN 'hold' THEN 'held' WHEN 'approval' THEN 'approved' ELSE 'refunded' END,
  'amount',round(e.amount,2)::text,'occurred_at',e.occurred_at,'issued_at',e.issued_at,
  'hold_event_id',e.hold_event_id,'hold_invoice_id',e.hold_invoice_id,
  'ledger_from_type',e.ledger_from_type,'ledger_from_entity_id',e.ledger_from_entity_id,
  'ledger_to_type',e.ledger_to_type,'ledger_to_entity_id',e.ledger_to_entity_id,
  'custody_movement_recorded',true,'cashout_completed',e.event_kind='approval',
  'refund_recorded',e.event_kind IN('cancellation','decline','expiry_refund'));
$function$;
REVOKE ALL ON FUNCTION public.fn_cashier_event_payload(public.accounting_cashier_events) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_cashier_document_body(p_event_id uuid,p_invoice_number text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE e public.accounting_cashier_events%ROWTYPE; title text;
BEGIN
 SELECT * INTO STRICT e FROM public.accounting_cashier_events WHERE id=p_event_id;
 title:=CASE e.event_kind WHEN 'hold' THEN 'Chips Held' WHEN 'approval' THEN 'Cashout Approved' ELSE 'Chips Returned' END;
 RETURN title||' · Invoice '||p_invoice_number||E'\nIssued By: '||e.issuer_name||E'\nFor: '||e.player_name
  ||E'\nAmount: '||round(e.amount,2)::text||' Chips'
  ||E'\n'||CASE e.event_kind WHEN 'hold' THEN 'Chips moved from the player wallet into escrow. The cashout is not complete.'
    WHEN 'approval' THEN 'Escrowed chips transferred to the approving cashier wallet. This records chips, not external cash settlement.'
    WHEN 'cancellation' THEN 'The player cancelled the cashout. Escrowed chips returned to the player wallet.'
    WHEN 'decline' THEN 'The cashier declined the cashout. Escrowed chips returned to the player wallet.'
    ELSE 'The cashout expired. Escrowed chips returned to the player wallet.' END
  ||E'\nRecorded: '||e.occurred_at::text||E'\nIssued: '||e.issued_at::text;
END $function$;
REVOKE ALL ON FUNCTION public.fn_cashier_document_body(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Canonical projection used inside the existing private Messenger reader.
-- It never promotes a social message's copied metadata into financial proof.
CREATE FUNCTION public.fn_cashier_invoice_contract(p_invoice_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE e public.accounting_cashier_events%ROWTYPE; i public.settlement_invoices%ROWTYPE;
 l public.chip_ledger%ROWTYPE;t public.chip_transactions%ROWTYPE;h public.accounting_cashier_events%ROWTYPE;
 payload jsonb;expected_type text;
BEGIN
 SELECT * INTO e FROM public.accounting_cashier_events WHERE invoice_id=p_invoice_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'cashier_document_event_missing' USING ERRCODE='23514';END IF;
 SELECT * INTO i FROM public.settlement_invoices WHERE id=p_invoice_id;
 SELECT * INTO l FROM public.chip_ledger WHERE id=e.source_ledger_id;
 SELECT * INTO t FROM public.chip_transactions WHERE id=e.source_transaction_id;
 payload:=public.fn_cashier_event_payload(e);
 expected_type:=CASE e.event_kind WHEN 'hold' THEN 'cashout_request_escrow' WHEN 'approval' THEN 'cashout_approved'
  WHEN 'cancellation' THEN 'cashout_cancelled' WHEN 'decline' THEN 'cashout_denied' ELSE 'cashout_expired_refund' END;
 IF i.id IS NULL OR i.invoice_type<>'cashier_cashout' OR i.club_id IS DISTINCT FROM e.club_id
  OR i.from_entity_type<>'club' OR i.from_entity_id IS DISTINCT FROM e.club_id::text
  OR i.to_entity_type<>'player' OR i.to_entity_id IS DISTINCT FROM e.player_id::text
  OR i.source_ledger_id IS DISTINCT FROM e.source_ledger_id OR i.gross_amount IS DISTINCT FROM e.amount
  OR i.net_amount IS DISTINCT FROM e.amount OR i.deductions IS DISTINCT FROM 0
  OR i.status IS DISTINCT FROM (CASE WHEN e.event_kind='hold' THEN 'generated' ELSE 'paid' END)
  OR i.chips_transferred IS DISTINCT FROM (e.event_kind<>'hold')
  OR i.transferred_at IS DISTINCT FROM (CASE WHEN e.event_kind='hold' THEN NULL::timestamptz ELSE e.occurred_at END)
  OR i.created_at IS DISTINCT FROM e.issued_at OR i.breakdown->'cashier' IS DISTINCT FROM payload
  OR l.id IS NULL OR l.status<>'posted' OR l.amount IS DISTINCT FROM e.amount OR l.club_id IS DISTINCT FROM e.club_id
  OR l.from_type IS DISTINCT FROM e.ledger_from_type OR l.from_entity_id IS DISTINCT FROM e.ledger_from_entity_id
  OR l.to_type IS DISTINCT FROM e.ledger_to_type OR l.to_entity_id IS DISTINCT FROM e.ledger_to_entity_id
  OR l.category IS DISTINCT FROM (CASE WHEN e.event_kind='hold' THEN 'escrow_hold' ELSE 'escrow_release' END)
  OR l.idempotency_key IS DISTINCT FROM 'cashout:'||e.cashout_id::text||(CASE WHEN e.event_kind='hold' THEN ':hold' ELSE ':release' END)
  OR l.table_id IS NOT NULL OR l.hand_id IS NOT NULL OR l.tournament_id IS NOT NULL OR l.settlement_id IS NOT NULL
  OR l.performed_by IS DISTINCT FROM e.ledger_actor_user_id OR l.created_at IS DISTINCT FROM e.occurred_at
  OR t.id IS NULL OR t.club_id IS DISTINCT FROM e.club_id OR t.amount IS DISTINCT FROM e.amount
  OR t.related_cashout_id IS DISTINCT FROM e.cashout_id OR t.transaction_type IS DISTINCT FROM expected_type
  OR t.metadata->>'op_id' IS DISTINCT FROM e.op_id::text OR t.metadata->>'cashier_document_version' IS DISTINCT FROM '1'
  OR t.metadata->>'event_id' IS DISTINCT FROM e.id::text
  OR t.metadata->>'actor_user_id' IS DISTINCT FROM e.actor_user_id::text OR t.metadata->>'actor_role' IS DISTINCT FROM e.actor_role
  OR t.metadata->>'assigned_agent_id' IS DISTINCT FROM e.assigned_agent_id::text OR t.table_id IS NOT NULL OR t.notes IS DISTINCT FROM e.transaction_note
  OR t.balance_after IS DISTINCT FROM e.wallet_after OR t.created_at IS DISTINCT FROM e.occurred_at
  OR e.wallet_before IS NULL OR e.wallet_after IS NULL
  OR e.wallet_before::text IN('NaN','Infinity','-Infinity') OR e.wallet_after::text IN('NaN','Infinity','-Infinity')
  OR e.wallet_after-e.wallet_before IS DISTINCT FROM (CASE WHEN e.event_kind='hold' THEN -e.amount ELSE e.amount END)
  OR NOT EXISTS(SELECT 1 FROM public.chip_ledger_idem k WHERE k.idempotency_key=l.idempotency_key AND k.leg_id=l.id)
 THEN RAISE EXCEPTION 'cashier_document_provenance_mismatch' USING ERRCODE='23514';END IF;
 IF e.event_kind IN('hold','cancellation') AND e.actor_user_id IS DISTINCT FROM e.player_id
  OR e.event_kind IN('approval','decline') AND (e.actor_user_id=e.player_id OR e.actor_role NOT IN('owner','co_owner','admin','super_agent','agent','sub_agent'))
  OR e.assigned_agent_id=e.player_id
 THEN RAISE EXCEPTION 'cashier_actor_provenance_mismatch' USING ERRCODE='23514';END IF;
 IF e.event_kind='hold' THEN
  IF e.actor_user_id IS DISTINCT FROM e.player_id OR e.ledger_from_type<>'player_wallet' OR e.ledger_from_entity_id<>e.player_id
   OR e.ledger_to_type<>'escrow' OR e.ledger_to_entity_id<>e.escrow_id OR e.wallet_owner_id<>e.player_id
   OR t.from_user_id IS DISTINCT FROM e.player_id OR t.to_user_id IS DISTINCT FROM e.assigned_agent_id
  THEN RAISE EXCEPTION 'cashier_hold_route_mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO h FROM public.accounting_cashier_events WHERE id=e.hold_event_id;
  IF h.event_kind IS DISTINCT FROM 'hold' OR h.cashout_id IS DISTINCT FROM e.cashout_id
   OR h.escrow_id IS DISTINCT FROM e.escrow_id OR h.invoice_id IS DISTINCT FROM e.hold_invoice_id
   OR h.amount IS DISTINCT FROM e.amount OR h.club_id IS DISTINCT FROM e.club_id OR h.player_id IS DISTINCT FROM e.player_id
   OR h.assigned_agent_id IS DISTINCT FROM e.assigned_agent_id
   OR e.ledger_from_type<>'escrow' OR e.ledger_from_entity_id<>e.escrow_id
   OR e.ledger_to_type IS DISTINCT FROM (CASE WHEN e.event_kind='approval' THEN 'agent_wallet' ELSE 'player_wallet' END)
   OR e.ledger_to_entity_id IS DISTINCT FROM (CASE WHEN e.event_kind='approval' THEN e.actor_user_id ELSE e.player_id END)
   OR e.wallet_owner_id IS DISTINCT FROM e.ledger_to_entity_id
   OR t.from_user_id IS DISTINCT FROM (CASE WHEN e.event_kind='approval' THEN e.player_id ELSE e.actor_user_id END)
   OR t.to_user_id IS DISTINCT FROM e.ledger_to_entity_id
  THEN RAISE EXCEPTION 'cashier_terminal_route_mismatch' USING ERRCODE='23514';END IF;
 END IF;
 RETURN payload;
END $function$;
REVOKE ALL ON FUNCTION public.fn_cashier_invoice_contract(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_cashier_assert_delivery(p_event_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $function$
DECLARE e public.accounting_cashier_events%ROWTYPE;i public.settlement_invoices%ROWTYPE;
 d record;payload jsonb;actual_users uuid[];expected_body text;
BEGIN
 SELECT * INTO STRICT e FROM public.accounting_cashier_events WHERE id=p_event_id;
 payload:=public.fn_cashier_invoice_contract(e.invoice_id);
 SELECT * INTO STRICT i FROM public.settlement_invoices WHERE id=e.invoice_id;
 expected_body:=public.fn_cashier_document_body(e.id,i.invoice_number);
 SELECT array_agg(recipient_id ORDER BY recipient_id) INTO actual_users FROM public.accounting_invoice_deliveries WHERE invoice_id=e.invoice_id;
 IF actual_users IS DISTINCT FROM e.audience_user_ids OR i.invoice_number IS NULL
  OR i.message_sent IS DISTINCT FROM true OR i.message_sent_at IS NULL
 THEN RAISE EXCEPTION 'cashier_document_delivery_missing' USING ERRCODE='23514';END IF;
 FOR d IN SELECT a.*,m.conversation_id,m.sender_id,m.content,m.message_type,m.media_metadata,
   n.user_id AS notice_user,n.type AS notice_type,n.data AS notice_data,n.metadata AS notice_metadata,
   n.title AS notice_title,n.message AS notice_message,n.action_url AS notice_url
  FROM public.accounting_invoice_deliveries a LEFT JOIN public.social_messages m ON m.id=a.message_id
  LEFT JOIN public.notifications n ON n.id=a.notification_id WHERE a.invoice_id=e.invoice_id LOOP
  IF d.delivery_mode IS DISTINCT FROM 'immediate' OR d.sender_id IS DISTINCT FROM e.issuer_representative_id
   OR d.message_type IS DISTINCT FROM 'invoice' OR d.content IS DISTINCT FROM expected_body
   OR d.media_metadata->>'invoice_id' IS DISTINCT FROM e.invoice_id::text
   OR d.media_metadata->'cashier' IS DISTINCT FROM payload
   OR d.notice_user IS DISTINCT FROM d.recipient_id OR d.notice_type IS DISTINCT FROM 'accounting_invoice'
   OR d.notice_data->>'invoice_id' IS DISTINCT FROM e.invoice_id::text OR d.notice_data->'cashier' IS DISTINCT FROM payload
   OR d.notice_metadata IS DISTINCT FROM d.media_metadata OR d.notice_data IS DISTINCT FROM d.media_metadata
   OR d.media_metadata->>'invoice_type' IS DISTINCT FROM 'cashier_cashout' OR d.media_metadata->'amount' IS DISTINCT FROM to_jsonb(i.net_amount)
   OR d.notice_title IS DISTINCT FROM (CASE e.event_kind WHEN 'hold' THEN 'Chips Held · ' WHEN 'approval' THEN 'Cashout Approved · ' ELSE 'Chips Returned · ' END||i.invoice_number)
   OR d.notice_message IS DISTINCT FROM (CASE e.event_kind WHEN 'hold' THEN 'Chips Held: ' WHEN 'approval' THEN 'Cashout Approved: ' ELSE 'Chips Returned: ' END||to_char(abs(i.net_amount),'FM999,999,999,999,990.00')||' Chips')
   OR d.notice_url IS DISTINCT FROM '/hub/messenger?conversation='||d.conversation_id::text
   OR NOT EXISTS(SELECT 1 FROM public.accounting_conversations c WHERE c.conversation_id=d.conversation_id
      AND c.scope_id=e.club_id AND c.issuer_type='club' AND c.issuer_id=e.club_id
      AND c.sender_id=e.issuer_representative_id AND c.recipient_id=d.recipient_id)
   OR EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id
      AND p.user_id<>ALL(ARRAY[e.issuer_representative_id,d.recipient_id]))
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id=d.recipient_id)
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id=e.issuer_representative_id)
  THEN RAISE EXCEPTION 'cashier_document_delivery_mismatch' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN payload;
END $function$;
REVOKE ALL ON FUNCTION public.fn_cashier_assert_delivery(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Same invoice delivery authority, with a frozen narrow cashier audience.
CREATE OR REPLACE FUNCTION public.fn_deliver_accounting_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_variable
DECLARE inv public.settlement_invoices%ROWTYPE; sender uuid; issuer_name text; recipient_name text;
 issuer_kind text; issuer_id uuid; recipient_id uuid; scope_id uuid; page_id uuid; users uuid[]; issuer_users uuid[]; recipient_users uuid[];
 person uuid; conv uuid; msg uuid; note uuid; body text; meta jsonb; count_sent int:=0; n int; line record; cashier public.accounting_cashier_events%ROWTYPE; cashier_payload jsonb;
BEGIN
 SELECT * INTO inv FROM public.settlement_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_invoice_missing' USING ERRCODE='23514'; END IF;
 IF inv.net_amount IS NULL OR inv.net_amount::text IN('NaN','Infinity','-Infinity') OR inv.net_amount<>round(inv.net_amount,2)
 THEN RAISE EXCEPTION 'invalid_invoice_amount' USING ERRCODE='23514'; END IF;
 issuer_kind:=inv.from_entity_type; issuer_id:=inv.from_entity_id::uuid; recipient_id:=inv.to_entity_id::uuid;
 scope_id:=COALESCE(inv.club_id,issuer_id);
 IF inv.invoice_type='cashier_cashout' THEN
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
 IF inv.invoice_type='cashier_cashout' THEN body:=public.fn_cashier_document_body(cashier.id,inv.invoice_number);END IF;
 meta:=jsonb_build_object('kind','accounting_invoice' ,'invoice_id',inv.id,'invoice_number',inv.invoice_number,
   'club_id',inv.club_id,'source_ledger_id',inv.source_ledger_id,'source_credit_invoice_id',inv.source_credit_invoice_id,
   'source_credit_payment_id',inv.source_credit_payment_id,'amount',inv.net_amount,'currency','CHIPS','conversationId',NULL,'status',inv.status,
   'invoice_type',inv.invoice_type,'from_entity_type',inv.from_entity_type,'from_entity_id',inv.from_entity_id,
   'to_entity_type',inv.to_entity_type,'to_entity_id',inv.to_entity_id,'lines',inv.breakdown-'source_ledger_ids');
 IF inv.invoice_type='cashier_cashout' THEN meta:=meta||jsonb_build_object('cashier',cashier_payload);END IF;
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
   IF inv.invoice_type='cashier_cashout' THEN meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);END IF;
   INSERT INTO public.social_messages(conversation_id,sender_id,content,message_type,media_metadata)
    VALUES(conv,sender,body,'invoice',meta) RETURNING id INTO msg;
   UPDATE public.social_conversations SET last_message_at=now(),last_message_preview=left(body,100),updated_at=now() WHERE id=conv;
   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);
   INSERT INTO public.notifications(user_id,type,title,message,data,read,action_url,metadata)
    VALUES(person,'accounting_invoice',CASE WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held · ' WHEN 'approval' THEN 'Cashout Approved · ' ELSE 'Chips Returned · ' END WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number,
     CASE WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held: ' WHEN 'approval' THEN 'Cashout Approved: ' ELSE 'Chips Returned: ' END WHEN inv.chips_transferred AND inv.breakdown->>'category'='rakeback' THEN 'Rakeback Transfer Recorded: ' WHEN inv.chips_transferred AND inv.breakdown->>'category'='commission' THEN 'Commission Transfer Recorded: ' WHEN inv.chips_transferred THEN 'Transfer Recorded: ' ELSE 'Invoice Issued: ' END||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips',
     meta,false,'/hub/messenger?conversation='||conv::text,meta) RETURNING id INTO note;
   INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) VALUES(inv.id,person,msg,note);
   count_sent:=count_sent+1;
 END LOOP;
 SELECT count(*) INTO n FROM public.accounting_invoice_deliveries WHERE invoice_id=inv.id;
 UPDATE public.settlement_invoices SET message_sent=true,message_sent_at=COALESCE(message_sent_at,now()) WHERE id=inv.id;
 RETURN jsonb_build_object('success',true,'invoice_id',inv.id,'delivered',n,'new_deliveries',count_sent);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_accounting_document_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE issued boolean;
BEGIN
 IF TG_TABLE_NAME='settlement_invoices' THEN
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

-- Deferred canonical outbox creation keeps dispatcher consent and quiet-hour gates.
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
   IF receipt.invoice_type='cashier_cashout' AND ROW(existing.title,existing.body,existing.url,existing.tag) IS DISTINCT FROM
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
  IF receipt.invoice_type='cashier_cashout' AND NOT EXISTS(SELECT 1 FROM public.push_outbox o
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

-- A receipt may describe an immutable hold while its current request is already
-- terminal. Only a matching terminal event can establish that later state.
CREATE FUNCTION public.fn_cashier_operation_receipt(p_event_id uuid,p_replayed boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE e public.accounting_cashier_events%ROWTYPE; terminal public.accounting_cashier_events%ROWTYPE;
 r public.cashout_requests%ROWTYPE;s public.chip_escrow%ROWTYPE;payload jsonb;expected_status text;expected_release text;
BEGIN
 SELECT * INTO STRICT e FROM public.accounting_cashier_events WHERE id=p_event_id;
 SELECT * INTO r FROM public.cashout_requests WHERE id=e.cashout_id FOR UPDATE;
 SELECT * INTO s FROM public.chip_escrow WHERE id=e.escrow_id FOR UPDATE;
 payload:=public.fn_cashier_assert_delivery(e.id);
 IF r.id IS NULL OR s.id IS NULL OR r.club_id IS DISTINCT FROM e.club_id OR r.player_id IS DISTINCT FROM e.player_id
   OR r.agent_id IS DISTINCT FROM e.assigned_agent_id OR r.amount IS DISTINCT FROM e.amount
   OR s.cashout_request_id IS DISTINCT FROM r.id OR s.player_id IS DISTINCT FROM e.player_id
   OR s.club_id IS DISTINCT FROM e.club_id OR s.amount IS DISTINCT FROM e.amount OR s.table_id IS NOT NULL
   OR r.created_at IS NULL OR r.updated_at IS NULL OR NOT isfinite(r.created_at) OR NOT isfinite(r.updated_at)
   OR s.locked_at IS DISTINCT FROM r.created_at
 THEN RAISE EXCEPTION 'cashier_request_receipt_mismatch' USING ERRCODE='23514';END IF;
 IF e.event_kind='hold' THEN
  IF r.created_at IS DISTINCT FROM e.occurred_at OR r.player_note IS DISTINCT FROM e.accepted_note
  THEN RAISE EXCEPTION 'cashier_hold_request_mismatch' USING ERRCODE='23514';END IF;
  IF r.status='pending' THEN
   IF s.released_at IS NOT NULL OR s.release_type IS NOT NULL OR r.acknowledged_at IS NOT NULL
      OR r.completed_at IS NOT NULL OR r.cancelled_at IS NOT NULL OR r.updated_at IS DISTINCT FROM e.occurred_at
      OR EXISTS(SELECT 1 FROM public.accounting_cashier_events x WHERE x.cashout_id=r.id AND x.event_slot='terminal')
   THEN RAISE EXCEPTION 'cashier_pending_request_mismatch' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO terminal FROM public.accounting_cashier_events WHERE cashout_id=r.id AND event_slot='terminal';
   IF NOT p_replayed OR terminal.id IS NULL OR terminal.hold_event_id IS DISTINCT FROM e.id
   THEN RAISE EXCEPTION 'cashier_terminal_receipt_missing' USING ERRCODE='23514';END IF;
   PERFORM public.fn_cashier_operation_receipt(terminal.id,true);
  END IF;
 ELSE
  expected_status:=CASE e.event_kind WHEN 'approval' THEN 'approved' WHEN 'cancellation' THEN 'cancelled'
    WHEN 'decline' THEN 'rejected' ELSE 'expired' END;
  expected_release:=CASE e.event_kind WHEN 'approval' THEN 'completed' ELSE expected_status END;
  IF r.status IS DISTINCT FROM expected_status OR s.release_type IS DISTINCT FROM expected_release
    OR s.released_at IS DISTINCT FROM e.occurred_at OR r.updated_at IS DISTINCT FROM e.occurred_at
    OR r.acknowledged_at IS DISTINCT FROM (CASE WHEN e.event_kind IN('approval','decline') THEN e.occurred_at ELSE NULL::timestamptz END)
    OR r.completed_at IS DISTINCT FROM (CASE WHEN e.event_kind='approval' THEN e.occurred_at ELSE NULL::timestamptz END)
    OR r.cancelled_at IS DISTINCT FROM (CASE WHEN e.event_kind IN('cancellation','decline','expiry_refund') THEN e.occurred_at ELSE NULL::timestamptz END)
    OR (e.event_kind IN('approval','decline') AND r.agent_note IS DISTINCT FROM e.accepted_note)
  THEN RAISE EXCEPTION 'cashier_terminal_request_mismatch' USING ERRCODE='23514';END IF;
  PERFORM public.fn_cashier_assert_delivery(e.hold_event_id);
 END IF;
 expected_status:=CASE e.event_kind WHEN 'hold' THEN 'pending' WHEN 'approval' THEN 'approved'
   WHEN 'cancellation' THEN 'cancelled' WHEN 'decline' THEN 'rejected' ELSE 'expired' END;
 RETURN payload||jsonb_build_object('success',true,'replayed',p_replayed,'op_id',e.op_id,
   'request_status',expected_status,'accepted_note',e.accepted_note,'actor_wallet_after',CASE WHEN e.event_kind IN('hold','approval','cancellation') THEN round(e.wallet_after,2)::text ELSE NULL END,
   'cashier',payload,'request',jsonb_build_object('id',r.id,'club_id',r.club_id,'player_id',r.player_id,'agent_id',r.agent_id,
    'amount',round(r.amount,2)::text,'status',r.status,'created_at',r.created_at,'updated_at',r.updated_at,
    'acknowledged_at',r.acknowledged_at,'completed_at',r.completed_at,'cancelled_at',r.cancelled_at,
    'player_note',r.player_note,'agent_note',r.agent_note));
END $function$;
REVOKE ALL ON FUNCTION public.fn_cashier_operation_receipt(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Recover only an already committed actor-owned operation before a caller
-- re-evaluates pre-payment business gates. This performs no financial/document
-- mutations, but its shared row locks require a writable SQL transaction.
CREATE FUNCTION public.fn_cashout_operation_receipt_v2(p_expected_actor_id uuid,p_op_id uuid,p_action text,
 p_club_id uuid,p_amount numeric,p_cashout_id uuid DEFAULT NULL,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET lock_timeout='3s' SET statement_timeout='30s' AS $function$
DECLARE actor uuid:=auth.uid();note text:=NULLIF(btrim(p_note),'');fingerprint jsonb;envelope jsonb;
 prior public.accounting_cashier_events%ROWTYPE;observed_event_id uuid;receipt jsonb;
BEGIN
 IF actor IS NULL OR actor IS DISTINCT FROM p_expected_actor_id
 THEN RAISE EXCEPTION 'cashier_account_changed' USING ERRCODE='42501';END IF;
 IF p_action IS NULL OR p_action NOT IN('hold','approval','release') OR p_club_id IS NULL OR p_op_id IS NULL
   OR (p_action='hold' AND p_cashout_id IS NOT NULL) OR (p_action<>'hold' AND p_cashout_id IS NULL)
 THEN RAISE EXCEPTION 'cashier_intent_incomplete' USING ERRCODE='22023';END IF;
 IF p_amount IS NULL OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<=0
   OR p_amount>1000000000 OR p_amount<>round(p_amount,2)
 THEN RAISE EXCEPTION 'cashier_invalid_amount' USING ERRCODE='22023';END IF;
 fingerprint:=jsonb_build_object('action',p_action,'actor',actor,'club_id',p_club_id,'cashout_id',p_cashout_id,
   'amount',round(p_amount,2)::text,'note',note);
 envelope:=jsonb_build_object('contract_version',1,'actor_user_id',actor,'op_id',p_op_id,'action',p_action,
   'club_id',p_club_id,'amount',round(p_amount,2)::text,'cashout_id',p_cashout_id,'accepted_note',note);
 -- Wait for the same in-flight operation before deciding that it is absent.
 PERFORM pg_advisory_xact_lock(hashtextextended('cashout-op:'||actor::text||':'||p_op_id::text,0));
 SELECT * INTO prior FROM public.accounting_cashier_events WHERE actor_user_id=actor AND op_id=p_op_id;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM public.chip_transactions t WHERE t.metadata->>'op_id'=p_op_id::text
    AND t.transaction_type IN('cashout_request_escrow','cashout_approved','cashout_cancelled','cashout_denied','cashout_expired_refund')
    AND (t.from_user_id=actor OR t.to_user_id=actor))
  THEN RAISE EXCEPTION 'cashier_legacy_operation_unverified' USING ERRCODE='23514';END IF;
  RETURN envelope||jsonb_build_object('found',false,'receipt',NULL);
 END IF;
 IF prior.operation_fingerprint IS DISTINCT FROM fingerprint
 THEN RAISE EXCEPTION 'cashier_operation_conflict' USING ERRCODE='22023';END IF;
 observed_event_id:=prior.id;
 -- Same order as transition replay: operation, hierarchy, club, request, escrow.
 PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));
 PERFORM id FROM public.clubs WHERE id=p_club_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'cashier_club_unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM public.accounting_cashier_events WHERE actor_user_id=actor AND op_id=p_op_id;
 IF NOT FOUND OR prior.id IS DISTINCT FROM observed_event_id OR prior.operation_fingerprint IS DISTINCT FROM fingerprint
   OR prior.actor_user_id IS DISTINCT FROM actor OR prior.club_id IS DISTINCT FROM p_club_id
   OR prior.amount IS DISTINCT FROM p_amount OR prior.accepted_note IS DISTINCT FROM note
   OR (p_action='hold' AND prior.event_kind IS DISTINCT FROM 'hold')
   OR (p_action='approval' AND prior.event_kind IS DISTINCT FROM 'approval')
   OR (p_action='release' AND prior.event_kind NOT IN('cancellation','decline'))
   OR (p_action<>'hold' AND prior.cashout_id IS DISTINCT FROM p_cashout_id)
 THEN RAISE EXCEPTION 'cashier_operation_receipt_mismatch' USING ERRCODE='23514';END IF;
 -- Frozen actor ownership is the read permission. Current role, assignee or
 -- club-owner changes do not authorize new money and do not revoke this receipt.
 receipt:=public.fn_cashier_operation_receipt(prior.id,true);
 RETURN envelope||jsonb_build_object('found',true,'receipt',receipt);
END $function$;
REVOKE ALL ON FUNCTION public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text) TO authenticated;

-- Lock only the real actor/target/assigned rows and their at-most-20-hop
-- membership chains. Recompute after waits so a changed chain is refused,
-- rather than treating a pre-lock observation as current authorization.
CREATE FUNCTION public.fn_cashier_lock_authority(p_club_id uuid,p_actor uuid,p_target uuid,p_assigned uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $function$
DECLARE before_ids uuid[];after_ids uuid[];
BEGIN
 WITH RECURSIVE chain AS (
  SELECT m.user_id,m.agent_id,0 depth FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=ANY(ARRAY[p_actor,p_target,p_assigned])
  UNION ALL SELECT m.user_id,m.agent_id,c.depth+1 FROM chain c JOIN public.club_members m ON m.club_id=p_club_id AND m.user_id=c.agent_id WHERE c.depth<20
 ) SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO before_ids FROM chain;
 PERFORM m.user_id FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=ANY(before_ids) ORDER BY m.user_id FOR UPDATE;
 WITH RECURSIVE chain AS (
  SELECT m.user_id,m.agent_id,0 depth FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=ANY(ARRAY[p_actor,p_target,p_assigned])
  UNION ALL SELECT m.user_id,m.agent_id,c.depth+1 FROM chain c JOIN public.club_members m ON m.club_id=p_club_id AND m.user_id=c.agent_id WHERE c.depth<20
 ) SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO after_ids FROM chain;
 IF before_ids IS DISTINCT FROM after_ids THEN RAISE EXCEPTION 'cashier_authority_changed_during_lock' USING ERRCODE='40001';END IF;
END $function$;
REVOKE ALL ON FUNCTION public.fn_cashier_lock_authority(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- All supported cashier custody movements finish here. Browser arguments never
-- supply a ledger actor, representative, physical source, document or audience.
CREATE FUNCTION public.fn_cashier_cashout_transition(p_action text,p_club_id uuid,p_cashout_id uuid,p_amount numeric,
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
REVOKE ALL ON FUNCTION public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_cashout_request_v2(p_club_id uuid,p_amount numeric,p_expected_actor_id uuid,p_op_id uuid,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $function$
 SELECT public.fn_cashier_cashout_transition('hold',p_club_id,NULL,p_amount,p_expected_actor_id,p_op_id,p_note);
$function$;
CREATE FUNCTION public.fn_cashout_approve_v2(p_cashout_id uuid,p_club_id uuid,p_amount numeric,p_expected_actor_id uuid,p_op_id uuid,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $function$
 SELECT public.fn_cashier_cashout_transition('approval',p_club_id,p_cashout_id,p_amount,p_expected_actor_id,p_op_id,p_note);
$function$;
CREATE FUNCTION public.fn_cashout_release_v2(p_cashout_id uuid,p_club_id uuid,p_amount numeric,p_expected_actor_id uuid,p_op_id uuid,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $function$
 SELECT public.fn_cashier_cashout_transition('release',p_club_id,p_cashout_id,p_amount,p_expected_actor_id,p_op_id,p_note);
$function$;
REVOKE ALL ON FUNCTION public.fn_cashout_request_v2(uuid,numeric,uuid,uuid,text),
 public.fn_cashout_approve_v2(uuid,uuid,numeric,uuid,uuid,text),public.fn_cashout_release_v2(uuid,uuid,numeric,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashout_request_v2(uuid,numeric,uuid,uuid,text),
 public.fn_cashout_approve_v2(uuid,uuid,numeric,uuid,uuid,text),public.fn_cashout_release_v2(uuid,uuid,numeric,uuid,uuid,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_cashout_request(p_club_id uuid,p_amount numeric,p_note text DEFAULT NULL,p_op_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
BEGIN RAISE EXCEPTION 'cashier_v2_intent_required' USING ERRCODE='22023';END $function$;
CREATE OR REPLACE FUNCTION public.fn_cashout_approve(p_cashout_id uuid,p_note text DEFAULT NULL,p_op_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
BEGIN RAISE EXCEPTION 'cashier_v2_intent_required' USING ERRCODE='22023';END $function$;
CREATE OR REPLACE FUNCTION public.fn_cashout_release(p_cashout_id uuid,p_note text DEFAULT NULL,p_op_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
BEGIN RAISE EXCEPTION 'cashier_v2_intent_required' USING ERRCODE='22023';END $function$;


-- Explicitly close every retained legacy service route as well.
CREATE OR REPLACE FUNCTION public.fn_approve_cashout_atomic(p_cashout_id uuid, p_agent_id uuid, p_agent_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN RAISE EXCEPTION 'cashier_v2_intent_required' USING ERRCODE='22023';END $function$;

CREATE OR REPLACE FUNCTION public.fn_cancel_cashout_atomic(p_cashout_id uuid, p_user_id uuid, p_is_agent boolean DEFAULT false, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN RAISE EXCEPTION 'cashier_v2_intent_required' USING ERRCODE='22023';END $function$;

CREATE OR REPLACE FUNCTION public.fn_cancel_cashout(p_cashout_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN RAISE EXCEPTION 'cashier_v2_intent_required' USING ERRCODE='22023';END $function$;

CREATE OR REPLACE FUNCTION public.fn_request_cashout(p_player_id uuid, p_club_id uuid, p_amount numeric, p_note text DEFAULT NULL::text, p_agent_id uuid DEFAULT NULL::uuid, p_type text DEFAULT 'request'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN RAISE EXCEPTION 'cashier_v2_intent_required' USING ERRCODE='22023';END $function$;

CREATE OR REPLACE FUNCTION public.fn_expire_stale_cashouts(p_ttl_hours integer DEFAULT 72) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE r record;n integer:=0;
BEGIN
 -- SECURITY DEFINER changes current_user; the invoking role and NULL user are
 -- still checked. Only this existing service entry can choose a system action.
 IF COALESCE(NULLIF(NULLIF(current_setting('role',true),''),'none'),session_user) NOT IN('service_role','postgres') OR auth.uid() IS NOT NULL
 THEN RAISE EXCEPTION 'cashier_expiry_service_required' USING ERRCODE='42501';END IF;
 IF p_ttl_hours IS NULL OR p_ttl_hours<1 OR p_ttl_hours>8760 THEN RAISE EXCEPTION 'cashier_invalid_expiry_hours' USING ERRCODE='22023';END IF;
 -- Bound one transaction to 100 canonical requests. Unsupported pre-cutover
 -- requests stay visible in the reconciliation inventory and cannot starve
 -- proven holds. Any anomaly in an admitted event still aborts this batch.
 FOR r IN SELECT c.id,c.club_id,c.amount,s.id AS escrow_id FROM public.cashout_requests c
   LEFT JOIN public.chip_escrow s ON s.cashout_request_id=c.id
   WHERE c.status='pending' AND EXISTS(SELECT 1 FROM public.accounting_cashier_events ce WHERE ce.cashout_id=c.id)
    AND (c.created_at<transaction_timestamp()-make_interval(hours=>p_ttl_hours) OR c.created_at IS NULL OR NOT isfinite(c.created_at))
   ORDER BY c.club_id,c.id LIMIT 100 LOOP
  IF r.escrow_id IS NULL THEN RAISE EXCEPTION 'cashier_escrow_unverified' USING ERRCODE='23514';END IF;
  PERFORM public.fn_cashier_cashout_transition('expiry_refund',r.club_id,r.id,r.amount,NULL,r.escrow_id,NULL);
  n:=n+1;
 END LOOP;
 RETURN n;
END $function$;
REVOKE ALL ON FUNCTION public.fn_expire_stale_cashouts(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_expire_stale_cashouts(integer) TO service_role;

-- Operations-only inventory, not a public customer-history reader or an
-- adoption writer. A count returned by expiry is never evidence that this
-- separate unverified liability queue has been reconciled.
CREATE FUNCTION public.fn_cashier_reconciliation_inventory(p_after_id uuid DEFAULT NULL,p_limit integer DEFAULT 50,p_ttl_hours integer DEFAULT 72) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_ttl_hours IS NULL OR p_ttl_hours<1 OR p_ttl_hours>8760
 THEN RAISE EXCEPTION 'cashier_inventory_bounds_invalid' USING ERRCODE='22023';END IF;
 WITH unsupported AS MATERIALIZED (
  SELECT r.*,r.amount IS NOT NULL AND r.amount::text NOT IN('NaN','Infinity','-Infinity') AND r.amount>0 AND r.amount=round(r.amount,2) AS amount_valid
  FROM public.cashout_requests r WHERE r.status='pending'
   AND NOT EXISTS(SELECT 1 FROM public.accounting_cashier_events e WHERE e.cashout_id=r.id)
 ), totals AS (
  SELECT count(*) total,count(*) FILTER(WHERE NOT amount_valid) invalid_amounts,
   COALESCE(sum(amount) FILTER(WHERE amount_valid),0) known_amount,
   count(*) FILTER(WHERE created_at IS NULL OR NOT isfinite(created_at)) invalid_times,
   count(*) FILTER(WHERE created_at<transaction_timestamp()-make_interval(hours=>p_ttl_hours)) due_count FROM unsupported
 ), page AS MATERIALIZED (
  SELECT u.* FROM unsupported u WHERE p_after_id IS NULL OR u.id>p_after_id ORDER BY u.id LIMIT p_limit
 ) SELECT jsonb_build_object('contract_version',1,'scope','unverified_pending_cashout_holds','adoption_supported',false,
   'unsupported_count',t.total,'valid_amount_sum',round(t.known_amount,2)::text,'invalid_amount_count',t.invalid_amounts,
   'invalid_created_at_count',t.invalid_times,'past_ttl_count',t.due_count,'captured_at',statement_timestamp(),
   'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object('cashout_id',r.id,'club_id',r.club_id,'player_id',r.player_id,
      'assigned_agent_id',r.agent_id,'amount',r.amount::text,'amount_valid',r.amount_valid,'created_at',r.created_at,
      'escrow_id',(SELECT s.id FROM public.chip_escrow s WHERE s.cashout_request_id=r.id)) ORDER BY r.id) FROM page r),'[]'::jsonb),
   'next_cursor',CASE WHEN EXISTS(SELECT 1 FROM unsupported u WHERE u.id>(SELECT id FROM page ORDER BY id DESC LIMIT 1))
     THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) ELSE NULL END)
 INTO result FROM totals t;
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_cashier_reconciliation_inventory(uuid,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashier_reconciliation_inventory(uuid,integer,integer) TO service_role;

-- Extend the established private read boundary. Only a real invoice joined
-- through its recorded delivery receives this typed canonical projection.
DO $reader$ DECLARE definition text;anchor text;replacement text; BEGIN
 definition:=pg_get_functiondef('public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)'::regprocedure);
 anchor:=$anchor$COALESCE(m.media_metadata,'{}')||CASE WHEN i.id IS NULL THEN jsonb_build_object('accounting_verified',false)
     ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
       'status',i.status,'chips_transferred',i.chips_transferred) END$anchor$;
 replacement:=$replacement$(COALESCE(m.media_metadata,'{}')-ARRAY['cashier','cashier_verified'])||CASE WHEN i.id IS NULL
     THEN jsonb_build_object('accounting_verified',false,'cashier_verified',false)
     ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
       'status',i.status,'chips_transferred',i.chips_transferred,'invoice_type',i.invoice_type,
       'source_ledger_id',i.source_ledger_id,'club_id',i.club_id,
       'cashier_verified',i.invoice_type='cashier_cashout')||CASE WHEN i.invoice_type='cashier_cashout'
        THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'cashier',public.fn_cashier_invoice_contract(i.id)) ELSE '{}'::jsonb END END$replacement$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'cashier_private_reader_anchor_changed';END IF;
 EXECUTE replace(definition,anchor,replacement);
 definition:=pg_get_functiondef('public.fn_messenger_invoice_visible_to(uuid,uuid)'::regprocedure);
 anchor:='WHERE i.id=p_invoice_id';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'cashier_invoice_privacy_anchor_changed';END IF;
 EXECUTE replace(definition,anchor,anchor||E'\n   AND (i.invoice_type<>''cashier_cashout'' OR EXISTS(SELECT 1 FROM public.accounting_cashier_events ce\n     WHERE ce.invoice_id=i.id AND p_user_id=ANY(ce.audience_user_ids)))');
END $reader$;

-- No direct table/column path can forge pending requests, custody releases or
-- event provenance. Existing scoped SELECT policies remain unchanged.
DO $columns$ DECLARE relation_name text;column_name text;role_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['cashout_requests','chip_escrow'] LOOP
  FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid=('public.'||relation_name)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE INSERT (%I),UPDATE (%I) ON public.%I FROM PUBLIC,anon,authenticated,service_role',column_name,column_name,relation_name);
  END LOOP;
 END LOOP;
END $columns$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_approve_cashout_atomic','retired','Legacy service route is retired; use the exact authenticated cashier v2 intent and canonical receipt.'),
 ('fn_cancel_cashout_atomic','retired','Legacy service route is retired; use the exact authenticated cashier v2 intent and canonical receipt.'),
 ('fn_cancel_cashout','retired','Legacy service route is retired; use the exact authenticated cashier v2 intent and canonical receipt.'),
 ('fn_request_cashout','retired','Legacy service route is retired; use the exact authenticated cashier v2 intent and canonical receipt.'),
 ('fn_cashout_request','retired','Use fn_cashout_request_v2 with exact account, club, amount and retained operation identity.'),
 ('fn_cashout_approve','retired','Use fn_cashout_approve_v2; old status-only replay cannot certify accounting documents.'),
 ('fn_cashout_release','retired','Use fn_cashout_release_v2; old status-only replay cannot certify accounting documents.'),
 ('fn_cashout_request_v2','approved','Atomic cashier hold through the existing physical journal and invoice authority. Exact actor/club/amount/operation and mandatory receipt.'),
 ('fn_cashout_approve_v2','approved','Atomic current-authority approval of a proven hold. Physical escrow to actual approving wallet and immutable invoice.'),
 ('fn_cashout_release_v2','approved','Atomic player cancellation or authorized cashier decline. Proven escrow returns to existing player wallet; no membership recreation.'),
 ('fn_expire_stale_cashouts','system','Service-only bounded atomic expiry/refund of canonical holds through the same cashier writer; unsupported legacy holds remain unchanged in fn_cashier_reconciliation_inventory and require reconciliation.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
DO $authority$ DECLARE role_name text;relation_name text;column_name text;signature text;BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH relation_name IN ARRAY ARRAY['cashout_requests','chip_escrow','accounting_cashier_events'] LOOP
   IF has_table_privilege(role_name,'public.'||relation_name,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
   THEN RAISE EXCEPTION 'cashier_direct_writer_remains' USING DETAIL=role_name||'.'||relation_name;END IF;
   FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid=('public.'||relation_name)::regclass AND attnum>0 AND NOT attisdropped LOOP
    IF has_column_privilege(role_name,'public.'||relation_name,column_name,'INSERT,UPDATE')
    THEN RAISE EXCEPTION 'cashier_column_writer_remains' USING DETAIL=role_name||'.'||relation_name||'.'||column_name;END IF;
   END LOOP;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['fn_cashier_lock_authority(uuid,uuid,uuid,uuid)','fn_cashier_event_append_only()','fn_cashier_event_payload(public.accounting_cashier_events)',
   'fn_cashier_document_body(uuid,text)','fn_cashier_invoice_contract(uuid)','fn_cashier_assert_delivery(uuid)',
   'fn_cashier_operation_receipt(uuid,boolean)','fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'] LOOP
   IF has_function_privilege(role_name,'public.'||signature,'EXECUTE')
   THEN RAISE EXCEPTION 'cashier_private_authority_executable' USING DETAIL=role_name||'.'||signature;END IF;
  END LOOP;
 END LOOP;
 IF has_function_privilege('anon','public.fn_cashout_request_v2(uuid,numeric,uuid,uuid,text)','EXECUTE')
   OR has_function_privilege('anon','public.fn_cashout_approve_v2(uuid,uuid,numeric,uuid,uuid,text)','EXECUTE')
   OR has_function_privilege('anon','public.fn_cashout_release_v2(uuid,uuid,numeric,uuid,uuid,text)','EXECUTE')
   OR has_function_privilege('anon','public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)','EXECUTE')
   OR has_function_privilege('service_role','public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)','EXECUTE')
   OR has_function_privilege('authenticated','public.fn_expire_stale_cashouts(integer)','EXECUTE')
   OR has_function_privilege('authenticated','public.fn_cashier_reconciliation_inventory(uuid,integer,integer)','EXECUTE')
   OR has_function_privilege('anon','public.fn_cashier_reconciliation_inventory(uuid,integer,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'cashier_public_authority_widened';END IF;
 IF NOT has_function_privilege('authenticated','public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)','EXECUTE')
  OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a
    WHERE p.oid='public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)'::regprocedure)
    IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres']::text[]
 THEN RAISE EXCEPTION 'cashier_receipt_resolver_access_changed';END IF;
END $authority$;
COMMIT;
