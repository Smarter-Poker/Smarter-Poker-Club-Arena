-- SOURCE ONLY / UNRUN. Additive component34 after the accepted cashier33 source.
-- This documents canonical journal facts, never a new payment or SQL call stack.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
LOCK TABLE public.chip_ledger,public.settlement_invoices IN ACCESS EXCLUSIVE MODE;

DO $preimage$ DECLARE actual jsonb;definition text;anchor text;replacement text;BEGIN
 IF current_user<>'postgres' OR to_regclass('public.accounting_correction_documents') IS NOT NULL THEN RAISE EXCEPTION 'correction_document_authority_preexists_or_wrong_owner';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['fn_accounting_correction_prepare','fn_accounting_correction_append_only','fn_accounting_correction_payload','fn_accounting_correction_document_body','fn_accounting_correction_contract','fn_accounting_correction_assert_delivery','fn_accounting_correction_is_unverified','fn_accounting_correction_legacy_identity'])) THEN RAISE EXCEPTION 'correction_document_helper_preexists';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_autoledger_delete()') AND md5(pg_get_functiondef(oid))='c6d7e02df8b654fbccc3e8844418bd01' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_autoledger_delete()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_autoledger_delete()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_autoledger()') AND md5(pg_get_functiondef(oid))='2ff8923b4c2d8fd3d343cf37acce0f2c' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_autoledger()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_autoledger()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_block_browser_money_table()') AND md5(pg_get_functiondef(oid))='c894814808498e86ac14d59924cfa145' AND proowner='postgres'::regrole AND prosecdef=false) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_block_browser_money_table()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_block_browser_money_table()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_incident_events_append_only()') AND md5(pg_get_functiondef(oid))='f5525c7ec050a1a9e1c9722d22eec86c' AND proowner='postgres'::regrole AND prosecdef=false) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_incident_events_append_only()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_incident_events_append_only()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_incident_resolution_reaches_the_alerts()') AND md5(pg_get_functiondef(oid))='17c6d9a34489d5b1581c2715da03f4ab' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_incident_resolution_reaches_the_alerts()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_incident_resolution_reaches_the_alerts()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_incidents_stay_in_midway()') AND md5(pg_get_functiondef(oid))='9811b6bdbe53ceb9bdfb2d3ab3096364' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_incidents_stay_in_midway()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_incidents_stay_in_midway()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb)') AND md5(pg_get_functiondef(oid))='a5a8bb3048872ea4c8acf58f1f64390d' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)') AND md5(pg_get_functiondef(oid))='3fc1c871313940f2e93a82a022f2faff' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_resolution_needs_a_cause()') AND md5(pg_get_functiondef(oid))='6c7dcd8c415422750cc946887be8d2c7' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_resolution_needs_a_cause()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_resolution_needs_a_cause()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_accounting_party_users(text,uuid)') AND md5(pg_get_functiondef(oid))='2436b25400e0ee73dbbe3158fdb47b0d' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_accounting_party_users(text,uuid)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_accounting_party_users(text,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_accounting_transfer_document_on_insert()') AND md5(pg_get_functiondef(oid))='bf9d870bfc52d44c1d2cc33860dfd71a' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_accounting_transfer_document_on_insert()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_accounting_transfer_document_on_insert()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_alert_resolution_reaches_the_incident()') AND md5(pg_get_functiondef(oid))='dbe622139f98faf98bca7bc30db0155c' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_alert_resolution_reaches_the_incident()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_alert_resolution_reaches_the_incident()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_escrow_on_overlay_leg()') AND md5(pg_get_functiondef(oid))='1b916fb576271d94c481099c11ca8b93' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_escrow_on_overlay_leg()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_escrow_on_overlay_leg()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_financial_alert_to_incident()') AND md5(pg_get_functiondef(oid))='00a43ae03ab12cec9505e2bfed71d937' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_financial_alert_to_incident()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_financial_alert_to_incident()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_register_issuance_leg(uuid)') AND md5(pg_get_functiondef(oid))='8d3d5e1feccd96fcf0045afefdb9fcdc' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_ca_register_issuance_leg(uuid)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_ca_register_issuance_leg(uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_is_union_overseer(uuid,uuid)') AND md5(pg_get_functiondef(oid))='5c1b25662b9751fc4152dac8e8b5e6f2' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_is_union_overseer(uuid,uuid)')) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_dependency_preimage_changed' USING DETAIL='fn_is_union_overseer(uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_invoice_accounting_ledger_transfer(uuid)') AND md5(prosrc)='6d364ff3d372100a5fbda16f3db3ed2d' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_invoice_accounting_ledger_transfer(uuid)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_preceding_authority_changed' USING DETAIL='fn_invoice_accounting_ledger_transfer(uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_deliver_accounting_invoice(uuid)') AND md5(prosrc)='246dbc9408b5135673d3e223a4708abb' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_deliver_accounting_invoice(uuid)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_preceding_authority_changed' USING DETAIL='fn_deliver_accounting_invoice(uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_accounting_document_immutable()') AND md5(prosrc)='48dfab0a6d69eeb68636f252ba4a2745' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_accounting_document_immutable()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_preceding_authority_changed' USING DETAIL='fn_accounting_document_immutable()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_mirror_notification_to_push_outbox()') AND md5(prosrc)='27249cc89b71b9dd26fe7e5a604e39ee' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid=to_regprocedure('public.fn_mirror_notification_to_push_outbox()')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_preceding_authority_changed' USING DETAIL='fn_mirror_notification_to_push_outbox()';END IF;
 SELECT prosrc INTO definition FROM pg_proc WHERE oid='public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)'::regprocedure;
 anchor:=$old$COALESCE(m.media_metadata,'{}')||CASE WHEN i.id IS NULL THEN jsonb_build_object('accounting_verified',false)
     ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
       'status',i.status,'chips_transferred',i.chips_transferred) END$old$;replacement:=$current$(COALESCE(m.media_metadata,'{}')-ARRAY['cashier','cashier_verified'])||CASE WHEN i.id IS NULL
     THEN jsonb_build_object('accounting_verified',false,'cashier_verified',false)
     ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
       'status',i.status,'chips_transferred',i.chips_transferred,'invoice_type',i.invoice_type,
       'source_ledger_id',i.source_ledger_id,'club_id',i.club_id,
       'cashier_verified',i.invoice_type='cashier_cashout')||CASE WHEN i.invoice_type='cashier_cashout'
        THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'cashier',public.fn_cashier_invoice_contract(i.id)) ELSE '{}'::jsonb END END$current$;
 IF definition IS NULL OR (length(definition)-length(replace(definition,replacement,'')))/length(replacement)<>1 OR md5(replace(definition,replacement,anchor))<>'4bf8638250b0a342b9c68ee4c33a2cae' THEN RAISE EXCEPTION 'correction_document_private_reader_preimage_changed';END IF;
 SELECT prosrc INTO definition FROM pg_proc WHERE oid='public.fn_messenger_invoice_visible_to(uuid,uuid)'::regprocedure;
 anchor:=$privacy$
   AND (i.invoice_type<>'cashier_cashout' OR EXISTS(SELECT 1 FROM public.accounting_cashier_events ce
     WHERE ce.invoice_id=i.id AND p_user_id=ANY(ce.audience_user_ids)))$privacy$;
 IF definition IS NULL OR (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 OR md5(replace(definition,anchor,''))<>'9b5448b6368a874b8dab206c686806a4' THEN RAISE EXCEPTION 'correction_document_privacy_preimage_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)'::regprocedure AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_reader_access_changed' USING DETAIL='fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_messenger_invoice_visible_to(uuid,uuid)'::regprocedure AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_messenger_invoice_visible_to(uuid,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_reader_access_changed' USING DETAIL='fn_messenger_invoice_visible_to(uuid,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.ca_drift_incidents'::regclass AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity=true AND relforcerowsecurity=false) THEN RAISE EXCEPTION 'correction_document_relation_changed' USING DETAIL='public.ca_drift_incidents';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.ca_drift_incidents'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $columns$[{"name":"id","type":"uuid","not_null":true,"default":"gen_random_uuid()","identity":"","generated":"","acl":null},{"name":"detected_at","type":"timestamp with time zone","not_null":true,"default":"now()","identity":"","generated":"","acl":null},{"name":"deadline_at","type":"timestamp with time zone","not_null":true,"default":"(now() + '00:20:00'::interval)","identity":"","generated":"","acl":null},{"name":"classification","type":"text","not_null":true,"default":"'unknown'::text","identity":"","generated":"","acl":null},{"name":"severity","type":"text","not_null":true,"default":"'critical'::text","identity":"","generated":"","acl":null},{"name":"layer","type":"text","not_null":true,"default":"'unknown'::text","identity":"","generated":"","acl":null},{"name":"status","type":"text","not_null":true,"default":"'open'::text","identity":"","generated":"","acl":null},{"name":"source","type":"text","not_null":true,"default":null,"identity":"","generated":"","acl":null},{"name":"dedupe_key","type":"text","not_null":true,"default":null,"identity":"","generated":"","acl":null},{"name":"union_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"club_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"entity_type","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"entity_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"table_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"tournament_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"hand_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"settlement_id","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"wallet_ids","type":"uuid[]","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"transaction_ids","type":"uuid[]","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"currency","type":"text","not_null":true,"default":"'club_chips'::text","identity":"","generated":"","acl":null},{"name":"expected_amount","type":"numeric","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"actual_amount","type":"numeric","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"discrepancy_amount","type":"numeric","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"ledger_balanced","type":"boolean","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"suspected_cause","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"auto_repair_status","type":"text","not_null":true,"default":"'pending'::text","identity":"","generated":"","acl":null},{"name":"escalation_level","type":"integer","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"past_target","type":"boolean","not_null":true,"default":"false","identity":"","generated":"","acl":null},{"name":"occurrences","type":"integer","not_null":true,"default":"1","identity":"","generated":"","acl":null},{"name":"last_seen_at","type":"timestamp with time zone","not_null":true,"default":"now()","identity":"","generated":"","acl":null},{"name":"acknowledged_by","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"acknowledged_at","type":"timestamp with time zone","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"assigned_to","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"root_cause","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"correction_ref","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"resolution","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"resolved_by","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"resolved_at","type":"timestamp with time zone","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"metadata","type":"jsonb","not_null":true,"default":"'{}'::jsonb","identity":"","generated":"","acl":null},{"name":"created_at","type":"timestamp with time zone","not_null":true,"default":"now()","identity":"","generated":"","acl":null}]$columns$::jsonb THEN RAISE EXCEPTION 'correction_document_columns_changed' USING DETAIL='public.ca_drift_incidents';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl) a WHERE c.oid='public.ca_drift_incidents'::regclass) IS DISTINCT FROM ARRAY['postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_relation_access_changed' USING DETAIL='public.ca_drift_incidents';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname) INTO actual FROM pg_constraint c WHERE c.conrelid='public.ca_drift_incidents'::regclass;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $constraints$[{"name":"ca_drift_incidents_auto_repair_status_check","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((auto_repair_status = ANY (ARRAY['pending'::text, 'running'::text, 'repaired'::text, 'manual_needed'::text, 'not_applicable'::text])))"},{"name":"ca_drift_incidents_classification_check","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((classification = ANY (ARRAY['ledger_imbalance'::text, 'settlement_error'::text, 'duplicate_payment'::text, 'missing_payment'::text, 'projection_delay'::text, 'cache_mismatch'::text, 'reporting_mismatch'::text, 'delayed_event'::text, 'duplicate_event'::text, 'rounding_error'::text, 'incorrect_rake'::text, 'incorrect_weighted_rake'::text, 'incorrect_rakeback'::text, 'bbj_error'::text, 'treasury_error'::text, 'credit_line_error'::text, 'cross_club_posting'::text, 'cross_union_posting'::text, 'unauthorized_adjustment'::text, 'historical_migration'::text, 'unknown'::text])))"},{"name":"ca_drift_incidents_layer_check","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((layer = ANY (ARRAY['ledger'::text, 'projection'::text, 'cache'::text, 'reporting'::text, 'settlement'::text, 'unknown'::text])))"},{"name":"ca_drift_incidents_pkey","type":"p","validated":true,"deferrable":false,"deferred":false,"definition":"PRIMARY KEY (id)"},{"name":"ca_drift_incidents_severity_check","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])))"},{"name":"ca_drift_incidents_status_check","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'reconciling'::text, 'resolved'::text])))"}]$constraints$::jsonb THEN RAISE EXCEPTION 'correction_document_constraints_changed' USING DETAIL='public.ca_drift_incidents';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) INTO actual FROM pg_trigger t WHERE t.tgrelid='public.ca_drift_incidents'::regclass AND NOT t.tgisinternal;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $triggers$[{"name":"trg_ca_incidents_stay_in_midway","enabled":"O","definition":"CREATE TRIGGER trg_ca_incidents_stay_in_midway BEFORE INSERT ON public.ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_incidents_stay_in_midway()"},{"name":"trg_ca_resolution_needs_a_cause","enabled":"O","definition":"CREATE TRIGGER trg_ca_resolution_needs_a_cause BEFORE UPDATE ON public.ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_resolution_needs_a_cause()"},{"name":"zz_ca_incident_resolution_reaches_the_alerts","enabled":"O","definition":"CREATE TRIGGER zz_ca_incident_resolution_reaches_the_alerts AFTER UPDATE OF status ON public.ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_incident_resolution_reaches_the_alerts()"}]$triggers$::jsonb THEN RAISE EXCEPTION 'correction_document_triggers_changed' USING DETAIL='public.ca_drift_incidents';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.ca_incident_events'::regclass AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity=true AND relforcerowsecurity=false) THEN RAISE EXCEPTION 'correction_document_relation_changed' USING DETAIL='public.ca_incident_events';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.ca_incident_events'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $columns$[{"name":"id","type":"bigint","not_null":true,"default":null,"identity":"a","generated":"","acl":null},{"name":"incident_id","type":"uuid","not_null":true,"default":null,"identity":"","generated":"","acl":null},{"name":"at","type":"timestamp with time zone","not_null":true,"default":"now()","identity":"","generated":"","acl":null},{"name":"kind","type":"text","not_null":true,"default":null,"identity":"","generated":"","acl":null},{"name":"actor","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"actor_label","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"detail","type":"jsonb","not_null":true,"default":"'{}'::jsonb","identity":"","generated":"","acl":null}]$columns$::jsonb THEN RAISE EXCEPTION 'correction_document_columns_changed' USING DETAIL='public.ca_incident_events';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl) a WHERE c.oid='public.ca_incident_events'::regclass) IS DISTINCT FROM ARRAY['postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_relation_access_changed' USING DETAIL='public.ca_incident_events';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname) INTO actual FROM pg_constraint c WHERE c.conrelid='public.ca_incident_events'::regclass;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $constraints$[{"name":"ca_incident_events_incident_id_fkey","type":"f","validated":true,"deferrable":false,"deferred":false,"definition":"FOREIGN KEY (incident_id) REFERENCES ca_drift_incidents(id)"},{"name":"ca_incident_events_kind_check","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((kind = ANY (ARRAY['created'::text, 'recurred'::text, 'notified'::text, 'escalated'::text, 'status_change'::text, 'repair_action'::text, 'comment'::text, 'assigned'::text, 'acknowledged'::text, 'resolved'::text, 'reopened'::text, 'notify_failed'::text, 'notify_withheld'::text])))"},{"name":"ca_incident_events_pkey","type":"p","validated":true,"deferrable":false,"deferred":false,"definition":"PRIMARY KEY (id)"}]$constraints$::jsonb THEN RAISE EXCEPTION 'correction_document_constraints_changed' USING DETAIL='public.ca_incident_events';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) INTO actual FROM pg_trigger t WHERE t.tgrelid='public.ca_incident_events'::regclass AND NOT t.tgisinternal;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $triggers$[{"name":"trg_ca_incident_events_append_only","enabled":"O","definition":"CREATE TRIGGER trg_ca_incident_events_append_only BEFORE DELETE OR UPDATE ON public.ca_incident_events FOR EACH ROW EXECUTE FUNCTION fn_ca_incident_events_append_only()"}]$triggers$::jsonb THEN RAISE EXCEPTION 'correction_document_triggers_changed' USING DETAIL='public.ca_incident_events';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.ca_incident_recipients'::regclass AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity=true AND relforcerowsecurity=false) THEN RAISE EXCEPTION 'correction_document_relation_changed' USING DETAIL='public.ca_incident_recipients';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.ca_incident_recipients'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $columns$[{"name":"id","type":"uuid","not_null":true,"default":"gen_random_uuid()","identity":"","generated":"","acl":null},{"name":"scope","type":"text","not_null":true,"default":"'platform'::text","identity":"","generated":"","acl":null},{"name":"scope_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"user_id","type":"uuid","not_null":true,"default":null,"identity":"","generated":"","acl":null},{"name":"min_severity","type":"text","not_null":true,"default":"'warning'::text","identity":"","generated":"","acl":null},{"name":"senior","type":"boolean","not_null":true,"default":"false","identity":"","generated":"","acl":null},{"name":"active","type":"boolean","not_null":true,"default":"true","identity":"","generated":"","acl":null},{"name":"created_at","type":"timestamp with time zone","not_null":true,"default":"now()","identity":"","generated":"","acl":null}]$columns$::jsonb THEN RAISE EXCEPTION 'correction_document_columns_changed' USING DETAIL='public.ca_incident_recipients';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl) a WHERE c.oid='public.ca_incident_recipients'::regclass) IS DISTINCT FROM ARRAY['postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_relation_access_changed' USING DETAIL='public.ca_incident_recipients';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname) INTO actual FROM pg_constraint c WHERE c.conrelid='public.ca_incident_recipients'::regclass;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $constraints$[{"name":"ca_incident_recipients_min_severity_check","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((min_severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])))"},{"name":"ca_incident_recipients_pkey","type":"p","validated":true,"deferrable":false,"deferred":false,"definition":"PRIMARY KEY (id)"},{"name":"ca_incident_recipients_scope_check","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((scope = ANY (ARRAY['platform'::text, 'financial_ops'::text, 'technical'::text, 'union'::text, 'club'::text])))"},{"name":"ca_incident_recipients_scope_scope_id_user_id_key","type":"u","validated":true,"deferrable":false,"deferred":false,"definition":"UNIQUE (scope, scope_id, user_id)"}]$constraints$::jsonb THEN RAISE EXCEPTION 'correction_document_constraints_changed' USING DETAIL='public.ca_incident_recipients';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) INTO actual FROM pg_trigger t WHERE t.tgrelid='public.ca_incident_recipients'::regclass AND NOT t.tgisinternal;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $triggers$[]$triggers$::jsonb THEN RAISE EXCEPTION 'correction_document_triggers_changed' USING DETAIL='public.ca_incident_recipients';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.ca_ledger_write_failures'::regclass AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity=true AND relforcerowsecurity=false) THEN RAISE EXCEPTION 'correction_document_relation_changed' USING DETAIL='public.ca_ledger_write_failures';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.ca_ledger_write_failures'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $columns$[{"name":"id","type":"bigint","not_null":true,"default":"nextval('ca_ledger_write_failures_id_seq'::regclass)","identity":"","generated":"","acl":null},{"name":"occurred_at","type":"timestamp with time zone","not_null":true,"default":"now()","identity":"","generated":"","acl":null},{"name":"club_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"user_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"delta","type":"numeric","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"sqlstate","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"message","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null}]$columns$::jsonb THEN RAISE EXCEPTION 'correction_document_columns_changed' USING DETAIL='public.ca_ledger_write_failures';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl) a WHERE c.oid='public.ca_ledger_write_failures'::regclass) IS DISTINCT FROM ARRAY['anon=rxt/postgres','authenticated=rxt/postgres','postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_relation_access_changed' USING DETAIL='public.ca_ledger_write_failures';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname) INTO actual FROM pg_constraint c WHERE c.conrelid='public.ca_ledger_write_failures'::regclass;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $constraints$[{"name":"ca_ledger_write_failures_pkey","type":"p","validated":true,"deferrable":false,"deferred":false,"definition":"PRIMARY KEY (id)"}]$constraints$::jsonb THEN RAISE EXCEPTION 'correction_document_constraints_changed' USING DETAIL='public.ca_ledger_write_failures';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) INTO actual FROM pg_trigger t WHERE t.tgrelid='public.ca_ledger_write_failures'::regclass AND NOT t.tgisinternal;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $triggers$[]$triggers$::jsonb THEN RAISE EXCEPTION 'correction_document_triggers_changed' USING DETAIL='public.ca_ledger_write_failures';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.union_wallets'::regclass AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity=true AND relforcerowsecurity=false) THEN RAISE EXCEPTION 'correction_document_relation_changed' USING DETAIL='public.union_wallets';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.union_wallets'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $columns$[{"name":"id","type":"uuid","not_null":true,"default":"gen_random_uuid()","identity":"","generated":"","acl":null},{"name":"union_id","type":"uuid","not_null":true,"default":null,"identity":"","generated":"","acl":null},{"name":"chip_balance","type":"numeric(20,2)","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"rake_wallet","type":"numeric(20,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"bbj_wallet","type":"numeric(20,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"promo_wallet","type":"numeric(20,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"insurance_wallet","type":"numeric(20,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"total_rake_collected","type":"numeric(20,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"total_settlements","type":"numeric","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"updated_at","type":"timestamp with time zone","not_null":false,"default":"now()","identity":"","generated":"","acl":null},{"name":"created_at","type":"timestamp with time zone","not_null":false,"default":"now()","identity":"","generated":"","acl":null},{"name":"spin_reserve_wallet","type":"numeric(20,2)","not_null":true,"default":"0","identity":"","generated":"","acl":null}]$columns$::jsonb THEN RAISE EXCEPTION 'correction_document_columns_changed' USING DETAIL='public.union_wallets';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl) a WHERE c.oid='public.union_wallets'::regclass) IS DISTINCT FROM ARRAY['anon=rxt/postgres','authenticated=rxt/postgres','postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_relation_access_changed' USING DETAIL='public.union_wallets';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname) INTO actual FROM pg_constraint c WHERE c.conrelid='public.union_wallets'::regclass;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $constraints$[{"name":"union_wallets_bbj_wallet_nonneg","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((bbj_wallet >= (0)::numeric))"},{"name":"union_wallets_chip_balance_nonneg","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((chip_balance >= (0)::numeric))"},{"name":"union_wallets_insurance_wallet_nonneg","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((insurance_wallet >= (0)::numeric))"},{"name":"union_wallets_pkey","type":"p","validated":true,"deferrable":false,"deferred":false,"definition":"PRIMARY KEY (id)"},{"name":"union_wallets_promo_wallet_nonneg","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((promo_wallet >= (0)::numeric))"},{"name":"union_wallets_rake_wallet_nonneg","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((rake_wallet >= (0)::numeric))"},{"name":"union_wallets_spin_reserve_wallet_nonneg","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK ((spin_reserve_wallet >= (0)::numeric))"},{"name":"union_wallets_union_id_fkey","type":"f","validated":true,"deferrable":false,"deferred":false,"definition":"FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE"},{"name":"union_wallets_union_id_key","type":"u","validated":true,"deferrable":false,"deferred":false,"definition":"UNIQUE (union_id)"}]$constraints$::jsonb THEN RAISE EXCEPTION 'correction_document_constraints_changed' USING DETAIL='public.union_wallets';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) INTO actual FROM pg_trigger t WHERE t.tgrelid='public.union_wallets'::regclass AND NOT t.tgisinternal;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $triggers$[{"name":"diamond_game_union_reserves","enabled":"O","definition":"CREATE TRIGGER diamond_game_union_reserves BEFORE UPDATE OF promo_wallet, chip_balance ON public.union_wallets FOR EACH ROW EXECUTE FUNCTION fn_diamond_game_reserved_cover_guard()"},{"name":"trg_ca_autoledger","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger AFTER INSERT OR UPDATE OF chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet, spin_reserve_wallet ON public.union_wallets FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('chip_balance=union_bank', 'rake_wallet=union_wallet', 'bbj_wallet=union_wallet', 'promo_wallet=union_wallet', 'insurance_wallet=union_wallet', 'spin_reserve_wallet=union_wallet')"},{"name":"trg_ca_autoledger_delete","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.union_wallets FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('chip_balance=union_bank', 'rake_wallet=union_wallet', 'bbj_wallet=union_wallet', 'promo_wallet=union_wallet', 'insurance_wallet=union_wallet', 'spin_reserve_wallet=union_wallet')"},{"name":"trg_ca_block_browser","enabled":"O","definition":"CREATE TRIGGER trg_ca_block_browser BEFORE INSERT OR DELETE OR UPDATE ON public.union_wallets FOR EACH ROW EXECUTE FUNCTION fn_ca_block_browser_money_table()"}]$triggers$::jsonb THEN RAISE EXCEPTION 'correction_document_triggers_changed' USING DETAIL='public.union_wallets';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.unions'::regclass AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity=true AND relforcerowsecurity=false) THEN RAISE EXCEPTION 'correction_document_relation_changed' USING DETAIL='public.unions';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.unions'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $columns$[{"name":"id","type":"uuid","not_null":true,"default":"gen_random_uuid()","identity":"","generated":"","acl":null},{"name":"name","type":"text","not_null":true,"default":null,"identity":"","generated":"","acl":null},{"name":"description","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"owner_id","type":"uuid","not_null":true,"default":null,"identity":"","generated":"","acl":null},{"name":"avatar_url","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"is_public","type":"boolean","not_null":false,"default":"true","identity":"","generated":"","acl":null},{"name":"member_count","type":"integer","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"club_count","type":"integer","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"total_rake","type":"numeric(15,2)","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"settings","type":"jsonb","not_null":false,"default":"'{\"shared_player_pool\": true, \"revenue_share_percent\": 10, \"cross_club_tournaments\": true}'::jsonb","identity":"","generated":"","acl":null},{"name":"created_at","type":"timestamp with time zone","not_null":false,"default":"now()","identity":"","generated":"","acl":null},{"name":"updated_at","type":"timestamp with time zone","not_null":false,"default":"now()","identity":"","generated":"","acl":null},{"name":"union_code","type":"integer","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"main_bbj_balance","type":"numeric(14,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"backup_bbj_balance","type":"numeric(14,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"promo_fund_balance","type":"numeric(14,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"code","type":"text","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"insurance_balance","type":"numeric(14,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"chip_balance","type":"numeric(20,4)","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"rake_wallet","type":"numeric(20,4)","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"bbj_wallet","type":"numeric(20,4)","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"promo_wallet","type":"numeric(20,4)","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"auto_settlement","type":"boolean","not_null":false,"default":"false","identity":"","generated":"","acl":null},{"name":"level","type":"integer","not_null":false,"default":"1","identity":"","generated":"","acl":null},{"name":"player_level","type":"integer","not_null":false,"default":"1","identity":"","generated":"","acl":null},{"name":"hierarchy_level","type":"integer","not_null":false,"default":"1","identity":"","generated":"","acl":null},{"name":"total_players","type":"integer","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"total_admins","type":"integer","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"total_super_agents","type":"integer","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"total_agents","type":"integer","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"hierarchy_units","type":"numeric(10,2)","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"hierarchy_units_rounded_up","type":"integer","not_null":false,"default":"0","identity":"","generated":"","acl":null},{"name":"player_threshold_current","type":"integer","not_null":false,"default":"30","identity":"","generated":"","acl":null},{"name":"player_threshold_next","type":"integer","not_null":false,"default":"34","identity":"","generated":"","acl":null},{"name":"hierarchy_threshold_current","type":"integer","not_null":false,"default":"2","identity":"","generated":"","acl":null},{"name":"hierarchy_threshold_next","type":"integer","not_null":false,"default":"2","identity":"","generated":"","acl":null},{"name":"promo_funded_from_bbj","type":"numeric","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"promo_funded_from_bank","type":"numeric","not_null":true,"default":"0","identity":"","generated":"","acl":null},{"name":"slug","type":"text","not_null":true,"default":null,"identity":"","generated":"","acl":null}]$columns$::jsonb THEN RAISE EXCEPTION 'correction_document_columns_changed' USING DETAIL='public.unions';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl) a WHERE c.oid='public.unions'::regclass) IS DISTINCT FROM ARRAY['anon=arwdxtm/postgres','authenticated=arwdxtm/postgres','postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_relation_access_changed' USING DETAIL='public.unions';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname) INTO actual FROM pg_constraint c WHERE c.conrelid='public.unions'::regclass;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $constraints$[{"name":"chk_chip_balance_is_two_decimal_places","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK (((chip_balance IS NULL) OR (chip_balance = round(chip_balance, 2))))"},{"name":"chk_rake_wallet_is_two_decimal_places","type":"c","validated":true,"deferrable":false,"deferred":false,"definition":"CHECK (((rake_wallet IS NULL) OR (rake_wallet = round(rake_wallet, 2))))"},{"name":"fk_unions_owner_id_profiles","type":"f","validated":true,"deferrable":false,"deferred":false,"definition":"FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE CASCADE"},{"name":"unions_code_unique","type":"u","validated":true,"deferrable":false,"deferred":false,"definition":"UNIQUE (code)"},{"name":"unions_owner_id_fkey","type":"f","validated":true,"deferrable":false,"deferred":false,"definition":"FOREIGN KEY (owner_id) REFERENCES auth.users(id)"},{"name":"unions_pkey","type":"p","validated":true,"deferrable":false,"deferred":false,"definition":"PRIMARY KEY (id)"}]$constraints$::jsonb THEN RAISE EXCEPTION 'correction_document_constraints_changed' USING DETAIL='public.unions';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) INTO actual FROM pg_trigger t WHERE t.tgrelid='public.unions'::regclass AND NOT t.tgisinternal;
 IF COALESCE(actual,'[]'::jsonb) IS DISTINCT FROM $triggers$[{"name":"trg_ca_autoledger","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF chip_balance, rake_wallet, main_bbj_balance, backup_bbj_balance, promo_fund_balance, insurance_balance ON public.unions FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('chip_balance=union_bank', 'rake_wallet=union_wallet', 'main_bbj_balance=bbj_pool', 'backup_bbj_balance=bbj_pool', 'promo_fund_balance=promo_wallet', 'insurance_balance=insurance_bank')"},{"name":"trg_ca_autoledger_delete","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.unions FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('chip_balance=union_bank', 'rake_wallet=union_wallet', 'main_bbj_balance=bbj_pool', 'backup_bbj_balance=bbj_pool', 'promo_fund_balance=promo_wallet', 'insurance_balance=insurance_bank')"},{"name":"trg_ca_autoledger_insert","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON public.unions FOR EACH ROW WHEN (((COALESCE(new.chip_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.rake_wallet, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.main_bbj_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.backup_bbj_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.promo_fund_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.insurance_balance, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_ca_autoledger('chip_balance=union_bank', 'rake_wallet=union_wallet', 'main_bbj_balance=bbj_pool', 'backup_bbj_balance=bbj_pool', 'promo_fund_balance=promo_wallet', 'insurance_balance=insurance_bank')"},{"name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.unions FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()"},{"name":"trg_new_union_gets_the_ladder","enabled":"O","definition":"CREATE TRIGGER trg_new_union_gets_the_ladder AFTER INSERT ON public.unions FOR EACH ROW EXECUTE FUNCTION fn_new_union_gets_the_ladder()"},{"name":"trg_union_creation_is_allowlisted","enabled":"O","definition":"CREATE TRIGGER trg_union_creation_is_allowlisted BEFORE INSERT ON public.unions FOR EACH ROW EXECUTE FUNCTION fn_guard_union_creation()"},{"name":"trg_union_owner_emit_management_access","enabled":"O","definition":"CREATE TRIGGER trg_union_owner_emit_management_access AFTER UPDATE OF owner_id ON public.unions FOR EACH ROW EXECUTE FUNCTION fn_emit_union_owner_access_event()"},{"name":"trg_unions_set_slug","enabled":"O","definition":"CREATE TRIGGER trg_unions_set_slug BEFORE INSERT OR UPDATE OF slug, name ON public.unions FOR EACH ROW EXECUTE FUNCTION fn_unions_set_slug()"}]$triggers$::jsonb THEN RAISE EXCEPTION 'correction_document_triggers_changed' USING DETAIL='public.unions';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_messenger_search_messages(uuid,uuid[],text,integer)'::regprocedure AND md5(prosrc)='283bdb9d30568265b49292a7ba97a818' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_messenger_search_messages(uuid,uuid[],text,integer)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_aux_reader_preimage_changed' USING DETAIL='fn_messenger_search_messages(uuid,uuid[],text,integer)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_messenger_accounting_threads(uuid,uuid[])'::regprocedure AND md5(prosrc)='944ea76947c58880e29ab6e010d56fa5' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl) a WHERE p.oid='public.fn_messenger_accounting_threads(uuid,uuid[])'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'correction_document_aux_reader_preimage_changed' USING DETAIL='fn_messenger_accounting_threads(uuid,uuid[])';END IF;
 IF md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure)) IS DISTINCT FROM 'd9a70f1d932538025e656bfe2b4d091d' THEN RAISE EXCEPTION 'correction_document_engine_authority_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_invoice_type_check' AND convalidated AND pg_get_constraintdef(oid)=$vocab$CHECK ((invoice_type = ANY (ARRAY['union_to_club'::text, 'club_to_agent'::text, 'agent_to_subagent'::text, 'agent_to_player'::text, 'union_club_pnl'::text, 'club_to_union'::text, 'union_weekly_squareup'::text, 'union_weekly_credit_note'::text, 'transaction_receipt'::text, 'club_weekly_accounting'::text, 'cashier_cashout'::text])))$vocab$) THEN RAISE EXCEPTION 'correction_document_invoice_vocabulary_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.chip_ledger'::regclass AND tgname='accounting_transfer_document' AND tgenabled='O' AND tgfoid='public.fn_accounting_transfer_document_on_insert()'::regprocedure AND replace(pg_get_triggerdef(oid,true),'public.','')=$trigger$CREATE TRIGGER accounting_transfer_document AFTER INSERT ON chip_ledger FOR EACH ROW WHEN (new.status = 'posted'::text AND ((new.from_type = ANY (ARRAY['union_wallet'::text, 'union_bank'::text, 'club_treasury'::text, 'player_wallet'::text, 'agent_wallet'::text])) OR new.from_type = 'settlement_suspense'::text AND new.category = 'rakeback'::text) AND (new.to_type = ANY (ARRAY['union_wallet'::text, 'union_bank'::text, 'club_treasury'::text, 'player_wallet'::text, 'agent_wallet'::text]))) EXECUTE FUNCTION fn_accounting_transfer_document_on_insert()$trigger$) THEN RAISE EXCEPTION 'correction_document_insert_trigger_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.settlement_invoices'::regclass AND attname='club_id' AND attnotnull AND atttypid='uuid'::regtype)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND confrelid='public.clubs'::regclass AND contype='f' AND convalidated AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.settlement_invoices'::regclass AND attname='club_id')]::smallint[])
 THEN RAISE EXCEPTION 'correction_document_invoice_club_identity_changed';END IF;
