-- Interrupted heads-up SNG originals retain their last committed stacks.
-- A reserved permit and pre-manifest park previously had no truthful outcome
-- after an already dealt hand stopped. Never call that hand never_started.
-- This explicit transaction drains original-generation writes, permanently
-- fences the generation/hand, records aborted_unsettled, and withdraws only
-- that pre-manifest reservation. No wallet/escrow/stack/history credit.
-- Runtime dependency: 2bbc/2ad preserve protocol-2 async actor provenance.
-- The serving process retains old in-memory custody until its normal certified
-- replacement; a fresh process consumes the unchanged active-state contract.
-- Qualified by the existing native F06 shared-hand-lane runner.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $preimages$ BEGIN
 IF md5(pg_get_functiondef('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure))<>'c451a6859a15bf62fea00fb31ef7ffa0' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_f06_discover_breaks(uuid,uuid,bigint,integer)'::regprocedure))<>'37d4e80dff9e31034559675e1cc14008' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_discover_breaks(uuid,uuid,bigint,integer)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED public.fn_f06_discover_breaks(uuid,uuid,bigint,integer)'; END IF;
 IF md5(pg_get_functiondef('public.fn_f06_hand_number_state(uuid,uuid,uuid)'::regprocedure))<>'28fbcb112405885065690597e28e6da0' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_hand_number_state(uuid,uuid,uuid)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED public.fn_f06_hand_number_state(uuid,uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_f06_table_state(uuid,uuid,uuid)'::regprocedure))<>'57e913c4b1001a17dbf6f5b50943a495' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_table_state(uuid,uuid,uuid)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED public.fn_f06_table_state(uuid,uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_hand_dispatch_guard(uuid,bigint)'::regprocedure))<>'9d41bbdff8f01245211be8f9d52d0c83' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_hand_dispatch_guard(uuid,bigint)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED smarter_private.f06_hand_dispatch_guard(uuid,bigint)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_immutable_identity()'::regprocedure))<>'1e1861693424c5350c74fe3acc9a672c' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_immutable_identity()'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED smarter_private.f06_immutable_identity()'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_move_guard(uuid,uuid,uuid,uuid,integer,uuid,text,uuid,uuid)'::regprocedure))<>'7c2371b25235eb49b6f043f077dd0c4d' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_move_guard(uuid,uuid,uuid,uuid,integer,uuid,text,uuid,uuid)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED smarter_private.f06_move_guard(uuid,uuid,uuid,uuid,integer,uuid,text,uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure))<>'d89dc77965f1abea47e366ad6f6a426f' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_source_guard()'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED smarter_private.f06_source_guard()'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_table_guard()'::regprocedure))<>'e472174e4289d124b672aa6e2a897244' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_table_guard()'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED smarter_private.f06_table_guard()'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_validate_destination(uuid,uuid,uuid,integer)'::regprocedure))<>'628c6623e3d5bdc8daf3072c95ba8eff' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_validate_destination(uuid,uuid,uuid,integer)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED smarter_private.f06_validate_destination(uuid,uuid,uuid,integer)'; END IF;
 IF md5(pg_get_functiondef('public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure))<>'4a41b0124e75e46ed8121e6a56014758' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED public.heartbeat_tournament_leases_v4(text,jsonb,integer)'; END IF;
 IF md5(pg_get_functiondef('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure))<>'73abfc4523de42cb4b8bca5443602cbd' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'; END IF;
 IF md5(pg_get_functiondef('public.heartbeat_tournament_leases_v3(text,jsonb,integer)'::regprocedure))<>'52cb6d75f301564351e9b0021805844b' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.heartbeat_tournament_leases_v3(text,jsonb,integer)'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED public.heartbeat_tournament_leases_v3(text,jsonb,integer)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.fn_smarter_data_api_pre_request()'::regprocedure))<>'8110794298f7f310a62944357c525fd3' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='smarter_private.fn_smarter_data_api_pre_request()'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED smarter_private.fn_smarter_data_api_pre_request()'; END IF;
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
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticator' AND 'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'=ANY(rolconfig)) THEN RAISE EXCEPTION 'F06_ABORT_PRE_REQUEST_NOT_INSTALLED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_state_snapshots'::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_BINDINGS_CHANGED'; END IF;
END $preimages$;
CREATE TABLE smarter_private.f06_unsettled_hand_aborts(
 receipt_id uuid PRIMARY KEY,tournament_id uuid NOT NULL,table_id uuid NOT NULL,
 generation uuid NOT NULL,permit_id uuid NOT NULL UNIQUE,hand_number bigint NOT NULL,
 break_id uuid NOT NULL UNIQUE,expected jsonb NOT NULL,
 outcome text NOT NULL DEFAULT 'aborted_unsettled' CHECK(outcome='aborted_unsettled'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tournament_id,generation),UNIQUE(table_id,hand_number));
REVOKE ALL ON smarter_private.f06_unsettled_hand_aborts FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_operations ADD COLUMN abort_receipt_id uuid;
ALTER TABLE smarter_private.f06_operations DROP CONSTRAINT f06_operations_state_check;
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_operations_state_check
 CHECK(state IN('park_requested','begun','close_confirmed','acknowledged','withdrawn_before_manifest'));
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_withdrawal_receipt
 CHECK((state='withdrawn_before_manifest')=(abort_receipt_id IS NOT NULL));
ALTER TABLE smarter_private.f06_hand_permits DROP CONSTRAINT f06_hand_permits_state_check;
ALTER TABLE smarter_private.f06_hand_permits ADD CONSTRAINT f06_hand_permits_state_check
 CHECK(state IN('reserved','accepted','never_started','aborted_unsettled'));
DROP INDEX smarter_private.f06_one_source;
CREATE UNIQUE INDEX f06_one_source ON smarter_private.f06_operations(source_table_id)
 WHERE state NOT IN('acknowledged','withdrawn_before_manifest');

CREATE FUNCTION smarter_private.f06_generation_aborted(t uuid,g uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,smarter_private AS $function$
BEGIN
 -- VOLATILE deliberately takes a fresh command snapshot after any row-lock wait.
 RETURN EXISTS(SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts
 WHERE tournament_id=t AND generation=g);
END $function$;
CREATE FUNCTION smarter_private.f06_aborted_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,smarter_private AS $function$
BEGIN
 IF smarter_private.f06_generation_aborted(NEW.tournament_id,NEW.lease_generation) THEN
 RAISE EXCEPTION 'F06_ABORTED_GENERATION_FENCED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $function$;
-- AFTER is necessary: an INSERT blocked behind the original lease deletion
-- must check the committed tombstone after its unique-index conflict resolves.
CREATE TRIGGER f06_aborted_generation AFTER INSERT OR UPDATE
 ON public.engine_tournament_leases FOR EACH ROW
 EXECUTE FUNCTION smarter_private.f06_aborted_generation_guard();

CREATE FUNCTION smarter_private.f06_abort_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'F06_ABORT_RECEIPT_IMMUTABLE' USING ERRCODE='55000'; END $function$;
CREATE TRIGGER f06_abort_receipt_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.f06_unsettled_hand_aborts FOR EACH ROW
 EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();

CREATE FUNCTION smarter_private.f06_aborted_hand_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
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
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORTED_HAND_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER a00_f06_aborted_hand BEFORE INSERT OR UPDATE ON public.hand_atomic_commits
 FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard();
CREATE TRIGGER a00_f06_aborted_history BEFORE INSERT OR UPDATE ON public.hand_history
 FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('hand_atomic_commits','a00_f06_aborted_hand','Permanent interrupted-hand refusal; no monetary write'),
 ('hand_history','a00_f06_aborted_history','Permanent interrupted-hand refusal; no monetary write');
REVOKE ALL ON FUNCTION smarter_private.f06_generation_aborted(uuid,uuid),
 smarter_private.f06_aborted_generation_guard(),smarter_private.f06_abort_receipt_immutable(),
 smarter_private.f06_aborted_hand_guard() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_f06_begin_hand(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid, p_lifecycle bigint, p_permit_id uuid, p_hand_number bigint, p_custody_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id;
 IF FOUND THEN
 IF (h.tournament_id,h.table_id,h.lifecycle,h.hand_number,h.custody_id,h.generation) IS DISTINCT FROM(p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) THEN
 RAISE EXCEPTION 'F06_CHANGED_HAND_PERMIT' USING ERRCODE='22023'; END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',h.state='reserved','lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=p_table_id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RETURN jsonb_build_object('ok',false,'reason','source_excluded'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id WHERE tb.id=p_table_id AND t.id=p_tournament_id AND upper(t.status)='RUNNING' AND tb.f06_lifecycle=p_lifecycle
 AND lower(tb.status)<>'closed' AND NOT COALESCE(tb.is_deleted,false)) THEN RAISE EXCEPTION 'F06_HAND_LIFECYCLE' USING ERRCODE='55000'; END IF;
 IF p_hand_number IS NULL OR p_hand_number<1 OR p_custody_id IS NULL THEN RAISE EXCEPTION 'F06_HAND_IDENTITY' USING ERRCODE='22023'; END IF;
 -- Hand numbers are permanently unique for the physical table, across every lifecycle.
 -- Exact permit replay above is lawful; a new permit cannot adopt historical evidence.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number=p_hand_number) THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_number_already_used'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND state='reserved') THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_permit_unresolved'); END IF;
 INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
 VALUES(p_permit_id,p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) RETURNING * INTO h;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_f06_discover_breaks(p_tournament_id uuid, p_lease_generation uuid, p_expected_cursor_revision bigint, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE c smarter_private.f06_cursors;items jsonb;last_id bigint;wrapped boolean:=false;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 32 OR p_limit IS NULL THEN RAISE EXCEPTION 'F06_PAGE_SIZE' USING ERRCODE='22023'; END IF;
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}','{}');
 INSERT INTO smarter_private.f06_cursors(tournament_id) VALUES(p_tournament_id) ON CONFLICT DO NOTHING;
 SELECT * INTO c FROM smarter_private.f06_cursors WHERE tournament_id=p_tournament_id FOR UPDATE;
 IF c.revision IS DISTINCT FROM p_expected_cursor_revision THEN RETURN jsonb_build_object('ok',false,'reason','cursor_revision_conflict','cursor_revision',c.revision::text,'wrapped',false,'operations','[]'::jsonb); END IF;
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id AND state NOT IN ('acknowledged','withdrawn_before_manifest') AND ordinal>c.ordinal) THEN c.ordinal:=0;wrapped:=true; END IF;
 SELECT jsonb_agg(smarter_private.f06_state(q.break_id) ORDER BY q.ordinal),max(q.ordinal) INTO items,last_id FROM
 (SELECT break_id,ordinal FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id AND state NOT IN ('acknowledged','withdrawn_before_manifest') AND ordinal>c.ordinal ORDER BY ordinal LIMIT p_limit) q;
 UPDATE smarter_private.f06_cursors SET ordinal=COALESCE(last_id,0),revision=revision+1 WHERE tournament_id=p_tournament_id;
 RETURN jsonb_build_object('ok',true,'reason',NULL,'cursor_revision',(c.revision+1)::text,'wrapped',wrapped,'operations',COALESCE(items,'[]'::jsonb));
END $function$;
CREATE OR REPLACE FUNCTION public.fn_f06_hand_number_state(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE life bigint; used bigint; pending jsonb; blocked text;
BEGIN
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT tb.f06_lifecycle,CASE WHEN upper(t.status)<>'RUNNING' THEN 'tournament_not_running'
 WHEN lower(tb.status)='closed' OR COALESCE(tb.is_deleted,false) THEN 'table_closed' END INTO life,blocked
 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id
 WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','table_not_found'); END IF;
 SELECT GREATEST(0,
 COALESCE((SELECT max(hand_number) FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id),0),
 COALESCE((SELECT max(hand_number) FROM public.hand_atomic_commits WHERE table_id=p_table_id),0),
 COALESCE((SELECT max(hand_number) FROM public.hand_history WHERE table_id=p_table_id),0)) INTO used;
 SELECT jsonb_build_object('permit_id',h.permit_id,'tournament_id',h.tournament_id,'table_id',h.table_id,
 'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text,'custody_id',h.custody_id,'generation',h.generation,'state',h.state)
 INTO pending FROM smarter_private.f06_hand_permits h WHERE h.table_id=p_table_id AND h.state='reserved';
 IF pending IS NOT NULL THEN blocked:='hand_permit_unresolved';
 ELSIF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=p_table_id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN blocked:='source_excluded';
 ELSIF used=9223372036854775807 THEN blocked:='hand_number_exhausted'; END IF;
 RETURN jsonb_build_object('ok',true,'table_id',p_table_id,'lifecycle',life::text,
 'used_hand_number_max',used::text,'next_hand_number_candidate',CASE WHEN blocked IS NULL THEN (used+1)::text ELSE NULL END,
 'can_reserve',blocked IS NULL,'blocked_reason',blocked,'unresolved_permit',pending);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_f06_table_state(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE v jsonb; recovery jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 recovery:=public.fn_f06_hand_number_state(p_tournament_id,p_lease_generation,p_table_id);
 SELECT jsonb_build_object('ok',true,'table_id',t.id,'lifecycle',t.f06_lifecycle::text,'excluded',o.break_id IS NOT NULL,'break_id',o.break_id) INTO v
 FROM public.tables t LEFT JOIN smarter_private.f06_operations o ON o.source_table_id=t.id AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
 WHERE t.id=p_table_id AND t.tournament_id=p_tournament_id;
 IF v IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','table_not_found'); END IF;
 RETURN v||jsonb_build_object('hand_number_high_water',recovery->'used_hand_number_max',
 'unresolved_permits',CASE WHEN recovery->'unresolved_permit'='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(recovery->'unresolved_permit') END,
 'unresolved_overflow',false,'can_reserve',recovery->'can_reserve','blocked_reason',recovery->'blocked_reason');
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.f06_hand_dispatch_guard(tid uuid, hn bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
 IF h.state IN ('never_started','aborted_unsettled') THEN RAISE EXCEPTION 'F06_HAND_PERMIT_FENCED' USING ERRCODE='55000'; END IF;
 IF h.state='reserved' THEN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 INSERT INTO smarter_private.f06_hand_dispatch VALUES(h.permit_id,txid_current()) ON CONFLICT(permit_id) DO UPDATE SET xid=EXCLUDED.xid;
 END IF;
 ELSIF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=tid AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RAISE EXCEPTION 'F06_UNPERMITTED_HAND' USING ERRCODE='55000';
 END IF;
END $function$;
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
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(NEW)->>'state')='withdrawn_before_manifest' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND ((to_jsonb(OLD)-'state'-'evidence_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'evidence_id') OR to_jsonb(OLD)->>'state'<>'reserved') THEN
 RAISE EXCEPTION 'F06_HAND_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_members' OR
 (TG_TABLE_NAME='f06_attempts' AND ((to_jsonb(OLD)-'state'-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'receipt') OR to_jsonb(OLD)->>'state'<>'active')) OR
 (TG_TABLE_NAME='f06_operations' AND ((to_jsonb(OLD)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') OR (to_jsonb(OLD)->'manifest'<>'null'::jsonb AND to_jsonb(OLD)->'manifest' IS DISTINCT FROM to_jsonb(NEW)->'manifest') OR (to_jsonb(OLD)->'close_receipt'<>'null'::jsonb AND to_jsonb(OLD)->'close_receipt' IS DISTINCT FROM to_jsonb(NEW)->'close_receipt'))) THEN
 RAISE EXCEPTION 'F06_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.f06_move_guard(t uuid, u uuid, src uuid, dst uuid, chair integer, req uuid, mode text, seat uuid, occ uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE a smarter_private.f06_attempts;o smarter_private.f06_operations;m smarter_private.f06_members;g uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=dst AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RAISE EXCEPTION 'F06_DESTINATION_EXCLUDED' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM smarter_private.f06_attempts WHERE request_id=req;
 IF NOT FOUND THEN
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=src AND state NOT IN ('acknowledged','withdrawn_before_manifest'))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members mm JOIN smarter_private.f06_operations oo USING(break_id) WHERE oo.tournament_id=t AND mm.user_id=u AND oo.state NOT IN ('acknowledged','withdrawn_before_manifest')
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts w WHERE w.break_id=mm.break_id AND w.user_id=mm.user_id AND w.state='winner')) THEN
 RAISE EXCEPTION 'F06_UNBOUND_MOVE' USING ERRCODE='55000'; END IF;
 RETURN; END IF;
 -- The injected pre-lane prefix already acquired lease KEY SHARE for manager.
 -- Legacy/service direct calls never acquire a late lease here; reject them.
 g:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
 PERFORM smarter_private.f06_authority(t,g,false);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=a.break_id FOR UPDATE;
 SELECT * INTO m FROM smarter_private.f06_members WHERE break_id=a.break_id AND user_id=a.user_id;
 IF a.state<>'active' OR o.state<>'begun' OR mode<>'live_source'
 OR (o.tournament_id,a.user_id,o.source_table_id,a.destination_table_id,a.destination_seat_number,m.source_seat_id,m.occupancy_id)
 IS DISTINCT FROM (t,u,src,dst,chair,seat,occ)
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=src AND f06_lifecycle=o.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=a.break_id AND user_id=u AND state='winner') THEN
 RAISE EXCEPTION 'F06_ATTEMPT_FENCED_OR_SOURCE_CHANGED' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_dispatch VALUES(req,txid_current(),occ,seat,o.lifecycle);
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Payload-only writes preserve source custody. They need to exclude a
 -- canonical move/begin, not other accepted hands in this tournament. The
 -- outer hand RPC already holds T shared; promoting it to exclusive here
 -- makes ordinary concurrent hands refuse each other even with no F06 move.
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME='table_seats'
   AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
   AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number'))
  OR (TG_TABLE_NAME='tournament_players'
   AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status'))
 ) THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
 END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 -- Closing the exact already-zero generation cannot move funded custody.
 -- Share G/T with other tables' hands, while still excluding every canonical
 -- begin/move/terminal authority, which owns T or G exclusively. Do not
 -- return here: PARK_REQUESTED still needs the original hand receipt and
 -- BEGUN still needs the original move receipt below.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='table_seats'
  AND oldj->>'left_at' IS NULL AND newj->>'left_at' IS NOT NULL
  AND newj->>'status'='left'
  AND oldj->'stack'='0'::jsonb AND newj->'stack'='0'::jsonb
  AND oldj->>'user_id' IS NOT NULL
  AND (src,oldj->>'id',oldj->>'user_id',oldj->>'seat_number',oldj->>'joined_at',oldj->>'club_id')
      IS NOT DISTINCT FROM
      (dst,newj->>'id',newj->>'user_id',newj->>'seat_number',newj->>'joined_at',newj->>'club_id') THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
 ELSE
  PERFORM smarter_private.f06_try_lane(t);
 END IF;
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state NOT IN ('acknowledged','withdrawn_before_manifest'));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.f06_table_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE blocked boolean; reopening boolean;
BEGIN
 IF TG_OP='INSERT' THEN NEW.f06_lifecycle:=nextval('smarter_private.f06_lifecycle_seq');RETURN NEW; END IF;
 PERFORM smarter_private.f06_try_lane(OLD.tournament_id);
 SELECT EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=OLD.id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) INTO blocked;
 IF TG_OP='DELETE' THEN
 IF blocked THEN RAISE EXCEPTION 'F06_PENDING_CUSTODY' USING ERRCODE='55000'; END IF; RETURN OLD; END IF;
 reopening:=(lower(COALESCE(OLD.status,'')) IN ('closed','completed','cancelled','finished') OR OLD.lifecycle='closed' OR COALESCE(OLD.is_deleted,false))
 AND NOT (lower(COALESCE(NEW.status,'')) IN ('closed','completed','cancelled','finished') OR NEW.lifecycle='closed' OR COALESCE(NEW.is_deleted,false));
 IF NEW.f06_lifecycle IS DISTINCT FROM OLD.f06_lifecycle THEN RAISE EXCEPTION 'F06_LIFECYCLE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF blocked AND (reopening OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id) THEN
 RAISE EXCEPTION 'F06_PENDING_CUSTODY' USING ERRCODE='55000'; END IF;
 IF reopening THEN NEW.f06_lifecycle:=nextval('smarter_private.f06_lifecycle_seq'); END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.f06_validate_destination(t uuid, src uuid, dst uuid, chair integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
 IF src=dst OR chair IS NULL OR chair NOT BETWEEN 1 AND 10 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=dst AND tournament_id=t
 AND NOT COALESCE(is_deleted,false) AND lower(status)<>'closed' AND chair<=COALESCE(max_players,9))
 OR EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=dst AND seat_number=chair AND left_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=t AND table_id=dst AND seat_number=chair AND status IN ('registered','playing'))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=dst AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RAISE EXCEPTION 'F06_CAPACITY_UNAVAILABLE' USING ERRCODE='55000'; END IF;
END $function$;
CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v4(p_instance_id text, p_claims jsonb, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(tournament_id uuid, state text, lease_generation uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v4 requires a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v4 requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;
  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v4 requires a JSON array of claims'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_claims) item
     WHERE jsonb_typeof(item) <> 'object'
        OR length(btrim(COALESCE(item ->> 'tournament_id', ''))) = 0
        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0
  ) THEN
    RAISE EXCEPTION
      'heartbeat_tournament_leases_v4 requires tournament_id and lease_generation for every claim'
      USING ERRCODE = '22023';
  END IF;

  /* UUID casts intentionally fail the whole request on malformed authority.
     A partial heartbeat would make its omitted managers look proven. */
  IF EXISTS (
    WITH asked AS (
      SELECT (item ->> 'tournament_id')::uuid AS id
        FROM jsonb_array_elements(p_claims) item
    )
    SELECT 1 FROM asked GROUP BY id HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v4 refuses duplicate tournaments'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'tournament_id')::uuid AS id,
           (item ->> 'lease_generation')::uuid AS requested_generation
      FROM jsonb_array_elements(p_claims) item
  ),
  lockable AS MATERIALIZED (
    SELECT l.tournament_id
      FROM public.engine_tournament_leases l
      JOIN asked a ON a.id = l.tournament_id
     WHERE l.instance_id = p_instance_id
       AND l.protocol_version = 2
       AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation)
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     -- Keep the same conflicting lock as the UPDATE, but never queue behind
     -- a settlement while holding already-renewed leases for other tables.
     FOR NO KEY UPDATE OF l SKIP LOCKED
  ),
  renewed AS (
    UPDATE public.engine_tournament_leases l
       SET heartbeat_at = clock_timestamp()
      FROM asked a, lockable k
     WHERE l.tournament_id = a.id
       AND k.tournament_id = l.tournament_id
       AND l.instance_id = p_instance_id
       AND l.protocol_version = 2
       AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation)
       /* An exact UUID is not immortal authority. Once the audited takeover
          boundary passes, even the old holder must claim a new generation;
          a delayed callback may not resurrect the stale one by heartbeating. */
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
    RETURNING l.tournament_id, l.lease_generation
  )
  SELECT a.id,
         CASE
           WHEN r.tournament_id IS NOT NULL THEN 'kept'
           WHEN l.tournament_id IS NULL THEN 'missing'
           WHEN l.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN 'stale'
           WHEN l.instance_id = p_instance_id
            AND l.protocol_version = 2
            AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation) THEN 'busy'
           ELSE 'taken'
         END,
         l.lease_generation
    FROM asked a
    LEFT JOIN renewed r ON r.tournament_id = a.id
    LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = a.id;
