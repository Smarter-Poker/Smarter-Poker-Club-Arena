-- Exact retired original custody; no lease is inserted or resurrected.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $pins$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)') AND md5(prosrc)='174685b1868d588bfae3b726f82c536f' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_RETIRED_DEPENDENCY_DRIFT: smarter_private.f06_retained_mtt_abort_snapshot(jsonb)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_f06_abort_retained_mtt_hands(uuid,jsonb)') AND md5(prosrc)='ac3cd23f4e9156b820fadf0098749235' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_RETIRED_DEPENDENCY_DRIFT: public.fn_f06_abort_retained_mtt_hands(uuid,jsonb)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)') AND md5(prosrc)='6cee89d253373a45298c13324429ab1b' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_RETIRED_DEPENDENCY_DRIFT: public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_f06_mixed_custody_contract()') AND md5(prosrc)='0adb4f8e9c99abffa9782b60f6847b3b' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog']) THEN RAISE EXCEPTION 'F06_RETIRED_DEPENDENCY_DRIFT: public.fn_f06_mixed_custody_contract()'; END IF;
END $pins$;
CREATE FUNCTION smarter_private.f06_retired_origin_cohort(t uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $cohort$ SELECT $data${"5a387a75-754a-416e-8fee-b85b15fc2702":{"engines":{"09f5e9eb-df66-4e55-a3c8-4385d27631e2":"771c20b5-a303-43fe-a6a8-fda2012ac4eb","12482d21-a767-474f-aa1e-6b78ba368968":"5e7ef136-a773-4e0b-b0e5-7c311693f50b","2c621856-e728-4e8b-bf08-4c56746a8649":"71ad1853-ab7c-4b29-9170-9e35819e665b","49a444ac-553a-4f44-a36f-92781d10a646":"10a16e4e-c347-4e59-b04c-4c6341ba2e5c","623b526d-0901-4c59-aec5-f8e459af7a6c":"2c4582be-ad47-4d17-b41f-d0524a021983","6d8512e3-899d-442b-8d6c-7c57a5f4a1f1":"28fd7b0c-70bc-4d95-a423-0940518f3e7c","7af8a050-53da-4094-8d8d-5c38565eedfc":"42985b85-213e-47e4-a0f2-8288fc3f0462","815d35dd-a6d5-4469-b0aa-e386cc2145b9":"2ffa5273-5a36-4fac-b4e4-c9deb8c6b783","98232ade-1f3d-4541-902f-cd13697bc0b8":"831836ee-98eb-46cd-bec2-50b35a288c28","9bf11d84-684d-4069-916c-c7b5bb397d21":"a75b056b-4e70-440a-9c34-5a44e1f78856","cde664d1-8c53-49dd-9534-bc298ed25a76":"a73e4809-548f-485d-b25e-4bbb0dd73c73","dbd8b7ea-1a99-494f-b564-f86d412dc764":"ab05c24a-69f2-4194-b822-5a934a8a423b","dfe93cf3-157c-45ea-b16b-6c27ab9ad3fe":"bcd61ad8-8a57-47bc-92c5-65dfe56d9261","fcbbd2ea-6fc2-47df-8b61-b9997fcd7b16":"4e4fd230-30a1-4244-9ca6-eb64655f251b"},"generation":"66291622-e7d1-4816-8c33-26ff1f092446","manager_id":"d55415ea-1306-410b-a336-bc6f7ea83944","permit":{"custody_id":"37815b8d-668b-472d-bc0c-3c5ae0da55b3","evidence_id":null,"generation":"66291622-e7d1-4816-8c33-26ff1f092446","hand_number":12942021,"lifecycle":283878,"permit_id":"098c0945-54f9-4c48-a600-3b8845da267b","state":"reserved","table_id":"2c621856-e728-4e8b-bf08-4c56746a8649","tournament_id":"5a387a75-754a-416e-8fee-b85b15fc2702"},"receipt_id":"7d0f56e9-10ce-4c2f-b337-101b75924257"},"615783bf-15e3-40b7-9368-75f21b6ac53b":{"engines":{"383aa2c7-79f1-4937-9d7e-8c49126fce8b":"72688412-7be5-4ebc-afed-2fba5ad8d747","5973d7f6-5a52-4d78-aa92-cba86e19d4ea":"0e362019-a967-4d15-b50e-68dbbe787dfd","737b1a84-da46-459c-b0e3-bba5b23171c0":"48f0243d-176c-4209-b692-076edd23b339","9e18dc43-a81a-4a4f-a360-4f624c60699b":"d4e2be78-93f4-408a-a9ea-3ea199158312","9f30d335-8262-4872-8926-3ddf1fefe75c":"99065d93-c07d-42fa-bda9-74edd2e04a6e","9fdd5393-6fd9-4497-85b2-f98b89cf168d":"f9a26fe0-1f69-4f8e-bf67-d5cc72f600d4","ac93f9eb-d288-400a-b626-b3331a1de466":"31a7dfa8-bdbc-4b8c-aad8-9a57b2d0e2b1","d6199e5e-7c40-4560-afd9-f1a135031097":"4c9965d7-a041-4628-a319-f81e4e709c62","f6bd2252-5c11-40df-b842-cdf99a1e8323":"31bac5c5-cafc-4aca-a4e6-50693e3dace5"},"generation":"b3d06bad-c464-4be8-9e1b-66f7191375ff","manager_id":"bf78d180-dacc-41c8-80dd-765b6fe6d9c4","permit":{"custody_id":"49542b5a-a662-4d79-b035-c82e9ecdbc88","evidence_id":null,"generation":"b3d06bad-c464-4be8-9e1b-66f7191375ff","hand_number":12943630,"lifecycle":289478,"permit_id":"14cddb92-cf9d-46fd-80f7-6379695c0032","state":"reserved","table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","tournament_id":"615783bf-15e3-40b7-9368-75f21b6ac53b"},"receipt_id":"16268739-c7c3-4d38-8a8f-e8f08ac0591b"}}$data$::jsonb->t::text $cohort$;
REVOKE ALL ON FUNCTION smarter_private.f06_retired_origin_cohort(uuid) FROM PUBLIC,anon,authenticated,service_role;
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

CREATE FUNCTION smarter_private.f06_retired_origin_snapshot(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_input->>'tournament_id')::uuid; g uuid:=(p_input->>'generation')::uuid;
 h smarter_private.f06_hand_permits; lease public.engine_tournament_leases;
 event public.tournaments; snap public.hand_state_snapshots; a public.hand_atomic_commits;
 oldseat public.table_seats; reg public.tournament_players; history public.hand_history;
 mr public.tournament_seat_move_receipts; attempt smarter_private.f06_attempts;
 member smarter_private.f06_members; op smarter_private.f06_operations;
 ids uuid[]; users uuid[]; u uuid; r jsonb; physical jsonb; request_json jsonb; payload jsonb; submitted jsonb;
 roster jsonb; prior_roster jsonb; proof jsonb; prior_proof jsonb; hand jsonb;
 zeros jsonb:='[]'; inbound jsonb:='[]'; cards jsonb:='[]'; actual jsonb; n integer;
 stale_seconds integer:=public.fn_engine_lease_stale_seconds();
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role'
 OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF t IS NULL OR g IS NULL OR p_input->>'kind' IS DISTINCT FROM 'retained_mtt_interruption_v1'
 OR jsonb_typeof(p_input->'hands') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'hands')<>1
 OR jsonb_typeof(p_input->'accepted_zeros') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_RETAINED_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 -- FOR UPDATE first drains protocol-2 requests admitted FOR KEY SHARE. A later
 -- lane cannot wait while holding this row; direct SQL may hold it in reverse.
 PERFORM smarter_private.f06_retired_origin_begin(p_input);
 PERFORM smarter_private.f06_try_lane(t);
 SELECT * INTO h FROM smarter_private.f06_hand_permits
 WHERE permit_id=(p_input#>>'{hands,0,permit,permit_id}')::uuid;
 IF NOT FOUND OR h.tournament_id IS DISTINCT FROM t OR h.generation IS DISTINCT FROM g
 OR h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL
 OR (SELECT count(*) FROM smarter_private.f06_hand_permits WHERE tournament_id=t AND state='reserved')<>1
 OR smarter_private.f06_generation_aborted(t,g) THEN
 RAISE EXCEPTION 'F06_RETAINED_WHOLE_ORIGINAL_REQUIRED' USING ERRCODE='55000'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM public.tables WHERE tournament_id=t;
 SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO users FROM public.table_seats
 WHERE table_id=ANY(ids) AND user_id IS NOT NULL;
 FOR u IN SELECT unnest(users) LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT * INTO event FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats WHERE table_id=ANY(ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id=t ORDER BY break_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_members WHERE break_id IN
 (SELECT break_id FROM smarter_private.f06_operations WHERE tournament_id=t) ORDER BY break_id,user_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_attempts WHERE break_id IN
 (SELECT break_id FROM smarter_private.f06_operations WHERE tournament_id=t) ORDER BY request_id FOR UPDATE;
 PERFORM 1 FROM public.tournament_seat_move_receipts WHERE tournament_id=t ORDER BY request_id FOR SHARE;
 PERFORM 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t ORDER BY permit_id FOR UPDATE;
 IF event.status IS DISTINCT FROM 'RUNNING' OR event.format_contract IS NULL
 OR event.format_contract NOT IN ('mtt-v1','mtt-v2') OR NOT EXISTS
 (SELECT 1 FROM public.tables WHERE id=h.table_id AND tournament_id=t AND f06_lifecycle=h.lifecycle
 AND lower(status) IN('waiting','running') AND NOT coalesce(is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_RETAINED_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- This evidence is attested by the owning release/recovery operation. SQL binds
 -- it to the exact lease and original, but cannot inspect another process.
 physical:=p_input->'physical';
 IF jsonb_typeof(physical) IS DISTINCT FROM 'object' OR physical->>'instance_id' IS DISTINCT FROM '1-3846b8bb'
 OR physical->>'source' IS DISTINCT FROM '8825af51817f379c4261658ca29ecc9d8d81932d' OR physical->>'generation' IS DISTINCT FROM g::text
 OR NOT coalesce(physical->>'evidence_sha256' ~ '^[0-9a-f]{64}$',false)
 OR nullif(physical->>'process_id','') IS NULL OR nullif(physical->>'container_id','') IS NULL
 OR NOT coalesce(pg_input_is_valid(physical->>'manager_id','uuid'),false)
 OR physical->'all_processes_accounted' IS DISTINCT FROM 'true'::jsonb
 OR physical->'all_owned_work_joined' IS DISTINCT FROM 'true'::jsonb
 OR physical->'original_stop_completed' IS DISTINCT FROM 'true'::jsonb
 OR physical->>'table_id' IS DISTINCT FROM h.table_id::text
 OR physical->>'permit_id' IS DISTINCT FROM h.permit_id::text
 OR NOT coalesce(pg_input_is_valid(physical->>'engine_id','uuid'),false) THEN
 RAISE EXCEPTION 'F06_RETAINED_PHYSICAL_PROOF_REQUIRED' USING ERRCODE='55000'; END IF;
 -- An accepted later hand or unknown submission wins over this disposition.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id AND hand_number>h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND hand_number>h.hand_number)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number>h.hand_number) THEN
 RAISE EXCEPTION 'F06_RETAINED_LATER_OR_UNKNOWN_CUSTODY' USING ERRCODE='55000'; END IF;
 -- Retain every monetary receipt at this table and require each to be an
 -- already accepted prior hand. An orphan receipt cannot be disposed by naming
 -- an unaccepted permit, even though this operation itself credits zero chips.
 PERFORM 1 FROM public.ca_settlements WHERE table_id=h.table_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.settlement_idempotency_keys WHERE table_id=h.table_id ORDER BY hand_id FOR SHARE;
 PERFORM 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id ORDER BY hand_number FOR SHARE;
 PERFORM 1 FROM public.hand_history WHERE table_id=h.table_id ORDER BY id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k
 LEFT JOIN public.hand_atomic_commits c ON c.table_id=k.table_id AND c.stack_result->>'hand_id'=k.hand_id::text
 WHERE k.table_id=h.table_id AND (k.status IS DISTINCT FROM 'succeeded' OR c.hand_id IS NULL
 OR k.result IS DISTINCT FROM c.stack_result OR k.error IS NOT NULL OR k.completed_at IS NULL))
 OR EXISTS(SELECT 1 FROM public.ca_settlements c LEFT JOIN public.settlement_idempotency_keys k
 ON k.table_id=c.table_id AND k.hand_id=c.hand_id WHERE c.table_id=h.table_id
 AND (c.settlement_type IS DISTINCT FROM 'hand_stacks' OR c.state IS DISTINCT FROM 'final'
 OR c.error_detail IS NOT NULL OR k.hand_id IS NULL))
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=h.table_id
 AND (c.hand_number>=h.hand_number OR c.post_commit_completed_at IS NULL
 OR c.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.hand_history q WHERE q.id=c.hand_id AND q.table_id=c.table_id AND q.hand_number=c.hand_number)
 OR NOT EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=c.table_id AND k.hand_id::text=c.stack_result->>'hand_id')
 OR (SELECT count(*) FROM public.ca_settlements q WHERE q.table_id=c.table_id AND q.hand_id::text=c.stack_result->>'hand_id')<>1))
 OR EXISTS(SELECT 1 FROM public.hand_history q WHERE q.table_id=h.table_id AND NOT EXISTS
 (SELECT 1 FROM public.hand_atomic_commits c WHERE c.hand_id=q.id AND c.table_id=q.table_id AND c.hand_number=q.hand_number)) THEN
 RAISE EXCEPTION 'F06_RETAINED_FINANCIAL_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 -- Every positive registration has one exact live occupancy and vice versa.
 IF EXISTS(SELECT 1 FROM public.table_seats s LEFT JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(ids) AND s.left_at IS NULL AND
 (p.id IS NULL OR s.occupancy_id IS NULL OR s.joined_at IS NULL OR s.terminal_closed_at IS NOT NULL
 OR s.stack IS DISTINCT FROM p.chips::numeric OR s.stack IS NULL OR s.stack<=0 OR s.stack::text IN('NaN','Infinity','-Infinity')))
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=t AND p.status='playing' AND p.chips<>0
 AND NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=p.table_id AND s.user_id=p.user_id
 AND s.seat_number=p.seat_number AND s.left_at IS NULL)) THEN
 RAISE EXCEPTION 'F06_RETAINED_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
 'user_id',s.user_id,'joined_at',s.joined_at,'table_id',s.table_id,'seat_number',s.seat_number,
 'stack',s.stack,'chips',p.chips) ORDER BY s.user_id) INTO roster
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=t AND p.user_id=s.user_id
 AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=h.table_id AND s.left_at IS NULL;
 IF jsonb_array_length(roster) NOT BETWEEN 2 AND 10 OR roster IS NULL
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(roster) x)<>jsonb_array_length(roster) THEN
 RAISE EXCEPTION 'F06_RETAINED_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 -- A zero registration is classified only by its original accepted, sealed
 -- zero-stack outcome and exact vacated occupancy. No rank or payout occurs.
 IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id=t AND status='playing' AND chips=0)
 <>jsonb_array_length(p_input->'accepted_zeros') THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_SET_CHANGED' USING ERRCODE='55000'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_input->'accepted_zeros') ORDER BY value->>'registration_id' LOOP
 SELECT * INTO reg FROM public.tournament_players WHERE id=(r->>'registration_id')::uuid;
 SELECT * INTO oldseat FROM public.table_seats WHERE id=(r->>'seat_id')::uuid;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE hand_id=(r->>'atomic_hand_id')::uuid FOR SHARE;
 SELECT * INTO history FROM public.hand_history WHERE id=a.hand_id AND table_id=a.table_id AND hand_number=a.hand_number FOR SHARE;
 IF reg.id IS NULL OR reg.tournament_id IS DISTINCT FROM t OR reg.status IS DISTINCT FROM 'playing'
 OR reg.chips IS DISTINCT FROM 0 OR reg.table_id IS DISTINCT FROM h.table_id
 OR oldseat.id IS NULL OR (oldseat.user_id,oldseat.table_id,oldseat.seat_number)
 IS DISTINCT FROM (reg.user_id,reg.table_id,reg.seat_number)
 OR oldseat.left_at IS NULL OR oldseat.occupancy_id IS NULL OR oldseat.joined_at IS NULL
 OR a.hand_id IS NULL OR a.table_id IS DISTINCT FROM h.table_id OR a.hand_number>=h.hand_number
 OR history.id IS NULL OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at)
 OR a.post_commit_completed_at<a.committed_at OR oldseat.left_at>a.post_commit_completed_at
 OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number
 OR a.payload_hash IS NULL OR a.payload_hash !~ '^[0-9a-f]{64}$'
 OR EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=ANY(ids) AND user_id=reg.user_id AND left_at IS NULL)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(zeros) z WHERE z->>'registration_id'=reg.id::text) THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 payload:=a.post_commit_payload; submitted:=payload-'accepted_hand_facts';
 IF jsonb_typeof(submitted->'pending_addons')='object' THEN
 IF jsonb_typeof(submitted#>'{pending_addons,ids}') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 submitted:=submitted#-'{pending_addons,ids}'; END IF;
 IF payload->>'version' IS DISTINCT FROM '1' OR jsonb_typeof(payload->'accepted_hand_facts') IS DISTINCT FROM 'object'
 OR encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_payload_hash
 OR encode(extensions.digest(convert_to(submitted::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_request_hash
 OR a.stack_result->'success' IS DISTINCT FROM 'true'::jsonb OR a.stack_result->>'mode' IS DISTINCT FROM 'delta'
 OR a.stack_result->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
 OR a.stack_result->'tournament_players_synced' IS DISTINCT FROM 'true'::jsonb
 OR a.stack_result->>'table_id' IS DISTINCT FROM h.table_id::text
 OR a.stack_result->>'tournament_id' IS DISTINCT FROM t::text
 OR (a.stack_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number
 OR a.stack_result->>'hand_id' IS DISTINCT FROM r->>'stack_hand_id'
 OR (a.stack_result->>'players')::integer NOT BETWEEN 2 AND 10
 OR (a.stack_result->>'tournament_player_count')::integer IS DISTINCT FROM (a.stack_result->>'players')::integer
 OR jsonb_typeof(a.stack_result#>'{request,stacks}') IS DISTINCT FROM 'array'
 OR jsonb_array_length(a.stack_result#>'{request,stacks}') IS DISTINCT FROM (a.stack_result->>'players')::integer
 OR (SELECT count(DISTINCT q->>'user_id') FROM jsonb_array_elements(a.stack_result#>'{request,stacks}') q)
 IS DISTINCT FROM (a.stack_result->>'players')::integer
 OR a.stack_result->'rebased' IS DISTINCT FROM '{}'::jsonb OR a.stack_result->'departed' IS DISTINCT FROM '[]'::jsonb
 OR (a.stack_result->>'rake')::numeric IS DISTINCT FROM 0 OR (a.stack_result->>'bbj')::numeric IS DISTINCT FROM 0
 OR (a.stack_result->>'net_deltas')::numeric IS DISTINCT FROM 0 OR (a.stack_result->>'inflow')::numeric IS DISTINCT FROM 0

 OR (a.stack_result->'written'->>reg.user_id::text)::numeric IS DISTINCT FROM 0
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.stack_result#>'{request,stacks}') s
 WHERE s->>'user_id'=reg.user_id::text AND s->>'seat_id'=oldseat.id::text
 AND (s->>'seat_joined_at')::timestamptz=oldseat.joined_at AND (s->>'stack')::numeric=0)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.stack_result->'tournament_player_chips') s
 WHERE s->>'user_id'=reg.user_id::text AND (s->>'chips')::numeric=0)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits later WHERE later.table_id=h.table_id AND later.hand_number>a.hand_number
 AND later.stack_result->'written' ? reg.user_id::text) THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 zeros:=zeros||jsonb_build_array(jsonb_build_object('registration_id',reg.id,'seat_id',oldseat.id,
 'atomic_hand_id',a.hand_id,'stack_hand_id',a.stack_result->>'hand_id','registration',to_jsonb(reg),
 'seat',to_jsonb(oldseat),'atomic_hash',md5(to_jsonb(a)::text),'history_hash',md5(to_jsonb(history)::text)));
 END LOOP;
 proof:=p_input#>'{hands,0,interruption}';
 SELECT * INTO snap FROM public.hand_state_snapshots WHERE table_id=h.table_id AND hand_number=h.hand_number FOR UPDATE;
 IF proof->>'kind'='original_preflop_snapshot' THEN
 IF snap.id IS NULL OR snap.is_complete IS DISTINCT FROM false OR snap.stage IS DISTINCT FROM 'preflop'
 OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
 OR snap.state_json->'actionHistory' IS DISTINCT FROM '[]'::jsonb
 OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'players') IS DISTINCT FROM jsonb_array_length(roster)
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(roster) s WHERE s->>'user_id'=x->>'user_id'
 AND (s->>'seat_number')::integer=(x->>'seat')::integer
 AND (s->>'stack')::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric
 AND (x->>'stack')::numeric>=0 AND (x->>'totalInvested')::numeric>=0
 AND (x->>'stack')::numeric::text NOT IN('NaN','Infinity','-Infinity')
 AND (x->>'totalInvested')::numeric::text NOT IN('NaN','Infinity','-Infinity')
 AND coalesce((x->>'deadInvested')::numeric,0) BETWEEN 0 AND (x->>'totalInvested')::numeric
 AND coalesce((x->>'individualAnteInvested')::numeric,0) BETWEEN 0 AND coalesce((x->>'deadInvested')::numeric,0)
 AND coalesce((x->>'returnedUncalled')::numeric,0)=0))
 OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
 (SELECT sum((x->>'totalInvested')::numeric) FROM jsonb_array_elements(snap.state_json->'players') x) THEN
 RAISE EXCEPTION 'F06_RETAINED_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) s WHERE s->>'user_id'=c.user_id::text
 AND (s->>'seat_number')::integer=c.seat_number)) THEN
 RAISE EXCEPTION 'F06_RETAINED_CARDS_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,
 'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) INTO cards FROM public.table_hole_cards c
 WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number;
 ELSIF proof->>'kind'='prior_commit_plus_inbound_moves' THEN
 IF snap.id IS NOT NULL OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)
 OR jsonb_typeof(proof->'inbound_requests') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_RETAINED_PRIOR_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE hand_id=(p_input#>>'{hands,0,prior,atomic_hand_id}')::uuid FOR SHARE;
 SELECT jsonb_agg(s ORDER BY s->>'user_id') INTO prior_roster FROM jsonb_array_elements(roster) s
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(a.stack_result#>'{request,stacks}') old WHERE old->>'user_id'=s->>'user_id');
 prior_proof:=smarter_private.f06_prior_committed_stacks(h.permit_id,p_input#>'{hands,0,prior}',prior_roster);
 n:=jsonb_array_length(roster)-jsonb_array_length(prior_roster);
 IF n<1 OR n IS NULL OR n<>jsonb_array_length(proof->'inbound_requests')
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(proof->'inbound_requests'))<>n THEN
 RAISE EXCEPTION 'F06_RETAINED_INBOUND_SET_CHANGED' USING ERRCODE='55000'; END IF;
 FOR request_json IN SELECT value FROM jsonb_array_elements(proof->'inbound_requests') ORDER BY value LOOP
 SELECT * INTO mr FROM public.tournament_seat_move_receipts WHERE request_id=(request_json#>>'{}')::uuid;
 SELECT * INTO attempt FROM smarter_private.f06_attempts WHERE request_id=mr.request_id;
 SELECT * INTO op FROM smarter_private.f06_operations WHERE break_id=attempt.break_id;
 SELECT * INTO member FROM smarter_private.f06_members WHERE break_id=attempt.break_id AND user_id=attempt.user_id;
 SELECT * INTO oldseat FROM public.table_seats WHERE id=mr.source_seat_id;
 SELECT s INTO r FROM jsonb_array_elements(roster) s WHERE s->>'seat_id'=mr.destination_seat_id::text;
 IF mr.request_id IS NULL OR attempt.request_id IS NULL OR member.user_id IS NULL OR op.break_id IS NULL
 OR mr.tournament_id IS DISTINCT FROM t OR mr.destination_table_id IS DISTINCT FROM h.table_id
 OR attempt.state IS DISTINCT FROM 'winner' OR attempt.generation IS DISTINCT FROM g
 OR (attempt.user_id,attempt.destination_table_id,attempt.destination_seat_number)
 IS DISTINCT FROM (mr.user_id,mr.destination_table_id,mr.destination_seat_number)
 OR (op.tournament_id,op.source_table_id,op.custody_generation) IS DISTINCT FROM (t,mr.source_table_id,g)
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=op.source_table_id AND f06_lifecycle=op.lifecycle)
 OR (member.source_seat_id,member.source_seat_number,member.occupancy_id)
 IS DISTINCT FROM (mr.source_seat_id,mr.source_seat_number,oldseat.occupancy_id)
 OR oldseat.user_id IS DISTINCT FROM mr.user_id OR oldseat.table_id IS DISTINCT FROM mr.source_table_id
 OR oldseat.left_at IS DISTINCT FROM mr.moved_at OR mr.moved_at IS NULL OR NOT isfinite(mr.moved_at)
 OR r IS NULL OR r->>'user_id' IS DISTINCT FROM mr.user_id::text
 OR (r->>'seat_number')::integer IS DISTINCT FROM mr.destination_seat_number
 OR (r->>'joined_at')::timestamptz IS DISTINCT FROM mr.moved_at
 OR (r->>'stack')::numeric IS DISTINCT FROM mr.stack
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(prior_roster) s WHERE s->>'user_id'=mr.user_id::text)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(inbound) s WHERE s#>>'{receipt,user_id}'=mr.user_id::text)
 OR attempt.receipt IS DISTINCT FROM (to_jsonb(mr)||jsonb_build_object('break_id',op.break_id,
 'source_lifecycle',op.lifecycle::text,'source_occupancy_id',member.occupancy_id))
 OR EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts later WHERE later.tournament_id=t AND later.user_id=mr.user_id
 AND later.moved_at>mr.moved_at) THEN
 RAISE EXCEPTION 'F06_RETAINED_INBOUND_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 inbound:=inbound||jsonb_build_array(jsonb_build_object('receipt',to_jsonb(mr),'attempt',to_jsonb(attempt),
 'member',to_jsonb(member),'operation',to_jsonb(op),'source_seat',to_jsonb(oldseat)));
 END LOOP;
 ELSE RAISE EXCEPTION 'F06_RETAINED_PROOF_KIND_REQUIRED' USING ERRCODE='55000'; END IF;
 hand:=jsonb_build_object('permit',to_jsonb(h),'snapshot_id',snap.id,
 'snapshot_hash',CASE WHEN snap.id IS NULL THEN NULL ELSE md5(to_jsonb(snap)::text) END,
 'roster',roster,'break_id',NULL,'prior',prior_proof,'interruption',jsonb_build_object('kind',proof->>'kind',
 'cards',cards,'inbound_requests',coalesce((SELECT jsonb_agg(value ORDER BY value) FROM jsonb_array_elements(proof->'inbound_requests')),'[]'),
 'inbound',inbound));
 actual:=jsonb_build_object('kind','retained_mtt_interruption_v1','tournament_id',t,'generation',g,
 'lease',NULL,'physical',p_input->'physical','format_contract',event.format_contract,
 'hands',jsonb_build_array(hand),'accepted_zeros',zeros,
 'financial',jsonb_build_object(
 'settlements',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.ca_settlements q WHERE table_id=h.table_id),
 'keys',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY hand_id),'[]') FROM public.settlement_idempotency_keys q WHERE table_id=h.table_id),
 'atomic',(SELECT coalesce(jsonb_agg(jsonb_build_object('hand_id',q.hand_id,'hand_number',q.hand_number,'row_hash',md5(to_jsonb(q)::text)) ORDER BY hand_number),'[]') FROM public.hand_atomic_commits q WHERE table_id=h.table_id),
 'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',q.id,'hand_number',q.hand_number,'row_hash',md5(to_jsonb(q)::text)) ORDER BY id),'[]') FROM public.hand_history q WHERE table_id=h.table_id)));
 SELECT actual||jsonb_build_object(
 'tables',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.tables q WHERE tournament_id=t),
 'registrations',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.tournament_players q WHERE tournament_id=t),
 'seats',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.table_seats q WHERE table_id=ANY(ids)),
 'operations',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY break_id),'[]') FROM smarter_private.f06_operations q WHERE tournament_id=t),
 'members',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.break_id,q.user_id),'[]') FROM smarter_private.f06_members q JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=t),
 'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.request_id),'[]') FROM smarter_private.f06_attempts q JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=t),
 'move_receipts',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY request_id),'[]') FROM public.tournament_seat_move_receipts q WHERE tournament_id=t),
 'permits',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY permit_id),'[]') FROM smarter_private.f06_hand_permits q WHERE tournament_id=t),
 'hand_dispatch',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.permit_id),'[]') FROM smarter_private.f06_hand_dispatch q JOIN smarter_private.f06_hand_permits p USING(permit_id) WHERE p.tournament_id=t),
 'move_dispatch',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.request_id),'[]') FROM smarter_private.f06_dispatch q JOIN smarter_private.f06_attempts b USING(request_id) JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=t)) INTO actual;
 RETURN actual;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_retired_origin_snapshot(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.f06_retained_mtt_abort_snapshot(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_input->>'tournament_id')::uuid; g uuid:=(p_input->>'generation')::uuid;
 h smarter_private.f06_hand_permits; lease public.engine_tournament_leases;
 event public.tournaments; snap public.hand_state_snapshots; a public.hand_atomic_commits;
 oldseat public.table_seats; reg public.tournament_players; history public.hand_history;
 mr public.tournament_seat_move_receipts; attempt smarter_private.f06_attempts;
 member smarter_private.f06_members; op smarter_private.f06_operations;
 ids uuid[]; users uuid[]; u uuid; r jsonb; physical jsonb; request_json jsonb; payload jsonb; submitted jsonb;
 roster jsonb; prior_roster jsonb; proof jsonb; prior_proof jsonb; hand jsonb;
 zeros jsonb:='[]'; inbound jsonb:='[]'; cards jsonb:='[]'; actual jsonb; n integer;
 stale_seconds integer:=public.fn_engine_lease_stale_seconds();
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role'
 OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF t IS NULL OR g IS NULL OR p_input->>'kind' IS DISTINCT FROM 'retained_mtt_interruption_v1'
 OR jsonb_typeof(p_input->'hands') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'hands')<>1
 OR jsonb_typeof(p_input->'accepted_zeros') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_RETAINED_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 -- FOR UPDATE first drains protocol-2 requests admitted FOR KEY SHARE. A later
 -- lane cannot wait while holding this row; direct SQL may hold it in reverse.
 PERFORM smarter_private.f06_retired_origin_lock(t);
 SELECT * INTO lease FROM public.engine_tournament_leases WHERE tournament_id=t FOR UPDATE;
 IF NOT FOUND AND p_input ? 'retired_origin_id' THEN RETURN smarter_private.f06_retired_origin_disposition(p_input); END IF;
 IF NOT FOUND OR stale_seconds IS NULL OR stale_seconds<=0
 OR lease.protocol_version IS DISTINCT FROM 2 OR lease.lease_generation IS DISTINCT FROM g
 OR lease.heartbeat_at IS NULL OR NOT isfinite(lease.heartbeat_at)
 OR lease.heartbeat_at>=clock_timestamp()-make_interval(secs=>stale_seconds)
 OR to_jsonb(lease) IS DISTINCT FROM p_input->'lease' THEN
 RAISE EXCEPTION 'F06_RETAINED_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_try_lane(t);
 SELECT * INTO h FROM smarter_private.f06_hand_permits
 WHERE permit_id=(p_input#>>'{hands,0,permit,permit_id}')::uuid;
 IF NOT FOUND OR h.tournament_id IS DISTINCT FROM t OR h.generation IS DISTINCT FROM g
 OR h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL
 OR (SELECT count(*) FROM smarter_private.f06_hand_permits WHERE tournament_id=t AND state='reserved')<>1
 OR smarter_private.f06_generation_aborted(t,g) THEN
 RAISE EXCEPTION 'F06_RETAINED_WHOLE_ORIGINAL_REQUIRED' USING ERRCODE='55000'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM public.tables WHERE tournament_id=t;
 SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO users FROM public.table_seats
 WHERE table_id=ANY(ids) AND user_id IS NOT NULL;
 FOR u IN SELECT unnest(users) LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT * INTO event FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats WHERE table_id=ANY(ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id=t ORDER BY break_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_members WHERE break_id IN
 (SELECT break_id FROM smarter_private.f06_operations WHERE tournament_id=t) ORDER BY break_id,user_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_attempts WHERE break_id IN
 (SELECT break_id FROM smarter_private.f06_operations WHERE tournament_id=t) ORDER BY request_id FOR UPDATE;
 PERFORM 1 FROM public.tournament_seat_move_receipts WHERE tournament_id=t ORDER BY request_id FOR SHARE;
 PERFORM 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t ORDER BY permit_id FOR UPDATE;
 IF event.status IS DISTINCT FROM 'RUNNING' OR event.format_contract IS NULL
 OR event.format_contract NOT IN ('mtt-v1','mtt-v2') OR NOT EXISTS
 (SELECT 1 FROM public.tables WHERE id=h.table_id AND tournament_id=t AND f06_lifecycle=h.lifecycle
 AND lower(status) IN('waiting','running') AND NOT coalesce(is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_RETAINED_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- This evidence is attested by the owning release/recovery operation. SQL binds
 -- it to the exact lease and original, but cannot inspect another process.
 physical:=p_input->'physical';
 IF jsonb_typeof(physical) IS DISTINCT FROM 'object' OR physical->>'instance_id' IS DISTINCT FROM lease.instance_id
 OR physical->>'source' IS DISTINCT FROM lease.engine_version OR physical->>'generation' IS DISTINCT FROM g::text
 OR NOT coalesce(physical->>'evidence_sha256' ~ '^[0-9a-f]{64}$',false)
 OR nullif(physical->>'process_id','') IS NULL OR nullif(physical->>'container_id','') IS NULL
 OR NOT coalesce(pg_input_is_valid(physical->>'manager_id','uuid'),false)
 OR physical->'all_processes_accounted' IS DISTINCT FROM 'true'::jsonb
 OR physical->'all_owned_work_joined' IS DISTINCT FROM 'true'::jsonb
 OR physical->'original_stop_completed' IS DISTINCT FROM 'true'::jsonb
 OR physical->>'table_id' IS DISTINCT FROM h.table_id::text
 OR physical->>'permit_id' IS DISTINCT FROM h.permit_id::text
 OR NOT coalesce(pg_input_is_valid(physical->>'engine_id','uuid'),false) THEN
 RAISE EXCEPTION 'F06_RETAINED_PHYSICAL_PROOF_REQUIRED' USING ERRCODE='55000'; END IF;
 -- An accepted later hand or unknown submission wins over this disposition.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id AND hand_number>h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND hand_number>h.hand_number)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number>h.hand_number) THEN
 RAISE EXCEPTION 'F06_RETAINED_LATER_OR_UNKNOWN_CUSTODY' USING ERRCODE='55000'; END IF;
 -- Retain every monetary receipt at this table and require each to be an
 -- already accepted prior hand. An orphan receipt cannot be disposed by naming
 -- an unaccepted permit, even though this operation itself credits zero chips.
 PERFORM 1 FROM public.ca_settlements WHERE table_id=h.table_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.settlement_idempotency_keys WHERE table_id=h.table_id ORDER BY hand_id FOR SHARE;
 PERFORM 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id ORDER BY hand_number FOR SHARE;
 PERFORM 1 FROM public.hand_history WHERE table_id=h.table_id ORDER BY id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k
 LEFT JOIN public.hand_atomic_commits c ON c.table_id=k.table_id AND c.stack_result->>'hand_id'=k.hand_id::text
 WHERE k.table_id=h.table_id AND (k.status IS DISTINCT FROM 'succeeded' OR c.hand_id IS NULL
 OR k.result IS DISTINCT FROM c.stack_result OR k.error IS NOT NULL OR k.completed_at IS NULL))
 OR EXISTS(SELECT 1 FROM public.ca_settlements c LEFT JOIN public.settlement_idempotency_keys k
 ON k.table_id=c.table_id AND k.hand_id=c.hand_id WHERE c.table_id=h.table_id
 AND (c.settlement_type IS DISTINCT FROM 'hand_stacks' OR c.state IS DISTINCT FROM 'final'
 OR c.error_detail IS NOT NULL OR k.hand_id IS NULL))
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=h.table_id
 AND (c.hand_number>=h.hand_number OR c.post_commit_completed_at IS NULL
 OR c.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.hand_history q WHERE q.id=c.hand_id AND q.table_id=c.table_id AND q.hand_number=c.hand_number)
 OR NOT EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=c.table_id AND k.hand_id::text=c.stack_result->>'hand_id')
 OR (SELECT count(*) FROM public.ca_settlements q WHERE q.table_id=c.table_id AND q.hand_id::text=c.stack_result->>'hand_id')<>1))
 OR EXISTS(SELECT 1 FROM public.hand_history q WHERE q.table_id=h.table_id AND NOT EXISTS
 (SELECT 1 FROM public.hand_atomic_commits c WHERE c.hand_id=q.id AND c.table_id=q.table_id AND c.hand_number=q.hand_number)) THEN
 RAISE EXCEPTION 'F06_RETAINED_FINANCIAL_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 -- Every positive registration has one exact live occupancy and vice versa.
 IF EXISTS(SELECT 1 FROM public.table_seats s LEFT JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(ids) AND s.left_at IS NULL AND
 (p.id IS NULL OR s.occupancy_id IS NULL OR s.joined_at IS NULL OR s.terminal_closed_at IS NOT NULL
 OR s.stack IS DISTINCT FROM p.chips::numeric OR s.stack IS NULL OR s.stack<=0 OR s.stack::text IN('NaN','Infinity','-Infinity')))
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=t AND p.status='playing' AND p.chips<>0
 AND NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=p.table_id AND s.user_id=p.user_id
 AND s.seat_number=p.seat_number AND s.left_at IS NULL)) THEN
 RAISE EXCEPTION 'F06_RETAINED_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
 'user_id',s.user_id,'joined_at',s.joined_at,'table_id',s.table_id,'seat_number',s.seat_number,
 'stack',s.stack,'chips',p.chips) ORDER BY s.user_id) INTO roster
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=t AND p.user_id=s.user_id
 AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=h.table_id AND s.left_at IS NULL;
 IF jsonb_array_length(roster) NOT BETWEEN 2 AND 10 OR roster IS NULL
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(roster) x)<>jsonb_array_length(roster) THEN
 RAISE EXCEPTION 'F06_RETAINED_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 -- A zero registration is classified only by its original accepted, sealed
 -- zero-stack outcome and exact vacated occupancy. No rank or payout occurs.
 IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id=t AND status='playing' AND chips=0)
 <>jsonb_array_length(p_input->'accepted_zeros') THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_SET_CHANGED' USING ERRCODE='55000'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_input->'accepted_zeros') ORDER BY value->>'registration_id' LOOP
 SELECT * INTO reg FROM public.tournament_players WHERE id=(r->>'registration_id')::uuid;
 SELECT * INTO oldseat FROM public.table_seats WHERE id=(r->>'seat_id')::uuid;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE hand_id=(r->>'atomic_hand_id')::uuid FOR SHARE;
 SELECT * INTO history FROM public.hand_history WHERE id=a.hand_id AND table_id=a.table_id AND hand_number=a.hand_number FOR SHARE;
 IF reg.id IS NULL OR reg.tournament_id IS DISTINCT FROM t OR reg.status IS DISTINCT FROM 'playing'
 OR reg.chips IS DISTINCT FROM 0 OR reg.table_id IS DISTINCT FROM h.table_id
 OR oldseat.id IS NULL OR (oldseat.user_id,oldseat.table_id,oldseat.seat_number)
 IS DISTINCT FROM (reg.user_id,reg.table_id,reg.seat_number)
 OR oldseat.left_at IS NULL OR oldseat.occupancy_id IS NULL OR oldseat.joined_at IS NULL
 OR a.hand_id IS NULL OR a.table_id IS DISTINCT FROM h.table_id OR a.hand_number>=h.hand_number
 OR history.id IS NULL OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at)
 OR a.post_commit_completed_at<a.committed_at OR oldseat.left_at>a.post_commit_completed_at
 OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number
 OR a.payload_hash IS NULL OR a.payload_hash !~ '^[0-9a-f]{64}$'
 OR EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=ANY(ids) AND user_id=reg.user_id AND left_at IS NULL)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(zeros) z WHERE z->>'registration_id'=reg.id::text) THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 payload:=a.post_commit_payload; submitted:=payload-'accepted_hand_facts';
 IF jsonb_typeof(submitted->'pending_addons')='object' THEN
 IF jsonb_typeof(submitted#>'{pending_addons,ids}') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 submitted:=submitted#-'{pending_addons,ids}'; END IF;
 IF payload->>'version' IS DISTINCT FROM '1' OR jsonb_typeof(payload->'accepted_hand_facts') IS DISTINCT FROM 'object'
 OR encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_payload_hash
 OR encode(extensions.digest(convert_to(submitted::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_request_hash
 OR a.stack_result->'success' IS DISTINCT FROM 'true'::jsonb OR a.stack_result->>'mode' IS DISTINCT FROM 'delta'
 OR a.stack_result->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
 OR a.stack_result->'tournament_players_synced' IS DISTINCT FROM 'true'::jsonb
 OR a.stack_result->>'table_id' IS DISTINCT FROM h.table_id::text
 OR a.stack_result->>'tournament_id' IS DISTINCT FROM t::text
 OR (a.stack_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number
 OR a.stack_result->>'hand_id' IS DISTINCT FROM r->>'stack_hand_id'
 OR (a.stack_result->>'players')::integer NOT BETWEEN 2 AND 10
 OR (a.stack_result->>'tournament_player_count')::integer IS DISTINCT FROM (a.stack_result->>'players')::integer
 OR jsonb_typeof(a.stack_result#>'{request,stacks}') IS DISTINCT FROM 'array'
 OR jsonb_array_length(a.stack_result#>'{request,stacks}') IS DISTINCT FROM (a.stack_result->>'players')::integer
 OR (SELECT count(DISTINCT q->>'user_id') FROM jsonb_array_elements(a.stack_result#>'{request,stacks}') q)
 IS DISTINCT FROM (a.stack_result->>'players')::integer
 OR a.stack_result->'rebased' IS DISTINCT FROM '{}'::jsonb OR a.stack_result->'departed' IS DISTINCT FROM '[]'::jsonb
 OR (a.stack_result->>'rake')::numeric IS DISTINCT FROM 0 OR (a.stack_result->>'bbj')::numeric IS DISTINCT FROM 0
 OR (a.stack_result->>'net_deltas')::numeric IS DISTINCT FROM 0 OR (a.stack_result->>'inflow')::numeric IS DISTINCT FROM 0

 OR (a.stack_result->'written'->>reg.user_id::text)::numeric IS DISTINCT FROM 0
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.stack_result#>'{request,stacks}') s
 WHERE s->>'user_id'=reg.user_id::text AND s->>'seat_id'=oldseat.id::text
 AND (s->>'seat_joined_at')::timestamptz=oldseat.joined_at AND (s->>'stack')::numeric=0)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.stack_result->'tournament_player_chips') s
 WHERE s->>'user_id'=reg.user_id::text AND (s->>'chips')::numeric=0)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits later WHERE later.table_id=h.table_id AND later.hand_number>a.hand_number
 AND later.stack_result->'written' ? reg.user_id::text) THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 zeros:=zeros||jsonb_build_array(jsonb_build_object('registration_id',reg.id,'seat_id',oldseat.id,
 'atomic_hand_id',a.hand_id,'stack_hand_id',a.stack_result->>'hand_id','registration',to_jsonb(reg),
 'seat',to_jsonb(oldseat),'atomic_hash',md5(to_jsonb(a)::text),'history_hash',md5(to_jsonb(history)::text)));
 END LOOP;
 proof:=p_input#>'{hands,0,interruption}';
 SELECT * INTO snap FROM public.hand_state_snapshots WHERE table_id=h.table_id AND hand_number=h.hand_number FOR UPDATE;
 IF proof->>'kind'='original_preflop_snapshot' THEN
 IF snap.id IS NULL OR snap.is_complete IS DISTINCT FROM false OR snap.stage IS DISTINCT FROM 'preflop'
 OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
 OR snap.state_json->'actionHistory' IS DISTINCT FROM '[]'::jsonb
 OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'players') IS DISTINCT FROM jsonb_array_length(roster)
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(roster) s WHERE s->>'user_id'=x->>'user_id'
 AND (s->>'seat_number')::integer=(x->>'seat')::integer
 AND (s->>'stack')::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric
 AND (x->>'stack')::numeric>=0 AND (x->>'totalInvested')::numeric>=0
 AND (x->>'stack')::numeric::text NOT IN('NaN','Infinity','-Infinity')
 AND (x->>'totalInvested')::numeric::text NOT IN('NaN','Infinity','-Infinity')
 AND coalesce((x->>'deadInvested')::numeric,0) BETWEEN 0 AND (x->>'totalInvested')::numeric
 AND coalesce((x->>'individualAnteInvested')::numeric,0) BETWEEN 0 AND coalesce((x->>'deadInvested')::numeric,0)
 AND coalesce((x->>'returnedUncalled')::numeric,0)=0))
 OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
 (SELECT sum((x->>'totalInvested')::numeric) FROM jsonb_array_elements(snap.state_json->'players') x) THEN
 RAISE EXCEPTION 'F06_RETAINED_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) s WHERE s->>'user_id'=c.user_id::text
 AND (s->>'seat_number')::integer=c.seat_number)) THEN
 RAISE EXCEPTION 'F06_RETAINED_CARDS_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,
 'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) INTO cards FROM public.table_hole_cards c
 WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number;
 ELSIF proof->>'kind'='prior_commit_plus_inbound_moves' THEN
 IF snap.id IS NOT NULL OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)
 OR jsonb_typeof(proof->'inbound_requests') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_RETAINED_PRIOR_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE hand_id=(p_input#>>'{hands,0,prior,atomic_hand_id}')::uuid FOR SHARE;
 SELECT jsonb_agg(s ORDER BY s->>'user_id') INTO prior_roster FROM jsonb_array_elements(roster) s
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(a.stack_result#>'{request,stacks}') old WHERE old->>'user_id'=s->>'user_id');
 prior_proof:=smarter_private.f06_prior_committed_stacks(h.permit_id,p_input#>'{hands,0,prior}',prior_roster);
 n:=jsonb_array_length(roster)-jsonb_array_length(prior_roster);
 IF n<1 OR n IS NULL OR n<>jsonb_array_length(proof->'inbound_requests')
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(proof->'inbound_requests'))<>n THEN
 RAISE EXCEPTION 'F06_RETAINED_INBOUND_SET_CHANGED' USING ERRCODE='55000'; END IF;
 FOR request_json IN SELECT value FROM jsonb_array_elements(proof->'inbound_requests') ORDER BY value LOOP
 SELECT * INTO mr FROM public.tournament_seat_move_receipts WHERE request_id=(request_json#>>'{}')::uuid;
 SELECT * INTO attempt FROM smarter_private.f06_attempts WHERE request_id=mr.request_id;
 SELECT * INTO op FROM smarter_private.f06_operations WHERE break_id=attempt.break_id;
 SELECT * INTO member FROM smarter_private.f06_members WHERE break_id=attempt.break_id AND user_id=attempt.user_id;
 SELECT * INTO oldseat FROM public.table_seats WHERE id=mr.source_seat_id;
 SELECT s INTO r FROM jsonb_array_elements(roster) s WHERE s->>'seat_id'=mr.destination_seat_id::text;
 IF mr.request_id IS NULL OR attempt.request_id IS NULL OR member.user_id IS NULL OR op.break_id IS NULL
 OR mr.tournament_id IS DISTINCT FROM t OR mr.destination_table_id IS DISTINCT FROM h.table_id
 OR attempt.state IS DISTINCT FROM 'winner' OR attempt.generation IS DISTINCT FROM g
 OR (attempt.user_id,attempt.destination_table_id,attempt.destination_seat_number)
 IS DISTINCT FROM (mr.user_id,mr.destination_table_id,mr.destination_seat_number)
 OR (op.tournament_id,op.source_table_id,op.custody_generation) IS DISTINCT FROM (t,mr.source_table_id,g)
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=op.source_table_id AND f06_lifecycle=op.lifecycle)
 OR (member.source_seat_id,member.source_seat_number,member.occupancy_id)
 IS DISTINCT FROM (mr.source_seat_id,mr.source_seat_number,oldseat.occupancy_id)
 OR oldseat.user_id IS DISTINCT FROM mr.user_id OR oldseat.table_id IS DISTINCT FROM mr.source_table_id
 OR oldseat.left_at IS DISTINCT FROM mr.moved_at OR mr.moved_at IS NULL OR NOT isfinite(mr.moved_at)
 OR r IS NULL OR r->>'user_id' IS DISTINCT FROM mr.user_id::text
 OR (r->>'seat_number')::integer IS DISTINCT FROM mr.destination_seat_number
 OR (r->>'joined_at')::timestamptz IS DISTINCT FROM mr.moved_at
 OR (r->>'stack')::numeric IS DISTINCT FROM mr.stack
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(prior_roster) s WHERE s->>'user_id'=mr.user_id::text)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(inbound) s WHERE s#>>'{receipt,user_id}'=mr.user_id::text)
 OR attempt.receipt IS DISTINCT FROM (to_jsonb(mr)||jsonb_build_object('break_id',op.break_id,
 'source_lifecycle',op.lifecycle::text,'source_occupancy_id',member.occupancy_id))
 OR EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts later WHERE later.tournament_id=t AND later.user_id=mr.user_id
 AND later.moved_at>mr.moved_at) THEN
 RAISE EXCEPTION 'F06_RETAINED_INBOUND_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 inbound:=inbound||jsonb_build_array(jsonb_build_object('receipt',to_jsonb(mr),'attempt',to_jsonb(attempt),
 'member',to_jsonb(member),'operation',to_jsonb(op),'source_seat',to_jsonb(oldseat)));
 END LOOP;
 ELSE RAISE EXCEPTION 'F06_RETAINED_PROOF_KIND_REQUIRED' USING ERRCODE='55000'; END IF;
 hand:=jsonb_build_object('permit',to_jsonb(h),'snapshot_id',snap.id,
 'snapshot_hash',CASE WHEN snap.id IS NULL THEN NULL ELSE md5(to_jsonb(snap)::text) END,
 'roster',roster,'break_id',NULL,'prior',prior_proof,'interruption',jsonb_build_object('kind',proof->>'kind',
 'cards',cards,'inbound_requests',coalesce((SELECT jsonb_agg(value ORDER BY value) FROM jsonb_array_elements(proof->'inbound_requests')),'[]'),
 'inbound',inbound));
 actual:=jsonb_build_object('kind','retained_mtt_interruption_v1','tournament_id',t,'generation',g,
 'lease',to_jsonb(lease),'physical',p_input->'physical','format_contract',event.format_contract,
 'hands',jsonb_build_array(hand),'accepted_zeros',zeros,
 'financial',jsonb_build_object(
 'settlements',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.ca_settlements q WHERE table_id=h.table_id),
 'keys',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY hand_id),'[]') FROM public.settlement_idempotency_keys q WHERE table_id=h.table_id),
 'atomic',(SELECT coalesce(jsonb_agg(jsonb_build_object('hand_id',q.hand_id,'hand_number',q.hand_number,'row_hash',md5(to_jsonb(q)::text)) ORDER BY hand_number),'[]') FROM public.hand_atomic_commits q WHERE table_id=h.table_id),
 'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',q.id,'hand_number',q.hand_number,'row_hash',md5(to_jsonb(q)::text)) ORDER BY id),'[]') FROM public.hand_history q WHERE table_id=h.table_id)));
 SELECT actual||jsonb_build_object(
 'tables',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.tables q WHERE tournament_id=t),
 'registrations',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.tournament_players q WHERE tournament_id=t),
 'seats',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.table_seats q WHERE table_id=ANY(ids)),
 'operations',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY break_id),'[]') FROM smarter_private.f06_operations q WHERE tournament_id=t),
 'members',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.break_id,q.user_id),'[]') FROM smarter_private.f06_members q JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=t),
 'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.request_id),'[]') FROM smarter_private.f06_attempts q JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=t),
 'move_receipts',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY request_id),'[]') FROM public.tournament_seat_move_receipts q WHERE tournament_id=t),
 'permits',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY permit_id),'[]') FROM smarter_private.f06_hand_permits q WHERE tournament_id=t),
 'hand_dispatch',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.permit_id),'[]') FROM smarter_private.f06_hand_dispatch q JOIN smarter_private.f06_hand_permits p USING(permit_id) WHERE p.tournament_id=t),
 'move_dispatch',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.request_id),'[]') FROM smarter_private.f06_dispatch q JOIN smarter_private.f06_attempts b USING(request_id) JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=t)) INTO actual;
 RETURN actual;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_f06_abort_retained_mtt_hands(p_receipt_id uuid,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE prior smarter_private.f06_mixed_aborts; actual jsonb; item jsonb; t uuid; g uuid;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role'
 OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_receipt_id IS NULL OR p_expected->>'kind' IS DISTINCT FROM 'retained_mtt_interruption_v1' THEN
 RAISE EXCEPTION 'F06_RETAINED_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 IF p_expected ? 'retired_origin_id' AND (p_expected->>'retired_origin_id')::uuid IS DISTINCT FROM p_receipt_id THEN RAISE EXCEPTION 'F06_RETIRED_OPERATION_CHANGED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:'||p_receipt_id::text,0));
 SELECT * INTO prior FROM smarter_private.f06_mixed_aborts WHERE receipt_id=p_receipt_id;
 IF FOUND THEN
 IF prior.expected IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_ABORT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 ELSE
 actual:=smarter_private.f06_retained_mtt_abort_snapshot(p_expected);
 IF actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_ABORT_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 t:=(actual->>'tournament_id')::uuid; g:=(actual->>'generation')::uuid; item:=actual#>'{hands,0}';
 INSERT INTO smarter_private.f06_mixed_aborts(receipt_id,tournament_id,expected) VALUES(p_receipt_id,t,actual);
 INSERT INTO smarter_private.f06_mixed_abort_generations(tournament_id,generation,receipt_id) VALUES(t,g,p_receipt_id);
 INSERT INTO smarter_private.f06_mixed_abort_hands
 (permit_id,receipt_id,tournament_id,generation,table_id,hand_number,snapshot_id,break_id,prior_hand_id,expected)
 VALUES((item#>>'{permit,permit_id}')::uuid,p_receipt_id,t,g,(item#>>'{permit,table_id}')::uuid,
 (item#>>'{permit,hand_number}')::bigint,(item->>'snapshot_id')::uuid,NULL,(item#>>'{prior,atomic_hand_id}')::uuid,item);
 UPDATE smarter_private.f06_hand_permits SET state='aborted_unsettled',evidence_id=p_receipt_id
 WHERE permit_id=(item#>>'{permit,permit_id}')::uuid;
 UPDATE public.hand_state_snapshots SET is_complete=true WHERE id=(item->>'snapshot_id')::uuid AND NOT is_complete;
 -- Preserve the original lease and EVERY mixed row. Subsequent custody receipt
 -- preparation must read this exact terminal proof before ordinary lease claim.
 END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',p_receipt_id,
 'hands',1,'credit',0,'lease_preserved',true);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_f06_prepare_mixed_manager_custody(p_transfer_id uuid,p_tournament_id uuid,
 p_origin_generation uuid,p_successor_generation uuid,p_local jsonb,p_expected jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE retired_origin boolean:=false; l public.engine_tournament_leases; canonical jsonb; receipt jsonb; prior smarter_private.f06_manager_custody_transfers; checkpoint jsonb; maintenance jsonb; leader jsonb; instant timestamptz:=clock_timestamp();
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
 PERFORM smarter_private.f06_retired_origin_lock(p_tournament_id);
 SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND AND checkpoint IS NOT NULL AND EXISTS(SELECT 1 FROM smarter_private.f06_retired_manager_origins WHERE tournament_id=p_tournament_id AND origin_generation=p_origin_generation) THEN retired_origin:=true;
 ELSE
 IF NOT FOUND OR l.protocol_version<>2 OR l.lease_generation IS DISTINCT FROM p_origin_generation
 OR l.heartbeat_at IS NULL OR NOT isfinite(l.heartbeat_at)
 OR l.heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN RAISE EXCEPTION 'F06_MIXED_OLD_LEASE_CHANGED'; END IF;
 IF checkpoint IS NOT NULL AND (l.instance_id IS DISTINCT FROM checkpoint->>'instance_id' OR l.engine_version IS DISTINCT FROM left(checkpoint->>'source',8)) THEN RAISE EXCEPTION 'F06_MIXED_OLD_PROCESS_CHANGED'; END IF;
 END IF;
 canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,p_origin_generation,p_local);
 IF retired_origin THEN PERFORM smarter_private.f06_retired_origin_transfer(p_tournament_id,p_origin_generation,p_local,canonical); END IF;
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
CREATE OR REPLACE FUNCTION public.fn_f06_mixed_custody_contract() RETURNS jsonb
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
 ('public.fn_f06_attest_retired_manager_origin(uuid,jsonb,jsonb)'),
 ('smarter_private.f06_retired_origin_cohort(uuid)'),
 ('smarter_private.f06_retired_origin_lock(uuid)'),
 ('smarter_private.f06_retired_origin_begin(jsonb)'),
 ('smarter_private.f06_retired_origin_snapshot(jsonb)'),
 ('smarter_private.f06_retired_origin_disposition(jsonb)'),
 ('smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb)'),
 ('smarter_private.f06_retired_origin_claim_guard()'),
 ('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)'),
 ('public.fn_f06_abort_retained_mtt_hands(uuid,jsonb)'),
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
COMMIT;