END $preimage$;

CREATE TABLE public.accounting_correction_documents(
 id uuid PRIMARY KEY,contract_version smallint NOT NULL CHECK(contract_version=1),
 source_ledger_id uuid NOT NULL UNIQUE REFERENCES public.chip_ledger(id),
 invoice_id uuid NOT NULL UNIQUE REFERENCES public.settlement_invoices(id) DEFERRABLE INITIALLY DEFERRED,
 club_id uuid NOT NULL REFERENCES public.clubs(id),union_id uuid REFERENCES public.unions(id),
 source_club_id uuid,source_union_id uuid,source_row jsonb NOT NULL,
 amount numeric NOT NULL CHECK(amount>0 AND amount<=9999999999.99 AND amount::text NOT IN('NaN','Infinity','-Infinity') AND amount=round(amount,2)),
 issuer_type text NOT NULL CHECK(issuer_type IN('club','union','agent','player')),issuer_id uuid NOT NULL,
 payee_type text NOT NULL CHECK(payee_type IN('club','union','agent','player')),payee_id uuid NOT NULL,
 issuer_representative_id uuid NOT NULL,issuer_name text NOT NULL,payee_name text NOT NULL,audience_user_ids uuid[] NOT NULL,
 incident_id uuid,write_failure_id bigint,
 recorded_at timestamptz NOT NULL,issued_at timestamptz NOT NULL,
 CHECK(incident_id IS NOT NULL OR write_failure_id IS NOT NULL),
 CHECK(isfinite(recorded_at) AND isfinite(issued_at) AND issued_at>=recorded_at AND cardinality(audience_user_ids)>=1)
);
ALTER TABLE public.accounting_correction_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_correction_documents FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_correction_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $function$
BEGIN RAISE EXCEPTION 'correction_document_is_immutable' USING ERRCODE='23514';END $function$;
CREATE TRIGGER correction_document_append_only BEFORE UPDATE OR DELETE ON public.accounting_correction_documents
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_correction_append_only();