END;
$function$;
CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2(p_tournament_id uuid, p_instance_id text, p_version text DEFAULT NULL::text, p_requested_generation uuid DEFAULT NULL::uuid, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_holder text;
  v_heartbeat timestamptz;
  v_generation uuid;
BEGIN
  IF p_tournament_id IS NULL
     OR length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_requested_generation IS NULL THEN
    RAISE EXCEPTION
      'claim_tournament_lease_v2 requires tournament_id, instance_id, and requested_generation'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'claim_tournament_lease_v2 requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;

  /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): the takeover waits for
     every in-flight manager transaction (they hold FOR KEY SHARE in the
     PostgREST pre-request hook). The upsert below only takes FOR NO KEY
     UPDATE on its own, which FOR KEY SHARE does not block. */
  PERFORM 1 FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;

  IF smarter_private.f06_generation_aborted(p_tournament_id,p_requested_generation) THEN
    RETURN QUERY SELECT false,NULL::text,NULL::numeric,NULL::uuid,2;
    RETURN;
  END IF;

  INSERT INTO public.engine_tournament_leases AS l (
    tournament_id,
    instance_id,
    engine_version,
    acquired_at,
    heartbeat_at,
    lease_generation,
    protocol_version
  ) VALUES (
    p_tournament_id,
    p_instance_id,
    p_version,
    clock_timestamp(),
    clock_timestamp(),
    p_requested_generation,
    2
  )
  ON CONFLICT (tournament_id) DO UPDATE
     SET instance_id = EXCLUDED.instance_id,
         engine_version = EXCLUDED.engine_version,
         acquired_at = CASE
           WHEN l.protocol_version = 2
            AND l.instance_id = EXCLUDED.instance_id
            AND l.lease_generation = EXCLUDED.lease_generation THEN l.acquired_at
           ELSE clock_timestamp()
         END,
         heartbeat_at = clock_timestamp(),
         lease_generation = EXCLUDED.lease_generation,
         protocol_version = 2
   WHERE (
           l.protocol_version = 2
       AND l.instance_id = EXCLUDED.instance_id
       AND l.lease_generation = EXCLUDED.lease_generation
         )
      OR (
           l.protocol_version < 2
       AND l.instance_id = EXCLUDED.instance_id
         )
      OR (
           l.heartbeat_at < clock_timestamp() - interval '30 seconds'
       AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation
         )
  RETURNING l.instance_id, l.heartbeat_at, l.lease_generation
       INTO v_holder, v_heartbeat, v_generation;

  IF v_holder IS NOT NULL THEN
    RETURN QUERY SELECT true, v_holder, 0::numeric, v_generation, 2;
    RETURN;
  END IF;

  SELECT l.instance_id, l.heartbeat_at, l.lease_generation
    INTO v_holder, v_heartbeat, v_generation
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id;

  RETURN QUERY
    SELECT false,
           v_holder,
           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1),
           v_generation,
           (SELECT l.protocol_version
              FROM public.engine_tournament_leases l
             WHERE l.tournament_id = p_tournament_id);
