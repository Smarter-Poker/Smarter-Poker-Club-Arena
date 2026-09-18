-- Separate whole-generation interrupted-hand disposition. Zero chips credited.
-- The installed HU and successor RPCs and their unique constraints are unchanged.
-- Exact current lease + full reserved set + saved-stack arithmetic are mandatory.
-- Accepted siblings and accepted-source park requests are never withdrawn.
-- Version reserved by scripts/new-migration.mjs; installation is not actuation.
-- money-trigger-ok: table_seats.a00_f06_source_seat because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
-- money-trigger-ok: tournament_players.a00_f06_source_roster because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $admission$
DECLARE v_deadline timestamptz := clock_timestamp()+interval '3 seconds';
BEGIN
 LOOP
  IF clock_timestamp()>=v_deadline THEN
   RAISE EXCEPTION 'F06_GENERATION_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
  END IF;
  BEGIN
   PERFORM set_config('lock_timeout',least(1000,greatest(1,ceil(extract(epoch FROM v_deadline-clock_timestamp())*1000)))::text||'ms',true);
   LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE;
   LOCK TABLE smarter_private.f06_unsettled_hand_aborts IN ACCESS EXCLUSIVE MODE NOWAIT;
   LOCK TABLE smarter_private.f06_hand_permits IN ACCESS EXCLUSIVE MODE NOWAIT;
   LOCK TABLE smarter_private.f06_operations IN ACCESS EXCLUSIVE MODE NOWAIT;
   LOCK TABLE public.hand_atomic_commits IN SHARE ROW EXCLUSIVE MODE NOWAIT;
   LOCK TABLE public.hand_history IN SHARE ROW EXCLUSIVE MODE NOWAIT;
   IF clock_timestamp()>=v_deadline THEN
    RAISE EXCEPTION 'F06_GENERATION_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
   END IF;
   EXIT;
  EXCEPTION WHEN lock_not_available THEN
   -- The exception subtransaction released every partial relation lock.
   PERFORM pg_sleep(least(0.01,greatest(0,extract(epoch FROM v_deadline-clock_timestamp()))));
  END;
 END LOOP;