-- Called only by the existing private ledger INSERT trigger. A newly inserted
-- row is proven; the function that initiated it is not inferred from metadata.
CREATE FUNCTION public.fn_accounting_correction_prepare(p_ledger_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE l public.chip_ledger%ROWTYPE;c public.clubs%ROWTYPE;u public.unions%ROWTYPE;
 scope uuid;endpoint_clubs uuid[];candidate_unions uuid[];party_kind text;party_id uuid;person uuid;party_name text;side int;
 intended public.accounting_correction_documents%ROWTYPE;surviving public.accounting_correction_documents%ROWTYPE;
 issuer_kind text;issuer_id uuid;sender uuid;issuer_name text;payee_kind text;payee_id uuid;recipient uuid;payee_name text;
 endpoint_type text;endpoint_id uuid;incident uuid;failure bigint;expected_key text;audience uuid[];issuer_users uuid[];payee_users uuid[];issued timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger_id;
 IF l.category IS DISTINCT FROM 'correction' OR l.status IS DISTINCT FROM 'posted'
  OR l.amount IS NULL OR l.amount::text IN('NaN','Infinity','-Infinity') OR l.amount<=0 OR l.amount>9999999999.99 OR l.amount<>round(l.amount,2)
  OR l.created_at IS NULL OR NOT isfinite(l.created_at) OR l.created_at>issued
  OR l.from_type NOT IN('union_bank','union_wallet','club_treasury','agent_wallet','player_wallet')
  OR l.to_type NOT IN('union_bank','union_wallet','club_treasury','agent_wallet','player_wallet')
  OR l.from_entity_id IS NULL OR l.to_entity_id IS NULL
  OR l.table_id IS NOT NULL OR l.hand_id IS NOT NULL OR l.tournament_id IS NOT NULL OR l.settlement_id IS NOT NULL
 THEN RAISE EXCEPTION 'correction_document_source_unverified' USING ERRCODE='23514';END IF;
 -- These are authoritative stored linkage facts, not authentication of the
 -- posted_via marker or proof of the original caller's unrecorded input bytes.
 incident:=NULLIF(l.metadata->>'incident_id','')::uuid;
 failure:=NULLIF(l.metadata->>'write_failure_id','')::bigint;
 expected_key:='correction:'||COALESCE('lwf:'||failure::text,'inc:'||incident::text);
 IF (incident IS NULL AND failure IS NULL) OR l.idempotency_key IS DISTINCT FROM expected_key
  OR (incident IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.ca_drift_incidents WHERE id=incident))
  OR (failure IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.ca_ledger_write_failures WHERE id=failure))
 THEN RAISE EXCEPTION 'correction_document_linkage_unverified' USING ERRCODE='23514';END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO endpoint_clubs FROM unnest(ARRAY[
  CASE WHEN l.from_type='club_treasury' THEN l.from_entity_id END,
  CASE WHEN l.to_type='club_treasury' THEN l.to_entity_id END])x WHERE x IS NOT NULL;
 scope:=l.club_id;
 IF scope IS NULL AND cardinality(endpoint_clubs)=1 THEN scope:=endpoint_clubs[1];END IF;
 IF scope IS NULL OR COALESCE(cardinality(endpoint_clubs),0)>1
  OR EXISTS(SELECT 1 FROM unnest(endpoint_clubs)x WHERE x<>scope)
 THEN RAISE EXCEPTION 'correction_document_club_scope_unverified' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM public.clubs WHERE id=scope FOR SHARE;
 IF NOT FOUND OR c.owner_id IS NULL THEN RAISE EXCEPTION 'correction_document_club_scope_unverified' USING ERRCODE='23514';END IF;
 IF l.union_id IS NOT NULL THEN
  SELECT * INTO u FROM public.unions WHERE id=l.union_id FOR SHARE;
  IF NOT FOUND OR u.owner_id IS NULL THEN RAISE EXCEPTION 'correction_document_union_scope_unverified' USING ERRCODE='23514';END IF;
 END IF;
 FOR side IN 1..2 LOOP
  endpoint_type:=CASE side WHEN 1 THEN l.from_type ELSE l.to_type END;
  endpoint_id:=CASE side WHEN 1 THEN l.from_entity_id ELSE l.to_entity_id END;
  IF endpoint_type IN('union_bank','union_wallet') THEN
   SELECT array_agg(DISTINCT id ORDER BY id) INTO candidate_unions FROM (
    SELECT x.id FROM public.unions x WHERE x.id=endpoint_id
    UNION SELECT w.union_id FROM public.union_wallets w WHERE w.id=endpoint_id)matches;
   IF l.union_id IS NULL OR cardinality(candidate_unions) IS DISTINCT FROM 1 OR candidate_unions[1] IS DISTINCT FROM l.union_id
   THEN RAISE EXCEPTION 'correction_document_union_identity_unverified' USING ERRCODE='23514';END IF;
   party_kind:='union';party_id:=l.union_id;person:=u.owner_id;party_name:=COALESCE(NULLIF(btrim(u.name),''),'Union');
  ELSIF endpoint_type='club_treasury' THEN
   party_kind:='club';party_id:=scope;person:=c.owner_id;party_name:=COALESCE(NULLIF(btrim(c.name),''),'Club');
  ELSE
   party_kind:=CASE endpoint_type WHEN 'agent_wallet' THEN 'agent' ELSE 'player' END;
   party_id:=endpoint_id;person:=endpoint_id;
   SELECT COALESCE(NULLIF(btrim(p.username),''),'Member') INTO party_name FROM public.profiles p WHERE p.id=person;
  END IF;
  IF person IS NULL OR party_name IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=person)
  THEN RAISE EXCEPTION 'correction_document_recipient_unverified' USING ERRCODE='23514';END IF;
  IF side=1 THEN issuer_kind:=party_kind;issuer_id:=party_id;sender:=person;issuer_name:=party_name;
  ELSE payee_kind:=party_kind;payee_id:=party_id;recipient:=person;payee_name:=party_name;END IF;
 END LOOP;
 -- A club must not receive each individual's correction as a back door into
 -- weekly rakeback detail. The sender remains a real conversation participant.
 SELECT array_agg(user_id ORDER BY user_id) INTO issuer_users FROM public.fn_accounting_party_users(issuer_kind,issuer_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO payee_users FROM public.fn_accounting_party_users(payee_kind,payee_id);
 IF COALESCE(cardinality(issuer_users),0)=0 OR COALESCE(cardinality(payee_users),0)=0
  OR sender=ANY(issuer_users) IS NOT TRUE OR recipient=ANY(payee_users) IS NOT TRUE
 THEN RAISE EXCEPTION 'correction_document_recipient_unverified' USING ERRCODE='23514';END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO audience FROM unnest(
  CASE WHEN issuer_kind='club' AND payee_kind IN('agent','player') THEN payee_users ELSE issuer_users||payee_users END)x;
 intended:=ROW(gen_random_uuid(),1,l.id,gen_random_uuid(),scope,l.union_id,l.club_id,l.union_id,to_jsonb(l),l.amount,
  issuer_kind,issuer_id,payee_kind,payee_id,sender,issuer_name,payee_name,audience,incident,failure,l.created_at,issued)::public.accounting_correction_documents;
 INSERT INTO public.accounting_correction_documents SELECT intended.*;
 SELECT * INTO surviving FROM public.accounting_correction_documents WHERE id=intended.id;
 IF NOT FOUND OR to_jsonb(surviving) IS DISTINCT FROM to_jsonb(intended)
 THEN RAISE EXCEPTION 'correction_document_provenance_write_missing' USING ERRCODE='23514';END IF;
END $function$;

CREATE FUNCTION public.fn_accounting_correction_payload(d public.accounting_correction_documents) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
 SELECT jsonb_build_object('contract_version',1,'document_id',d.id,'invoice_id',d.invoice_id,'source_ledger_id',d.source_ledger_id,
  'event_kind','correction_recorded','display_state','recorded','amount',round(d.amount,2)::text,'club_id',d.club_id,'union_id',d.union_id,
  'recorded_at',d.recorded_at,'issued_at',d.issued_at,'payment_proven',false,'new_chip_movement_claimed',false,'original_payment_invoice_id',NULL);
$function$;

CREATE FUNCTION public.fn_accounting_correction_document_body(p_document_id uuid,p_invoice_number text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE d public.accounting_correction_documents%ROWTYPE;BEGIN
 SELECT * INTO STRICT d FROM public.accounting_correction_documents WHERE id=p_document_id;
 RETURN 'Correction Recorded · '||p_invoice_number||E'\nIssued By: '||d.issuer_name||E'\nFor: '||d.payee_name
  ||E'\nCorrection Amount: '||to_char(d.amount,'FM999,999,999,999,990.00')||' Chips'
  ||E'\nA correction was recorded in the accounting journal. This record does not establish a new chip payment.'
  ||E'\nRecorded: '||d.recorded_at::text||E'\nIssued: '||d.issued_at::text;
END $function$;

CREATE FUNCTION public.fn_accounting_correction_contract(p_invoice_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE d public.accounting_correction_documents%ROWTYPE;i public.settlement_invoices%ROWTYPE;l public.chip_ledger%ROWTYPE;payload jsonb;
BEGIN
 SELECT * INTO d FROM public.accounting_correction_documents WHERE invoice_id=p_invoice_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'correction_document_provenance_missing' USING ERRCODE='23514';END IF;
 SELECT * INTO i FROM public.settlement_invoices WHERE id=p_invoice_id;
 SELECT * INTO l FROM public.chip_ledger WHERE id=d.source_ledger_id;
 payload:=public.fn_accounting_correction_payload(d);
 IF l.id IS NULL OR to_jsonb(l) IS DISTINCT FROM d.source_row OR l.category IS DISTINCT FROM 'correction' OR l.status IS DISTINCT FROM 'posted'
  OR l.amount IS DISTINCT FROM d.amount OR l.club_id IS DISTINCT FROM d.source_club_id OR l.union_id IS DISTINCT FROM d.source_union_id
  OR l.created_at IS DISTINCT FROM d.recorded_at
  OR l.idempotency_key IS DISTINCT FROM 'correction:'||COALESCE('lwf:'||d.write_failure_id::text,'inc:'||d.incident_id::text)
  OR NOT EXISTS(SELECT 1 FROM public.chip_ledger_idem k WHERE k.leg_id=l.id AND k.idempotency_key=l.idempotency_key)
  OR i.id IS NULL OR i.invoice_type IS DISTINCT FROM 'accounting_correction' OR i.club_id IS DISTINCT FROM d.club_id
  OR i.source_ledger_id IS DISTINCT FROM d.source_ledger_id OR i.period_id IS NOT NULL
  OR i.from_entity_type IS DISTINCT FROM d.issuer_type OR i.from_entity_id IS DISTINCT FROM d.issuer_id::text
  OR i.to_entity_type IS DISTINCT FROM d.payee_type OR i.to_entity_id IS DISTINCT FROM d.payee_id::text
  OR i.gross_amount IS DISTINCT FROM d.amount OR i.net_amount IS DISTINCT FROM d.amount OR i.deductions IS DISTINCT FROM 0
  OR i.status IS DISTINCT FROM 'generated' OR i.chips_transferred IS DISTINCT FROM false OR i.transferred_at IS NOT NULL
  OR i.due_at IS NOT NULL OR i.chip_transfer_id IS NOT NULL OR i.adjusts_invoice_id IS NOT NULL
  OR i.source_credit_invoice_id IS NOT NULL OR i.source_credit_payment_id IS NOT NULL
  OR i.overdue_at IS NOT NULL OR i.reminders_sent IS DISTINCT FROM 0 OR i.last_reminder_at IS NOT NULL
  OR i.notes IS NOT NULL OR i.created_at IS DISTINCT FROM d.issued_at
  OR i.breakdown IS DISTINCT FROM jsonb_build_object('category','correction','correction',payload)
 THEN RAISE EXCEPTION 'correction_document_provenance_mismatch' USING ERRCODE='23514';END IF;
 RETURN payload;
END $function$;

CREATE FUNCTION public.fn_accounting_correction_assert_delivery(p_document_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE c public.accounting_correction_documents%ROWTYPE;i public.settlement_invoices%ROWTYPE;
 d record;payload jsonb;actual_users uuid[];expected_body text;expected_meta jsonb;
BEGIN
 SELECT * INTO STRICT c FROM public.accounting_correction_documents WHERE id=p_document_id;
 payload:=public.fn_accounting_correction_contract(c.invoice_id);
 SELECT * INTO STRICT i FROM public.settlement_invoices WHERE id=c.invoice_id;
 expected_body:=public.fn_accounting_correction_document_body(c.id,i.invoice_number);
 SELECT array_agg(recipient_id ORDER BY recipient_id) INTO actual_users FROM public.accounting_invoice_deliveries WHERE invoice_id=c.invoice_id;
 IF actual_users IS DISTINCT FROM c.audience_user_ids OR i.invoice_number IS NULL OR i.message_sent IS DISTINCT FROM true OR i.message_sent_at IS NULL
 THEN RAISE EXCEPTION 'correction_document_delivery_missing' USING ERRCODE='23514';END IF;
 FOR d IN SELECT a.*,m.conversation_id,m.sender_id,m.content,m.message_type,m.media_metadata,
   n.user_id AS notice_user,n.type AS notice_type,n.data AS notice_data,n.metadata AS notice_metadata,
   n.title AS notice_title,n.message AS notice_message,n.action_url AS notice_url
  FROM public.accounting_invoice_deliveries a LEFT JOIN public.social_messages m ON m.id=a.message_id
  LEFT JOIN public.notifications n ON n.id=a.notification_id WHERE a.invoice_id=c.invoice_id LOOP
  expected_meta:=jsonb_build_object('kind','accounting_invoice','invoice_id',i.id,'invoice_number',i.invoice_number,
   'club_id',i.club_id,'source_ledger_id',i.source_ledger_id,'source_credit_invoice_id',NULL,'source_credit_payment_id',NULL,
   'amount',i.net_amount,'currency','CHIPS','conversationId',d.conversation_id,'conversation_id',d.conversation_id,
   'status','generated','invoice_type','accounting_correction','from_entity_type',i.from_entity_type,'from_entity_id',i.from_entity_id,
   'to_entity_type',i.to_entity_type,'to_entity_id',i.to_entity_id,'lines',i.breakdown,'correction',payload);
  IF d.delivery_mode IS DISTINCT FROM 'immediate' OR d.sender_id IS DISTINCT FROM c.issuer_representative_id
   OR d.message_type IS DISTINCT FROM 'invoice' OR d.content IS DISTINCT FROM expected_body
   OR d.media_metadata IS DISTINCT FROM expected_meta
   OR d.media_metadata->>'invoice_id' IS DISTINCT FROM c.invoice_id::text OR d.media_metadata->'correction' IS DISTINCT FROM payload
   OR d.media_metadata->>'invoice_type' IS DISTINCT FROM 'accounting_correction' OR d.media_metadata->'amount' IS DISTINCT FROM to_jsonb(i.net_amount)
   OR d.media_metadata->'lines' IS DISTINCT FROM i.breakdown OR d.media_metadata ?| ARRAY['incident_id','write_failure_id','reason','actor_user_id','wallet_before','wallet_after']
   OR d.notice_user IS DISTINCT FROM d.recipient_id OR d.notice_type IS DISTINCT FROM 'accounting_invoice'
   OR d.notice_metadata IS DISTINCT FROM d.media_metadata OR d.notice_data IS DISTINCT FROM d.media_metadata
   OR d.notice_title IS DISTINCT FROM 'Correction Recorded · '||i.invoice_number
   OR d.notice_message IS DISTINCT FROM 'Correction Recorded: '||to_char(i.net_amount,'FM999,999,999,999,990.00')||' Chips'
   OR d.notice_url IS DISTINCT FROM '/hub/messenger?conversation='||d.conversation_id::text
   OR NOT EXISTS(SELECT 1 FROM public.accounting_conversations x WHERE x.conversation_id=d.conversation_id
      AND x.scope_id=c.club_id AND x.issuer_type=c.issuer_type AND x.issuer_id=c.issuer_id
      AND x.sender_id=c.issuer_representative_id AND x.recipient_id=d.recipient_id)
   OR EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id<>ALL(ARRAY[c.issuer_representative_id,d.recipient_id]))
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id=d.recipient_id)
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id=c.issuer_representative_id)
  THEN RAISE EXCEPTION 'correction_document_delivery_mismatch' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN payload;
END $function$;

-- A legacy row can establish its identity without establishing payment. Raw
-- table readers deny it; only recipient-bound private readers get a placeholder.
CREATE FUNCTION public.fn_accounting_correction_is_unverified(p_invoice_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 SELECT EXISTS(SELECT 1 FROM public.settlement_invoices i JOIN public.chip_ledger l ON l.id=i.source_ledger_id
  WHERE i.id=p_invoice_id AND l.category='correction' AND (i.invoice_type<>'accounting_correction'
   OR NOT EXISTS(SELECT 1 FROM public.accounting_correction_documents d WHERE d.invoice_id=i.id AND d.source_ledger_id=l.id)));
$function$;

CREATE FUNCTION public.fn_accounting_correction_legacy_identity(p_message_id uuid,p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE linked record;l public.chip_ledger%ROWTYPE;
BEGIN
 IF p_user_id IS NULL OR (NOT public.fn_caller_is_engine() AND auth.uid() IS DISTINCT FROM p_user_id) THEN RETURN NULL;END IF;
 -- Verify this viewer's exact original recipient delivery before inspecting
 -- the source category. Participation/issuer status alone grants no identity.
 SELECT i.id,i.invoice_type,i.source_ledger_id,i.club_id,i.from_entity_type,i.from_entity_id,i.to_entity_type,i.to_entity_id
 INTO linked FROM public.accounting_invoice_deliveries d
 JOIN public.social_messages m ON m.id=d.message_id
 JOIN public.settlement_invoices i ON i.id=d.invoice_id
 JOIN public.accounting_conversations c ON c.conversation_id=m.conversation_id AND c.recipient_id=d.recipient_id AND c.sender_id=m.sender_id
 WHERE d.message_id=p_message_id AND d.recipient_id=p_user_id AND d.delivery_mode='immediate'
  AND m.message_type='invoice' AND NOT COALESCE(m.is_deleted,false)
  AND m.media_metadata->>'invoice_id'=i.id::text
  AND c.issuer_type=i.from_entity_type AND c.issuer_id::text=i.from_entity_id
  AND c.scope_id=i.club_id
  AND EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=m.conversation_id AND p.user_id=p_user_id)
  AND EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=m.conversation_id AND p.user_id=m.sender_id)
  AND NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=m.conversation_id AND p.user_id<>ALL(ARRAY[m.sender_id,p_user_id]));
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO l FROM public.chip_ledger WHERE id=linked.source_ledger_id;
 IF NOT FOUND OR l.category IS DISTINCT FROM 'correction'
  OR (linked.invoice_type='accounting_correction' AND EXISTS(SELECT 1 FROM public.accounting_correction_documents d
     WHERE d.invoice_id=linked.id AND d.source_ledger_id=l.id)) THEN RETURN NULL;END IF;
 IF linked.club_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=linked.club_id)
  OR (l.club_id IS NOT NULL AND l.club_id IS DISTINCT FROM linked.club_id)
  OR (l.from_type='club_treasury' AND l.from_entity_id IS DISTINCT FROM linked.club_id)
  OR (l.to_type='club_treasury' AND l.to_entity_id IS DISTINCT FROM linked.club_id)
  OR (l.club_id IS NULL AND l.from_type<>'club_treasury' AND l.to_type<>'club_treasury')
 THEN RETURN NULL;END IF;
 -- Old generic delivery may have included an issuer. For an individual club
 -- correction only the exact recorded physical payee can see even a placeholder.
 IF (l.from_type='club_treasury' AND l.to_type IN('agent_wallet','player_wallet'))
   OR (linked.from_entity_type='club' AND linked.to_entity_type IN('agent','player')) THEN
  IF l.from_type IS DISTINCT FROM 'club_treasury' OR l.to_type NOT IN('agent_wallet','player_wallet')
   OR l.to_entity_id IS DISTINCT FROM p_user_id OR linked.to_entity_id IS DISTINCT FROM p_user_id::text
   OR linked.from_entity_type IS DISTINCT FROM 'club' OR linked.from_entity_id IS DISTINCT FROM l.from_entity_id::text
   OR linked.to_entity_type NOT IN('agent','player') THEN RETURN NULL;END IF;
 END IF;
 RETURN jsonb_build_object('kind','accounting_invoice','invoice_identity_verified',true,'correction_unverified',true,
  'accounting_verified',false,'correction_verified',false,'invoice_id',linked.id,'invoice_type',linked.invoice_type,
  'source_ledger_id',l.id,'club_id',linked.club_id,'union_id',l.union_id);