END;
$function$;
CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v3(p_instance_id text, p_claims jsonb, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(tournament_id uuid, state text, lease_generation uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v3 requires a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v3 requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;
  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v3 requires a JSON array of claims'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_claims) item
     WHERE jsonb_typeof(item) <> 'object'
        OR length(btrim(COALESCE(item ->> 'tournament_id', ''))) = 0
        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0
  ) THEN
    RAISE EXCEPTION
      'heartbeat_tournament_leases_v3 requires tournament_id and lease_generation for every claim'
      USING ERRCODE = '22023';
  END IF;

  /* UUID casts intentionally fail the whole request on malformed authority.
     A partial heartbeat would make its omitted managers look proven. */
  IF EXISTS (
    WITH asked AS (
      SELECT (item ->> 'tournament_id')::uuid AS id
        FROM jsonb_array_elements(p_claims) item
    )
    SELECT 1 FROM asked GROUP BY id HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v3 refuses duplicate tournaments'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'tournament_id')::uuid AS id,
           (item ->> 'lease_generation')::uuid AS requested_generation
      FROM jsonb_array_elements(p_claims) item
  ),
  renewed AS (
    UPDATE public.engine_tournament_leases l
       SET heartbeat_at = clock_timestamp()
      FROM asked a
     WHERE l.tournament_id = a.id
       AND l.instance_id = p_instance_id
       AND l.protocol_version = 2
       AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation)
       /* An exact UUID is not immortal authority. Once the audited takeover
          boundary passes, even the old holder must claim a new generation;
          a delayed callback may not resurrect the stale one by heartbeating. */
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
    RETURNING l.tournament_id, l.lease_generation
  )
  SELECT a.id,
         CASE
           WHEN r.tournament_id IS NOT NULL THEN 'kept'
           WHEN l.tournament_id IS NULL THEN 'missing'
           WHEN l.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN 'stale'
           ELSE 'taken'
         END,
         l.lease_generation
    FROM asked a
    LEFT JOIN renewed r ON r.tournament_id = a.id
    LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = a.id;