END $admission$;
SET LOCAL lock_timeout='1s';
DO $preimages$ BEGIN
 IF md5(pg_get_functiondef('public.fn_f06_abort_successor_unsettled_hand(uuid,jsonb)'::regprocedure))<>'3d8695093433344cef51d4d158658c77' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_abort_successor_unsettled_hand(uuid,jsonb)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED public.fn_f06_abort_successor_unsettled_hand(uuid,jsonb)'; END IF;
 IF md5(pg_get_functiondef('public.fn_f06_begin_break(uuid,uuid,uuid,jsonb)'::regprocedure))<>'efebd049c672b162c180bbed1fd41af0' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_begin_break(uuid,uuid,uuid,jsonb)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED public.fn_f06_begin_break(uuid,uuid,uuid,jsonb)'; END IF;
 IF md5(pg_get_functiondef('public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint)'::regprocedure))<>'f7c8c35f4bc8e68ac1c9463518069f98' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint)'; END IF;
 IF md5(pg_get_functiondef('public.fn_f06_discover_breaks(uuid,uuid,bigint,integer)'::regprocedure))<>'ee849383bac8962af9d110341293317a' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_discover_breaks(uuid,uuid,bigint,integer)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED public.fn_f06_discover_breaks(uuid,uuid,bigint,integer)'; END IF;
 IF md5(pg_get_functiondef('public.fn_f06_table_state(uuid,uuid,uuid)'::regprocedure))<>'912feb4ac2e7759d240ef1309d5ab4d0' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_table_state(uuid,uuid,uuid)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED public.fn_f06_table_state(uuid,uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.release_tournament_leases_v2(text,jsonb)'::regprocedure))<>'2c92f4af8b6f14b8cdc0a5af7e98fcf8' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.release_tournament_leases_v2(text,jsonb)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED public.release_tournament_leases_v2(text,jsonb)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_abort_receipt_immutable()'::regprocedure))<>'811127b67caea34bd7d3e5bc6c41ed94' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_abort_receipt_immutable()'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED smarter_private.f06_abort_receipt_immutable()'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_aborted_hand_guard()'::regprocedure))<>'fccb0507e74649a7176d6dc233b0a820' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_aborted_hand_guard()'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED smarter_private.f06_aborted_hand_guard()'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_authority(uuid,uuid,boolean)'::regprocedure))<>'848b06c8e958ad739e0a60b388430f38' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_authority(uuid,uuid,boolean)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED smarter_private.f06_authority(uuid,uuid,boolean)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_generation_aborted(uuid,uuid)'::regprocedure))<>'3c74c8c78714677ae35f82d01ef72720' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_generation_aborted(uuid,uuid)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED smarter_private.f06_generation_aborted(uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_hand_dispatch_guard(uuid,bigint)'::regprocedure))<>'fa3b6cc670788a490c42f324ecf74a76' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_hand_dispatch_guard(uuid,bigint)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED smarter_private.f06_hand_dispatch_guard(uuid,bigint)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_immutable_identity()'::regprocedure))<>'008d3e5674205e2f5a4e7510585bceca' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_immutable_identity()'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED smarter_private.f06_immutable_identity()'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_try_lane(uuid)'::regprocedure))<>'78a3a191b9991b0a3a343db39de335aa' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_try_lane(uuid)'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED smarter_private.f06_try_lane(uuid)'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 IF EXISTS(WITH expected(signature,definition_md5,owner_name,acl) AS(VALUES
('claim_tournament_lease_v2(uuid,text,text,uuid,integer)','1d5fdcf284efb107c4f5e2a3be364fb0','postgres','{postgres=X/postgres,service_role=X/postgres}'),
('fn_f06_abort_unsettled_hand(uuid,jsonb)','b9107a9215ace3a1ba3a1fa501e67be1','postgres','{postgres=X/postgres,service_role=X/postgres}'),
('fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)','f50408947a84ee5901e2e59d0be61d94','postgres','{postgres=X/postgres,service_role=X/postgres}'),
('fn_f06_discover_breaks(uuid,uuid,bigint,integer)','ee849383bac8962af9d110341293317a','postgres','{postgres=X/postgres,service_role=X/postgres}'),
('fn_f06_hand_number_state(uuid,uuid,uuid)','cfb6d1f8b0793c0e4ef4e0b5f147779c','postgres','{postgres=X/postgres,service_role=X/postgres}'),
('fn_f06_table_state(uuid,uuid,uuid)','912feb4ac2e7759d240ef1309d5ab4d0','postgres','{postgres=X/postgres,service_role=X/postgres}'),
('heartbeat_tournament_leases_v3(text,jsonb,integer)','d0266630abef45edf1cff78783b2a154','postgres','{postgres=X/postgres,service_role=X/postgres}'),
('heartbeat_tournament_leases_v4(text,jsonb,integer)','01fa17de7097d3c42748e6879b478411','postgres','{postgres=X/postgres,service_role=X/postgres}'),
('smarter_private.f06_abort_receipt_immutable()','811127b67caea34bd7d3e5bc6c41ed94','postgres','{postgres=X/postgres}'),
('smarter_private.f06_aborted_generation_guard()','78bdb7fde133088800446a0da7dddc57','postgres','{postgres=X/postgres}'),
('smarter_private.f06_aborted_hand_guard()','fccb0507e74649a7176d6dc233b0a820','postgres','{postgres=X/postgres}'),
('smarter_private.f06_generation_aborted(uuid,uuid)','3c74c8c78714677ae35f82d01ef72720','postgres','{postgres=X/postgres}'),
('smarter_private.f06_hand_dispatch_guard(uuid,bigint)','fa3b6cc670788a490c42f324ecf74a76','postgres','{postgres=X/postgres}'),
('smarter_private.f06_immutable_identity()','008d3e5674205e2f5a4e7510585bceca','postgres','{postgres=X/postgres}'),
('smarter_private.f06_move_guard(uuid,uuid,uuid,uuid,integer,uuid,text,uuid,uuid)','67043ce7cbe35b5582b625aaea29d12b','postgres','{postgres=X/postgres}'),
('smarter_private.f06_source_guard()','6c108a5830fa520b8e48b7cab04b053a','postgres','{postgres=X/postgres}'),
('smarter_private.f06_table_guard()','d8775467cf3f807b1992be752638d308','postgres','{postgres=X/postgres}'),
('smarter_private.f06_validate_destination(uuid,uuid,uuid,integer)','16e687b5cd55ad66166bc76479985f23','postgres','{postgres=X/postgres}'),
('smarter_private.fn_smarter_data_api_pre_request()','88d1373951b8e9184c50f703701bd28f','postgres','{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
 ) SELECT 1 FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
 WHERE p.oid IS NULL OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM e.definition_md5
 OR pg_get_userbyid(p.proowner) IS DISTINCT FROM e.owner_name
 OR p.proacl::text IS DISTINCT FROM e.acl) THEN
 RAISE EXCEPTION 'F06_GENERATION_FENCE_PREIMAGE_CHANGED'; END IF;
 -- The predecessor was installed separately: qualify its unchanged dependencies
 -- and original trigger bindings again at this exact installation boundary.
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_atomic_commits'::regclass AND tgname='zzzz_f06_accepted_hand' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER zzzz_f06_accepted_hand AFTER INSERT OR UPDATE OF post_commit_completed_at ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_accept_hand()') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED zzzz_f06_accepted_hand'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_attempts'::regclass AND tgname='f06_attempts_immutable' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_attempts_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_attempts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED f06_attempts_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_hand_permits'::regclass AND tgname='f06_hand_permits_immutable' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_hand_permits_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED f06_hand_permits_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_members'::regclass AND tgname='f06_members_immutable' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_members_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_members FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED f06_members_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_operations'::regclass AND tgname='f06_operations_immutable' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_operations_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_operations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED f06_operations_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND tgname='a00_f06_source_seat' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED a00_f06_source_seat'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tables'::regclass AND tgname='a00_f06_lifecycle' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_lifecycle BEFORE INSERT OR DELETE OR UPDATE OF id, tournament_id, status, lifecycle, is_deleted, f06_lifecycle ON public.tables FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_table_guard()') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED a00_f06_lifecycle'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_players'::regclass AND tgname='a00_f06_source_roster' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED a00_f06_source_roster'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_seat_move_receipts'::regclass AND tgname='f06_bind_move_receipt' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_bind_move_receipt AFTER INSERT ON public.tournament_seat_move_receipts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_receipt_guard()') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED f06_bind_move_receipt'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_try_lane(uuid)'::regprocedure))<>'78a3a191b9991b0a3a343db39de335aa' THEN RAISE EXCEPTION 'F06_ABORT_DEPENDENCY_CHANGED smarter_private.f06_try_lane(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.release_tournament_leases_v2(text,jsonb)'::regprocedure))<>'2c92f4af8b6f14b8cdc0a5af7e98fcf8' THEN RAISE EXCEPTION 'F06_ABORT_DEPENDENCY_CHANGED public.release_tournament_leases_v2(text,jsonb)'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure))<>'409b14ee72ce888d3b26524c52d49a68' THEN RAISE EXCEPTION 'F06_ABORT_DEPENDENCY_CHANGED public.fn_ca_share_settlement_lane_for_table(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_active_maintenance_release_boundary()'::regprocedure))<>'0d9548e27105b7172d83be4f7d10ea47' THEN RAISE EXCEPTION 'F06_ABORT_FREEZE_DEPENDENCY_CHANGED public.fn_active_maintenance_release_boundary()'; END IF;
 IF md5(pg_get_functiondef('public.fn_platform_frozen()'::regprocedure))<>'ec683805e052fceeae74789e82dce4cc' THEN RAISE EXCEPTION 'F06_ABORT_FREEZE_DEPENDENCY_CHANGED public.fn_platform_frozen()'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure))<>'8c0acda3b19e958ecd5bbbc07c845afe' THEN RAISE EXCEPTION 'F06_ABORT_OUTER_SETTLEMENT_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticator'
 AND 'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'=ANY(rolconfig)) THEN
 RAISE EXCEPTION 'F06_ABORT_PRE_REQUEST_NOT_INSTALLED'; END IF;
 IF EXISTS(WITH expected(relation_name,trigger_name,function_name,trigger_type) AS(VALUES
 ('public.engine_tournament_leases','f06_aborted_generation','smarter_private.f06_aborted_generation_guard()',21),
 ('smarter_private.f06_unsettled_hand_aborts','f06_abort_receipt_immutable','smarter_private.f06_abort_receipt_immutable()',27),
 ('public.hand_atomic_commits','a00_f06_aborted_hand','smarter_private.f06_aborted_hand_guard()',23),
 ('public.hand_history','a00_f06_aborted_history','smarter_private.f06_aborted_hand_guard()',23))
 SELECT 1 FROM expected e LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass(e.relation_name)
 AND t.tgname=e.trigger_name WHERE t.oid IS NULL OR t.tgenabled<>'O'
 OR t.tgfoid IS DISTINCT FROM to_regprocedure(e.function_name) OR t.tgtype<>e.trigger_type) THEN
 RAISE EXCEPTION 'F06_SUCCESSOR_ABORT_BINDING_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_state_snapshots'::regclass AND NOT tgisinternal) THEN
 RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_BINDINGS_CHANGED'; END IF;
