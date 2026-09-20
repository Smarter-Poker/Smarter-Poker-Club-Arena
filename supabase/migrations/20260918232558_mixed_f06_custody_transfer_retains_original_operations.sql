-- Original custody transfer and finite receipt-bound canonical recovery. Preparation appends custody only.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
-- BEGIN CAPTURED MOVEMENT DEPENDENCIES
DO $movement_dependencies$
DECLARE actual jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_receipt_guard()') AND md5(pg_get_functiondef(p.oid))='aaec65e9760efeaa6985eceecc08add9' AND md5(p.prosrc)='ae5b6eae7e5a55e1e6f810a2898a8911' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','smarter_private.f06_receipt_guard()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_tournament_seat_move_receipts_append_only()') AND md5(pg_get_functiondef(p.oid))='7069f5e998da3a06889861446b7ae2e9' AND md5(p.prosrc)='85534593874dc5d908193ccbfc309719' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_tournament_seat_move_receipts_append_only()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_tournament_seat_move_receipt(uuid)') AND md5(pg_get_functiondef(p.oid))='4610936f3d1fd5935da9ae09c8e88001' AND md5(p.prosrc)='68813ee03e355e2eec053e15bf40f98d' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_ca_tournament_seat_move_receipt(uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)') AND md5(pg_get_functiondef(p.oid))='1adbc87ee53a885ba9a161560aab9c55' AND md5(p.prosrc)='1bfea45e31dd3236c31966e4185dfbdb' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp", "statement_timeout=30s"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)') AND md5(pg_get_functiondef(p.oid))='43c53a2b376cb28161584db487bfd17c' AND md5(p.prosrc)='f00ad0e9a08496d96f6375cbf6f30678' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp", "statement_timeout=30s"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)') AND md5(pg_get_functiondef(p.oid))='1d5fdcf284efb107c4f5e2a3be364fb0' AND md5(p.prosrc)='ee2e1143ea1bdff2395bb5cc6c5932f5' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_ack_cleanup(uuid,uuid,uuid,uuid,bigint,text)') AND md5(pg_get_functiondef(p.oid))='7b86ea417aadc35dd5805f1b7f3de4dc' AND md5(p.prosrc)='6d52f389b20e51eb82f54ed07fe3238e' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_f06_ack_cleanup(uuid,uuid,uuid,uuid,bigint,text)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_begin_break(uuid,uuid,uuid,jsonb)') AND md5(pg_get_functiondef(p.oid))='efebd049c672b162c180bbed1fd41af0' AND md5(p.prosrc)='955e8e73b07988b55d8dcc870c902297' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_f06_begin_break(uuid,uuid,uuid,jsonb)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)') AND md5(pg_get_functiondef(p.oid))='f50408947a84ee5901e2e59d0be61d94' AND md5(p.prosrc)='ee839b0fd6bac5601191118fee304980' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_break_state(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='0d1d1f4404ca923cd36a86210ea0a92d' AND md5(p.prosrc)='65833666f7157904dbaee811fe45cce4' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_f06_break_state(uuid,uuid,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint)') AND md5(pg_get_functiondef(p.oid))='f7c8c35f4bc8e68ac1c9463518069f98' AND md5(p.prosrc)='8370eedf9f3d7ac46d522f4b265bed60' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_close_break(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='091073a6e7c4f195f4e974eee5e4d30f' AND md5(p.prosrc)='31a544987423c3da6648fb45f73a2ad1' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_f06_close_break(uuid,uuid,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_hand_number_state(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='cfb6d1f8b0793c0e4ef4e0b5f147779c' AND md5(p.prosrc)='33b39b69d092879b6528851235a85397' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_f06_hand_number_state(uuid,uuid,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_table_state(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='912feb4ac2e7759d240ef1309d5ab4d0' AND md5(p.prosrc)='f4feed631cda151a3157f70066448b22' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_f06_table_state(uuid,uuid,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='9877846ffabee004690e6b24a3ddcee2' AND md5(p.prosrc)='3acb4c1d763181905cf5b64287f8f28f' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_authority(uuid,uuid,boolean)') AND md5(pg_get_functiondef(p.oid))='848b06c8e958ad739e0a60b388430f38' AND md5(p.prosrc)='939908ee892773e79e04fc73241c3f75' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','smarter_private.f06_authority(uuid,uuid,boolean)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_generation_aborted(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='3530559a94372866bf3baec006a8fd3c' AND md5(p.prosrc)='76f64dfc5436d6208c6afbed3ad7da53' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','smarter_private.f06_generation_aborted(uuid,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_immutable_identity()') AND md5(pg_get_functiondef(p.oid))='0fe40a0711ef6d196c6883d3b9e8b86f' AND md5(p.prosrc)='31329a1df4bec9c92e0517b38fd42b93' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','smarter_private.f06_immutable_identity()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_move_guard(uuid,uuid,uuid,uuid,integer,uuid,text,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='67043ce7cbe35b5582b625aaea29d12b' AND md5(p.prosrc)='50e1279c8f5e1c22872350d5b712a8b3' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','smarter_private.f06_move_guard(uuid,uuid,uuid,uuid,integer,uuid,text,uuid,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])') AND md5(pg_get_functiondef(p.oid))='dae9d5b5f71a68362f202dfdf89c8fae' AND md5(p.prosrc)='d857e9d6270456d122ef385c751bc5f1' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_source_guard()') AND md5(pg_get_functiondef(p.oid))='de1b25f96d2c08bf20213c0e194ae261' AND md5(p.prosrc)='97d26bf7859cc41d42752311d0b40d2f' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, smarter_private"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','smarter_private.f06_source_guard()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_close_empty_tournament_table(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='0af954ab1264dc12ebce7741b7845343' AND md5(p.prosrc)='4abef1a7ccd6d56c2523fe6cb02396b6' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %','public.fn_close_empty_tournament_table(uuid,uuid,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('smarter_private.f06_attempts') AND pg_get_userbyid(c.relowner)='postgres' AND c.relacl::text='{postgres=arwdDxtm/postgres}' AND c.relrowsecurity=true AND c.relforcerowsecurity=false) THEN RAISE EXCEPTION 'F06_MOVEMENT_RELATION_DRIFT: %','smarter_private.f06_attempts'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_amendment_id_key' AND pg_get_constraintdef(oid)='UNIQUE (amendment_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_amendment_id_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_break_id_user_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (break_id, user_id) REFERENCES smarter_private.f06_members(break_id, user_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_break_id_user_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_break_id_user_id_revision_key' AND pg_get_constraintdef(oid)='UNIQUE (break_id, user_id, revision)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_break_id_user_id_revision_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_check' AND pg_get_constraintdef(oid)='CHECK (((state = ''winner''::text) = (receipt IS NOT NULL)))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_destination_seat_number_check' AND pg_get_constraintdef(oid)='CHECK (((destination_seat_number >= 1) AND (destination_seat_number <= 10)))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_destination_seat_number_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_pkey' AND pg_get_constraintdef(oid)='PRIMARY KEY (request_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_pkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_predecessor_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (predecessor) REFERENCES smarter_private.f06_attempts(request_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_predecessor_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_predecessor_key' AND pg_get_constraintdef(oid)='UNIQUE (predecessor)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_predecessor_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_revision_check' AND pg_get_constraintdef(oid)='CHECK ((revision > 0))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_revision_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_attempts'::regclass AND conname='f06_attempts_state_check' AND pg_get_constraintdef(oid)='CHECK ((state = ANY (ARRAY[''active''::text, ''fenced''::text, ''winner''::text])))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_attempts_state_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_attempts'::regclass AND tgname='f06_attempts_immutable' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_attempts_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_attempts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()' AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %','f06_attempts_immutable'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='smarter_private.f06_attempts'::regclass AND a.attnum>0 AND NOT a.attisdropped; IF actual IS DISTINCT FROM '[{"name": "request_id", "type": "uuid", "notnull": true, "default": null}, {"name": "break_id", "type": "uuid", "notnull": true, "default": null}, {"name": "user_id", "type": "uuid", "notnull": true, "default": null}, {"name": "revision", "type": "integer", "notnull": true, "default": null}, {"name": "predecessor", "type": "uuid", "notnull": false, "default": null}, {"name": "amendment_id", "type": "uuid", "notnull": false, "default": null}, {"name": "amendment_payload", "type": "jsonb", "notnull": false, "default": null}, {"name": "destination_table_id", "type": "uuid", "notnull": true, "default": null}, {"name": "destination_seat_number", "type": "integer", "notnull": true, "default": null}, {"name": "generation", "type": "uuid", "notnull": true, "default": null}, {"name": "state", "type": "text", "notnull": true, "default": "''active''::text"}, {"name": "receipt", "type": "jsonb", "notnull": false, "default": null}]'::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_COLUMNS_DRIFT: %','smarter_private.f06_attempts'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('smarter_private.f06_dispatch') AND pg_get_userbyid(c.relowner)='postgres' AND c.relacl::text='{postgres=arwdDxtm/postgres}' AND c.relrowsecurity=true AND c.relforcerowsecurity=false) THEN RAISE EXCEPTION 'F06_MOVEMENT_RELATION_DRIFT: %','smarter_private.f06_dispatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_dispatch'::regclass AND conname='f06_dispatch_pkey' AND pg_get_constraintdef(oid)='PRIMARY KEY (request_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_dispatch_pkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_dispatch'::regclass AND conname='f06_dispatch_request_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (request_id) REFERENCES smarter_private.f06_attempts(request_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_dispatch_request_id_fkey'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='smarter_private.f06_dispatch'::regclass AND a.attnum>0 AND NOT a.attisdropped; IF actual IS DISTINCT FROM '[{"name": "request_id", "type": "uuid", "notnull": true, "default": null}, {"name": "xid", "type": "bigint", "notnull": true, "default": null}, {"name": "occupancy_id", "type": "uuid", "notnull": true, "default": null}, {"name": "source_seat_id", "type": "uuid", "notnull": true, "default": null}, {"name": "lifecycle", "type": "bigint", "notnull": true, "default": null}]'::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_COLUMNS_DRIFT: %','smarter_private.f06_dispatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('smarter_private.f06_hand_dispatch') AND pg_get_userbyid(c.relowner)='postgres' AND c.relacl::text='{postgres=arwdDxtm/postgres}' AND c.relrowsecurity=true AND c.relforcerowsecurity=false) THEN RAISE EXCEPTION 'F06_MOVEMENT_RELATION_DRIFT: %','smarter_private.f06_hand_dispatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_hand_dispatch'::regclass AND conname='f06_hand_dispatch_permit_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (permit_id) REFERENCES smarter_private.f06_hand_permits(permit_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_hand_dispatch_permit_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_hand_dispatch'::regclass AND conname='f06_hand_dispatch_pkey' AND pg_get_constraintdef(oid)='PRIMARY KEY (permit_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_hand_dispatch_pkey'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='smarter_private.f06_hand_dispatch'::regclass AND a.attnum>0 AND NOT a.attisdropped; IF actual IS DISTINCT FROM '[{"name": "permit_id", "type": "uuid", "notnull": true, "default": null}, {"name": "xid", "type": "bigint", "notnull": true, "default": null}]'::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_COLUMNS_DRIFT: %','smarter_private.f06_hand_dispatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('smarter_private.f06_hand_permits') AND pg_get_userbyid(c.relowner)='postgres' AND c.relacl::text='{postgres=arwdDxtm/postgres}' AND c.relrowsecurity=true AND c.relforcerowsecurity=false) THEN RAISE EXCEPTION 'F06_MOVEMENT_RELATION_DRIFT: %','smarter_private.f06_hand_permits'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_hand_permits'::regclass AND conname='f06_hand_permits_pkey' AND pg_get_constraintdef(oid)='PRIMARY KEY (permit_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_hand_permits_pkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_hand_permits'::regclass AND conname='f06_hand_permits_state_check' AND pg_get_constraintdef(oid)='CHECK ((state = ANY (ARRAY[''reserved''::text, ''accepted''::text, ''never_started''::text, ''aborted_unsettled''::text])))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_hand_permits_state_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_hand_permits'::regclass AND conname='f06_hand_permits_table_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (table_id) REFERENCES tables(id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_hand_permits_table_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_hand_permits'::regclass AND conname='f06_hand_permits_table_id_hand_number_key' AND pg_get_constraintdef(oid)='UNIQUE (table_id, hand_number)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_hand_permits_table_id_hand_number_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_hand_permits'::regclass AND tgname='f06_hand_permits_immutable' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_hand_permits_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()' AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %','f06_hand_permits_immutable'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='smarter_private.f06_hand_permits'::regclass AND a.attnum>0 AND NOT a.attisdropped; IF actual IS DISTINCT FROM '[{"name": "permit_id", "type": "uuid", "notnull": true, "default": null}, {"name": "tournament_id", "type": "uuid", "notnull": true, "default": null}, {"name": "table_id", "type": "uuid", "notnull": true, "default": null}, {"name": "lifecycle", "type": "bigint", "notnull": true, "default": null}, {"name": "hand_number", "type": "bigint", "notnull": true, "default": null}, {"name": "custody_id", "type": "uuid", "notnull": true, "default": null}, {"name": "generation", "type": "uuid", "notnull": true, "default": null}, {"name": "state", "type": "text", "notnull": true, "default": "''reserved''::text"}, {"name": "evidence_id", "type": "uuid", "notnull": false, "default": null}]'::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_COLUMNS_DRIFT: %','smarter_private.f06_hand_permits'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('smarter_private.f06_members') AND pg_get_userbyid(c.relowner)='postgres' AND c.relacl::text='{postgres=arwdDxtm/postgres}' AND c.relrowsecurity=true AND c.relforcerowsecurity=false) THEN RAISE EXCEPTION 'F06_MOVEMENT_RELATION_DRIFT: %','smarter_private.f06_members'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_members'::regclass AND conname='f06_members_break_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (break_id) REFERENCES smarter_private.f06_operations(break_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_members_break_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_members'::regclass AND conname='f06_members_break_id_source_seat_id_key' AND pg_get_constraintdef(oid)='UNIQUE (break_id, source_seat_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_members_break_id_source_seat_id_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_members'::regclass AND conname='f06_members_occupancy_id_key' AND pg_get_constraintdef(oid)='UNIQUE (occupancy_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_members_occupancy_id_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_members'::regclass AND conname='f06_members_pkey' AND pg_get_constraintdef(oid)='PRIMARY KEY (break_id, user_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_members_pkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_members'::regclass AND conname='f06_members_source_seat_number_check' AND pg_get_constraintdef(oid)='CHECK (((source_seat_number >= 1) AND (source_seat_number <= 10)))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_members_source_seat_number_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_members'::regclass AND tgname='f06_members_immutable' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_members_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_members FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()' AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %','f06_members_immutable'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='smarter_private.f06_members'::regclass AND a.attnum>0 AND NOT a.attisdropped; IF actual IS DISTINCT FROM '[{"name": "break_id", "type": "uuid", "notnull": true, "default": null}, {"name": "user_id", "type": "uuid", "notnull": true, "default": null}, {"name": "source_seat_id", "type": "uuid", "notnull": true, "default": null}, {"name": "source_seat_number", "type": "integer", "notnull": true, "default": null}, {"name": "occupancy_id", "type": "uuid", "notnull": true, "default": null}]'::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_COLUMNS_DRIFT: %','smarter_private.f06_members'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('smarter_private.f06_operations') AND pg_get_userbyid(c.relowner)='postgres' AND c.relacl::text='{postgres=arwdDxtm/postgres}' AND c.relrowsecurity=true AND c.relforcerowsecurity=false) THEN RAISE EXCEPTION 'F06_MOVEMENT_RELATION_DRIFT: %','smarter_private.f06_operations'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_operations'::regclass AND conname='f06_operations_boundary_id_key' AND pg_get_constraintdef(oid)='UNIQUE (boundary_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_operations_boundary_id_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_operations'::regclass AND conname='f06_operations_check' AND pg_get_constraintdef(oid)='CHECK (((state = ANY (ARRAY[''close_confirmed''::text, ''acknowledged''::text])) = (close_receipt IS NOT NULL)))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_operations_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_operations'::regclass AND conname='f06_operations_ordinal_key' AND pg_get_constraintdef(oid)='UNIQUE (ordinal)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_operations_ordinal_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_operations'::regclass AND conname='f06_operations_pkey' AND pg_get_constraintdef(oid)='PRIMARY KEY (break_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_operations_pkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_operations'::regclass AND conname='f06_operations_source_table_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (source_table_id) REFERENCES tables(id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_operations_source_table_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_operations'::regclass AND conname='f06_operations_state_check' AND pg_get_constraintdef(oid)='CHECK ((state = ANY (ARRAY[''park_requested''::text, ''begun''::text, ''close_confirmed''::text, ''acknowledged''::text, ''withdrawn_before_manifest''::text])))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_operations_state_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_operations'::regclass AND conname='f06_withdrawal_receipt' AND pg_get_constraintdef(oid)='CHECK (((state = ''withdrawn_before_manifest''::text) = (abort_receipt_id IS NOT NULL)))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','f06_withdrawal_receipt'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_operations'::regclass AND tgname='f06_operations_immutable' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_operations_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_operations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()' AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %','f06_operations_immutable'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='smarter_private.f06_operations'::regclass AND a.attnum>0 AND NOT a.attisdropped; IF actual IS DISTINCT FROM '[{"name": "break_id", "type": "uuid", "notnull": true, "default": null}, {"name": "ordinal", "type": "bigint", "notnull": true, "default": null}, {"name": "tournament_id", "type": "uuid", "notnull": true, "default": null}, {"name": "source_table_id", "type": "uuid", "notnull": true, "default": null}, {"name": "lifecycle", "type": "bigint", "notnull": true, "default": null}, {"name": "boundary_id", "type": "uuid", "notnull": true, "default": null}, {"name": "origin_generation", "type": "uuid", "notnull": true, "default": null}, {"name": "state", "type": "text", "notnull": true, "default": "''park_requested''::text"}, {"name": "manifest", "type": "jsonb", "notnull": false, "default": null}, {"name": "revision", "type": "bigint", "notnull": true, "default": "0"}, {"name": "custody_id", "type": "uuid", "notnull": false, "default": null}, {"name": "custody_generation", "type": "uuid", "notnull": false, "default": null}, {"name": "cleanup_kind", "type": "text", "notnull": false, "default": null}, {"name": "close_receipt", "type": "jsonb", "notnull": false, "default": null}, {"name": "created_at", "type": "timestamp with time zone", "notnull": true, "default": "clock_timestamp()"}, {"name": "abort_receipt_id", "type": "uuid", "notnull": false, "default": null}]'::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_COLUMNS_DRIFT: %','smarter_private.f06_operations'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.tournament_seat_move_receipts') AND pg_get_userbyid(c.relowner)='postgres' AND c.relacl::text='{postgres=arwdDxtm/postgres}' AND c.relrowsecurity=true AND c.relforcerowsecurity=false) THEN RAISE EXCEPTION 'F06_MOVEMENT_RELATION_DRIFT: %','public.tournament_seat_move_receipts'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_check' AND pg_get_constraintdef(oid)='CHECK ((source_table_id <> destination_table_id))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_check1' AND pg_get_constraintdef(oid)='CHECK ((source_seat_id <> destination_seat_id))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_check1'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_destination_seat_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (destination_seat_id) REFERENCES table_seats(id) ON DELETE RESTRICT' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_destination_seat_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_destination_seat_number_check' AND pg_get_constraintdef(oid)='CHECK (((destination_seat_number >= 1) AND (destination_seat_number <= 10)))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_destination_seat_number_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_destination_table_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (destination_table_id) REFERENCES tables(id) ON DELETE RESTRICT' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_destination_table_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_pkey' AND pg_get_constraintdef(oid)='PRIMARY KEY (request_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_pkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_source_mode_check' AND pg_get_constraintdef(oid)='CHECK ((source_mode = ANY (ARRAY[''live_source''::text, ''closed_orphan''::text])))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_source_mode_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_source_seat_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (source_seat_id) REFERENCES table_seats(id) ON DELETE RESTRICT' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_source_seat_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_source_seat_number_check' AND pg_get_constraintdef(oid)='CHECK (((source_seat_number >= 1) AND (source_seat_number <= 10)))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_source_seat_number_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_source_table_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (source_table_id) REFERENCES tables(id) ON DELETE RESTRICT' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_source_table_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_stack_check' AND pg_get_constraintdef(oid)='CHECK ((((stack)::text <> ALL (ARRAY[''NaN''::text, ''Infinity''::text, ''-Infinity''::text])) AND (stack > (0)::numeric)))' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_stack_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_tournament_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_tournament_id_fkey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_seat_move_receipts'::regclass AND conname='tournament_seat_move_receipts_tournament_id_user_id_request_key' AND pg_get_constraintdef(oid)='UNIQUE (tournament_id, user_id, request_id)' AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %','tournament_seat_move_receipts_tournament_id_user_id_request_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_seat_move_receipts'::regclass AND tgname='f06_bind_move_receipt' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_bind_move_receipt AFTER INSERT ON public.tournament_seat_move_receipts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_receipt_guard()' AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %','f06_bind_move_receipt'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_seat_move_receipts'::regclass AND tgname='tournament_seat_move_receipts_append_only' AND pg_get_triggerdef(oid)='CREATE TRIGGER tournament_seat_move_receipts_append_only BEFORE DELETE OR UPDATE ON public.tournament_seat_move_receipts FOR EACH ROW EXECUTE FUNCTION fn_tournament_seat_move_receipts_append_only()' AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %','tournament_seat_move_receipts_append_only'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.tournament_seat_move_receipts'::regclass AND a.attnum>0 AND NOT a.attisdropped; IF actual IS DISTINCT FROM '[{"name": "request_id", "type": "uuid", "notnull": true, "default": null}, {"name": "tournament_id", "type": "uuid", "notnull": true, "default": null}, {"name": "user_id", "type": "uuid", "notnull": true, "default": null}, {"name": "source_table_id", "type": "uuid", "notnull": true, "default": null}, {"name": "destination_table_id", "type": "uuid", "notnull": true, "default": null}, {"name": "source_seat_id", "type": "uuid", "notnull": true, "default": null}, {"name": "destination_seat_id", "type": "uuid", "notnull": true, "default": null}, {"name": "source_seat_number", "type": "integer", "notnull": true, "default": null}, {"name": "destination_seat_number", "type": "integer", "notnull": true, "default": null}, {"name": "source_mode", "type": "text", "notnull": true, "default": null}, {"name": "stack", "type": "numeric", "notnull": true, "default": null}, {"name": "moved_at", "type": "timestamp with time zone", "notnull": true, "default": null}]'::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_COLUMNS_DRIFT: %','public.tournament_seat_move_receipts'; END IF;
-- money-trigger-ok: table_seats.a00_f06_source_seat because this asserts its retained enabled binding; the original trigger is not modified.
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND tgname='a00_f06_source_seat' AND tgenabled='O' AND NOT tgisinternal AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()') THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %','a00_f06_source_seat'; END IF;
-- money-trigger-ok: tournament_players.a00_f06_source_roster because this asserts its retained enabled binding; the original trigger is not modified.
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_players'::regclass AND tgname='a00_f06_source_roster' AND tgenabled='O' AND NOT tgisinternal AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()') THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %','a00_f06_source_roster'; END IF;
END $movement_dependencies$;
-- END CAPTURED MOVEMENT DEPENDENCIES
DO $drained_dependencies$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure AND md5(prosrc)='97c4a1afeaa41512026d3dca6936364a' AND md5(pg_get_functiondef(oid))='438d2cbaad05751066393aeadf710228' AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_DRAINED_DEPENDENCY_DRIFT: f06_movement_prior'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_movement_permits(uuid,uuid,bigint)'::regprocedure AND md5(prosrc)='5588297eb169b5df9bab3f58047b3379' AND md5(pg_get_functiondef(oid))='2ddcf96913de8e87b858c1c207f57ed0' AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_DRAINED_DEPENDENCY_DRIFT: f06_movement_permits'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_prepared_hand_cancellations'::regclass AND tgname='f06_prepared_cancellation_immutable' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_prepared_cancellation_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_prepared_hand_cancellations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_prepared_cancellation_immutable()') THEN RAISE EXCEPTION 'F06_DRAINED_PREPARATION_BINDING'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_prepared_cancellation_immutable()'::regprocedure AND md5(prosrc)='55b942212973a9f10ba6a6d3174bf048' AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog']) THEN RAISE EXCEPTION 'F06_DRAINED_PREPARATION_GUARD'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='smarter_private.f06_prepared_hand_cancellations'::regclass AND relrowsecurity AND NOT relforcerowsecurity AND pg_get_userbyid(relowner)='postgres' AND relacl::text='{postgres=arwdDxtm/postgres}') OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='smarter_private.f06_prepared_hand_cancellations'::regclass) OR (SELECT array_agg(attname::text||':'||format_type(atttypid,atttypmod)||':'||attnotnull::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='smarter_private.f06_prepared_hand_cancellations'::regclass AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['permit_id:uuid:true','tournament_id:uuid:true','generation:uuid:true','table_id:uuid:true','lifecycle:bigint:true','hand_number:bigint:true','custody_id:uuid:true','created_at:timestamp with time zone:true'] OR (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY contype) FROM pg_constraint WHERE conrelid='smarter_private.f06_prepared_hand_cancellations'::regclass) IS DISTINCT FROM ARRAY['PRIMARY KEY (permit_id)','UNIQUE (table_id, hand_number)'] THEN RAISE EXCEPTION 'F06_DRAINED_PREPARATION_RELATION'; END IF;
END $drained_dependencies$;
-- Only this append-only record changes. Original business authority is untouched.
CREATE TABLE smarter_private.f06_manager_custody_transfers (
 transfer_id uuid PRIMARY KEY,
 tournament_id uuid NOT NULL,
 origin_generation uuid NOT NULL,
 successor_generation uuid NOT NULL,
 local_proof jsonb NOT NULL CHECK(jsonb_typeof(local_proof)='object'),
 canonical_proof jsonb NOT NULL CHECK(jsonb_typeof(canonical_proof)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tournament_id,origin_generation), UNIQUE(tournament_id,successor_generation),
 CHECK(origin_generation<>successor_generation)
);
ALTER TABLE smarter_private.f06_manager_custody_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_manager_custody_transfers FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.f06_manager_transfer_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'F06_MANAGER_TRANSFER_IMMUTABLE' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_manager_transfer_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_manager_transfer_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_manager_custody_transfers
FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();
CREATE TRIGGER f06_manager_transfer_no_truncate BEFORE TRUNCATE ON smarter_private.f06_manager_custody_transfers
FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();

-- Admission binds the real lease row, including the process and acquisition.
-- Completion is appended separately; historical transfer evidence never changes.
CREATE TABLE smarter_private.f06_manager_custody_admissions (
 transfer_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, generation uuid NOT NULL,
 lease_identity jsonb NOT NULL, terminal_proof jsonb NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE smarter_private.f06_manager_custody_completions (
 transfer_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, generation uuid NOT NULL,
 admission jsonb NOT NULL, operation_receipts jsonb NOT NULL, presence_receipts jsonb NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE smarter_private.f06_manager_custody_intents (
 transfer_id uuid NOT NULL, intent_key text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(transfer_id,intent_key)
);
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['f06_manager_custody_admissions','f06_manager_custody_completions','f06_manager_custody_intents'] LOOP
 EXECUTE format('ALTER TABLE smarter_private.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('REVOKE ALL ON smarter_private.%I FROM PUBLIC,anon,authenticated,service_role',n);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON smarter_private.%I FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable()',n);
 EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON smarter_private.%I FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable()',n);
 END LOOP; END $$;

-- A disposed engine cannot reconstruct purchased time from accounting metadata.
-- Retained values must have the exact native durable hand/occupancy checkpoint.
CREATE FUNCTION smarter_private.f06_mixed_bank_proof(t uuid,engine jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE custody jsonb:=engine->'bank_custody'; durable jsonb; banks jsonb; x jsonb; bank jsonb; key text; value jsonb;
BEGIN
 IF jsonb_typeof(custody) IS DISTINCT FROM 'object' OR
 jsonb_typeof(custody->'roster') IS DISTINCT FROM 'array' OR
 jsonb_typeof(custody->'time_bank_metadata') IS DISTINCT FROM 'array' OR
 jsonb_typeof(custody->'parked_time_banks') IS DISTINCT FROM 'object' OR
 custody->'live_time_banks' IS DISTINCT FROM '[]'::jsonb OR
 custody->'disconnect_states' IS DISTINCT FROM '{}'::jsonb OR
 NOT custody ? 'durable_presence' OR COALESCE(custody->>'hand_number','') !~ '^(0|[1-9][0-9]*)$'
 THEN RAISE EXCEPTION 'F06_MIXED_BANK_CUSTODY_UNAVAILABLE'; END IF;
 SELECT to_jsonb(p) INTO durable FROM public.engine_presence_parked p WHERE table_id=(engine->>'table_id')::uuid FOR SHARE;
 IF COALESCE(durable,'null'::jsonb) IS DISTINCT FROM custody->'durable_presence' THEN RAISE EXCEPTION 'F06_MIXED_BANK_DURABLE_CHANGED'; END IF;
 banks:=durable#>'{time_bank_snapshot,players}';
 IF jsonb_array_length(custody->'time_bank_metadata')>0 OR custody->'parked_time_banks'<>'{}'::jsonb OR (banks IS NOT NULL AND banks<>'{}'::jsonb) THEN
 IF durable#>>'{time_bank_snapshot,version}' IS DISTINCT FROM '1' OR jsonb_typeof(banks) IS DISTINCT FROM 'object'
 OR durable#>>'{time_bank_snapshot,handNumber}' IS DISTINCT FROM custody->>'hand_number'
 OR NOT isfinite((durable->>'parked_at')::timestamptz)
 OR (durable#>>'{time_bank_snapshot,parkedAt}')::timestamptz IS DISTINCT FROM (durable->>'parked_at')::timestamptz
 THEN RAISE EXCEPTION 'F06_MIXED_BANK_ORIGINAL_EVIDENCE_MISSING'; END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(custody->'time_bank_metadata') LOOP
 bank:=banks->(x->>0);
 IF jsonb_typeof(bank) IS DISTINCT FROM 'object' OR jsonb_typeof(x->1) IS DISTINCT FROM 'object' OR NOT bank @> (x->1)
 THEN RAISE EXCEPTION 'F06_MIXED_BANK_METADATA_UNBACKED'; END IF;
 END LOOP;
 FOR key,value IN SELECT * FROM jsonb_each(custody->'parked_time_banks') LOOP
 IF banks->key IS DISTINCT FROM value THEN RAISE EXCEPTION 'F06_MIXED_PARKED_BANK_UNBACKED'; END IF; END LOOP;
 FOR key,bank IN SELECT * FROM jsonb_each(banks) LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(custody->'roster') r WHERE r->>0=key AND r->>1=bank->>'occupancyId')
 OR (bank->>'occupancyId')::uuid IS NULL OR (key)::uuid IS NULL
 OR jsonb_typeof(bank->'unlimitedActivations') NOT IN('boolean','null')
 THEN RAISE EXCEPTION 'F06_MIXED_BANK_OCCUPANCY_UNPROVEN'; END IF;
 FOREACH value IN ARRAY ARRAY[bank->'remainingSeconds',bank->'usesRemaining',bank->'initialSeconds',bank->'baseSeconds',bank->'dbConsumedSeconds'] LOOP
 IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR (value::text)::numeric<0 THEN RAISE EXCEPTION 'F06_MIXED_BANK_VALUE_INVALID'; END IF; END LOOP;
 IF (bank->>'usesRemaining')::numeric<>trunc((bank->>'usesRemaining')::numeric)
 OR (bank->>'remainingSeconds')::numeric>(bank->>'initialSeconds')::numeric
 OR (bank->>'baseSeconds')::numeric>(bank->>'initialSeconds')::numeric
 OR (bank->>'dbConsumedSeconds')::numeric>(bank->>'initialSeconds')::numeric-(bank->>'baseSeconds')::numeric
 THEN RAISE EXCEPTION 'F06_MIXED_BANK_VALUE_INVALID'; END IF;
 END LOOP;
 END IF;
 RETURN jsonb_build_object('table_id',engine->>'table_id','custody',custody);
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_bank_proof(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Caller takes the lease row FIRST. Same lane/user/event/player/table/seat order
-- as f06_prefix, followed by the complete canonical operation and receipt set.
CREATE FUNCTION smarter_private.f06_mixed_custody_snapshot(t uuid,g uuid,local_proof jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE ids uuid[]; users uuid[]; u uuid; x jsonb; b jsonb; r record; result jsonb:='{}'; value jsonb; original_row smarter_private.f06_hand_permits; witness jsonb; original_evidence jsonb:='[]'; pending jsonb:='[]'; lifecycles jsonb:='[]'; witnesses jsonb; witnessed_lifecycle text;
BEGIN
 IF jsonb_typeof(local_proof) IS DISTINCT FROM 'object' OR
 (local_proof->>'manager_id')::uuid IS NULL OR (local_proof->>'move_owner')::uuid IS NULL THEN
 RAISE EXCEPTION 'F06_MIXED_LOCAL_INVALID' USING ERRCODE='22023'; END IF;
 FOREACH u IN ARRAY ARRAY[t,g] LOOP IF u IS NULL THEN RAISE EXCEPTION 'F06_MIXED_LOCAL_INVALID'; END IF; END LOOP;
 FOR r IN SELECT unnest(ARRAY['engines','retained','durable','pending_moves','parks','begins','amendments',
 'rejected_begins','resolved_proposals','custody_ids','cleanup_kinds','no_start','stopped_originals','arrival_wakes','reservations']) key LOOP
 IF jsonb_typeof(local_proof->r.key) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'F06_MIXED_LOCAL_INCOMPLETE'; END IF;
 END LOOP;
 IF NOT local_proof ? 'retirement' OR jsonb_array_length(local_proof->'engines')=0 OR
 (SELECT count(DISTINCT e->>'table_id') FROM jsonb_array_elements(local_proof->'engines') e)<>jsonb_array_length(local_proof->'engines') OR
 (SELECT count(DISTINCT e->>'engine_id') FROM jsonb_array_elements(local_proof->'engines') e)<>jsonb_array_length(local_proof->'engines') THEN
 RAISE EXCEPTION 'F06_MIXED_PHYSICAL_MAP_INVALID'; END IF;
 PERFORM smarter_private.f06_try_lane(t);
 SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO ids FROM public.tables WHERE tournament_id=t;
 SELECT COALESCE(array_agg(DISTINCT user_id ORDER BY user_id),'{}') INTO users FROM public.table_seats WHERE table_id=ANY(ids) AND user_id IS NOT NULL;
 FOREACH u IN ARRAY users LOOP IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)) THEN RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF; END LOOP;
 PERFORM 1 FROM public.tournaments WHERE id=t AND upper(status)='RUNNING' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_MIXED_EVENT_CHANGED'; END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s WHERE s.table_id=ANY(ids) ORDER BY s.id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id=t ORDER BY break_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_members WHERE break_id IN(SELECT break_id FROM smarter_private.f06_operations WHERE tournament_id=t) ORDER BY break_id,user_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_attempts WHERE break_id IN(SELECT break_id FROM smarter_private.f06_operations WHERE tournament_id=t) ORDER BY request_id FOR UPDATE;
 PERFORM 1 FROM public.tournament_seat_move_receipts WHERE tournament_id=t ORDER BY request_id FOR SHARE;
 PERFORM 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t AND (state='reserved' OR permit_id IN
 (SELECT (e#>>'{permit,binding,permit_id}')::uuid FROM jsonb_array_elements(local_proof->'engines') e)) ORDER BY permit_id FOR SHARE;
 -- Historical allocator custody is the native witness after a permit clears.
 -- Observation resolves only the DTO; it never invokes or changes an allocator.
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'engines') LOOP
 IF x->>'allocation_epoch' IS NOT NULL AND x->'permit'='null'::jsonb THEN
 PERFORM 1 FROM smarter_private.f06_hand_permits h WHERE h.tournament_id=t AND h.generation=g
 AND h.table_id=(x->>'table_id')::uuid AND h.custody_id=(x->>'allocation_epoch')::uuid ORDER BY permit_id FOR SHARE;
 SELECT jsonb_agg(to_jsonb(h) ORDER BY permit_id),min(h.lifecycle)::text INTO witnesses,witnessed_lifecycle
 FROM smarter_private.f06_hand_permits h WHERE h.tournament_id=t AND h.generation=g
 AND h.table_id=(x->>'table_id')::uuid AND h.custody_id=(x->>'allocation_epoch')::uuid;
 IF witnesses IS NULL OR (SELECT count(DISTINCT h->>'lifecycle') FROM jsonb_array_elements(witnesses) h)<>1
 OR (x->>'lifecycle' IS NOT NULL AND x->>'lifecycle' IS DISTINCT FROM witnessed_lifecycle)
 THEN RAISE EXCEPTION 'F06_MIXED_ALLOCATION_WITNESS_UNPROVEN'; END IF;
 lifecycles:=lifecycles||jsonb_build_array(jsonb_build_object('table_id',x->>'table_id','allocation_epoch',x->>'allocation_epoch','lifecycle',witnessed_lifecycle,'permits',witnesses));
 x:=x||jsonb_build_object('lifecycle',witnessed_lifecycle);
 local_proof:=jsonb_set(local_proof,'{engines}',(SELECT jsonb_agg(CASE WHEN e->>'table_id'=x->>'table_id' THEN x ELSE e END ORDER BY n)
 FROM jsonb_array_elements(local_proof->'engines') WITH ORDINALITY a(e,n)));
 END IF;
 END LOOP;
 result:=result||jsonb_build_object('engine_lifecycles',lifecycles);
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'engines') LOOP
 PERFORM smarter_private.f06_mixed_bank_proof(t,x);
 IF (x->>'engine_id')::uuid IS NULL OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=(x->>'table_id')::uuid
 AND tournament_id=t AND f06_lifecycle::text=x->>'lifecycle') THEN RAISE EXCEPTION 'F06_MIXED_PHYSICAL_LIFECYCLE_CHANGED'; END IF;
 IF x->'permit' IS DISTINCT FROM 'null'::jsonb THEN
 b:=x#>'{permit,binding}';
 IF (b->>'tournament_id',b->>'lease_generation',b->>'table_id',b->>'lifecycle') IS DISTINCT FROM
 (t::text,g::text,x->>'table_id',x->>'lifecycle') OR (b->>'permit_id')::uuid IS NULL OR (b->>'custody_id')::uuid IS NULL
 OR b->>'hand_number' !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'F06_MIXED_ORIGINAL_IDENTITY_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.permit_id=(b->>'permit_id')::uuid AND
 (h.tournament_id,h.generation,h.table_id,h.lifecycle,h.hand_number,h.custody_id) IS DISTINCT FROM
 (t,g,(b->>'table_id')::uuid,(b->>'lifecycle')::bigint,(b->>'hand_number')::bigint,(b->>'custody_id')::uuid)) THEN
 RAISE EXCEPTION 'F06_MIXED_ORIGINAL_IDENTITY_CHANGED'; END IF;
 END IF;
 END LOOP;
 -- Auxiliary continuations retain their exact physical identity. A possibly
 -- sent no-start cannot be inferred from an absent row or replayed by a new dealer.
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'no_start') LOOP
 b:=x#>'{1,binding}';
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(local_proof->'engines') e WHERE e->>'table_id'=b->>'tableId' AND e->>'engine_id'=x#>>'{1,engine_id}')
 OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_no_start_continuations n JOIN smarter_private.f06_operations o USING(break_id)
 WHERE n.break_id=(x->>0)::uuid AND n.tournament_id=t AND n.table_id=(b->>'tableId')::uuid
 AND n.lifecycle=(b->>'tableIncarnation')::bigint AND n.park->>'custody_id'=b->>'custodyId'
 AND n.park->>'custody_generation'=b->>'leaseGeneration' AND n.park->>'revision'=b->>'durableRevision'
 AND o.state='withdrawn_before_manifest') THEN RAISE EXCEPTION 'F06_MIXED_NO_START_UNRESOLVED'; END IF;
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'stopped_originals') LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o JOIN jsonb_array_elements(local_proof->'engines') e ON e->>'table_id'=o.source_table_id::text
 WHERE o.break_id=(x->>0)::uuid AND o.tournament_id=t AND o.source_table_id=(x->>1)::uuid) THEN RAISE EXCEPTION 'F06_MIXED_STOPPED_ORIGINAL_CHANGED'; END IF;
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'arrival_wakes') LOOP
 FOR b IN SELECT * FROM jsonb_array_elements(x->1) LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts a JOIN public.tournament_seat_move_receipts mr USING(request_id)
 JOIN jsonb_array_elements(local_proof->'engines') e ON e->>'table_id'=mr.destination_table_id::text
 WHERE a.break_id=(x->>0)::uuid AND a.request_id=(b->>0)::uuid AND a.state='winner'
 AND mr.tournament_id=t AND mr.destination_table_id=(b->>1)::uuid) THEN RAISE EXCEPTION 'F06_MIXED_ARRIVAL_CHANGED'; END IF;
 END LOOP; END LOOP;
 x:=local_proof->'retirement';
 IF x<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(local_proof->'engines') e
 WHERE e->>'table_id'=x->>'table_id' AND e->>'engine_id'=x->>'engine_id') THEN RAISE EXCEPTION 'F06_MIXED_RETIREMENT_CHANGED'; END IF;
 -- Every reserved original is bound, including non-source destinations.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.tournament_id=t AND h.state='reserved' AND NOT EXISTS
 (SELECT 1 FROM jsonb_array_elements(local_proof->'engines') e WHERE
 (e#>>'{permit,binding,permit_id}')::uuid=h.permit_id AND e->>'table_id'=h.table_id::text)) THEN
 RAISE EXCEPTION 'F06_MIXED_ORIGINAL_OMITTED'; END IF;
 -- Mixed means complete source custody, never an individually convenient park.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.tournament_id=t AND o.state NOT IN('acknowledged','withdrawn_before_manifest')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(local_proof->'retained') e JOIN jsonb_array_elements(local_proof->'engines') engine ON
 engine->>'table_id'=e->>'table_id' AND engine->>'engine_id'=e->>'engine_id'
 WHERE e->>'break_id'=o.break_id::text AND e->>'table_id'=o.source_table_id::text AND engine->>'lifecycle'=o.lifecycle::text)) THEN
 RAISE EXCEPTION 'F06_MIXED_SOURCE_OMITTED'; END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'retained') LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.tournament_id=t AND o.break_id=(x->>'break_id')::uuid
 AND o.source_table_id=(x->>'table_id')::uuid) THEN RAISE EXCEPTION 'F06_MIXED_SOURCE_CHANGED'; END IF;
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'durable') LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.tournament_id=t AND o.break_id=(x->>0)::uuid
 AND o.lifecycle::text=x#>>'{1,lifecycle}') THEN RAISE EXCEPTION 'F06_MIXED_BREAK_CHANGED'; END IF;
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'pending_moves') LOOP
 b:=x#>'{1,input}';
 IF x->>0 IS DISTINCT FROM b->>'requestId' OR b->>'tournamentId' IS DISTINCT FROM t::text OR
 NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts a JOIN smarter_private.f06_operations o USING(break_id)
 WHERE a.request_id=(x->>0)::uuid AND o.tournament_id=t AND a.user_id=(b->>'userId')::uuid
 AND o.source_table_id=(b->>'sourceTableId')::uuid AND a.destination_table_id=(b->>'destinationTableId')::uuid
 AND a.destination_seat_number=(b->>'destinationSeatNumber')::integer) THEN RAISE EXCEPTION 'F06_MIXED_REQUEST_CHANGED'; END IF;
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'reservations') LOOP
 b:=x->'binding';
 IF jsonb_array_length(b)<>7 OR b->>0 IS DISTINCT FROM t::text OR b->>4 IS DISTINCT FROM g::text OR
 x->>'table_id' IS DISTINCT FROM b->>2 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(local_proof->'engines') e WHERE e->>'table_id'=b->>2) OR
 NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.tournament_id=t AND o.break_id=(b->>1)::uuid
 AND o.source_table_id=(b->>2)::uuid AND o.lifecycle::text=b->>3 AND o.custody_generation::text=b->>4
 AND o.custody_id::text=b->>5 AND o.revision::text=b->>6) THEN RAISE EXCEPTION 'F06_MIXED_RESERVATION_CHANGED'; END IF;
 END LOOP;
 SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY break_id),'[]') INTO value FROM smarter_private.f06_operations o WHERE tournament_id=t;
 result:=result||jsonb_build_object('operations',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.break_id,m.user_id),'[]') INTO value FROM smarter_private.f06_members m JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=t;
 result:=result||jsonb_build_object('members',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.request_id),'[]') INTO value FROM smarter_private.f06_attempts a JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=t;
 result:=result||jsonb_build_object('attempts',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(mr) ORDER BY request_id),'[]') INTO value FROM public.tournament_seat_move_receipts mr WHERE tournament_id=t;
 result:=result||jsonb_build_object('move_receipts',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY permit_id),'[]') INTO value FROM smarter_private.f06_hand_permits h WHERE tournament_id=t AND (state='reserved' OR permit_id IN
 (SELECT (e#>>'{permit,binding,permit_id}')::uuid FROM jsonb_array_elements(local_proof->'engines') e));
 result:=result||jsonb_build_object('originals',value);
 -- Terminal evidence belongs to the original operation. State labels or missing
 -- rows never remove the retained preparation barrier after process replacement.
 FOR x IN SELECT * FROM jsonb_array_elements(local_proof->'engines') e WHERE e->'permit' IS DISTINCT FROM 'null'::jsonb LOOP
 b:=x#>'{permit,binding}'; witness:=NULL;
 SELECT * INTO original_row FROM smarter_private.f06_hand_permits WHERE permit_id=(b->>'permit_id')::uuid;
 IF original_row.state='accepted' THEN
 SELECT jsonb_build_object('atomic',to_jsonb(a),'history_id',hh.id) INTO witness FROM public.hand_atomic_commits a
 JOIN public.hand_history hh ON hh.id=a.hand_id AND hh.table_id=a.table_id AND hh.hand_number=a.hand_number
 WHERE a.hand_id=original_row.evidence_id AND a.table_id=original_row.table_id AND a.hand_number=original_row.hand_number
 AND a.post_commit_completed_at IS NOT NULL AND isfinite(a.post_commit_completed_at)
 AND a.post_commit_completed_at>=a.committed_at AND a.post_commit_result->'ok'='true'::jsonb
 AND a.post_commit_result->>'hand_id'=a.hand_id::text AND (a.post_commit_result->>'hand_number')::bigint=a.hand_number;
 ELSIF original_row.state='never_started' THEN
 SELECT to_jsonb(c) INTO witness FROM smarter_private.f06_prepared_hand_cancellations c WHERE
 (c.permit_id,c.tournament_id,c.generation,c.table_id,c.lifecycle,c.hand_number,c.custody_id)=
 (original_row.permit_id,original_row.tournament_id,original_row.generation,original_row.table_id,original_row.lifecycle,original_row.hand_number,original_row.custody_id) AND original_row.evidence_id=original_row.permit_id;
 ELSIF original_row.state='aborted_unsettled' AND smarter_private.f06_generation_aborted(original_row.tournament_id,original_row.generation) THEN
 SELECT jsonb_build_object('hand',to_jsonb(a),'receipt',to_jsonb(c)) INTO witness
 FROM smarter_private.f06_mixed_abort_hands a JOIN smarter_private.f06_mixed_aborts c USING(receipt_id,tournament_id)
 WHERE (a.permit_id,a.receipt_id,a.tournament_id,a.generation,a.table_id,a.hand_number)=
 (original_row.permit_id,original_row.evidence_id,original_row.tournament_id,original_row.generation,original_row.table_id,original_row.hand_number) AND c.outcome='aborted_unsettled'
 AND a.expected->'permit'=(to_jsonb(original_row)||jsonb_build_object('state','reserved','evidence_id',NULL));
 END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=original_row.permit_id) THEN witness:=NULL; END IF;
 original_evidence:=original_evidence||jsonb_build_array(jsonb_build_object('binding',b,'permit',to_jsonb(original_row),'evidence',witness));
 IF witness IS NULL THEN pending:=pending||jsonb_build_array(x->>'table_id'); END IF;
 END LOOP;
 result:=result||jsonb_build_object('original_evidence',original_evidence,'pending_original_tables',pending);

 SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.permit_id),'[]') INTO value FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) WHERE h.tournament_id=t;
 result:=result||jsonb_build_object('hand_dispatch',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.request_id),'[]') INTO value FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id) JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=t;
 result:=result||jsonb_build_object('move_dispatch',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY permit_id),'[]') INTO value FROM smarter_private.f06_prepared_hand_cancellations c WHERE tournament_id=t;
 result:=result||jsonb_build_object('prepared_cancellations',value);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'lifecycle',f06_lifecycle::text,'status',status,'deleted',is_deleted) ORDER BY id),'[]') INTO value FROM public.tables WHERE tournament_id=t;
 result:=result||jsonb_build_object('tables',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') INTO value FROM public.table_seats s WHERE table_id=ANY(ids);
 result:=result||jsonb_build_object('seats',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.user_id),'[]') INTO value FROM public.tournament_players p WHERE p.tournament_id=t;
 result:=result||jsonb_build_object('registrations',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.table_id),'[]') INTO value FROM public.engine_presence_parked p WHERE p.table_id=ANY(ids);
 result:=result||jsonb_build_object('presence',value);
 SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.break_id),'[]') INTO value FROM smarter_private.f06_no_start_continuations n WHERE n.tournament_id=t;
 result:=result||jsonb_build_object('no_start_continuations',value);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_f06_prepare_mixed_manager_custody(p_transfer_id uuid,p_tournament_id uuid,
 p_origin_generation uuid,p_successor_generation uuid,p_local jsonb,p_expected jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE l public.engine_tournament_leases; canonical jsonb; receipt jsonb; prior smarter_private.f06_manager_custody_transfers; checkpoint jsonb; maintenance jsonb; leader jsonb; instant timestamptz:=clock_timestamp();
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN RAISE EXCEPTION 'F06_MIXED_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_transfer_id IS NULL OR p_tournament_id IS NULL OR p_origin_generation IS NULL OR p_successor_generation IS NULL
 OR p_origin_generation=p_successor_generation THEN RAISE EXCEPTION 'F06_MIXED_IDENTITY_REQUIRED'; END IF;
 -- Take the existing entry/maintenance lock before any lease row. The
 -- checkpoint is an assertion against locked authority, never a bypass GUC.
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RAISE EXCEPTION 'F06_RETRY_MAINTENANCE_LANE' USING ERRCODE='40001'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR p_local ? 'release_checkpoint' THEN
 checkpoint:=p_local->'release_checkpoint';
 SELECT to_jsonb(b) INTO maintenance FROM public.engine_maintenance_break b WHERE to_jsonb(b)->'id'='true'::jsonb FOR SHARE;
 SELECT to_jsonb(e) INTO leader FROM public.engine_leader e WHERE id=true FOR SHARE;
 IF maintenance IS NULL OR leader IS NULL OR public.fn_platform_frozen() IS DISTINCT FROM true
 OR checkpoint IS NULL OR checkpoint->>'kind' IS DISTINCT FROM 'legacy_engine_checkpoint_8825_v1'
 OR checkpoint->>'source' IS DISTINCT FROM '8825af51817f379c4261658ca29ecc9d8d81932d'
 OR checkpoint->>'instance_id' IS DISTINCT FROM '1-3846b8bb'
 OR checkpoint->>'container_id' IS DISTINCT FROM 'c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66'
 OR checkpoint->>'process_id' IS DISTINCT FROM '1'
 OR COALESCE(checkpoint->>'run_id','') !~ '^[1-9][0-9]*(-[1-9][0-9]*)?$' OR COALESCE(checkpoint->>'control_sha','') !~ '^[0-9a-f]{40}$'
 OR checkpoint->>'phase' IS DISTINCT FROM 'counting_down'
 OR maintenance->>'phase' IS DISTINCT FROM checkpoint->>'phase'
 OR maintenance->>'declared_by' IS DISTINCT FROM '8825af51'
 OR (maintenance->>'ownership_token')::uuid IS DISTINCT FROM (checkpoint->>'ownership_token')::uuid
 OR (checkpoint->>'ownership_token')::uuid IS NULL
 OR (maintenance->>'announced_at')::timestamptz IS DISTINCT FROM (checkpoint->>'announced_at')::timestamptz
 OR (maintenance->>'break_started_at')::timestamptz IS DISTINCT FROM (checkpoint->>'break_started_at')::timestamptz
 OR (maintenance->>'break_ends_at')::timestamptz IS DISTINCT FROM (checkpoint->>'break_ends_at')::timestamptz
 OR maintenance->>'reason' IS DISTINCT FROM checkpoint->>'reason'
 OR (maintenance->>'announced_at')::timestamptz IS NULL
 OR (maintenance->>'break_started_at')::timestamptz IS NULL
 OR (maintenance->>'break_ends_at')::timestamptz IS NULL
 OR NOT isfinite((maintenance->>'announced_at')::timestamptz)
 OR NOT isfinite((maintenance->>'break_started_at')::timestamptz)
 OR NOT isfinite((maintenance->>'break_ends_at')::timestamptz)
 OR NOT (instant>=(maintenance->>'break_started_at')::timestamptz AND (maintenance->>'break_ends_at')::timestamptz-instant>=interval '285 seconds')
 OR leader->>'instance_id' IS DISTINCT FROM checkpoint->>'instance_id'
 OR leader->>'engine_version' IS DISTINCT FROM '8825af51'
 OR (leader->>'heartbeat_at')::timestamptz IS NULL
 OR NOT isfinite((leader->>'heartbeat_at')::timestamptz)
 OR NOT (instant-(leader->>'heartbeat_at')::timestamptz BETWEEN interval '-30 seconds' AND interval '60 seconds')
 THEN RAISE EXCEPTION 'F06_MIXED_FROZEN_CHECKPOINT_UNPROVEN' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND OR l.protocol_version<>2 OR l.lease_generation IS DISTINCT FROM p_origin_generation
 OR l.heartbeat_at IS NULL OR NOT isfinite(l.heartbeat_at)
 OR l.heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN RAISE EXCEPTION 'F06_MIXED_OLD_LEASE_CHANGED'; END IF;
 IF checkpoint IS NOT NULL AND (l.instance_id IS DISTINCT FROM checkpoint->>'instance_id' OR l.engine_version IS DISTINCT FROM left(checkpoint->>'source',8)) THEN RAISE EXCEPTION 'F06_MIXED_OLD_PROCESS_CHANGED'; END IF;
 canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,p_origin_generation,p_local);
 SELECT * INTO prior FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id=p_tournament_id AND origin_generation=p_origin_generation;
 IF FOUND AND (prior.transfer_id,prior.successor_generation,prior.local_proof,prior.canonical_proof) IS DISTINCT FROM
 (p_transfer_id,p_successor_generation,p_local,canonical) THEN RAISE EXCEPTION 'F06_MIXED_TRANSFER_CHANGED'; END IF;
 IF p_expected IS NOT NULL THEN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_local->'engines') e WHERE e->>'lifecycle' IS NULL) THEN RAISE EXCEPTION 'F06_MIXED_PHYSICAL_LIFECYCLE_CHANGED'; END IF;
 IF p_expected IS DISTINCT FROM canonical THEN RAISE EXCEPTION 'F06_MIXED_CANONICAL_CHANGED'; END IF;
 IF prior.transfer_id IS NULL THEN
 INSERT INTO smarter_private.f06_manager_custody_transfers(transfer_id,tournament_id,origin_generation,successor_generation,local_proof,canonical_proof)
 VALUES(p_transfer_id,p_tournament_id,p_origin_generation,p_successor_generation,p_local,canonical) RETURNING * INTO prior;
 END IF;
 receipt:=to_jsonb(prior);
 END IF;
 RETURN jsonb_build_object('ok',true,'transfer_id',p_transfer_id,'tournament_id',p_tournament_id,
 'origin_generation',p_origin_generation,'successor_generation',p_successor_generation,'local',p_local,'canonical',canonical,'receipt',receipt);
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb) TO service_role;

