-- Two interrupted originals retained reserved permits after a certified process
-- replacement gave their events new leases. The existing abort correctly requires
-- its own original lease. This forward extension retains the original hand identity
-- and permanently fences the separately locked/drained current generation too.
-- No wallet, seat, registration, prior hand, payout or played-stat writes occur.
-- Qualified only for the existing heads-up SNG uncommitted-hand contract.
-- money-trigger-ok: table_seats.a00_f06_source_seat because its CREATE TRIGGER text below is only an exact existing catalog preimage assertion; this migration never creates or replaces that trigger.
-- money-trigger-ok: tournament_players.a00_f06_source_roster because its CREATE TRIGGER text below is only an exact existing catalog preimage assertion; this migration never creates or replaces that trigger.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
-- Admit this one installation within a finite transaction-local budget. A live
-- caller may own its lease before reading receipts; never retain a partial set.
-- Queue only the first gate while owning no application relation lock: this
-- drains short lease-to-receipt callers instead of starving behind new readers.
DO $admission$
DECLARE v_deadline timestamptz := clock_timestamp()+interval '3 seconds';
BEGIN
 LOOP
  IF clock_timestamp()>=v_deadline THEN
   RAISE EXCEPTION 'F06_SUCCESSOR_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
  END IF;
  BEGIN
   PERFORM set_config('lock_timeout',least(1000,greatest(1,ceil(extract(epoch FROM v_deadline-clock_timestamp())*1000)))::text||'ms',true);
   LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE;
   LOCK TABLE smarter_private.f06_unsettled_hand_aborts IN ACCESS EXCLUSIVE MODE NOWAIT;
   IF clock_timestamp()>=v_deadline THEN
    RAISE EXCEPTION 'F06_SUCCESSOR_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
   END IF;
   EXIT;
  EXCEPTION WHEN lock_not_available THEN
   -- The exception subtransaction released every partial relation lock.
   PERFORM pg_sleep(least(0.01,greatest(0,extract(epoch FROM v_deadline-clock_timestamp()))));
  END;
 END LOOP;
END $admission$;
SET LOCAL lock_timeout='1s';
DO $preimages$
BEGIN
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
('smarter_private.f06_generation_aborted(uuid,uuid)','7d5e74e099589f1e381b98c3db039aa6','postgres','{postgres=X/postgres}'),
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
 RAISE EXCEPTION 'F06_SUCCESSOR_ABORT_PREIMAGE_CHANGED'; END IF;
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

ALTER TABLE smarter_private.f06_unsettled_hand_aborts
 ADD COLUMN retired_lease_generation uuid,
 ADD CONSTRAINT f06_abort_successor_distinct CHECK(retired_lease_generation IS NULL OR retired_lease_generation<>generation);
CREATE UNIQUE INDEX f06_abort_retired_lease_generation
 ON smarter_private.f06_unsettled_hand_aborts(tournament_id,retired_lease_generation)
 WHERE retired_lease_generation IS NOT NULL;

CREATE OR REPLACE FUNCTION smarter_private.f06_generation_aborted(t uuid,g uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,smarter_private AS $function$
BEGIN
 -- Existing leases, heartbeats, request admission and resurrection triggers all
 -- use this VOLATILE authority after their row-lock waits.
 RETURN EXISTS(SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts
 WHERE tournament_id=t AND (generation=g OR retired_lease_generation=g));
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_generation_aborted(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_f06_abort_successor_unsettled_hand(p_receipt_id uuid,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_expected->>'tournament_id')::uuid;
 tab uuid:=(p_expected->>'table_id')::uuid;
 g uuid:=(p_expected->>'generation')::uuid;
 current_g uuid:=(p_expected->>'lease_generation')::uuid;
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
 OR current_g IS NULL OR current_g=g
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

 -- The original permit/custody remain original. Drain the separately identified
 -- current writer; fencing only the former generation would leave this owner live.
 -- Never block on G/T while holding this lease: direct SQL can own T first.
 SELECT * INTO lease FROM public.engine_tournament_leases
 WHERE tournament_id=t AND lease_generation=current_g AND protocol_version=2 FOR UPDATE;
 IF NOT FOUND OR lease.instance_id IS DISTINCT FROM p_expected->>'instance_id'
 OR lease.engine_version IS DISTINCT FROM p_expected->>'engine_version' THEN
 RAISE EXCEPTION 'F06_ABORT_CURRENT_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
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
 'lease_generation',current_g,'instance_id',lease.instance_id,'engine_version',lease.engine_version,
 'permit',to_jsonb(h),'park',to_jsonb(o)-'abort_receipt_id',
 'snapshot_id',snap.id,'snapshot_hash',md5(to_jsonb(snap)::text),'roster',roster);
 IF actual IS DISTINCT FROM p_expected THEN
 RAISE EXCEPTION 'F06_ABORT_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 IF public.fn_platform_frozen() THEN
 RAISE EXCEPTION 'PLATFORM_FROZEN: interrupted-hand abort refused' USING ERRCODE='55000'; END IF;

 -- No hand is accepted and no chips, wallet, escrow, ledger, prize or history
 -- is rewritten. The receipt permanently revokes BOTH original and current writers.
 INSERT INTO smarter_private.f06_unsettled_hand_aborts
 (receipt_id,tournament_id,table_id,generation,permit_id,hand_number,break_id,expected,retired_lease_generation)
 VALUES(p_receipt_id,t,tab,g,h.permit_id,h.hand_number,o.break_id,actual,current_g);
 UPDATE smarter_private.f06_hand_permits SET state='aborted_unsettled',evidence_id=p_receipt_id
 WHERE permit_id=h.permit_id;
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=p_receipt_id
 WHERE break_id=o.break_id;
 UPDATE public.hand_state_snapshots SET is_complete=true WHERE id=snap.id;
 PERFORM public.release_tournament_leases_v2(lease.instance_id,
 jsonb_build_array(jsonb_build_object('tournament_id',t,'lease_generation',current_g)));
 IF EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND lease_generation=current_g) THEN
 RAISE EXCEPTION 'F06_ABORT_LEASE_NOT_WITHDRAWN' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',p_receipt_id,'credit',0);
END $function$;

REVOKE ALL ON FUNCTION public.fn_f06_abort_successor_unsettled_hand(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_successor_unsettled_hand(uuid,jsonb) TO service_role;
COMMIT;
