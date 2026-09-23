-- The missing lease is not reconstructed. This immutable record preserves a
-- positively stopped original owner and its complete canonical evidence.
CREATE TABLE smarter_private.f06_retired_manager_origins (
 receipt_id uuid PRIMARY KEY,
 tournament_id uuid NOT NULL,
 origin_generation uuid NOT NULL,
 physical_proof jsonb NOT NULL,
 canonical_proof jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tournament_id,origin_generation)
);
ALTER TABLE smarter_private.f06_retired_manager_origins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_retired_manager_origins FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_retired_manager_origins
FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON smarter_private.f06_retired_manager_origins
FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();

CREATE FUNCTION smarter_private.f06_retired_origin_lock(t uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:retired-origin:'||t::text,0)) THEN
 RAISE EXCEPTION 'F06_RETIRED_CLAIM_BUSY' USING ERRCODE='40001'; END IF;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_retired_origin_lock(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- This entry point is only used by the complete original-hand snapshot below.
-- It takes the same native claim lock as the lease trigger before testing absence.
CREATE FUNCTION smarter_private.f06_retired_origin_begin(p_input jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE t uuid:=(p_input->>'tournament_id')::uuid; g uuid:=(p_input->>'generation')::uuid;
 cohort jsonb:=smarter_private.f06_retired_origin_cohort(t); physical jsonb:=p_input->'physical';
 leader jsonb; item jsonb; pairs jsonb; instant timestamptz:=clock_timestamp();
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF cohort IS NULL OR cohort->>'generation' IS DISTINCT FROM g::text
 OR p_input->'lease' IS DISTINCT FROM 'null'::jsonb
 OR p_input#>'{hands,0,permit}' IS DISTINCT FROM cohort->'permit' THEN
 RAISE EXCEPTION 'F06_RETIRED_ORIGIN_SCOPE_CHANGED'; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
 RAISE EXCEPTION 'F06_RETRY_MAINTENANCE_LANE' USING ERRCODE='40001'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 PERFORM smarter_private.f06_retired_origin_lock(t);
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t FOR UPDATE;
 IF FOUND THEN RAISE EXCEPTION 'F06_RETIRED_COMPETING_LEASE'; END IF;
 SELECT to_jsonb(e) INTO leader FROM public.engine_leader e WHERE id=true FOR SHARE;
 IF leader IS NULL OR leader->>'instance_id' IS DISTINCT FROM '1-3846b8bb'
 OR leader->>'engine_version' IS DISTINCT FROM '8825af51'
 OR (leader->>'heartbeat_at')::timestamptz IS NULL OR NOT isfinite((leader->>'heartbeat_at')::timestamptz)
 OR NOT (instant-(leader->>'heartbeat_at')::timestamptz BETWEEN interval '-30 seconds' AND interval '60 seconds') THEN
 RAISE EXCEPTION 'F06_RETIRED_PROCESS_CHANGED'; END IF;
 IF physical->>'source' IS DISTINCT FROM '8825af51817f379c4261658ca29ecc9d8d81932d'
 OR physical->>'instance_id' IS DISTINCT FROM '1-3846b8bb'
 OR physical->>'process_id' IS DISTINCT FROM '1231816'
 OR physical->>'application_pid' IS DISTINCT FROM '1'
 OR physical->>'container_id' IS DISTINCT FROM 'c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66'
 OR physical->>'image' IS DISTINCT FROM 'sha256:7973b0cd170e7ea00a948f6376b17a201485c3e03ae47c06f0248b17a4bfae1c'
 OR physical->>'manager_id' IS DISTINCT FROM cohort->>'manager_id'
 OR physical->>'generation' IS DISTINCT FROM g::text
 OR physical->'all_processes_accounted' IS DISTINCT FROM 'true'::jsonb
 OR physical->'all_owned_work_joined' IS DISTINCT FROM 'true'::jsonb
 OR physical->'original_stop_completed' IS DISTINCT FROM 'true'::jsonb
 OR physical->'owner_index_complete' IS DISTINCT FROM 'true'::jsonb
 OR physical->'scheduler_pending' IS DISTINCT FROM '0'::jsonb
 OR physical->'lifecycle_pending' IS DISTINCT FROM '0'::jsonb
 OR jsonb_typeof(physical->'engines') IS DISTINCT FROM 'array'
 OR physical->>'engine_id' IS DISTINCT FROM cohort->'engines'->>(physical->>'table_id')
 OR COALESCE(physical->>'evidence_sha256','') !~ '^[0-9a-f]{64}$' THEN
 RAISE EXCEPTION 'F06_RETIRED_PHYSICAL_PROOF_REQUIRED'; END IF;
 SELECT jsonb_object_agg(e->>'table_id',e->'engine_id') INTO pairs FROM jsonb_array_elements(physical->'engines') e;
 IF pairs IS DISTINCT FROM cohort->'engines'
 OR jsonb_array_length(physical->'engines')<>(SELECT count(*) FROM jsonb_object_keys(cohort->'engines')) THEN
 RAISE EXCEPTION 'F06_RETIRED_WHOLE_OWNER_REQUIRED'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(physical->'engines') LOOP
 IF item->>'generation' IS DISTINCT FROM g::text OR item->'terminal' IS DISTINCT FROM 'true'::jsonb
 OR item->'running' IS DISTINCT FROM 'false'::jsonb OR item->>'last_event' IS DISTINCT FROM 'stop_completed'
 OR item->'owned_work_joined' IS DISTINCT FROM 'true'::jsonb
 OR item->'diagnostic_write_failures' IS DISTINCT FROM '0'::jsonb
 OR item->'dropped_records' IS DISTINCT FROM '0'::jsonb
 OR item->'dealing_loop' IS DISTINCT FROM 'false'::jsonb OR item->'settlements' IS DISTINCT FROM '0'::jsonb
 OR item->'post_hand_tasks' IS DISTINCT FROM 'false'::jsonb OR item->'tournament_moves' IS DISTINCT FROM '0'::jsonb
 OR item->>'read_continuation_proof' IS DISTINCT FROM '8825_stop_completed_joins_fixed_point'
 THEN RAISE EXCEPTION 'F06_RETIRED_ORIGINAL_NOT_DRAINED'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_retired_origin_begin(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_f06_attest_retired_manager_origin(p_receipt_id uuid,p_input jsonb,p_expected jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE t uuid:=(p_input->>'tournament_id')::uuid; g uuid:=(p_input->>'generation')::uuid;
 actual jsonb; prior smarter_private.f06_retired_manager_origins; observed timestamptz;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_receipt_id IS NULL OR p_receipt_id::text IS DISTINCT FROM smarter_private.f06_retired_origin_cohort(t)->>'receipt_id' THEN
 RAISE EXCEPTION 'F06_RETIRED_OPERATION_CHANGED'; END IF;
 PERFORM smarter_private.f06_retired_origin_lock(t);
 SELECT * INTO prior FROM smarter_private.f06_retired_manager_origins WHERE receipt_id=p_receipt_id;
 IF FOUND THEN
 -- A lost response reads its immutable outcome, even after hand disposition.
 IF (prior.tournament_id,prior.origin_generation,prior.physical_proof) IS DISTINCT FROM (t,g,p_input->'physical')
 OR (p_expected IS NOT NULL AND prior.canonical_proof IS DISTINCT FROM p_expected) THEN
 RAISE EXCEPTION 'F06_RETIRED_CHANGED_REPLAY'; END IF;
 RETURN jsonb_build_object('ok',true,'receipt',to_jsonb(prior),'canonical',prior.canonical_proof);
 END IF;
 observed:=(p_input#>>'{physical,observed_at}')::timestamptz;
 IF observed IS NULL OR NOT isfinite(observed) OR NOT (clock_timestamp()-observed BETWEEN interval '-30 seconds' AND interval '60 seconds') THEN
 RAISE EXCEPTION 'F06_RETIRED_PHYSICAL_PROOF_STALE'; END IF;
 actual:=smarter_private.f06_retired_origin_snapshot(p_input);
 IF p_expected IS NOT NULL THEN
 IF actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED'; END IF;
 INSERT INTO smarter_private.f06_retired_manager_origins(receipt_id,tournament_id,origin_generation,physical_proof,canonical_proof)
 VALUES(p_receipt_id,t,g,p_input->'physical',actual) RETURNING * INTO prior;
 END IF;
 RETURN jsonb_build_object('ok',true,'canonical',actual,'receipt',CASE WHEN prior.receipt_id IS NULL THEN NULL ELSE to_jsonb(prior) END);
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_attest_retired_manager_origin(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_attest_retired_manager_origin(uuid,jsonb,jsonb) TO service_role;

CREATE FUNCTION smarter_private.f06_retired_origin_disposition(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE prior smarter_private.f06_retired_manager_origins; actual jsonb;
BEGIN
 PERFORM smarter_private.f06_retired_origin_lock((p_input->>'tournament_id')::uuid);
 SELECT * INTO prior FROM smarter_private.f06_retired_manager_origins WHERE receipt_id=(p_input->>'retired_origin_id')::uuid;
 IF NOT FOUND OR prior.tournament_id::text IS DISTINCT FROM p_input->>'tournament_id'
 OR prior.origin_generation::text IS DISTINCT FROM p_input->>'generation' THEN RAISE EXCEPTION 'F06_RETIRED_RECEIPT_REQUIRED'; END IF;
 actual:=smarter_private.f06_retired_origin_snapshot(p_input);
 IF actual IS DISTINCT FROM prior.canonical_proof THEN RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED'; END IF;
 RETURN actual||jsonb_build_object('retired_origin_id',prior.receipt_id);
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_retired_origin_disposition(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.f06_retired_origin_transfer(t uuid,g uuid,local_proof jsonb,canonical jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE prior smarter_private.f06_retired_manager_origins; item jsonb; pairs jsonb; key text; expected_permit jsonb;
BEGIN
 SELECT * INTO prior FROM smarter_private.f06_retired_manager_origins WHERE tournament_id=t AND origin_generation=g FOR SHARE;
 IF NOT FOUND OR local_proof->>'manager_id' IS DISTINCT FROM prior.physical_proof->>'manager_id'
 OR local_proof#>>'{release_checkpoint,instance_id}' IS DISTINCT FROM prior.physical_proof->>'instance_id'
 OR local_proof#>>'{release_checkpoint,source}' IS DISTINCT FROM prior.physical_proof->>'source'
 OR local_proof#>>'{release_checkpoint,container_id}' IS DISTINCT FROM prior.physical_proof->>'container_id' THEN
 RAISE EXCEPTION 'F06_RETIRED_TRANSFER_OWNER_CHANGED'; END IF;
 SELECT jsonb_object_agg(e->>'table_id',e->'engine_id') INTO pairs FROM jsonb_array_elements(local_proof->'engines') e;
 IF pairs IS DISTINCT FROM smarter_private.f06_retired_origin_cohort(t)->'engines' THEN RAISE EXCEPTION 'F06_RETIRED_WHOLE_OWNER_REQUIRED'; END IF;
 FOREACH key IN ARRAY ARRAY['operations','members','attempts','move_receipts','seats','registrations','hand_dispatch','move_dispatch'] LOOP
 -- Snapshot functions use different stable sorting for registrations only.
 IF (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(canonical->key) x) IS DISTINCT FROM
 (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(prior.canonical_proof->key) x) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;
 END LOOP;
 expected_permit:=prior.canonical_proof#>'{hands,0,permit}';
 IF canonical->'pending_original_tables' IS DISTINCT FROM '[]'::jsonb OR NOT EXISTS
 (SELECT 1 FROM jsonb_array_elements(canonical->'original_evidence') e WHERE e#>'{evidence,receipt,expected}'=
 prior.canonical_proof||jsonb_build_object('retired_origin_id',prior.receipt_id)
 AND e#>>'{permit,permit_id}'=expected_permit->>'permit_id' AND e#>>'{permit,state}'='aborted_unsettled') THEN
 RAISE EXCEPTION 'F06_RETIRED_TERMINAL_RECEIPT_REQUIRED'; END IF;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- INSERT acquires the same lock before ON CONFLICT can inspect or replace a row.
-- UPDATE takes it nonblocking, so an existing row lock cannot invert the order.
CREATE FUNCTION smarter_private.f06_retired_origin_claim_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE origin smarter_private.f06_retired_manager_origins; transfer smarter_private.f06_manager_custody_transfers;
 admission smarter_private.f06_manager_custody_admissions; current_identity jsonb; current_heartbeat timestamptz;
BEGIN
 IF TG_OP='UPDATE' AND OLD.tournament_id IS DISTINCT FROM NEW.tournament_id
 AND smarter_private.f06_retired_origin_cohort(OLD.tournament_id) IS NOT NULL THEN
 RAISE EXCEPTION 'F06_RETIRED_EVENT_IDENTITY_CHANGED'; END IF;
 IF smarter_private.f06_retired_origin_cohort(NEW.tournament_id) IS NULL THEN RETURN NEW; END IF;
 PERFORM smarter_private.f06_retired_origin_lock(NEW.tournament_id);
 SELECT * INTO origin FROM smarter_private.f06_retired_manager_origins WHERE tournament_id=NEW.tournament_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NEW.lease_generation IS NOT DISTINCT FROM origin.origin_generation OR NEW.protocol_version IS DISTINCT FROM 2 THEN
 RAISE EXCEPTION 'F06_RETIRED_ORIGINAL_GENERATION_FENCED'; END IF;
 SELECT * INTO transfer FROM smarter_private.f06_manager_custody_transfers
 WHERE tournament_id=origin.tournament_id AND origin_generation=origin.origin_generation;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_RETIRED_TRANSFER_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions WHERE transfer_id=transfer.transfer_id) THEN RETURN NEW; END IF;
 IF NEW.lease_generation IS DISTINCT FROM transfer.successor_generation
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=NEW.tournament_id AND state='reserved') THEN
 RAISE EXCEPTION 'F06_RETIRED_SUCCESSOR_FENCED'; END IF;
 SELECT * INTO admission FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id=transfer.transfer_id;
 IF FOUND THEN
 SELECT to_jsonb(l)-'heartbeat_at',l.heartbeat_at INTO current_identity,current_heartbeat FROM public.engine_tournament_leases l WHERE tournament_id=NEW.tournament_id;
 IF current_heartbeat IS NULL OR NOT isfinite(current_heartbeat)
 OR current_heartbeat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds())
 OR current_identity IS DISTINCT FROM admission.lease_identity OR NEW.instance_id IS DISTINCT FROM admission.lease_identity->>'instance_id'
 OR NEW.engine_version IS DISTINCT FROM admission.lease_identity->>'engine_version'
 OR (TG_OP='UPDATE' AND to_jsonb(NEW)-'heartbeat_at' IS DISTINCT FROM admission.lease_identity) THEN
 RAISE EXCEPTION 'F06_RETIRED_PARTIAL_PROCESS_CHANGED'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_retired_origin_claim_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER a00_f06_retired_origin_claim BEFORE INSERT OR UPDATE OF tournament_id,lease_generation,instance_id,engine_version,acquired_at,protocol_version
ON public.engine_tournament_leases FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_retired_origin_claim_guard();