CREATE FUNCTION smarter_private.f06_mixed_current_admission(t uuid,g uuid,transfer uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE a smarter_private.f06_manager_custody_admissions; l jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(t,g);
 SELECT to_jsonb(e)-'heartbeat_at' INTO l FROM public.engine_tournament_leases e WHERE tournament_id=t;
 SELECT * INTO a FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id=transfer FOR SHARE;
 IF NOT FOUND OR a.tournament_id IS DISTINCT FROM t OR a.generation IS DISTINCT FROM g OR a.lease_identity IS DISTINCT FROM l THEN
 RAISE EXCEPTION 'F06_MIXED_ADMITTED_PROCESS_CHANGED'; END IF;
 RETURN to_jsonb(a);
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_current_admission(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_f06_admit_mixed_manager_custody(p_tournament_id uuid,p_lease_generation uuid,p_transfer_id uuid,p_expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE prior smarter_private.f06_manager_custody_transfers; canonical jsonb; a smarter_private.f06_manager_custody_admissions; l jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 PERFORM smarter_private.f06_try_lane(p_tournament_id);
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation,false);
 SELECT * INTO prior FROM smarter_private.f06_manager_custody_transfers WHERE transfer_id=p_transfer_id FOR SHARE;
 IF NOT FOUND OR prior.tournament_id IS DISTINCT FROM p_tournament_id OR prior.successor_generation IS DISTINCT FROM p_lease_generation
 OR to_jsonb(prior) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_MIXED_SUCCESSOR_CHANGED'; END IF;
 SELECT * INTO a FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id=p_transfer_id;
 IF FOUND THEN
 PERFORM smarter_private.f06_mixed_current_admission(p_tournament_id,p_lease_generation,p_transfer_id);
 ELSE
 canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,prior.origin_generation,prior.local_proof);
 -- The only legal change before admission is an original's positive terminal
 -- disposition. The original bindings and all operation/seat vectors stay exact.
 IF canonical-ARRAY['originals','original_evidence','pending_original_tables'] IS DISTINCT FROM
 prior.canonical_proof-ARRAY['originals','original_evidence','pending_original_tables'] THEN RAISE EXCEPTION 'F06_MIXED_CANONICAL_CHANGED'; END IF;
 IF canonical->'pending_original_tables' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED'; END IF;
 SELECT to_jsonb(e)-'heartbeat_at' INTO l FROM public.engine_tournament_leases e WHERE tournament_id=p_tournament_id;
 INSERT INTO smarter_private.f06_manager_custody_admissions(transfer_id,tournament_id,generation,lease_identity,terminal_proof)
 VALUES(p_transfer_id,p_tournament_id,p_lease_generation,l,canonical->'original_evidence') RETURNING * INTO a;
 END IF;
 RETURN jsonb_build_object('ok',true,'custody_only',true,'transfer_id',p_transfer_id,'tournament_id',p_tournament_id,
 'lease_generation',p_lease_generation,'receipt',to_jsonb(prior),'admission',to_jsonb(a));
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb) TO service_role;