END $function$;

ALTER TABLE public.settlement_invoices DROP CONSTRAINT settlement_invoices_invoice_type_check;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT settlement_invoices_invoice_type_check CHECK(invoice_type=ANY(ARRAY['union_to_club','club_to_agent','agent_to_subagent','agent_to_player','union_club_pnl','club_to_union','union_weekly_squareup','union_weekly_credit_note','transaction_receipt','club_weekly_accounting','cashier_cashout','accounting_correction']));

CREATE OR REPLACE FUNCTION public.fn_accounting_transfer_document_on_insert()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NEW.category='correction' THEN PERFORM public.fn_accounting_correction_prepare(NEW.id);END IF;
 PERFORM public.fn_invoice_accounting_ledger_transfer(NEW.id);
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_transfer_document_on_insert() FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION public.fn_invoice_accounting_ledger_transfer(p_ledger_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE leg public.chip_ledger%ROWTYPE; inv_id uuid; issuer_kind text; issuer_id uuid; payee_kind text; payee_id uuid; kind text; recorded_role text; routed boolean; correction public.accounting_correction_documents%ROWTYPE;
BEGIN
 SELECT * INTO leg FROM public.chip_ledger WHERE id=p_ledger_id;
 IF NOT FOUND OR leg.status IS DISTINCT FROM 'posted' OR leg.amount IS NULL OR leg.amount<=0
    OR leg.amount::text IN('NaN','Infinity','-Infinity') OR leg.amount<>round(leg.amount,2)
 THEN RAISE EXCEPTION 'invalid_accounting_transfer' USING ERRCODE='23514'; END IF;
 IF leg.category='correction' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('accounting_ledger_invoice:'||leg.id::text,0));
  SELECT * INTO correction FROM public.accounting_correction_documents WHERE source_ledger_id=leg.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'historical_correction_document_unverified' USING ERRCODE='23514';END IF;
  SELECT id INTO inv_id FROM public.settlement_invoices WHERE source_ledger_id=leg.id;
  IF inv_id IS NOT NULL THEN
   IF inv_id IS DISTINCT FROM correction.invoice_id THEN RAISE EXCEPTION 'correction_document_invoice_collision' USING ERRCODE='23514';END IF;
   PERFORM public.fn_accounting_correction_assert_delivery(correction.id);
   RETURN inv_id;
  END IF;
  INSERT INTO public.settlement_invoices(id,club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,due_at,notes,source_ledger_id,created_at)
  VALUES(correction.invoice_id,correction.club_id,'accounting_correction',correction.issuer_type,correction.issuer_id::text,
    correction.payee_type,correction.payee_id::text,correction.amount,correction.amount,0,
    jsonb_build_object('category','correction','correction',public.fn_accounting_correction_payload(correction)),
    'generated',false,NULL,NULL,NULL,leg.id,correction.issued_at) RETURNING id INTO inv_id;
  IF NOT FOUND OR inv_id IS DISTINCT FROM correction.invoice_id THEN RAISE EXCEPTION 'correction_document_invoice_write_missing' USING ERRCODE='23514';END IF;
  PERFORM public.fn_deliver_accounting_invoice(inv_id);
  PERFORM public.fn_accounting_correction_assert_delivery(correction.id);
  RETURN inv_id;
 END IF;
 routed:=COALESCE(leg.metadata->>'routing_version'='3'
  AND current_setting('app.accounting_routing_context',true)=
   CASE WHEN leg.union_id IS NOT NULL THEN leg.union_id::text
    WHEN leg.metadata->>'accounting_scope_kind'='club' AND leg.metadata->>'accounting_scope_id'=leg.club_id::text
     THEN 'club:'||leg.club_id::text END
   ||':'||((leg.metadata->>'period_start')::timestamptz)::text||':'||((leg.metadata->>'period_end')::timestamptz)::text,false);
 recorded_role:=CASE WHEN routed THEN leg.metadata->>'payee_role_at_transfer' END;
 IF routed AND leg.to_type IN('player_wallet','agent_wallet') AND (recorded_role IS NULL OR recorded_role NOT IN('player','sub_agent','agent','super_agent')) THEN
  RAISE EXCEPTION 'routed_payment_recipient_role_missing' USING ERRCODE='23514'; END IF;

 IF leg.from_type IN('union_wallet','union_bank') THEN issuer_kind:='union';issuer_id:=leg.from_entity_id;
 ELSIF leg.from_type='club_treasury' THEN issuer_kind:='club';issuer_id:=leg.from_entity_id;
 ELSIF leg.from_type IN('player_wallet','agent_wallet') THEN issuer_id:=leg.from_entity_id;
   issuer_kind:=CASE WHEN routed OR leg.from_type='agent_wallet' OR EXISTS(SELECT 1 FROM public.agents a WHERE a.user_id=issuer_id AND a.club_id=leg.club_id) THEN 'agent' ELSE 'player' END;
 ELSIF leg.from_type='settlement_suspense' AND leg.category='rakeback' AND leg.club_id IS NOT NULL THEN
   -- Club-issued receipt for the existing clearing-account leg; preserve its actual source in breakdown.
   issuer_kind:='club';issuer_id:=leg.club_id;
 ELSE RAISE EXCEPTION 'unsupported_accounting_transfer_source' USING ERRCODE='23514'; END IF;
 -- Game payout journals retain the physical union_wallets.id store identity.
 -- Accounting parties use unions.id. Resolve only a matching, declared host;
 -- never rewrite the original journal or infer a different union.
 IF leg.category IN('wheel_prize','plinko_prize','crash_prize','crossing_prize','mines_prize')
    AND issuer_kind='union' AND leg.union_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.id=issuer_id AND w.union_id=leg.union_id)
 THEN issuer_id:=leg.union_id; END IF;
 IF leg.to_type IN('union_wallet','union_bank') THEN payee_kind:='union';payee_id:=leg.to_entity_id;
 ELSIF leg.to_type='club_treasury' THEN payee_kind:='club';payee_id:=leg.to_entity_id;
 ELSIF leg.to_type IN('player_wallet','agent_wallet') THEN
   payee_id:=leg.to_entity_id;
   payee_kind:=CASE WHEN routed THEN CASE WHEN recorded_role='player' THEN 'player' ELSE 'agent' END WHEN leg.category='commission' OR EXISTS(SELECT 1 FROM public.agents a WHERE a.user_id=payee_id AND a.club_id=leg.club_id) THEN 'agent' ELSE 'player' END;
 ELSE RAISE EXCEPTION 'unsupported_accounting_transfer_recipient' USING ERRCODE='23514'; END IF;
 kind:=CASE WHEN issuer_kind='union' AND payee_kind='club' THEN 'union_to_club'
            WHEN issuer_kind='club' AND payee_kind='agent' THEN 'club_to_agent'
            WHEN issuer_kind='agent' AND payee_kind='agent' THEN 'agent_to_subagent'
            WHEN issuer_kind='agent' AND payee_kind='player' THEN 'agent_to_player' ELSE 'transaction_receipt' END;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_ledger_invoice:'||leg.id::text,0));
 SELECT id INTO inv_id FROM public.settlement_invoices WHERE source_ledger_id=leg.id;
 IF inv_id IS NULL THEN
   INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,notes,source_ledger_id)
   VALUES(COALESCE(leg.club_id,leg.union_id),kind,issuer_kind,issuer_id::text,payee_kind,payee_id::text,leg.amount,leg.amount,0,
    COALESCE(leg.metadata,'{}'::jsonb)||jsonb_build_object('ledger_id',leg.id,'category',leg.category,'ledger_from_type',leg.from_type,
      'ledger_from_entity_id',leg.from_entity_id,'ledger_to_type',leg.to_type,'ledger_to_entity_id',leg.to_entity_id,
      'payee_role_at_transfer',CASE WHEN routed AND recorded_role IS NOT NULL THEN recorded_role WHEN payee_kind='player' THEN 'player' ELSE (SELECT a.role FROM public.agents a WHERE a.user_id=payee_id AND a.club_id=leg.club_id ORDER BY a.id LIMIT 1) END),
    'paid',true,leg.created_at,'Receipt For A Posted Accounting Transfer. This Does Not Certify The Entire Weekly Close.',leg.id)
   RETURNING id INTO inv_id;
 END IF;
 PERFORM public.fn_deliver_accounting_invoice(inv_id);
 RETURN inv_id;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_deliver_accounting_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_variable