END;
$function$;
CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_actor text;
  v_protocol text;
  v_request_role text;
  v_method text;
  v_path text;
  v_tournament_id uuid;
  v_lease_generation uuid;
  /* Must remain identical to TOURNAMENT_LEASE_STALE_SECONDS and the claim RPC
     default. The catalog assertion below pins this audited takeover window. */
  v_stale_seconds constant integer := 30;
BEGIN
  BEGIN
    v_headers := COALESCE(
      NULLIF(current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
    v_claims := COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: malformed PostgREST request context'
      USING ERRCODE = '22023';
  END;

  v_actor := lower(btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')));
  v_protocol := btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', ''));
  /* This function is SECURITY DEFINER, so current_user is its owner, not the
     impersonated API role. The transaction-scoped, PostgREST-verified JWT
     claims are the request identity inside this privileged function. */
  v_request_role := btrim(COALESCE(auth.role(), ''));
  IF v_actor <> ''
     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', '')) THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: verified JWT role disagrees with request claims'
      USING ERRCODE = '22023';
  END IF;
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));

  /* This route cannot exist while smarter_private stays outside db-schemas.
     Keep the refusal as fail-closed defence if that deployment boundary is
     ever misconfigured. */
  IF v_path = 'rpc/fn_smarter_data_api_pre_request' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: request hook is not an RPC'
      USING ERRCODE = '42501';
  END IF;

  /* Stage A strict mode is intentionally OFF.  Unmarked old engines and
     ordinary browser clients remain compatible until a later activation
     migration.  Recording the local marker lets downstream Stage-B guards
     distinguish this path without guessing from table names or payloads. */
  IF v_actor = '' THEN
    PERFORM set_config('app.smarter_data_actor', 'legacy-unmarked', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_request_role <> 'service_role' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: marked server actor requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor = 'service' THEN
    IF v_protocol <> '1'
       OR length(btrim(COALESCE(v_headers ->> 'x-smarter-tournament-id', ''))) > 0
       OR length(
            btrim(
              COALESCE(v_headers ->> 'x-smarter-tournament-lease-generation', '')
            )
          ) > 0 THEN
      RAISE EXCEPTION 'DATA_ACTOR_INVALID: service authority headers are inconsistent'
        USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.smarter_data_actor', 'service', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_actor <> 'tournament-manager' OR v_protocol <> '2' THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: unknown actor or protocol'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_tournament_id := (v_headers ->> 'x-smarter-tournament-id')::uuid;
    v_lease_generation :=
      (v_headers ->> 'x-smarter-tournament-lease-generation')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END;
  IF v_tournament_id IS NULL OR v_lease_generation IS NULL THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END IF;

  /* PostgREST executes this hook inside the same transaction as the requested
     statement.  Read-only GET/HEAD requests need exact validation only.
     Every possible mutation method takes a shared row lock first; a lease
     takeover/update therefore waits until this manager transaction commits. */
  IF v_method IN ('GET', 'HEAD', 'OPTIONS')
     OR current_setting('transaction_read_only') = 'on' THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,v_lease_generation)
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,v_lease_generation)
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): FOR KEY SHARE, not
        FOR SHARE. The heartbeat renews heartbeat_at with FOR NO KEY
        UPDATE ... SKIP LOCKED; FOR SHARE made every in-flight manager
        request read as busy and expired the manager after 20 seconds.
        A takeover still waits: claim_tournament_lease_v2 takes FOR
        UPDATE, which FOR KEY SHARE does conflict with. */
     FOR KEY SHARE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);
  PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
  PERFORM set_config(
    'app.smarter_tournament_lease_generation',
    v_lease_generation::text,
    true
  );