-- First execution retains the proposed original input before a business RPC.
-- A lost reply can only recover the same key/payload, never mint another UUID.
CREATE FUNCTION public.fn_f06_mixed_custody_intent(p_tournament_id uuid,p_lease_generation uuid,p_transfer_id uuid,p_key text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE prior smarter_private.f06_manager_custody_intents;
BEGIN
 PERFORM smarter_private.f06_mixed_current_admission(p_tournament_id,p_lease_generation,p_transfer_id);
 IF p_key IS NULL OR p_key !~ '^(begin|amend|custody):[0-9a-f-]{36}(:[0-9a-f-]{36})?$' OR COALESCE(jsonb_typeof(p_payload),'null') NOT IN('object','array') THEN
 RAISE EXCEPTION 'F06_MIXED_INTENT_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions WHERE transfer_id=p_transfer_id) THEN RAISE EXCEPTION 'F06_MIXED_ALREADY_COMPLETE'; END IF;
 SELECT * INTO prior FROM smarter_private.f06_manager_custody_intents WHERE transfer_id=p_transfer_id AND intent_key=p_key;
 IF NOT FOUND THEN INSERT INTO smarter_private.f06_manager_custody_intents(transfer_id,intent_key,payload)
 VALUES(p_transfer_id,p_key,p_payload) RETURNING * INTO prior;
 ELSIF prior.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'F06_MIXED_INTENT_CHANGED'; END IF;
 RETURN jsonb_build_object('ok',true,'transfer_id',p_transfer_id,'key',p_key,'payload',prior.payload);
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_mixed_custody_intent(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_mixed_custody_intent(uuid,uuid,uuid,text,jsonb) TO service_role;

-- Consume native parked custody only after exact canonical winners. This writes
-- the same native checkpoint read by applyParkedTimeBanks; it does not seed an
-- allowance or calculate one from accounting metadata.
CREATE FUNCTION smarter_private.f06_mixed_adopt_presence(t uuid,local_proof jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE engine jsonb; custody jsonb; durable jsonb; banks jsonb; fsm jsonb; user_key text; original_stay uuid;
 target public.table_seats; bank jsonb; presence jsonb; targets jsonb:='{}'; item jsonb; table_key text;
 hand bigint; at_time timestamptz:=clock_timestamp(); receipt jsonb; receipts jsonb:='[]'; n integer;
BEGIN
 FOR engine IN SELECT * FROM jsonb_array_elements(local_proof->'engines') LOOP
 PERFORM smarter_private.f06_mixed_bank_proof(t,engine);
 custody:=engine->'bank_custody'; durable:=custody->'durable_presence';
 banks:=COALESCE(durable#>'{time_bank_snapshot,players}','{}'::jsonb);
 fsm:=COALESCE(durable->'disconnect_states','{}'::jsonb);
 FOR user_key IN SELECT key FROM jsonb_object_keys(banks||fsm) AS keys(key) ORDER BY key LOOP
 SELECT count(*),min((r->>1)::text)::uuid INTO n,original_stay FROM jsonb_array_elements(custody->'roster') r WHERE r->>0=user_key;
 IF n<>1 OR original_stay IS NULL THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN'; END IF;
 SELECT count(*) INTO n FROM public.table_seats seat WHERE seat.table_id=(engine->>'table_id')::uuid
 AND seat.user_id=user_key::uuid AND seat.occupancy_id=original_stay AND seat.left_at IS NULL;
 receipt:=NULL;
 IF n=1 THEN
 SELECT * INTO target FROM public.table_seats seat WHERE seat.table_id=(engine->>'table_id')::uuid AND seat.user_id=user_key::uuid AND seat.occupancy_id=original_stay AND seat.left_at IS NULL;
 ELSE
 SELECT count(*) INTO n FROM public.tournament_seat_move_receipts m JOIN smarter_private.f06_attempts a ON a.request_id=m.request_id AND a.state='winner' AND a.receipt-ARRAY['source_occupancy_id','source_lifecycle','break_id']=to_jsonb(m) JOIN public.table_seats seat ON seat.id=m.destination_seat_id
 AND seat.table_id=m.destination_table_id AND seat.user_id=m.user_id AND seat.seat_number=m.destination_seat_number
 AND seat.joined_at=m.moved_at AND seat.left_at IS NULL
 WHERE m.tournament_id=t AND m.user_id=user_key::uuid AND m.source_table_id=(engine->>'table_id')::uuid AND (a.receipt->>'source_occupancy_id')::uuid=original_stay;
 IF n<>1 THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN'; END IF;
 SELECT to_jsonb(m) INTO receipt FROM public.tournament_seat_move_receipts m JOIN smarter_private.f06_attempts a ON a.request_id=m.request_id AND a.state='winner' AND a.receipt-ARRAY['source_occupancy_id','source_lifecycle','break_id']=to_jsonb(m) JOIN public.table_seats seat ON seat.id=m.destination_seat_id
 AND seat.table_id=m.destination_table_id AND seat.user_id=m.user_id AND seat.seat_number=m.destination_seat_number
 AND seat.joined_at=m.moved_at AND seat.left_at IS NULL
 WHERE m.tournament_id=t AND m.user_id=user_key::uuid AND m.source_table_id=(engine->>'table_id')::uuid AND (a.receipt->>'source_occupancy_id')::uuid=original_stay;
 SELECT * INTO target FROM public.table_seats WHERE id=(receipt->>'destination_seat_id')::uuid;
 END IF;
 IF target.occupancy_id IS NULL THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_DESTINATION_UNPROVEN'; END IF;
 bank:=banks->user_key; presence:=fsm->user_key; table_key:=target.table_id::text;
 IF bank IS NOT NULL THEN bank:=jsonb_set(bank,'{occupancyId}',to_jsonb(target.occupancy_id)); END IF;
 item:=COALESCE(targets->table_key,jsonb_build_object('banks','{}'::jsonb,'presence','{}'::jsonb));
 -- Retain the oldest contributing native timestamp. Banks have no age expiry;
 -- disconnect presence does. Transfer must not renew its original freshness.
 IF durable->>'parked_at' IS NULL OR NOT isfinite((durable->>'parked_at')::timestamptz) THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_TIME_UNPROVEN'; END IF;
 item:=jsonb_set(item,'{parked_at}',to_jsonb(LEAST((item->>'parked_at')::timestamptz,(durable->>'parked_at')::timestamptz)));
 IF item#>ARRAY['banks',user_key] IS NOT NULL AND item#>ARRAY['banks',user_key] IS DISTINCT FROM bank
 OR item#>ARRAY['presence',user_key] IS NOT NULL AND item#>ARRAY['presence',user_key] IS DISTINCT FROM presence
 THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_CONFLICT'; END IF;
 IF bank IS NOT NULL THEN item:=jsonb_set(item,ARRAY['banks',user_key],bank); END IF;
 IF presence IS NOT NULL THEN item:=jsonb_set(item,ARRAY['presence',user_key],presence); END IF;
 targets:=jsonb_set(targets,ARRAY[table_key],item);
 receipts:=receipts||jsonb_build_array(jsonb_build_object('user_id',user_key,'source_table',engine->>'table_id',
 'source_occupancy',original_stay,'destination_table',target.table_id,'destination_occupancy',target.occupancy_id,'move_receipt',receipt,'bank',bank,'presence',presence));
 END LOOP;
 END LOOP;
 FOR table_key,item IN SELECT * FROM jsonb_each(targets) ORDER BY key LOOP
 SELECT COALESCE(max(hand_number),0) INTO hand FROM public.hand_history WHERE table_id=table_key::uuid;
 INSERT INTO public.engine_presence_parked(table_id,disconnect_states,parked_at,engine_instance,time_bank_snapshot)
 VALUES(table_key::uuid,item->'presence',(item->>'parked_at')::timestamptz,'f06_mixed_custody',jsonb_build_object('version',1,'parkedAt',item->'parked_at','handNumber',hand,'players',item->'banks'))
 ON CONFLICT(table_id) DO UPDATE SET disconnect_states=EXCLUDED.disconnect_states,parked_at=EXCLUDED.parked_at,
 engine_instance=EXCLUDED.engine_instance,time_bank_snapshot=EXCLUDED.time_bank_snapshot;
 END LOOP;
 RETURN receipts;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_adopt_presence(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_f06_complete_mixed_manager_custody(p_tournament_id uuid,p_lease_generation uuid,p_transfer_id uuid,p_expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE a jsonb; prior smarter_private.f06_manager_custody_transfers; c smarter_private.f06_manager_custody_completions; operations jsonb; x jsonb; ids uuid[]; users uuid[]; u uuid; presence_receipts jsonb;
BEGIN
 a:=smarter_private.f06_mixed_current_admission(p_tournament_id,p_lease_generation,p_transfer_id);
 PERFORM smarter_private.f06_try_lane(p_tournament_id);
 SELECT * INTO prior FROM smarter_private.f06_manager_custody_transfers WHERE transfer_id=p_transfer_id FOR SHARE;
 IF to_jsonb(prior) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_MIXED_COMPLETION_CHANGED'; END IF;
 SELECT * INTO c FROM smarter_private.f06_manager_custody_completions WHERE transfer_id=p_transfer_id;
 IF NOT FOUND THEN
 SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO ids FROM public.tables WHERE tournament_id=p_tournament_id;
 IF to_jsonb(ids) IS DISTINCT FROM (SELECT jsonb_agg(e->'id' ORDER BY e->>'id') FROM jsonb_array_elements(prior.canonical_proof->'tables') e)
 THEN RAISE EXCEPTION 'F06_MIXED_TABLE_SET_CHANGED'; END IF;
 SELECT COALESCE(array_agg(DISTINCT user_id ORDER BY user_id),'{}') INTO users FROM public.table_seats WHERE table_id=ANY(ids) AND user_id IS NOT NULL;
 FOREACH u IN ARRAY users LOOP IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)) THEN RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF; END LOOP;
 PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s WHERE s.table_id=ANY(ids) ORDER BY s.id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id ORDER BY break_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_members WHERE break_id IN(SELECT break_id FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id) ORDER BY break_id,user_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_attempts WHERE break_id IN(SELECT break_id FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id) ORDER BY request_id FOR UPDATE;
 PERFORM 1 FROM public.tournament_seat_move_receipts WHERE tournament_id=p_tournament_id ORDER BY request_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id AND state NOT IN('acknowledged','withdrawn_before_manifest'))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=p_tournament_id AND state='reserved')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts m USING(request_id) JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=p_tournament_id)
 THEN RAISE EXCEPTION 'F06_MIXED_RECOVERY_INCOMPLETE'; END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(prior.canonical_proof->'operations') LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.break_id=(x->>'break_id')::uuid AND o.tournament_id=p_tournament_id
 AND o.source_table_id=(x->>'source_table_id')::uuid AND o.lifecycle=(x->>'lifecycle')::bigint AND
 (o.state='acknowledged' AND o.close_receipt IS NOT NULL OR o.state='withdrawn_before_manifest' AND EXISTS(SELECT 1 FROM smarter_private.f06_no_start_continuations n WHERE n.break_id=o.break_id))) THEN
 RAISE EXCEPTION 'F06_MIXED_ORIGINAL_OUTCOME_UNPROVEN'; END IF; END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(prior.local_proof->'pending_moves') LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts a JOIN smarter_private.f06_operations o USING(break_id)
 WHERE o.tournament_id=p_tournament_id AND a.request_id=(x->>0)::uuid AND a.state IN('winner','fenced')
 AND EXISTS(SELECT 1 FROM smarter_private.f06_members m JOIN smarter_private.f06_attempts winner ON winner.break_id=m.break_id AND winner.user_id=m.user_id
 WHERE m.break_id=a.break_id AND m.user_id=a.user_id AND winner.state='winner' AND winner.receipt IS NOT NULL))
 THEN RAISE EXCEPTION 'F06_MIXED_PENDING_REQUEST_UNRESOLVED'; END IF;
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(prior.local_proof->'parks') LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.tournament_id=p_tournament_id
 AND o.break_id=(x#>>'{1,breakId}')::uuid AND o.source_table_id=(x->>0)::uuid
 AND o.lifecycle=(x#>>'{1,lifecycle}')::bigint AND o.boundary_id=(x#>>'{1,boundaryId}')::uuid
 AND o.state IN('acknowledged','withdrawn_before_manifest')) THEN RAISE EXCEPTION 'F06_MIXED_PENDING_PARK_UNRESOLVED'; END IF;
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(prior.local_proof->'custody_ids') LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.tournament_id=p_tournament_id
 AND o.break_id=(x->>0)::uuid AND o.custody_id=(x->>1)::uuid AND o.state='acknowledged')
 THEN RAISE EXCEPTION 'F06_MIXED_PENDING_CUSTODY_UNRESOLVED'; END IF;
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(prior.local_proof->'cleanup_kinds') LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.tournament_id=p_tournament_id
 AND o.break_id=(x->>0)::uuid AND o.cleanup_kind=x->>1 AND o.state='acknowledged')
 THEN RAISE EXCEPTION 'F06_MIXED_PENDING_ACK_UNRESOLVED'; END IF;
 END LOOP;
 -- Pending begin input and first-send intents bind immutable original manifests.
 FOR x IN SELECT value FROM jsonb_array_elements(prior.local_proof->'begins')
 UNION ALL SELECT jsonb_build_array(split_part(intent_key,':',2),payload) FROM smarter_private.f06_manager_custody_intents
 WHERE transfer_id=p_transfer_id AND intent_key LIKE 'begin:%' LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.tournament_id=p_tournament_id AND o.break_id=(x->>0)::uuid
 AND o.manifest=(SELECT jsonb_agg(m ORDER BY m->>'user_id') FROM jsonb_array_elements(x->1) m) AND o.state='acknowledged')
 THEN RAISE EXCEPTION 'F06_MIXED_PENDING_BEGIN_UNRESOLVED'; END IF;
 END LOOP;
 FOR x IN SELECT value->1 FROM jsonb_array_elements(prior.local_proof->'amendments')
 UNION ALL SELECT payload FROM smarter_private.f06_manager_custody_intents WHERE transfer_id=p_transfer_id AND intent_key LIKE 'amend:%' LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts attempt WHERE attempt.break_id=(x->>'breakId')::uuid AND attempt.user_id=(x->>'userId')::uuid
 AND ((attempt.amendment_id=(x->>'amendmentId')::uuid AND attempt.request_id=(x->>'newRequestId')::uuid
 AND attempt.predecessor=(x->>'expectedRequestId')::uuid AND attempt.amendment_payload=jsonb_build_object('break',x->>'breakId','user',x->>'userId','predecessor',x->>'expectedRequestId','new',x->>'newRequestId','destination',x->>'destinationTableId','seat',(x->>'destinationSeatNumber')::integer,'reason',x->>'reason'))
 OR (attempt.request_id=(x->>'expectedRequestId')::uuid AND attempt.state IN('winner','fenced'))))
 THEN RAISE EXCEPTION 'F06_MIXED_PENDING_AMENDMENT_UNRESOLVED'; END IF;
 END LOOP;
 FOR x IN SELECT jsonb_build_array(split_part(intent_key,':',2),payload->>'custodyId') FROM smarter_private.f06_manager_custody_intents WHERE transfer_id=p_transfer_id AND intent_key LIKE 'custody:%' LOOP
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.tournament_id=p_tournament_id AND o.break_id=(x->>0)::uuid
 AND o.custody_id=(x->>1)::uuid AND o.state='acknowledged') THEN RAISE EXCEPTION 'F06_MIXED_PENDING_CUSTODY_UNRESOLVED'; END IF;
 END LOOP;
 SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.break_id),'[]') INTO operations FROM smarter_private.f06_operations o WHERE tournament_id=p_tournament_id;
 PERFORM 1 FROM public.engine_presence_parked WHERE table_id=ANY(ids) ORDER BY table_id FOR UPDATE;
 presence_receipts:=smarter_private.f06_mixed_adopt_presence(p_tournament_id,prior.local_proof);
 INSERT INTO smarter_private.f06_manager_custody_completions(transfer_id,tournament_id,generation,admission,operation_receipts,presence_receipts)
 VALUES(p_transfer_id,p_tournament_id,p_lease_generation,a,operations,presence_receipts) RETURNING * INTO c;
 END IF;
 RETURN jsonb_build_object('ok',true,'transfer_id',p_transfer_id,'tournament_id',p_tournament_id,'lease_generation',p_lease_generation,'completion',to_jsonb(c));
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb) TO service_role;