DECLARE inv public.settlement_invoices%ROWTYPE; sender uuid; issuer_name text; recipient_name text;
 issuer_kind text; issuer_id uuid; recipient_id uuid; scope_id uuid; page_id uuid; users uuid[]; issuer_users uuid[]; recipient_users uuid[];
 person uuid; conv uuid; msg uuid; note uuid; body text; meta jsonb; count_sent int:=0; n int; line record; cashier public.accounting_cashier_events%ROWTYPE; cashier_payload jsonb; correction public.accounting_correction_documents%ROWTYPE; correction_payload jsonb;
BEGIN
 SELECT * INTO inv FROM public.settlement_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_invoice_missing' USING ERRCODE='23514'; END IF;
 IF public.fn_accounting_correction_is_unverified(inv.id)
 THEN RAISE EXCEPTION 'historical_correction_document_unverified' USING ERRCODE='23514';END IF;
 IF inv.net_amount IS NULL OR inv.net_amount::text IN('NaN','Infinity','-Infinity') OR inv.net_amount<>round(inv.net_amount,2)
 THEN RAISE EXCEPTION 'invalid_invoice_amount' USING ERRCODE='23514'; END IF;
 issuer_kind:=inv.from_entity_type; issuer_id:=inv.from_entity_id::uuid; recipient_id:=inv.to_entity_id::uuid;
 scope_id:=COALESCE(inv.club_id,issuer_id);
 IF inv.invoice_type='accounting_correction' THEN
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
 IF inv.invoice_type='cashier_cashout' THEN body:=public.fn_cashier_document_body(cashier.id,inv.invoice_number);
 ELSIF inv.invoice_type='accounting_correction' THEN body:=public.fn_accounting_correction_document_body(correction.id,inv.invoice_number);END IF;
 meta:=jsonb_build_object('kind','accounting_invoice' ,'invoice_id',inv.id,'invoice_number',inv.invoice_number,
   'club_id',inv.club_id,'source_ledger_id',inv.source_ledger_id,'source_credit_invoice_id',inv.source_credit_invoice_id,
   'source_credit_payment_id',inv.source_credit_payment_id,'amount',inv.net_amount,'currency','CHIPS','conversationId',NULL,'status',inv.status,
   'invoice_type',inv.invoice_type,'from_entity_type',inv.from_entity_type,'from_entity_id',inv.from_entity_id,
   'to_entity_type',inv.to_entity_type,'to_entity_id',inv.to_entity_id,'lines',inv.breakdown-'source_ledger_ids');
 IF inv.invoice_type='cashier_cashout' THEN meta:=meta||jsonb_build_object('cashier',cashier_payload);
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
   IF inv.invoice_type IN('cashier_cashout','accounting_correction') THEN meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);END IF;
   INSERT INTO public.social_messages(conversation_id,sender_id,content,message_type,media_metadata)
    VALUES(conv,sender,body,'invoice',meta) RETURNING id INTO msg;
   UPDATE public.social_conversations SET last_message_at=now(),last_message_preview=left(body,100),updated_at=now() WHERE id=conv;
   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);
   INSERT INTO public.notifications(user_id,type,title,message,data,read,action_url,metadata)
    VALUES(person,'accounting_invoice',CASE WHEN inv.invoice_type='accounting_correction' THEN 'Correction Recorded · ' WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held · ' WHEN 'approval' THEN 'Cashout Approved · ' ELSE 'Chips Returned · ' END WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number,
     CASE WHEN inv.invoice_type='accounting_correction' THEN 'Correction Recorded: ' WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held: ' WHEN 'approval' THEN 'Cashout Approved: ' ELSE 'Chips Returned: ' END WHEN inv.chips_transferred AND inv.breakdown->>'category'='rakeback' THEN 'Rakeback Transfer Recorded: ' WHEN inv.chips_transferred AND inv.breakdown->>'category'='commission' THEN 'Commission Transfer Recorded: ' WHEN inv.chips_transferred THEN 'Transfer Recorded: ' ELSE 'Invoice Issued: ' END||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips',
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
   IF receipt.invoice_type IN('cashier_cashout','accounting_correction') AND ROW(existing.title,existing.body,existing.url,existing.tag) IS DISTINCT FROM
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
  IF receipt.invoice_type IN('cashier_cashout','accounting_correction') AND NOT EXISTS(SELECT 1 FROM public.push_outbox o
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

DO $readers$ DECLARE definition text;anchor text;replacement text;BEGIN
 definition:=pg_get_functiondef('public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)'::regprocedure);
 anchor:=$old$(COALESCE(m.media_metadata,'{}')-ARRAY['cashier','cashier_verified'])||CASE WHEN i.id IS NULL
     THEN jsonb_build_object('accounting_verified',false,'cashier_verified',false)
     ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
       'status',i.status,'chips_transferred',i.chips_transferred,'invoice_type',i.invoice_type,
       'source_ledger_id',i.source_ledger_id,'club_id',i.club_id,
       'cashier_verified',i.invoice_type='cashier_cashout')||CASE WHEN i.invoice_type='cashier_cashout'
        THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'cashier',public.fn_cashier_invoice_contract(i.id)) ELSE '{}'::jsonb END END$old$;replacement:=$new$CASE WHEN legacy.identity IS NOT NULL THEN legacy.identity ELSE
 (COALESCE(m.media_metadata,'{}')-ARRAY['cashier','cashier_verified','correction','correction_verified','correction_unverified','invoice_identity_verified'])
 ||CASE WHEN i.id IS NULL THEN jsonb_build_object('accounting_verified',false,'cashier_verified',false,'correction_verified',false)
 ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
  'status',i.status,'chips_transferred',i.chips_transferred,'invoice_type',i.invoice_type,'source_ledger_id',i.source_ledger_id,'club_id',i.club_id,
  'cashier_verified',i.invoice_type='cashier_cashout','correction_verified',i.invoice_type='accounting_correction')
 ||CASE WHEN i.invoice_type='cashier_cashout' THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'cashier',public.fn_cashier_invoice_contract(i.id))
 WHEN i.invoice_type='accounting_correction' THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'due_at',i.due_at,'transferred_at',i.transferred_at,
  'union_id',(SELECT c.union_id FROM public.accounting_correction_documents c WHERE c.invoice_id=i.id),
  'correction',public.fn_accounting_correction_contract(i.id)) ELSE '{}'::jsonb END END END$new$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_projection_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='m.id,m.conversation_id,m.sender_id,m.content';replacement:='m.id,m.conversation_id,m.sender_id,CASE WHEN legacy.identity IS NOT NULL THEN ''Correction receipt unavailable.'' ELSE m.content END';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_content_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='LEFT JOIN public.settlement_invoices i ON i.id=d.invoice_id';replacement:=anchor||E'\n LEFT JOIN LATERAL(SELECT public.fn_accounting_correction_legacy_identity(m.id,p_user_id) AS identity) legacy ON true';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_identity_join_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='AND public.fn_messenger_message_visible_to(m.id,p_user_id)';replacement:='AND (public.fn_messenger_message_visible_to(m.id,p_user_id) OR legacy.identity IS NOT NULL)';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_identity_filter_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 EXECUTE definition;
 definition:=pg_get_functiondef('public.fn_messenger_search_messages(uuid,uuid[],text,integer)'::regprocedure);
 anchor:=$old$COALESCE(m.media_metadata,'{}')||CASE WHEN i.id IS NULL THEN jsonb_build_object('accounting_verified',false)
     ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
       'status',i.status,'chips_transferred',i.chips_transferred) END$old$;replacement:=$new$CASE WHEN legacy.identity IS NOT NULL THEN legacy.identity ELSE
 (COALESCE(m.media_metadata,'{}')-ARRAY['cashier','cashier_verified','correction','correction_verified','correction_unverified','invoice_identity_verified'])
 ||CASE WHEN i.id IS NULL THEN jsonb_build_object('accounting_verified',false,'cashier_verified',false,'correction_verified',false)
 ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
  'status',i.status,'chips_transferred',i.chips_transferred,'invoice_type',i.invoice_type,'source_ledger_id',i.source_ledger_id,'club_id',i.club_id,
  'cashier_verified',i.invoice_type='cashier_cashout','correction_verified',i.invoice_type='accounting_correction')
 ||CASE WHEN i.invoice_type='cashier_cashout' THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'cashier',public.fn_cashier_invoice_contract(i.id))
 WHEN i.invoice_type='accounting_correction' THEN jsonb_build_object('amount',round(i.net_amount,2)::text,'due_at',i.due_at,'transferred_at',i.transferred_at,
  'union_id',(SELECT c.union_id FROM public.accounting_correction_documents c WHERE c.invoice_id=i.id),
  'correction',public.fn_accounting_correction_contract(i.id)) ELSE '{}'::jsonb END END END$new$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_projection_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='m.id,m.conversation_id,m.sender_id,m.content';replacement:='m.id,m.conversation_id,m.sender_id,CASE WHEN legacy.identity IS NOT NULL THEN ''Correction receipt unavailable.'' ELSE m.content END';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_content_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='LEFT JOIN public.settlement_invoices i ON i.id=d.invoice_id';replacement:=anchor||E'\n LEFT JOIN LATERAL(SELECT public.fn_accounting_correction_legacy_identity(m.id,p_user_id) AS identity) legacy ON true';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_identity_join_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='AND public.fn_messenger_message_visible_to(m.id,p_user_id)';replacement:='AND (public.fn_messenger_message_visible_to(m.id,p_user_id) OR legacy.identity IS NOT NULL)';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_identity_filter_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='strpos(lower(m.content),lower(btrim(p_query)))>0';replacement:='strpos(lower(CASE WHEN legacy.identity IS NOT NULL THEN ''Correction receipt unavailable.'' ELSE m.content END),lower(btrim(p_query)))>0';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_search_text_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 EXECUTE definition;
 definition:=pg_get_functiondef('public.fn_messenger_accounting_threads(uuid,uuid[])'::regprocedure);
 anchor:='LEFT JOIN LATERAL(SELECT m.content,m.created_at FROM public.social_messages m';replacement:='LEFT JOIN LATERAL(SELECT CASE WHEN legacy.identity IS NOT NULL THEN ''Correction receipt unavailable.'' ELSE m.content END AS content,m.created_at FROM public.social_messages m';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_thread_content_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='LEFT JOIN public.accounting_invoice_deliveries d ON d.message_id=m.id';replacement:=anchor||E'\n   LEFT JOIN LATERAL(SELECT public.fn_accounting_correction_legacy_identity(m.id,p_user_id) AS identity) legacy ON true';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_thread_identity_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='AND public.fn_messenger_message_visible_to(m.id,p_user_id)';replacement:='AND (public.fn_messenger_message_visible_to(m.id,p_user_id) OR legacy.identity IS NOT NULL)';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_thread_filter_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);
 anchor:='d.recipient_id=p_user_id AND d.delivery_mode=''immediate'' AND COALESCE(m.is_deleted,false)=false';replacement:=anchor||' AND (public.fn_messenger_message_visible_to(m.id,p_user_id) OR public.fn_accounting_correction_legacy_identity(m.id,p_user_id) IS NOT NULL)';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_thread_recipient_anchor_changed';END IF;definition:=replace(definition,anchor,replacement);EXECUTE definition;
 definition:=pg_get_functiondef('public.fn_messenger_invoice_visible_to(uuid,uuid)'::regprocedure);anchor:='WHERE i.id=p_invoice_id';
 replacement:=anchor||E'\n   AND NOT public.fn_accounting_correction_is_unverified(i.id)\n   AND (i.invoice_type<>''accounting_correction'' OR EXISTS(SELECT 1 FROM public.accounting_correction_documents cd JOIN public.accounting_invoice_deliveries d ON d.invoice_id=cd.invoice_id AND d.recipient_id=p_user_id AND d.delivery_mode=''immediate'' WHERE cd.invoice_id=i.id AND p_user_id=ANY(cd.audience_user_ids)))';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'correction_document_visibility_anchor_changed';END IF;EXECUTE replace(definition,anchor,replacement);