END $preimages$;
CREATE TABLE smarter_private.f06_generation_aborts(
 receipt_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, generation uuid NOT NULL,
 expected jsonb NOT NULL, outcome text NOT NULL DEFAULT 'aborted_unsettled'
 CHECK(outcome='aborted_unsettled'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tournament_id,generation), UNIQUE(receipt_id,tournament_id,generation));
CREATE TABLE smarter_private.f06_generation_abort_hands(
 permit_id uuid PRIMARY KEY, receipt_id uuid NOT NULL,
 tournament_id uuid NOT NULL, generation uuid NOT NULL, table_id uuid NOT NULL, hand_number bigint NOT NULL,
 snapshot_id uuid NOT NULL, break_id uuid UNIQUE, expected jsonb NOT NULL,
 UNIQUE(table_id,hand_number), FOREIGN KEY(receipt_id,tournament_id,generation)
 REFERENCES smarter_private.f06_generation_aborts(receipt_id,tournament_id,generation));
ALTER TABLE smarter_private.f06_generation_aborts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_generation_abort_hands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_generation_aborts,smarter_private.f06_generation_abort_hands
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_generation_receipt_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.f06_generation_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER f06_generation_child_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.f06_generation_abort_hands FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();

CREATE OR REPLACE FUNCTION smarter_private.f06_aborted_hand_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE t uuid;
BEGIN
 SELECT tournament_id INTO t FROM smarter_private.f06_hand_permits
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF FOUND THEN
 -- A direct SQL insert may already own its row. Never wait for an earlier lane.
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORTED_HAND_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_aborted_hand_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION smarter_private.f06_generation_aborted(t uuid, g uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'smarter_private'
AS $function$
BEGIN
 -- Existing leases, heartbeats, request admission and resurrection triggers all
 -- use this VOLATILE authority after their row-lock waits.
 RETURN EXISTS(SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts
 WHERE tournament_id=t AND (generation=g OR retired_lease_generation=g))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_generation_aborts WHERE tournament_id=t AND generation=g);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_generation_aborted(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION smarter_private.f06_immutable_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'F06_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(OLD)->>'state')='withdrawn_before_manifest' THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND (to_jsonb(NEW)->>'state')='aborted_unsettled' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid
 AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(NEW)->>'state')='withdrawn_before_manifest' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND ((to_jsonb(OLD)-'state'-'evidence_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'evidence_id') OR to_jsonb(OLD)->>'state'<>'reserved') THEN
 RAISE EXCEPTION 'F06_HAND_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_members' OR
 (TG_TABLE_NAME='f06_attempts' AND ((to_jsonb(OLD)-'state'-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'receipt') OR to_jsonb(OLD)->>'state'<>'active')) OR
 (TG_TABLE_NAME='f06_operations' AND ((to_jsonb(OLD)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') OR (to_jsonb(OLD)->'manifest'<>'null'::jsonb AND to_jsonb(OLD)->'manifest' IS DISTINCT FROM to_jsonb(NEW)->'manifest') OR (to_jsonb(OLD)->'close_receipt'<>'null'::jsonb AND to_jsonb(OLD)->'close_receipt' IS DISTINCT FROM to_jsonb(NEW)->'close_receipt'))) THEN
 RAISE EXCEPTION 'F06_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_immutable_identity() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_f06_abort_unsettled_generation(p_receipt_id uuid,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_expected->>'tournament_id')::uuid;
 g uuid:=(p_expected->>'generation')::uuid;
 lease public.engine_tournament_leases;
 event public.tournaments;
 h smarter_private.f06_hand_permits;
 o smarter_private.f06_operations;
 snap public.hand_state_snapshots;
 prior smarter_private.f06_generation_aborts;
 item jsonb; hands jsonb:='[]'; parks jsonb; open_tables jsonb; roster jsonb; event_roster jsonb;
 accepted jsonb; actual jsonb; users uuid[]; u uuid; tab_ids uuid[]; reserved_ids uuid[];
 v_break_id uuid; player_count integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role'
 OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_receipt_id IS NULL OR t IS NULL OR g IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_expected->'hands') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_GENERATION_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:'||p_receipt_id::text,0));
 SELECT * INTO prior FROM smarter_private.f06_generation_aborts WHERE receipt_id=p_receipt_id;
 IF FOUND THEN
 IF prior.expected IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_ABORT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome',prior.outcome,'receipt_id',p_receipt_id,
 'hands',jsonb_array_length(prior.expected->'hands'),'credit',0);
 END IF;

 -- The lease FOR UPDATE drains protocol-2 HTTP requests admitted FOR KEY SHARE.
 -- Never wait on an earlier lane while holding it: direct SQL may own that lane.
 SELECT * INTO lease FROM public.engine_tournament_leases
 WHERE tournament_id=t AND lease_generation=g AND protocol_version=2 FOR UPDATE;
 IF NOT FOUND OR lease.instance_id IS DISTINCT FROM p_expected->>'instance_id'
 OR lease.engine_version IS DISTINCT FROM p_expected->>'engine_version' THEN
 RAISE EXCEPTION 'F06_GENERATION_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_try_lane(t);
 SELECT array_agg(permit_id ORDER BY permit_id) INTO reserved_ids FROM smarter_private.f06_hand_permits
 WHERE tournament_id=t AND state='reserved';
 IF reserved_ids IS NULL OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits
 WHERE tournament_id=t AND state='reserved' AND generation<>g)
 OR reserved_ids IS DISTINCT FROM (SELECT array_agg((x->'permit'->>'permit_id')::uuid ORDER BY (x->'permit'->>'permit_id')::uuid)
 FROM jsonb_array_elements(p_expected->'hands') x) THEN
 RAISE EXCEPTION 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED' USING ERRCODE='55000'; END IF;
 FOR u IN SELECT unnest(reserved_ids) LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT array_agg(id ORDER BY id) INTO tab_ids FROM public.tables
 WHERE tournament_id=t AND lower(status)<>'closed' AND NOT COALESCE(is_deleted,false);
 SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO users FROM public.table_seats
 WHERE table_id=ANY(tab_ids) AND left_at IS NULL;
 FOR u IN SELECT unnest(users) LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT * INTO event FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats WHERE table_id=ANY(tab_ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t ORDER BY permit_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id=t ORDER BY break_id FOR UPDATE;
 IF event.status IS DISTINCT FROM 'RUNNING' OR event.format_contract NOT IN ('mtt-v1','mtt-v2','spin-v1')
 OR event.format_contract IS NULL OR tab_ids IS NULL
 OR (event.format_contract='spin-v1' AND cardinality(tab_ids)<>1)
 OR EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(tab_ids)
 AND (lower(status) NOT IN ('waiting','running') OR f06_lifecycle IS NULL)) THEN
 RAISE EXCEPTION 'F06_GENERATION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- Every occupied chair in the complete open-table generation has one exact
 -- playing registration; every playing registration has that current chair.
 IF EXISTS(SELECT 1 FROM public.table_seats s LEFT JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(tab_ids) AND s.left_at IS NULL AND (p.id IS NULL OR s.occupancy_id IS NULL
 OR s.terminal_closed_at IS NOT NULL OR s.stack IS DISTINCT FROM p.chips::numeric
 OR s.stack IS NULL OR s.stack<0 OR s.stack::text IN ('NaN','Infinity','-Infinity')))
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=t AND p.status='playing'
 AND NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=ANY(tab_ids) AND s.table_id=p.table_id
 AND s.user_id=p.user_id AND s.seat_number=p.seat_number AND s.left_at IS NULL)) THEN
 RAISE EXCEPTION 'F06_GENERATION_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'deleted',is_deleted,'lifecycle',f06_lifecycle) ORDER BY id)
 INTO open_tables FROM public.tables WHERE id=ANY(tab_ids);
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
 'user_id',s.user_id,'table_id',s.table_id,'seat_number',s.seat_number,'stack',s.stack,'chips',p.chips) ORDER BY s.id)
 INTO event_roster FROM public.table_seats s JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(tab_ids) AND s.left_at IS NULL;
 -- Pending post-commit work is an accepted financial outcome, never an abort.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.tournament_id=t AND p.table_id=ANY(tab_ids)
 AND p.state='accepted' AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits later WHERE later.table_id=p.table_id AND later.hand_number>p.hand_number) AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c
 WHERE c.table_id=p.table_id AND c.hand_number=p.hand_number AND c.hand_id=p.evidence_id AND c.post_commit_completed_at IS NOT NULL
 AND c.post_commit_result->'ok'='true'::jsonb)) THEN
 RAISE EXCEPTION 'F06_GENERATION_ACCEPTED_PROOF_INCOMPLETE' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('permit',to_jsonb(p),'atomic_hash',md5(to_jsonb(c)::text)) ORDER BY p.permit_id),'[]')
 INTO accepted FROM smarter_private.f06_hand_permits p JOIN public.hand_atomic_commits c
 ON c.table_id=p.table_id AND c.hand_number=p.hand_number
 WHERE p.tournament_id=t AND p.table_id=ANY(tab_ids) AND p.state='accepted' AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits later WHERE later.table_id=p.table_id AND later.hand_number>p.hand_number);
 -- Keep accepted-source parks intact for the genuine new-generation F06 owner.
 -- Only a target hand's pre-manifest park can receive a truthful withdrawal.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations p WHERE p.tournament_id=t
 AND p.state NOT IN ('acknowledged','withdrawn_before_manifest') AND
 (p.state<>'park_requested' OR p.manifest IS NOT NULL OR p.close_receipt IS NOT NULL OR p.cleanup_kind IS NOT NULL
 OR p.abort_receipt_id IS NOT NULL OR NOT p.source_table_id=ANY(tab_ids)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=p.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=p.break_id))) THEN
 RAISE EXCEPTION 'F06_GENERATION_PARK_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.break_id),'[]') INTO parks FROM smarter_private.f06_operations p
 WHERE p.tournament_id=t AND p.state NOT IN ('acknowledged','withdrawn_before_manifest');

 FOR h IN SELECT * FROM smarter_private.f06_hand_permits WHERE permit_id=ANY(reserved_ids) ORDER BY permit_id LOOP
 IF h.generation IS DISTINCT FROM g OR h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=h.table_id AND id=ANY(tab_ids) AND f06_lifecycle=h.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id AND hand_number>h.hand_number) THEN
 RAISE EXCEPTION 'F06_GENERATION_PERMIT_CHANGED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;
 SELECT * INTO snap FROM public.hand_state_snapshots
 WHERE table_id=h.table_id AND hand_number=h.hand_number AND NOT is_complete FOR UPDATE;
 IF NOT FOUND OR snap.stage IS DISTINCT FROM 'preflop'
 OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
 OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10 THEN
 RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO roster FROM jsonb_array_elements(event_roster) x
 WHERE x->>'table_id'=h.table_id::text;
 player_count:=jsonb_array_length(roster);
 IF player_count IS DISTINCT FROM jsonb_array_length(snap.state_json->'players')
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)<>player_count
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(roster) r WHERE r->>'user_id'=x->>'user_id'
 AND (r->>'seat_number')::integer=(x->>'seat')::integer
 AND (r->>'stack')::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric
 AND (x->>'stack')::numeric>=0 AND (x->>'totalInvested')::numeric>=0
 AND (x->>'stack')::numeric::text NOT IN ('NaN','Infinity','-Infinity')
 AND (x->>'totalInvested')::numeric::text NOT IN ('NaN','Infinity','-Infinity')
 -- BBA dead investment is already part of totalInvested. Do not credit it twice.
 AND COALESCE((x->>'deadInvested')::numeric,0) BETWEEN 0 AND (x->>'totalInvested')::numeric
 AND COALESCE((x->>'returnedUncalled')::numeric,0)=0
 AND COALESCE((x->>'individualAnteInvested')::numeric,0)=0))
 OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
 (SELECT sum((x->>'totalInvested')::numeric) FROM jsonb_array_elements(snap.state_json->'players') x) THEN
 RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE='55000'; END IF;
 v_break_id:=NULL;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE source_table_id=h.table_id
 AND state NOT IN ('acknowledged','withdrawn_before_manifest');
 IF FOUND THEN
 IF o.origin_generation IS DISTINCT FROM g OR o.lifecycle IS DISTINCT FROM h.lifecycle
 OR (o.custody_generation IS NOT NULL AND o.custody_generation<>g) THEN
 RAISE EXCEPTION 'F06_GENERATION_PARK_CHANGED' USING ERRCODE='55000'; END IF;
 v_break_id:=o.break_id;
 END IF;
 hands:=hands||jsonb_build_array(jsonb_build_object('permit',to_jsonb(h),'snapshot_id',snap.id,
 'snapshot_hash',md5(to_jsonb(snap)::text),'roster',roster,'break_id',v_break_id));
 END LOOP;
 actual:=jsonb_build_object('tournament_id',t,'generation',g,'instance_id',lease.instance_id,
 'engine_version',lease.engine_version,'format_contract',event.format_contract,'open_tables',open_tables,
 'roster',event_roster,'parks',parks,'accepted',accepted,'hands',hands);
 IF actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_ABORT_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_generation_aborts(receipt_id,tournament_id,generation,expected)
 VALUES(p_receipt_id,t,g,actual);
 FOR item IN SELECT value FROM jsonb_array_elements(hands) LOOP
 INSERT INTO smarter_private.f06_generation_abort_hands
 (permit_id,receipt_id,tournament_id,generation,table_id,hand_number,snapshot_id,break_id,expected)
 VALUES((item->'permit'->>'permit_id')::uuid,p_receipt_id,t,g,(item->'permit'->>'table_id')::uuid,
 (item->'permit'->>'hand_number')::bigint,(item->>'snapshot_id')::uuid,(item->>'break_id')::uuid,item);
 END LOOP;
 UPDATE smarter_private.f06_hand_permits SET state='aborted_unsettled',evidence_id=p_receipt_id WHERE permit_id=ANY(reserved_ids);
 UPDATE public.hand_state_snapshots SET is_complete=true
 WHERE id IN(SELECT a.snapshot_id FROM smarter_private.f06_generation_abort_hands a WHERE a.receipt_id=p_receipt_id);
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=p_receipt_id
 WHERE break_id IN(SELECT a.break_id FROM smarter_private.f06_generation_abort_hands a WHERE a.receipt_id=p_receipt_id);
 PERFORM public.release_tournament_leases_v2(lease.instance_id,
 jsonb_build_array(jsonb_build_object('tournament_id',t,'lease_generation',g)));
 IF EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND lease_generation=g) THEN
 RAISE EXCEPTION 'F06_ABORT_LEASE_NOT_WITHDRAWN' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',p_receipt_id,
 'hands',jsonb_array_length(hands),'credit',0);
END $function$;
REVOKE ALL ON FUNCTION public.fn_f06_abort_unsettled_generation(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_unsettled_generation(uuid,jsonb) TO service_role;

COMMIT;
