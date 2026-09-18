-- A source excluded by its original break needs movement custody, never a new hand.
-- Additive only: original settlement, mixed-disposition and no-start guards remain intact.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';

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

CREATE TABLE smarter_private.f06_movement_admissions (
 admission_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, lease_generation uuid NOT NULL,
 table_id uuid NOT NULL, lifecycle bigint NOT NULL CHECK(lifecycle>0), break_id uuid NOT NULL,
 custody_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0), requested_revision bigint NOT NULL CHECK(requested_revision>=0), proof jsonb NOT NULL,
 proof_hash text NOT NULL CHECK(proof_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(break_id,custody_id)
);
ALTER TABLE smarter_private.f06_movement_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_movement_admissions FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.f06_movement_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'F06_MOVEMENT_RECEIPT_IMMUTABLE' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_movement_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_movement_admissions
FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_movement_immutable();
CREATE TRIGGER f06_movement_no_truncate BEFORE TRUNCATE ON smarter_private.f06_movement_admissions
FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_movement_immutable();

-- Modern sources retain accepted permits. They are historical custody, not an
-- unresolved hand, only when each permit joins its actual completed commit.
CREATE FUNCTION smarter_private.f06_movement_permits(p_tournament uuid,p_table uuid,p_boundary bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE result jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h
 LEFT JOIN public.hand_atomic_commits a ON a.hand_id=h.evidence_id AND a.table_id=h.table_id AND a.hand_number=h.hand_number
 WHERE h.table_id=p_table AND (h.tournament_id IS DISTINCT FROM p_tournament OR h.state<>'accepted'
 OR h.hand_number>p_boundary OR a.hand_id IS NULL OR a.post_commit_completed_at IS NULL
 OR NOT isfinite(a.post_commit_completed_at) OR a.post_commit_completed_at<a.committed_at
 OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number
 OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=p_table AND t.f06_lifecycle=h.lifecycle)))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) WHERE h.table_id=p_table) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.hand_number,h.permit_id),'[]'::jsonb) INTO result
 FROM smarter_private.f06_hand_permits h WHERE h.table_id=p_table;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_permits(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;

-- Only the owning admission transaction calls this under the original F06 lanes.
-- Zero-stack participants remain in the canonical receipt and tombstone evidence;
-- the remaining positive seats are a subset, not a fabricated new hand roster.
CREATE FUNCTION smarter_private.f06_movement_prior(p_tournament uuid,p_table uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE a public.hand_atomic_commits; h public.hand_history; s jsonb; payload jsonb; submitted jsonb;
 x jsonb; seat public.table_seats; registration public.tournament_players;
 roster jsonb:='[]'; eliminated jsonb:='[]'; permits jsonb; n integer; positive integer:=0;
BEGIN
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=p_table ORDER BY hand_number DESC LIMIT 1 FOR SHARE;
 IF NOT FOUND OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at)
 OR a.post_commit_completed_at<a.committed_at OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number THEN
 RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 SELECT * INTO h FROM public.hand_history WHERE id=a.hand_id AND table_id=p_table AND hand_number=a.hand_number FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table AND committed_at>a.committed_at)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table AND hand_number>a.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table AND hand_number>a.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table AND NOT is_complete) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_NOT_LAST_BOUNDARY' USING ERRCODE='55000'; END IF;
 permits:=smarter_private.f06_movement_permits(p_tournament,p_table,a.hand_number);
 payload:=a.post_commit_payload;
 IF a.payload_hash IS NULL OR a.payload_hash !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload->>'version' IS DISTINCT FROM '1'
 OR jsonb_typeof(payload->'accepted_hand_facts') IS DISTINCT FROM 'object'
 OR encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_payload_hash THEN
 RAISE EXCEPTION 'F06_MOVEMENT_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 submitted:=payload-'accepted_hand_facts';
 IF jsonb_typeof(submitted->'pending_addons')='object' THEN
 IF jsonb_typeof(submitted#>'{pending_addons,ids}') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_MOVEMENT_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 submitted:=submitted#-'{pending_addons,ids}'; END IF;
 IF encode(extensions.digest(convert_to(submitted::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_request_hash THEN
 RAISE EXCEPTION 'F06_MOVEMENT_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 s:=a.stack_result;
 IF s->'success' IS DISTINCT FROM 'true'::jsonb OR s->>'mode' IS DISTINCT FROM 'delta'
 OR s->>'table_id' IS DISTINCT FROM p_table::text OR s->>'tournament_id' IS DISTINCT FROM p_tournament::text
 OR (s->>'hand_number')::bigint IS DISTINCT FROM a.hand_number OR NULLIF(s->>'hand_id','') IS NULL
 OR s->'conservation_checked' IS DISTINCT FROM 'true'::jsonb OR s->'tournament_players_synced' IS DISTINCT FROM 'true'::jsonb
 OR s->'rebased' IS DISTINCT FROM '{}'::jsonb OR s->'departed' IS DISTINCT FROM '[]'::jsonb
 OR (s->>'net_deltas')::numeric IS DISTINCT FROM 0 OR (s->>'inflow')::numeric IS DISTINCT FROM 0
 OR (s->>'rake')::numeric IS DISTINCT FROM 0 OR (s->>'bbj')::numeric IS DISTINCT FROM 0
 OR jsonb_typeof(s#>'{request,stacks}') IS DISTINCT FROM 'array'
 OR jsonb_typeof(s->'written') IS DISTINCT FROM 'object'
 OR jsonb_typeof(s->'tournament_player_chips') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 n:=jsonb_array_length(s#>'{request,stacks}');
 IF n NOT BETWEEN 1 AND 10 OR (s->>'players')::integer IS DISTINCT FROM n
 OR (s->>'tournament_player_count')::integer IS DISTINCT FROM n
 OR jsonb_array_length(s->'tournament_player_chips')<>n
 OR (SELECT count(*) FROM jsonb_object_keys(s->'written'))<>n
 OR (SELECT count(DISTINCT v->>'user_id') FROM jsonb_array_elements(s#>'{request,stacks}') v)<>n
 OR (SELECT count(DISTINCT v->>'user_id') FROM jsonb_array_elements(s->'tournament_player_chips') v)<>n THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(s#>'{request,stacks}') ORDER BY value->>'user_id' LOOP
 IF x->>'stack' IS NULL OR x->>'stack' !~ '^[0-9]+([.][0-9]+)?$'
 OR (s->'written'->>(x->>'user_id'))::numeric IS DISTINCT FROM (x->>'stack')::numeric
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'tournament_player_chips') v
 WHERE v->>'user_id'=x->>'user_id' AND (v->>'chips')::numeric=(x->>'stack')::numeric) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 SELECT * INTO seat FROM public.table_seats WHERE id=(x->>'seat_id')::uuid AND table_id=p_table
 AND user_id=(x->>'user_id')::uuid AND joined_at=(x->>'seat_joined_at')::timestamptz FOR UPDATE;
 IF NOT FOUND OR seat.stack IS DISTINCT FROM (x->>'stack')::numeric OR seat.occupancy_id IS NULL THEN
 RAISE EXCEPTION 'F06_MOVEMENT_SEAT_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO registration FROM public.tournament_players WHERE tournament_id=p_tournament AND user_id=seat.user_id FOR UPDATE;
 IF NOT FOUND OR registration.chips::numeric IS DISTINCT FROM seat.stack THEN
 RAISE EXCEPTION 'F06_MOVEMENT_REGISTRATION_CHANGED' USING ERRCODE='55000'; END IF;
 IF seat.stack=0 THEN
 IF seat.left_at IS NULL OR registration.status<>'eliminated' OR registration.eliminated_at IS NULL THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_UNPROVEN' USING ERRCODE='55000'; END IF;
 eliminated:=eliminated||jsonb_build_array(jsonb_build_object('seat',to_jsonb(seat),'registration',to_jsonb(registration),'accepted',x));
 ELSE
 IF seat.left_at IS NOT NULL OR registration.status<>'playing' OR registration.eliminated_at IS NOT NULL
 OR (registration.table_id,registration.seat_number) IS DISTINCT FROM(seat.table_id,seat.seat_number) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 positive:=positive+1;
 roster:=roster||jsonb_build_array(jsonb_build_object('seat',to_jsonb(seat),'registration',to_jsonb(registration)));
 END IF;
 END LOOP;
 IF positive=0 OR (SELECT count(*) FROM public.table_seats WHERE table_id=p_table AND left_at IS NULL)<>positive
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament AND table_id=p_table AND status IN ('playing','registered'))<>positive THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('atomic',to_jsonb(a),'history',to_jsonb(h),'roster',roster,'eliminated',eliminated,'permits',permits);
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Re-prove retained custody at each actual begin/dispatch. A committed winning
-- move replaces exactly one source seat; its receipt, never destination stack,
-- is the continuation proof while other players are still being moved.
CREATE FUNCTION smarter_private.f06_assert_movement(p_break uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE a smarter_private.f06_movement_admissions; o smarter_private.f06_operations;
 r jsonb; actual jsonb; winner jsonb; movement public.tournament_seat_move_receipts; remaining integer:=0;
 g uuid:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions WHERE break_id=p_break) THEN RETURN; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break;
 SELECT * INTO a FROM smarter_private.f06_movement_admissions WHERE break_id=p_break AND custody_id=o.custody_id;
 IF NOT FOUND OR o.custody_generation IS DISTINCT FROM a.lease_generation OR o.revision IS DISTINCT FROM a.revision
 OR o.lifecycle IS DISTINCT FROM a.lifecycle OR o.source_table_id IS DISTINCT FROM a.table_id
 OR o.tournament_id IS DISTINCT FROM a.tournament_id OR g IS DISTINCT FROM a.lease_generation
 OR o.state NOT IN ('park_requested','begun','close_confirmed') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_authority(a.tournament_id,a.lease_generation,false);
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
REVOKE ALL ON FUNCTION smarter_private.f06_assert_movement(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_f06_admit_parked_movement(p_tournament_id uuid,p_lease_generation uuid,p_table_id uuid,p_lifecycle bigint,
 p_break_id uuid,p_admission_id uuid,p_custody_id uuid,p_expected_revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE o smarter_private.f06_operations; a smarter_private.f06_movement_admissions; prior smarter_private.f06_movement_admissions;
 users uuid[]; proof jsonb; claimed jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.tournament_players WHERE tournament_id=p_tournament_id AND table_id=p_table_id;
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,COALESCE(users,'{}'),ARRAY[p_table_id]);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id FOR UPDATE;
 IF NOT FOUND OR (o.tournament_id,o.source_table_id,o.lifecycle) IS DISTINCT FROM(p_tournament_id,p_table_id,p_lifecycle)
 OR o.state NOT IN ('park_requested','begun') OR p_admission_id IS NULL OR p_custody_id IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND upper(status)='RUNNING')
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=p_table_id AND tournament_id=p_tournament_id AND f06_lifecycle=p_lifecycle AND lower(status)<>'closed' AND NOT COALESCE(is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_OPERATION_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM smarter_private.f06_movement_admissions WHERE admission_id=p_admission_id;
 IF FOUND THEN
 IF (a.tournament_id,a.lease_generation,a.table_id,a.lifecycle,a.break_id,a.custody_id) IS DISTINCT FROM
 (p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_break_id,p_custody_id) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 IF a.requested_revision IS DISTINCT FROM p_expected_revision THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 IF (a.custody_id,a.lease_generation,a.revision) IS DISTINCT FROM
 (o.custody_id,o.custody_generation,o.revision) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_assert_movement(p_break_id);
 ELSE
 IF o.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'F06_MOVEMENT_CAS_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO prior FROM smarter_private.f06_movement_admissions WHERE break_id=p_break_id AND custody_id=o.custody_id;
 IF FOUND THEN
 -- A successor may carry the same immutable original proof, not recapture a
 -- partial roster. Current lease authority replaces the old custody by CAS.
 proof:=prior.proof;
 ELSE
 IF o.state<>'park_requested' OR o.manifest IS NOT NULL THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);
 END IF;
 claimed:=public.fn_f06_claim_custody(p_tournament_id,p_lease_generation,p_break_id,p_custody_id,p_expected_revision);
 IF claimed->'ok' IS DISTINCT FROM 'true'::jsonb OR claimed->>'custody_id' IS DISTINCT FROM p_custody_id::text
 OR claimed->>'custody_generation' IS DISTINCT FROM p_lease_generation::text THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CAS_CHANGED' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_movement_admissions(admission_id,tournament_id,lease_generation,table_id,lifecycle,break_id,custody_id,revision,requested_revision,proof,proof_hash)
 VALUES(p_admission_id,p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_break_id,p_custody_id,(claimed->>'revision')::bigint,p_expected_revision,proof,
 encode(extensions.digest(convert_to(proof::text,'UTF8'),'sha256'),'hex')) RETURNING * INTO a;
 PERFORM smarter_private.f06_assert_movement(p_break_id);
 END IF;
 RETURN jsonb_build_object('ok',true,'mode','movement_only','admission_id',a.admission_id,'tournament_id',a.tournament_id,
 'lease_generation',a.lease_generation,'table_id',a.table_id,'lifecycle',a.lifecycle::text,'break_id',a.break_id,
 'custody_id',a.custody_id,'revision',a.revision::text,'proof_hash',a.proof_hash);
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint) TO service_role;

CREATE FUNCTION smarter_private.f06_movement_transition_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE b uuid;
BEGIN
 IF TG_TABLE_NAME='f06_operations' THEN
 IF NEW.manifest IS NOT DISTINCT FROM OLD.manifest THEN RETURN NEW; END IF;
 b:=NEW.break_id;
 ELSE
 SELECT break_id INTO b FROM smarter_private.f06_attempts WHERE request_id=NEW.request_id;
 END IF;
 PERFORM smarter_private.f06_assert_movement(b);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_transition_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_movement_manifest BEFORE UPDATE OF manifest ON smarter_private.f06_operations
FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_movement_transition_guard();
CREATE TRIGGER f06_movement_dispatch BEFORE INSERT OR UPDATE ON smarter_private.f06_dispatch
FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_movement_transition_guard();
COMMIT;