-- A replacement process discovers the already selected generation before claim.
-- This observation grants neither a lease nor physical absence.
CREATE FUNCTION public.fn_f06_find_mixed_manager_custody(p_tournament_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE receipt smarter_private.f06_manager_custody_transfers;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR p_tournament_id IS NULL THEN RAISE EXCEPTION 'F06_MIXED_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id=p_tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions c WHERE c.transfer_id=f06_manager_custody_transfers.transfer_id))>1 THEN
 RAISE EXCEPTION 'F06_MIXED_TRANSFER_SELECTION_UNPROVEN'; END IF;
 SELECT * INTO receipt FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id=p_tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions c WHERE c.transfer_id=f06_manager_custody_transfers.transfer_id);
 RETURN jsonb_build_object('ok',true,'tournament_id',p_tournament_id,'receipt',CASE WHEN FOUND THEN to_jsonb(receipt) ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_find_mixed_manager_custody(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_find_mixed_manager_custody(uuid) TO service_role;

-- The existing publisher verifies the installed contract before creating its
-- one-shot intent or attaching to the original process. This fixed catalogue
-- observation has no dynamic SQL, business reads, locks or write capabilities.
CREATE FUNCTION public.fn_f06_mixed_custody_contract() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'F06_MIXED_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN (SELECT jsonb_build_object('kind','f06_mixed_custody_contract_v1','functions',jsonb_agg(jsonb_build_object(
 'signature',wanted.signature,'definition_md5',md5(pg_get_functiondef(p.oid)),
 'body_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,
 'security_definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile) ORDER BY wanted.signature))
 FROM (VALUES
 ('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)'),
 ('public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'),
 ('public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb)'),
 ('public.fn_f06_find_mixed_manager_custody(uuid)'),
 ('public.fn_f06_mixed_custody_intent(uuid,uuid,uuid,text,jsonb)'),
 ('public.fn_f06_mixed_custody_contract()'),
 ('smarter_private.f06_assert_movement(uuid)'),
 ('smarter_private.f06_manager_transfer_immutable()'),
 ('smarter_private.f06_mixed_adopt_presence(uuid,jsonb)'),
 ('smarter_private.f06_mixed_bank_proof(uuid,jsonb)'),
 ('smarter_private.f06_mixed_current_admission(uuid,uuid,uuid)'),
 ('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)'),
 ('smarter_private.f06_mixed_movement_generation(uuid)'),
 ('smarter_private.f06_mixed_preparation_guard()')
 ) wanted(signature) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(wanted.signature));
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_mixed_custody_contract() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_mixed_custody_contract() TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_assert_movement(uuid)'::regprocedure AND md5(prosrc)='21bdda0e69a407e7df29e2dbf51f0af3' AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_GUARD_DRIFT'; END IF; END $$;
-- The original operation stays in its original generation. A separate admitted
-- receipt authorizes only its original movement under one real successor lease.
CREATE FUNCTION smarter_private.f06_mixed_movement_generation(p_break uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE o smarter_private.f06_operations; transfer smarter_private.f06_manager_custody_transfers;
 original jsonb; seat jsonb; registration jsonb; actual jsonb; winning jsonb; movement jsonb; g uuid;
 remaining integer:=0;
BEGIN
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT c.* INTO transfer FROM smarter_private.f06_manager_custody_transfers c
 JOIN smarter_private.f06_manager_custody_admissions a USING(transfer_id)
 WHERE c.tournament_id=o.tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions done WHERE done.transfer_id=c.transfer_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 g:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
 PERFORM smarter_private.f06_mixed_current_admission(o.tournament_id,g,transfer.transfer_id);
 SELECT value INTO original FROM jsonb_array_elements(transfer.canonical_proof->'operations') WHERE value->>'break_id'=p_break::text;
 IF original IS NULL OR (original->>'tournament_id',original->>'source_table_id',original->>'lifecycle') IS DISTINCT FROM
 (o.tournament_id::text,o.source_table_id::text,o.lifecycle::text)
 OR original->>'state' NOT IN('park_requested','begun','close_confirmed')
 OR o.state NOT IN('park_requested','begun','close_confirmed')
 OR (original->'manifest'<>'null'::jsonb AND original->'manifest' IS DISTINCT FROM o.manifest)
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=o.source_table_id AND tournament_id=o.tournament_id AND f06_lifecycle=o.lifecycle)
 THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_ORIGINAL_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=o.tournament_id AND state='reserved')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) WHERE h.tournament_id=o.tournament_id)
 THEN RAISE EXCEPTION 'F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED'; END IF;
 -- The complete captured source roster remains exact until canonical winning
 -- receipts consume each original occupancy. Destination stacks are not proof.
 FOR seat IN SELECT value FROM jsonb_array_elements(transfer.canonical_proof->'seats')
 WHERE value->>'table_id'=o.source_table_id::text AND value->'left_at'='null'::jsonb LOOP
 SELECT value INTO registration FROM jsonb_array_elements(transfer.canonical_proof->'registrations') WHERE value->>'user_id'=seat->>'user_id';
 IF registration IS NULL OR (seat->>'stack')::numeric<=0 OR registration->>'status'<>'playing'
 OR (registration->>'chips')::numeric IS DISTINCT FROM (seat->>'stack')::numeric THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_ROSTER_UNPROVEN'; END IF;
 SELECT a.receipt,to_jsonb(r) INTO winning,movement FROM smarter_private.f06_attempts a
 JOIN public.tournament_seat_move_receipts r USING(request_id) WHERE a.break_id=p_break AND a.user_id=(seat->>'user_id')::uuid AND a.state='winner';
 IF FOUND THEN
 IF winning-ARRAY['source_occupancy_id','source_lifecycle','break_id'] IS DISTINCT FROM movement
 OR (winning->>'source_seat_id',winning->>'source_occupancy_id',winning->>'source_table_id',winning->>'source_lifecycle',winning->>'break_id') IS DISTINCT FROM
 (seat->>'id',seat->>'occupancy_id',o.source_table_id::text,o.lifecycle::text,p_break::text)
 OR (winning->>'stack')::numeric IS DISTINCT FROM (seat->>'stack')::numeric
 THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_WINNER_CHANGED'; END IF;
 ELSE
 remaining:=remaining+1;
 SELECT to_jsonb(s) INTO actual FROM public.table_seats s WHERE s.id=(seat->>'id')::uuid;
 IF actual IS DISTINCT FROM seat THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_ROSTER_CHANGED'; END IF;
 SELECT to_jsonb(p) INTO actual FROM public.tournament_players p WHERE p.tournament_id=o.tournament_id AND p.user_id=(seat->>'user_id')::uuid;
 IF actual IS DISTINCT FROM registration THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_REGISTRATION_CHANGED'; END IF;
 END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=o.source_table_id AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=o.tournament_id AND table_id=o.source_table_id AND status IN('playing','registered'))<>remaining
 THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_WHOLE_ROSTER_REQUIRED'; END IF;
 RETURN g;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_movement_generation(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- A custody-only admission cannot create an ordinary dealer permit. The fence
-- ends at the immutable completion, never at a missing process-local object.
CREATE FUNCTION smarter_private.f06_mixed_preparation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
BEGIN
 IF NEW.state='reserved' AND EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers c
 WHERE c.tournament_id=NEW.tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions done WHERE done.transfer_id=c.transfer_id))
 THEN RAISE EXCEPTION 'F06_MIXED_CUSTODY_ONLY'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_preparation_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_mixed_preparation_custody BEFORE INSERT OR UPDATE ON smarter_private.f06_hand_permits
FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_mixed_preparation_guard();

CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(p_break uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE a smarter_private.f06_movement_admissions; o smarter_private.f06_operations;
 r jsonb; actual jsonb; winner jsonb; movement public.tournament_seat_move_receipts; remaining integer:=0; mixed_generation uuid;
 g uuid:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
BEGIN
 mixed_generation:=smarter_private.f06_mixed_movement_generation(p_break);
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions WHERE break_id=p_break) THEN RETURN; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break;
 SELECT * INTO a FROM smarter_private.f06_movement_admissions WHERE break_id=p_break AND custody_id=o.custody_id;
 IF NOT FOUND OR o.custody_generation IS DISTINCT FROM a.lease_generation OR o.revision IS DISTINCT FROM a.revision
 OR o.lifecycle IS DISTINCT FROM a.lifecycle OR o.source_table_id IS DISTINCT FROM a.table_id
 OR o.tournament_id IS DISTINCT FROM a.tournament_id OR (g IS DISTINCT FROM a.lease_generation AND g IS DISTINCT FROM mixed_generation)
 OR o.state NOT IN ('park_requested','begun','close_confirmed') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_authority(a.tournament_id,COALESCE(mixed_generation,a.lease_generation),false);
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR smarter_private.f06_movement_permits(a.tournament_id,a.table_id,(a.proof#>>'{atomic,hand_number}')::bigint) IS DISTINCT FROM a.proof->'permits'
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id AND NOT is_complete)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id AND (hand_number>(a.proof#>>'{atomic,hand_number}')::bigint OR committed_at>(a.proof#>>'{atomic,committed_at}')::timestamptz))
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits x WHERE hand_id=(a.proof#>>'{atomic,hand_id}')::uuid AND to_jsonb(x)=a.proof->'atomic')
 OR NOT EXISTS(SELECT 1 FROM public.hand_history x WHERE id=(a.proof#>>'{history,id}')::uuid AND to_jsonb(x)=a.proof->'history') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'roster') LOOP
 SELECT d.receipt INTO winner FROM smarter_private.f06_attempts d JOIN public.tournament_seat_move_receipts m ON m.request_id=d.request_id
 WHERE d.break_id=p_break AND d.user_id=(r#>>'{seat,user_id}')::uuid AND d.state='winner';
 IF FOUND THEN
 SELECT * INTO movement FROM public.tournament_seat_move_receipts WHERE request_id=(winner->>'request_id')::uuid;
 IF NOT FOUND OR winner-'source_occupancy_id'-'source_lifecycle'-'break_id' IS DISTINCT FROM to_jsonb(movement)
 OR (winner->>'source_table_id')::uuid IS DISTINCT FROM a.table_id OR (winner->>'source_seat_id')::uuid IS DISTINCT FROM (r#>>'{seat,id}')::uuid
 OR (winner->>'source_occupancy_id')::uuid IS DISTINCT FROM (r#>>'{seat,occupancy_id}')::uuid
 OR (winner->>'stack')::numeric IS DISTINCT FROM (r#>>'{seat,stack}')::numeric OR (winner->>'break_id')::uuid IS DISTINCT FROM p_break
 OR (winner->>'source_lifecycle')::bigint IS DISTINCT FROM a.lifecycle THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WINNER_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 remaining:=remaining+1;
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p)) INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id AND s.left_at IS NULL;
 IF actual IS DISTINCT FROM r THEN RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'eliminated') LOOP
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p),'accepted',r->'accepted') INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id;
 IF actual IS DISTINCT FROM r THEN RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=a.table_id AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=a.tournament_id AND table_id=a.table_id AND status IN ('playing','registered'))<>remaining THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
END $$;
COMMIT;