END;
$function$;
-- New authoritative operation. Expected values are comparisons, never evidence
-- supplied by a caller: every prerequisite below is re-read under its own locks.
CREATE FUNCTION public.fn_f06_abort_unsettled_hand(p_receipt_id uuid,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_expected->>'tournament_id')::uuid;
 tab uuid:=(p_expected->>'table_id')::uuid;
 g uuid:=(p_expected->>'generation')::uuid;
 h smarter_private.f06_hand_permits;
 o smarter_private.f06_operations;
 lease public.engine_tournament_leases;
 snap public.hand_state_snapshots;
 prior smarter_private.f06_unsettled_hand_aborts;
 actual jsonb; roster jsonb; users uuid[]; u uuid;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role'
 OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_receipt_id IS NULL OR t IS NULL OR tab IS NULL OR g IS NULL
 OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
 RAISE EXCEPTION 'F06_ABORT_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN
 RAISE EXCEPTION 'PLATFORM_FROZEN: interrupted-hand abort refused' USING ERRCODE='55000'; END IF;

 -- Serializes duplicate receipts, including the replay after lease withdrawal.
 PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:'||p_receipt_id::text,0));
 SELECT * INTO prior FROM smarter_private.f06_unsettled_hand_aborts WHERE receipt_id=p_receipt_id;
 IF FOUND THEN
 IF prior.expected IS DISTINCT FROM p_expected THEN
 RAISE EXCEPTION 'F06_ABORT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',prior.receipt_id,'credit',0);
 END IF;

 -- Linearization: drain every already admitted protocol-2 HTTP mutation.
 -- Never block on G/T while holding this lease: direct SQL can own T first.
 SELECT * INTO lease FROM public.engine_tournament_leases
 WHERE tournament_id=t AND lease_generation=g AND protocol_version=2 FOR UPDATE;
 IF NOT FOUND OR lease.instance_id IS DISTINCT FROM p_expected->>'instance_id'
 OR lease.engine_version IS DISTINCT FROM p_expected->>'engine_version' THEN
 RAISE EXCEPTION 'F06_ABORT_ORIGINAL_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_try_lane(t);
 SELECT * INTO h FROM smarter_private.f06_hand_permits
 WHERE permit_id=(p_expected->'permit'->>'permit_id')::uuid;
 IF NOT FOUND OR h.tournament_id IS DISTINCT FROM t OR h.table_id IS DISTINCT FROM tab
 OR h.generation IS DISTINCT FROM g OR h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL THEN
 RAISE EXCEPTION 'F06_ABORT_ORIGINAL_PERMIT_CHANGED' USING ERRCODE='55000'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.table_seats
 WHERE table_id=tab AND left_at IS NULL;
 FOR u IN SELECT x FROM unnest(users) x ORDER BY x LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE='40001'; END IF;
 END LOOP;
 PERFORM 1 FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats WHERE table_id=tab ORDER BY id FOR UPDATE;
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=h.permit_id FOR UPDATE;
 SELECT * INTO o FROM smarter_private.f06_operations
 WHERE break_id=(p_expected->'park'->>'break_id')::uuid FOR UPDATE;
 IF NOT FOUND OR o.tournament_id IS DISTINCT FROM t OR o.source_table_id IS DISTINCT FROM tab
 OR o.lifecycle IS DISTINCT FROM h.lifecycle OR o.origin_generation IS DISTINCT FROM g
 OR o.custody_generation IS DISTINCT FROM g OR o.custody_id IS NULL
 OR o.state IS DISTINCT FROM 'park_requested' OR o.manifest IS NOT NULL
 OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
 OR o.abort_receipt_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=o.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=o.break_id) THEN
 RAISE EXCEPTION 'F06_ABORT_PARK_NOT_PREMANIFEST' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=t AND status='RUNNING'
 AND format_contract='sng-v1' AND table_size=2 AND current_players=2)
 OR (SELECT count(*) FROM public.tables WHERE tournament_id=t
 AND lower(status)<>'closed' AND NOT COALESCE(is_deleted,false))<>1
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=tab AND tournament_id=t
 AND f06_lifecycle=h.lifecycle AND lower(status) IN ('waiting','running')
 AND NOT COALESCE(is_deleted,false))
 OR cardinality(users) IS DISTINCT FROM 2
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=t AND status='playing')<>2
 OR EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=tab AND left_at IS NULL
 AND (occupancy_id IS NULL OR terminal_closed_at IS NOT NULL))
 OR (SELECT count(*) FROM smarter_private.f06_hand_permits
 WHERE table_id=tab AND state='reserved')<>1
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits
 WHERE table_id=tab AND hand_number>h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=tab AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=tab AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=tab AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;
 SELECT * INTO snap FROM public.hand_state_snapshots
 WHERE table_id=tab AND hand_number=h.hand_number AND NOT is_complete FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'players')<>2 THEN
 RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,
 'registration_id',p.id,'user_id',s.user_id,'seat_number',s.seat_number,
 'stack',s.stack,'chips',p.chips) ORDER BY s.user_id) INTO roster
 FROM public.table_seats s JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number
 WHERE s.table_id=tab AND s.left_at IS NULL AND p.status='playing';
 IF jsonb_array_length(roster) IS DISTINCT FROM 2
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)<>2
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r
 WHERE r->>'user_id'=x->>'user_id' AND (r->>'seat_number')::integer=(x->>'seat')::integer
 AND (r->>'stack')::numeric=(r->>'chips')::numeric
 AND (r->>'stack')::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric
 AND (x->>'stack')::numeric>=0 AND (x->>'totalInvested')::numeric>=0
 AND COALESCE((x->>'deadInvested')::numeric,0)=0
 AND COALESCE((x->>'returnedUncalled')::numeric,0)=0
 AND COALESCE((x->>'individualAnteInvested')::numeric,0)=0)) THEN
 RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE='55000'; END IF;
 actual:=jsonb_build_object('tournament_id',t,'table_id',tab,'generation',g,
 'instance_id',lease.instance_id,'engine_version',lease.engine_version,
 'permit',to_jsonb(h),'park',to_jsonb(o)-'abort_receipt_id',
 'snapshot_id',snap.id,'snapshot_hash',md5(to_jsonb(snap)::text),'roster',roster);
 IF actual IS DISTINCT FROM p_expected THEN
 RAISE EXCEPTION 'F06_ABORT_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 IF public.fn_platform_frozen() THEN
 RAISE EXCEPTION 'PLATFORM_FROZEN: interrupted-hand abort refused' USING ERRCODE='55000'; END IF;

 -- No hand is accepted and no chips, wallet, escrow, ledger, prize or history
 -- is rewritten. This immutable receipt permanently revokes the old writer.
 INSERT INTO smarter_private.f06_unsettled_hand_aborts
 (receipt_id,tournament_id,table_id,generation,permit_id,hand_number,break_id,expected)
 VALUES(p_receipt_id,t,tab,g,h.permit_id,h.hand_number,o.break_id,actual);
 UPDATE smarter_private.f06_hand_permits SET state='aborted_unsettled',evidence_id=p_receipt_id
 WHERE permit_id=h.permit_id;
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=p_receipt_id
 WHERE break_id=o.break_id;
 UPDATE public.hand_state_snapshots SET is_complete=true WHERE id=snap.id;
 PERFORM public.release_tournament_leases_v2(lease.instance_id,
 jsonb_build_array(jsonb_build_object('tournament_id',t,'lease_generation',g)));
 IF EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND lease_generation=g) THEN
 RAISE EXCEPTION 'F06_ABORT_LEASE_NOT_WITHDRAWN' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',p_receipt_id,'credit',0);
END $function$;

REVOKE ALL ON FUNCTION public.fn_f06_abort_unsettled_hand(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_unsettled_hand(uuid,jsonb) TO service_role;
COMMIT;