END $readers$;

REVOKE ALL ON FUNCTION public.fn_accounting_correction_prepare(uuid),public.fn_accounting_correction_append_only(),public.fn_accounting_correction_payload(public.accounting_correction_documents),public.fn_accounting_correction_document_body(uuid,text),public.fn_accounting_correction_contract(uuid),public.fn_accounting_correction_assert_delivery(uuid),public.fn_accounting_correction_is_unverified(uuid),public.fn_accounting_correction_legacy_identity(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

DO $authority$ DECLARE who text;sig text;col text;BEGIN
 FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
 IF has_table_privilege(who,'public.accounting_correction_documents','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN') THEN RAISE EXCEPTION 'correction_document_private_table_exposed';END IF;
 FOREACH sig IN ARRAY ARRAY['public.fn_accounting_correction_prepare(uuid)','public.fn_accounting_correction_append_only()','public.fn_accounting_correction_payload(public.accounting_correction_documents)','public.fn_accounting_correction_document_body(uuid,text)','public.fn_accounting_correction_contract(uuid)','public.fn_accounting_correction_assert_delivery(uuid)','public.fn_accounting_correction_is_unverified(uuid)','public.fn_accounting_correction_legacy_identity(uuid,uuid)'] LOOP IF has_function_privilege(who,sig,'EXECUTE') THEN RAISE EXCEPTION 'correction_document_private_helper_exposed' USING DETAIL=who||':'||sig;END IF;END LOOP;
 FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='public.accounting_correction_documents'::regclass AND attnum>0 AND NOT attisdropped LOOP IF has_column_privilege(who,'public.accounting_correction_documents',col,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'correction_document_private_column_exposed';END IF;END LOOP;
 END LOOP;
END $authority$;
COMMIT;
