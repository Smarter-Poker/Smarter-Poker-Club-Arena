-- Unknown old banks remain recorded; one ordinary Lifetime session is materialized only by original completion.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $pins$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_mixed_bank_proof(uuid,jsonb)') AND md5(prosrc)='5600dda463cd9eb331333dd16f708031' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DEPENDENCY_DRIFT: smarter_private.f06_mixed_bank_proof'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)') AND md5(prosrc)='884dcaa75ea8fe389f4e228ab5f811d2' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DEPENDENCY_DRIFT: smarter_private.f06_mixed_custody_snapshot'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)') AND md5(prosrc)='568665a1a07652dd2aad09dbd3a3d7f1' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DEPENDENCY_DRIFT: public.fn_f06_prepare_mixed_manager_custody'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_mixed_adopt_presence(uuid,jsonb)') AND md5(prosrc)='14ef74fe205a1b4164d9ba90b496f95b' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DEPENDENCY_DRIFT: smarter_private.f06_mixed_adopt_presence'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_f06_mixed_custody_contract()') AND md5(prosrc)='92dbd220f8746ba1e99ced05d7e5052e' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog']) THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DEPENDENCY_DRIFT: public.fn_f06_mixed_custody_contract'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_time_bank_allowance_v2(uuid[])') AND md5(prosrc)='ed579fcc91759f2d35d69dc97db74b24' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_ALLOWANCE_DRIFT'; END IF;
END $pins$;
CREATE FUNCTION smarter_private.f06_historical_bank_loss_cohort(t uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $cohort$ SELECT $data${"5a387a75-754a-416e-8fee-b85b15fc2702":{"bank_witness_sha256":"31d0faaf9c8513f306160f0b7729d6e19dd8284677506d926805dbf9cb801af3","generation":"66291622-e7d1-4816-8c33-26ff1f092446","kind":"historical_loss_normal_session_v1","occupants":[{"joined_at":"2026-09-17T17:06:16.817557+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"164f4293-d57e-42c6-bbad-242f3d11e1cd","seat_id":"5cff5b9c-d48d-4391-8ec9-7cae469f57fe","table_id":"09f5e9eb-df66-4e55-a3c8-4385d27631e2","user_id":"046718c5-474f-4108-a15c-c3a1ce1f8d61"},{"joined_at":"2026-09-18T22:09:41.227524+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"093709bf-995f-4848-bdda-da4f254a0cc9","seat_id":"df3e8f01-27ab-4973-bb90-792f82fac562","table_id":"2c621856-e728-4e8b-bf08-4c56746a8649","user_id":"23e84589-611a-44ea-99e1-c51ae7ada6c5"},{"joined_at":"2026-09-17T17:06:50.374103+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"f959c4dc-7b3d-4135-b160-c2fb11014196","seat_id":"f6564dc7-d0ec-46f9-be3d-0ededac28fe3","table_id":"2c621856-e728-4e8b-bf08-4c56746a8649","user_id":"c1b575fb-3efd-43b6-b314-353e1d300aaa"},{"joined_at":"2026-09-17T17:07:48.373927+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"358500d2-527c-4026-81d4-fc8c908b9272","seat_id":"7bbe071c-6253-4d65-bb87-8ce8103b1ce0","table_id":"49a444ac-553a-4f44-a36f-92781d10a646","user_id":"a23ca5c9-b748-482f-9b59-9db35f7aa996"},{"joined_at":"2026-09-17T17:08:04.809856+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"d767fa91-e33b-446f-8867-30eaab0c2990","seat_id":"96e5f8fa-c883-4107-b469-4d89eb050eb0","table_id":"623b526d-0901-4c59-aec5-f8e459af7a6c","user_id":"00000000-0000-0000-0000-000000000038"},{"joined_at":"2026-09-17T17:07:31.133198+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"daf13850-0e47-4dfd-adc0-da5ac09f12dc","seat_id":"933d6d7b-7d2e-455b-84f5-59432760ed9b","table_id":"6d8512e3-899d-442b-8d6c-7c57a5f4a1f1","user_id":"302ba66b-3b1e-4747-9458-84695c70f396"},{"joined_at":"2026-09-17T21:38:20.734335+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"31c012fd-4f6e-4386-a62a-e44e1ad878a7","seat_id":"1be3101b-5c33-4561-b64e-138d80609519","table_id":"815d35dd-a6d5-4469-b0aa-e386cc2145b9","user_id":"c82e74af-4101-49b0-bd0f-93755f7bb13b"},{"joined_at":"2026-09-17T23:26:34.171939+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"76c77980-c9b3-41ad-9200-896435d29e5c","seat_id":"f2169a73-3148-4f14-b438-4fe6e5b40a0c","table_id":"9bf11d84-684d-4069-916c-c7b5bb397d21","user_id":"92ecbaed-bdec-49ae-96db-90e3d61a8f7b"},{"joined_at":"2026-09-18T22:08:29.04283+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"c322a02b-5d56-4c0a-adab-8c00cda69381","seat_id":"a87d1719-c2e1-4142-98e9-0b246ed249c0","table_id":"dbd8b7ea-1a99-494f-b564-f86d412dc764","user_id":"00000000-0000-0000-0000-000000000023"},{"joined_at":"2026-09-18T22:06:46.596949+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"0ebe3f87-4988-45b6-a5a4-b026326bb608","seat_id":"c8296047-8c8b-458b-8695-e3990e920edb","table_id":"dbd8b7ea-1a99-494f-b564-f86d412dc764","user_id":"38563ca3-66a9-40bb-8053-7a698887ec93"},{"joined_at":"2026-09-18T22:10:08.554647+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"a94b8085-95f2-4e11-8f62-18d95ba47cb2","seat_id":"4276abea-759f-48e6-ac59-c8a41e8d78b7","table_id":"fcbbd2ea-6fc2-47df-8b61-b9997fcd7b16","user_id":"c7a783ee-ac19-4a86-8e26-422666281805"},{"joined_at":"2026-09-18T19:34:43.230547+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"78e9cbed-1128-439e-8336-349b19237c1a","seat_id":"e8ef0440-81c7-4d6d-8c25-d9e1951456c1","table_id":"fcbbd2ea-6fc2-47df-8b61-b9997fcd7b16","user_id":"cb50fee0-a87b-4ac8-a6fe-8e665c5ddd8c"}],"pending_arrivals":[{"amendment_id":"770b2444-2b8d-4f66-8138-d76adeed833f","atomic_hand_id":"e18787c7-10a9-4435-85f3-31eaf95526d0","break_id":"3ebe59ce-4a7c-4290-960f-2843d7aebd71","destination_seat_number":2,"destination_table_id":"09f5e9eb-df66-4e55-a3c8-4385d27631e2","hand_number":12114088,"joined_at":"2026-09-17T17:07:20.624929+00:00","kind":"pending_arrival_historical_loss_v1","last_durable_seconds":40,"last_durable_uses":2,"lifecycle":283892,"occupancy_id":"f45e6d45-f041-4318-bd78-e5e066a77e17","origin_generation":"14e79c70-5590-47a4-bb9e-928bb8bd123a","payload_hash":"0af5bc2c83acb25b7c36054b30f6bd0a9af3db6c6bbbc8da8f45a415c29f430b","post_commit_payload_hash":"8469adc20e2069d06dde4f35624461f88aa829cde49773ab8ee58791c94329ba","post_commit_request_hash":"b297208a812da14e5791a8fc5a45ee34b7235fd7acf1fb1e9366bbb3f1d1ebf8","predecessor":"04a81643-7124-41e9-9a76-6111e627c288","request_id":"48b9a0f7-e40e-4163-845e-1a5244a2dac2","seat_id":"093766ff-7108-4a69-a36f-189039af1a93","seat_number":4,"settlement_id":"8b4e4676-e9b2-44c1-8c35-8aa87be96308","stack":45000,"stack_hand_id":"911ceac9-72ab-68bb-405a-82f0e523fc1a","table_id":"66b1cb1d-5056-41c1-a951-1bd078f8276f","user_id":"6688345d-e7be-49bd-a318-4ee1e6b10253"}],"receipt_id":"7d0f56e9-10ce-4c2f-b337-101b75924257"},"615783bf-15e3-40b7-9368-75f21b6ac53b":{"bank_witness_sha256":"31d0faaf9c8513f306160f0b7729d6e19dd8284677506d926805dbf9cb801af3","generation":"b3d06bad-c464-4be8-9e1b-66f7191375ff","kind":"historical_loss_normal_session_v1","occupants":[{"joined_at":"2026-09-17T22:06:23.33465+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"61f4d574-eed6-4487-a4c8-a771ca326eb2","seat_id":"19e141a8-bbc4-4864-a1e7-d5e46a66723c","table_id":"383aa2c7-79f1-4937-9d7e-8c49126fce8b","user_id":"46887b99-8cd6-45db-861c-ad24232efbfe"},{"joined_at":"2026-09-17T22:06:22.513736+00:00","last_durable_seconds":20,"last_durable_uses":1,"occupancy_id":"f7056064-b637-47a1-8386-1da512a7d1f0","seat_id":"e52388d6-d007-4e31-bafe-aefbe3bf3e40","table_id":"5973d7f6-5a52-4d78-aa92-cba86e19d4ea","user_id":"374d0e7a-aef5-4d09-a2f2-5d4a18568d97"},{"joined_at":"2026-09-17T22:06:36.220363+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"a08137de-c7b2-4268-b3ca-7f1720bca0a5","seat_id":"0180cd98-024b-4406-8529-2ef52fc3c217","table_id":"737b1a84-da46-459c-b0e3-bba5b23171c0","user_id":"1d81eaa9-42bc-4815-9616-01ad6e6d5800"},{"joined_at":"2026-09-17T22:06:38.780641+00:00","last_durable_seconds":20,"last_durable_uses":1,"occupancy_id":"0eba0337-1825-4969-95ca-ff2260319e5a","seat_id":"4a597dfc-98a2-4503-9913-c10f9349aa33","table_id":"9e18dc43-a81a-4a4f-a360-4f624c60699b","user_id":"3a94c68d-2dd2-40b0-afea-96a238b505f2"},{"joined_at":"2026-09-18T19:48:57.356759+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"a0f25a76-732c-42d5-ab0c-f96d404428dc","seat_id":"0d1d3c90-5b3d-4f48-9b45-6e4881a4d359","table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","user_id":"44f1ff92-b5de-44c5-9f7b-319318ff2a74"},{"joined_at":"2026-09-18T22:12:31.939388+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"9eab6eee-7abb-404a-8b22-2747896c3123","seat_id":"fd4646b0-d531-424c-85ac-f34baae5ac90","table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","user_id":"ae0bc48d-f98c-4b25-a9fa-e3522f986173"},{"joined_at":"2026-09-18T22:12:19.599699+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"292af3a4-995f-4fc9-8852-55d340cdddbe","seat_id":"a77f5c0e-36c2-4d5e-9078-32350e36652c","table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","user_id":"c49b2414-97ff-461c-8c20-3c05fe09809b"},{"joined_at":"2026-09-18T22:10:36.076555+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"af606bd2-8d9d-4692-8e61-ed3b2f1b8bf1","seat_id":"17f5edbc-6f65-4a92-87d9-994096f38a3a","table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","user_id":"cb35cc6f-3150-48ce-b7dc-887b6aca8327"},{"joined_at":"2026-09-18T22:10:36.511105+00:00","last_durable_seconds":40,"last_durable_uses":2,"occupancy_id":"f137a187-d1c6-41ec-bbe1-8518e702a5ca","seat_id":"535d19b3-b732-4d32-b614-f0f4bca07965","table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","user_id":"f8c8eb13-14a0-4478-8771-7d29e71036ca"},{"joined_at":"2026-09-17T22:07:06.763072+00:00","last_durable_seconds":120,"last_durable_uses":6,"occupancy_id":"dcc84998-a924-4bd7-89f0-f9359caba8d1","seat_id":"f24cd458-be8d-43a6-9375-926524072f5f","table_id":"9fdd5393-6fd9-4497-85b2-f98b89cf168d","user_id":"f740e628-9097-47cf-91fc-95bbee245792"},{"joined_at":"2026-09-17T22:07:07.255289+00:00","last_durable_seconds":20,"last_durable_uses":1,"occupancy_id":"14955bd2-a8e9-4425-8b15-cb9829f48d11","seat_id":"afb40353-6310-4f3e-8275-754bc26439e5","table_id":"d6199e5e-7c40-4560-afd9-f1a135031097","user_id":"fdf075f5-e450-4099-a043-691377b0ae64"}],"pending_arrivals":[],"receipt_id":"16268739-c7c3-4d38-8a8f-e8f08ac0591b"}}$data$::jsonb->t::text $cohort$;
REVOKE ALL ON FUNCTION smarter_private.f06_historical_bank_loss_cohort(uuid) FROM PUBLIC,anon,authenticated,service_role;
-- This is a named disposition of unknown historical values, never evidence of
-- an old native park. The normal session is first materialized at completion.
CREATE FUNCTION smarter_private.f06_historical_loss_bank_proof(t uuid,engine jsonb,durable jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE scope jsonb:=smarter_private.f06_historical_bank_loss_cohort(t);
 origin jsonb:=smarter_private.f06_retired_origin_cohort(t);
 marker jsonb:=engine#>'{bank_custody,historical_loss}'; item jsonb; allowance jsonb;
 banks jsonb:='{}'; roster jsonb:='[]'; observations jsonb:='[]'; seat public.table_seats;
BEGIN
 IF scope IS NULL OR marker IS DISTINCT FROM scope-ARRAY['occupants','pending_arrivals']
 OR origin->'engines'->>(engine->>'table_id') IS DISTINCT FROM engine->>'engine_id'
 OR engine#>'{bank_custody,stopped_capture}' IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_retired_manager_origins r
 WHERE r.receipt_id=(scope->>'receipt_id')::uuid AND r.tournament_id=t
 AND r.origin_generation=(scope->>'generation')::uuid)
 OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_aborts a
 JOIN smarter_private.f06_mixed_abort_hands h USING(receipt_id,tournament_id)
 JOIN smarter_private.f06_hand_permits p ON p.permit_id=h.permit_id
 WHERE a.receipt_id=(scope->>'receipt_id')::uuid AND a.tournament_id=t
 AND a.outcome='aborted_unsettled' AND a.expected->>'kind'='retained_mtt_interruption_v1'
 AND h.generation=(scope->>'generation')::uuid
 AND p.permit_id=(origin#>>'{permit,permit_id}')::uuid AND p.state='aborted_unsettled'
 AND p.evidence_id=a.receipt_id)
 THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_ORIGINAL_UNPROVEN'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(scope->'occupants') x
 WHERE x->>'table_id'=engine->>'table_id' ORDER BY x->>'user_id' LOOP
 SELECT * INTO seat FROM public.table_seats s WHERE s.id=(item->>'seat_id')::uuid;
 IF NOT FOUND OR (seat.table_id,seat.user_id,seat.occupancy_id,seat.joined_at) IS DISTINCT FROM
 ((item->>'table_id')::uuid,(item->>'user_id')::uuid,(item->>'occupancy_id')::uuid,(item->>'joined_at')::timestamptz)
 THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_OCCUPANCY_CHANGED'; END IF;
 -- Native time-bank consumers use this same user lane. Refuse inversion or
 -- unavailable evidence instead of waiting behind a differently ordered owner.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('time_bank:'||seat.user_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HISTORICAL_LOSS_ALLOWANCE_BUSY' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.profiles WHERE id=seat.user_id FOR UPDATE NOWAIT;
 SELECT to_jsonb(a) INTO allowance FROM public.fn_time_bank_allowance_v2(ARRAY[seat.user_id]) a;
 IF allowance IS NULL OR allowance->>'user_id' IS DISTINCT FROM seat.user_id::text
 OR allowance->'is_vip' IS DISTINCT FROM 'true'::jsonb
 OR allowance->'is_lifetime' IS DISTINCT FROM 'true'::jsonb
 OR allowance->'unlimited_activations' IS DISTINCT FROM 'true'::jsonb
 OR allowance->'vip_seconds_remaining' IS DISTINCT FROM 'null'::jsonb
 OR allowance->'purchased_seconds' IS DISTINCT FROM '0'::jsonb
 OR allowance->'extra_seconds' IS DISTINCT FROM '0'::jsonb
 THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_ALLOWANCE_UNPROVEN'; END IF;
 banks:=banks||jsonb_build_object(seat.user_id::text,jsonb_build_object(
 'occupancyId',seat.occupancy_id,'remainingSeconds',40,'usesRemaining',2,
 'initialSeconds',40,'baseSeconds',40,'dbConsumedSeconds',0,'unlimitedActivations',true));
 roster:=roster||jsonb_build_array(jsonb_build_array(seat.user_id,seat.occupancy_id,seat.seat_number,seat.stack));
 observations:=observations||jsonb_build_array(jsonb_build_object('original',item,'allowance',allowance));
 END LOOP;
 RETURN jsonb_build_object('table_id',engine->>'table_id','custody',engine->'bank_custody',
 'historical_loss',jsonb_build_object('disposition',marker,'old_final_balance','unknown',
 'old_debit_outcomes','retained_not_replayed','initialization','ordinary_lifetime_session',
 'observations',observations),'source_roster',roster,
 'presence',jsonb_build_object('table_id',engine->>'table_id','parked_at',NULL,
 'disconnect_states','{}'::jsonb,'time_bank_snapshot',jsonb_build_object('version',1,
 'handNumber',engine#>'{bank_custody,hand_number}','players',banks,
 'initializationKind','historical_loss_normal_session_v1','originalReceiptId',scope->>'receipt_id')));
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_historical_loss_bank_proof(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.f06_historical_loss_snapshot(t uuid,g uuid,local_proof jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE scope jsonb:=smarter_private.f06_historical_bank_loss_cohort(t); item jsonb;
 proof jsonb; plans jsonb:='[]'; actual jsonb; expected jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(local_proof->'engines') e
 WHERE e#>'{bank_custody,historical_loss}' IS NOT NULL) THEN RETURN NULL; END IF;
 IF scope IS NULL OR scope->>'generation' IS DISTINCT FROM g::text
 OR local_proof#>>'{release_checkpoint,kind}' IS DISTINCT FROM 'legacy_engine_checkpoint_8825_v1'
 OR local_proof#>>'{release_checkpoint,source}' IS DISTINCT FROM '8825af51817f379c4261658ca29ecc9d8d81932d'
 OR (SELECT jsonb_object_agg(e->>'table_id',e->'engine_id') FROM jsonb_array_elements(local_proof->'engines') e)
 IS DISTINCT FROM smarter_private.f06_retired_origin_cohort(t)->'engines'
 THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_WHOLE_OWNER_REQUIRED'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_array(s.table_id,s.id,s.user_id,s.occupancy_id,s.joined_at)
 ORDER BY s.id),'[]') INTO actual FROM public.table_seats s
 WHERE s.left_at IS NULL AND s.user_id IS NOT NULL AND s.stack>0 AND s.table_id IN
 (SELECT (e->>'table_id')::uuid FROM jsonb_array_elements(local_proof->'engines') e);
 SELECT jsonb_agg(jsonb_build_array((e->>'table_id')::uuid,(e->>'seat_id')::uuid,
 (e->>'user_id')::uuid,(e->>'occupancy_id')::uuid,(e->>'joined_at')::timestamptz)
 ORDER BY e->>'seat_id') INTO expected FROM jsonb_array_elements(scope->'occupants') e;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_COHORT_CHANGED'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(local_proof->'engines') ORDER BY value->>'table_id' LOOP
 IF item#>'{bank_custody,historical_loss}' IS DISTINCT FROM scope-ARRAY['occupants','pending_arrivals'] THEN
 RAISE EXCEPTION 'F06_HISTORICAL_LOSS_WHOLE_OWNER_REQUIRED'; END IF;
 proof:=smarter_private.f06_mixed_bank_proof(t,item);
 plans:=plans||jsonb_build_array(jsonb_build_object('table_id',item->>'table_id',
 'disposition',proof->'historical_loss','normal_session',proof#>'{presence,time_bank_snapshot,players}'));
 END LOOP;
 RETURN jsonb_build_object('kind','historical_loss_normal_session_v1','original_receipt_id',scope->>'receipt_id','plans',plans,'pending_arrivals',smarter_private.f06_historical_loss_pending(t,local_proof,false));
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_historical_loss_snapshot(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- This source is a separately identified old pending move, not an invented
-- stopped engine. The complete physical absence attestation comes from the
-- same pinned legacy checkpoint and is sealed with the transfer.
CREATE FUNCTION smarter_private.f06_historical_loss_pending(t uuid,local_proof jsonb,completing boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE scope jsonb:=smarter_private.f06_historical_bank_loss_cohort(t); item jsonb; captured jsonb;
 result jsonb:='[]'; o smarter_private.f06_operations; a smarter_private.f06_attempts;
 old smarter_private.f06_attempts; seat public.table_seats; atomic public.hand_atomic_commits;
 allowance jsonb; bank jsonb; durable jsonb; proof jsonb; submitted jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(local_proof->'engines') e WHERE e#>'{bank_custody,historical_loss}' IS NOT NULL) THEN RETURN result; END IF;
 IF local_proof#>>'{release_checkpoint,source}' IS DISTINCT FROM '8825af51817f379c4261658ca29ecc9d8d81932d'
 OR jsonb_typeof(local_proof->'historical_loss_pending_arrivals') IS DISTINCT FROM 'array'
 OR jsonb_array_length(local_proof->'historical_loss_pending_arrivals')<>jsonb_array_length(scope->'pending_arrivals') THEN
 RAISE EXCEPTION 'F06_HISTORICAL_PENDING_SCOPE_CHANGED'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(scope->'pending_arrivals') LOOP
 SELECT e INTO captured FROM jsonb_array_elements(local_proof->'historical_loss_pending_arrivals') e WHERE e->'original'=item;
 IF captured IS NULL OR captured#>>'{absence,kind}' IS DISTINCT FROM 'all_current_engine_maps_absent_v1'
 OR captured#>>'{absence,source}' IS DISTINCT FROM local_proof#>>'{release_checkpoint,source}'
 OR captured#>>'{absence,instance_id}' IS DISTINCT FROM local_proof#>>'{release_checkpoint,instance_id}'
 OR captured#>>'{absence,table_id}' IS DISTINCT FROM item->>'table_id'
 OR captured#>'{absence,global_absent}' IS DISTINCT FROM 'true'::jsonb
 OR captured#>'{absence,owned_absent}' IS DISTINCT FROM 'true'::jsonb
 OR captured#>'{absence,retirement_absent}' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(captured#>'{absence,managers}') IS DISTINCT FROM 'array'
 OR jsonb_array_length(captured#>'{absence,managers}')<2
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(captured#>'{absence,managers}') m WHERE m->'absent' IS DISTINCT FROM 'true'::jsonb OR (m->>'manager_id')::uuid IS NULL)
 OR EXISTS(SELECT 1 FROM public.engine_table_leases WHERE table_id=(item->>'table_id')::uuid)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=(item->>'table_id')::uuid)
 THEN RAISE EXCEPTION 'F06_HISTORICAL_PENDING_ABSENCE_UNPROVEN'; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=(item->>'break_id')::uuid;
 SELECT * INTO a FROM smarter_private.f06_attempts WHERE request_id=(item->>'request_id')::uuid;
 SELECT * INTO old FROM smarter_private.f06_attempts WHERE request_id=(item->>'predecessor')::uuid;
 IF (o.tournament_id,o.source_table_id,o.lifecycle,o.origin_generation) IS DISTINCT FROM
 (t,(item->>'table_id')::uuid,(item->>'lifecycle')::bigint,(item->>'origin_generation')::uuid)
 OR o.state IS DISTINCT FROM (CASE WHEN completing THEN 'acknowledged' ELSE 'begun' END)
 OR (a.break_id,a.user_id,a.predecessor,a.amendment_id,a.destination_table_id,a.destination_seat_number,a.generation) IS DISTINCT FROM
 (o.break_id,(item->>'user_id')::uuid,old.request_id,(item->>'amendment_id')::uuid,(item->>'destination_table_id')::uuid,(item->>'destination_seat_number')::integer,(scope->>'generation')::uuid)
 OR a.state IS DISTINCT FROM (CASE WHEN completing THEN 'winner' ELSE 'active' END) OR old.state IS DISTINCT FROM 'fenced'
 OR (old.break_id,old.user_id,old.generation) IS DISTINCT FROM (o.break_id,a.user_id,o.origin_generation)
 OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id AND m.user_id=a.user_id
 AND m.source_seat_id=(item->>'seat_id')::uuid AND m.occupancy_id=(item->>'occupancy_id')::uuid AND m.source_seat_number=(item->>'seat_number')::integer)
 THEN RAISE EXCEPTION 'F06_HISTORICAL_PENDING_OPERATION_CHANGED'; END IF;
 SELECT * INTO seat FROM public.table_seats WHERE id=(item->>'seat_id')::uuid;
 IF (seat.table_id,seat.user_id,seat.occupancy_id,seat.joined_at,seat.seat_number) IS DISTINCT FROM
 ((item->>'table_id')::uuid,a.user_id,(item->>'occupancy_id')::uuid,(item->>'joined_at')::timestamptz,(item->>'seat_number')::integer)
 OR (NOT completing AND (seat.left_at IS NOT NULL OR seat.stack IS DISTINCT FROM (item->>'stack')::numeric)) THEN
 RAISE EXCEPTION 'F06_HISTORICAL_PENDING_OCCUPANCY_CHANGED'; END IF;
 SELECT * INTO atomic FROM public.hand_atomic_commits WHERE hand_id=(item->>'atomic_hand_id')::uuid FOR SHARE;
 submitted:=atomic.post_commit_payload-'accepted_hand_facts';
 IF jsonb_typeof(submitted->'pending_addons')='object' THEN submitted:=submitted#-'{pending_addons,ids}'; END IF;
 IF (SELECT count(*) FROM public.hand_atomic_commits WHERE table_id=seat.table_id AND hand_number=(item->>'hand_number')::bigint)<>1
 OR (SELECT count(*) FROM public.hand_history WHERE id=atomic.hand_id AND table_id=atomic.table_id AND hand_number=atomic.hand_number)<>1
 OR (SELECT count(*) FROM public.hand_history WHERE table_id=atomic.table_id AND hand_number=atomic.hand_number)<>1
 OR atomic.payload_hash IS DISTINCT FROM item->>'payload_hash'
 OR atomic.post_commit_payload_hash IS DISTINCT FROM item->>'post_commit_payload_hash'
 OR atomic.post_commit_request_hash IS DISTINCT FROM item->>'post_commit_request_hash'
 OR encode(extensions.digest(convert_to(atomic.post_commit_payload::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM atomic.post_commit_payload_hash
 OR encode(extensions.digest(convert_to(submitted::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM atomic.post_commit_request_hash
 OR atomic.post_commit_payload->>'version' IS DISTINCT FROM '1'
 OR jsonb_typeof(atomic.post_commit_payload->'accepted_hand_facts') IS DISTINCT FROM 'object'
 OR atomic.stack_result->'success' IS DISTINCT FROM 'true'::jsonb
 OR atomic.stack_result->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
 OR atomic.stack_result->'tournament_players_synced' IS DISTINCT FROM 'true'::jsonb
 OR atomic.stack_result->>'hand_id' IS DISTINCT FROM item->>'stack_hand_id'
 OR atomic.stack_result->>'table_id' IS DISTINCT FROM seat.table_id::text
 OR atomic.stack_result->>'tournament_id' IS DISTINCT FROM t::text
 OR (atomic.stack_result->>'hand_number')::bigint IS DISTINCT FROM atomic.hand_number
 OR (atomic.stack_result#>>ARRAY['written',seat.user_id::text])::numeric IS DISTINCT FROM (item->>'stack')::numeric
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(atomic.stack_result#>'{request,stacks}') s
 WHERE s->>'user_id'=seat.user_id::text AND s->>'seat_id'=seat.id::text AND (s->>'seat_joined_at')::timestamptz=seat.joined_at AND (s->>'stack')::numeric=(item->>'stack')::numeric)
 OR NOT EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=seat.table_id AND k.hand_id=(item->>'stack_hand_id')::uuid
 AND k.status='succeeded' AND k.error IS NULL AND k.completed_at IS NOT NULL AND isfinite(k.completed_at) AND k.result=atomic.stack_result)
 OR (SELECT count(*) FROM public.ca_settlements f WHERE f.table_id=seat.table_id AND f.hand_id=(item->>'stack_hand_id')::uuid)<>1
 OR NOT EXISTS(SELECT 1 FROM public.ca_settlements f WHERE f.id=(item->>'settlement_id')::uuid AND f.table_id=seat.table_id AND f.hand_id=(item->>'stack_hand_id')::uuid
 AND f.state='final' AND f.settlement_type='hand_stacks' AND f.error_detail IS NULL)
 OR atomic.table_id IS DISTINCT FROM seat.table_id OR atomic.hand_number IS DISTINCT FROM (item->>'hand_number')::bigint
 OR atomic.post_commit_completed_at IS NULL OR NOT isfinite(atomic.post_commit_completed_at)
 OR atomic.post_commit_completed_at<atomic.committed_at OR atomic.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR atomic.post_commit_result->>'hand_id' IS DISTINCT FROM atomic.hand_id::text
 OR (atomic.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM atomic.hand_number
 OR (SELECT count(*) FROM jsonb_array_elements(atomic.post_commit_payload->'time_banks') b WHERE b->>'user_id'=seat.user_id::text)<>1
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(atomic.post_commit_payload->'time_banks') b WHERE
 (b->>'user_id',b->>'seat_id',(b->>'seat_joined_at')::timestamptz,(b->>'seconds_remaining')::integer,(b->>'uses_remaining')::integer) IS NOT DISTINCT FROM
 (seat.user_id::text,seat.id::text,seat.joined_at,(item->>'last_durable_seconds')::integer,(item->>'last_durable_uses')::integer))
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=seat.table_id AND hand_number>atomic.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=seat.table_id AND hand_number>atomic.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=seat.table_id AND hand_number>atomic.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=seat.table_id AND hand_number>atomic.hand_number)
 THEN RAISE EXCEPTION 'F06_HISTORICAL_PENDING_BANK_WITNESS_CHANGED'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('time_bank:'||seat.user_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HISTORICAL_LOSS_ALLOWANCE_BUSY' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.profiles WHERE id=seat.user_id FOR UPDATE NOWAIT;
 SELECT to_jsonb(v) INTO allowance FROM public.fn_time_bank_allowance_v2(ARRAY[seat.user_id]) v;
 IF allowance IS NULL OR allowance->>'user_id' IS DISTINCT FROM seat.user_id::text
 OR allowance->'is_vip' IS DISTINCT FROM 'true'::jsonb OR allowance->'is_lifetime' IS DISTINCT FROM 'true'::jsonb
 OR allowance->'unlimited_activations' IS DISTINCT FROM 'true'::jsonb OR allowance->'vip_seconds_remaining' IS DISTINCT FROM 'null'::jsonb
 OR allowance->'purchased_seconds' IS DISTINCT FROM '0'::jsonb OR allowance->'extra_seconds' IS DISTINCT FROM '0'::jsonb
 THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_ALLOWANCE_UNPROVEN'; END IF;
 SELECT to_jsonb(p) INTO durable FROM public.engine_presence_parked p WHERE table_id=seat.table_id FOR SHARE;
 IF COALESCE(durable,'null'::jsonb) IS DISTINCT FROM captured->'durable_presence' THEN RAISE EXCEPTION 'F06_HISTORICAL_PENDING_PRESENCE_CHANGED'; END IF;
 bank:=jsonb_build_object('occupancyId',seat.occupancy_id,'remainingSeconds',40,'usesRemaining',2,
 'initialSeconds',40,'baseSeconds',40,'dbConsumedSeconds',0,'unlimitedActivations',true);
 proof:=jsonb_build_object('disposition',scope-ARRAY['occupants','pending_arrivals'],'old_final_balance','unknown',
 'old_debit_outcomes','retained_not_replayed','initialization','ordinary_lifetime_session',
 'observations',jsonb_build_array(jsonb_build_object('original',item,'allowance',allowance)),
 'original_kind','pending_arrival_historical_loss_v1','accepted_bank_commit',to_jsonb(atomic));
 result:=result||jsonb_build_array(jsonb_build_object('source',jsonb_build_object('table_id',seat.table_id,
 'bank_custody',jsonb_build_object('historical_loss',scope-ARRAY['occupants','pending_arrivals'])),
 'proof',jsonb_build_object('historical_loss',proof,'source_roster',jsonb_build_array(jsonb_build_array(seat.user_id,seat.occupancy_id,seat.seat_number,seat.stack)),
 'presence',jsonb_build_object('parked_at',NULL,'disconnect_states','{}'::jsonb,'time_bank_snapshot',jsonb_build_object('players',jsonb_build_object(seat.user_id::text,bank))))));
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_historical_loss_pending(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_bank_proof(t uuid,engine jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE custody jsonb:=engine->'bank_custody'; durable jsonb; banks jsonb; x jsonb; bank jsonb; key text; value jsonb; captured jsonb;
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
 IF custody ? 'historical_loss' THEN
 RETURN smarter_private.f06_historical_loss_bank_proof(t,engine,durable);
 END IF;
 -- Prior parked evidence remains a CAS input. A new runtime may additionally
 -- retain the actual values it captured before disposal, in this immutable
 -- transfer itself. This is never an inferred replacement for legacy data.
 IF custody ? 'stopped_capture' THEN
 captured:=custody->'stopped_capture';
 IF captured->>'kind' IS DISTINCT FROM 'mtt_pre_disposal_bank_v1'
 OR captured->>'table_id' IS DISTINCT FROM engine->>'table_id'
 OR captured->>'engine_id' IS DISTINCT FROM engine->>'engine_id'
 OR captured->>'tournament_id' IS DISTINCT FROM t::text
 OR captured->>'lifecycle' IS DISTINCT FROM engine->>'lifecycle'
 OR (captured->>'generation')::uuid IS NULL
 OR captured->>'accounting' IS DISTINCT FROM 'acknowledged'
 OR jsonb_typeof(captured->'snapshot') IS DISTINCT FROM 'object'
 OR captured#>>'{snapshot,table_id}' IS DISTINCT FROM engine->>'table_id'
 OR jsonb_typeof(captured#>'{snapshot,disconnect_states}') IS DISTINCT FROM 'object'
 OR captured#>>'{snapshot,time_bank_snapshot,version}' IS DISTINCT FROM '1'
 OR captured#>>'{snapshot,time_bank_snapshot,handNumber}' IS DISTINCT FROM custody->>'hand_number'
 OR captured#>>'{snapshot,parked_at}' IS NULL
 OR NOT isfinite((captured#>>'{snapshot,parked_at}')::timestamptz)
 OR captured#>>'{snapshot,time_bank_snapshot,parkedAt}' IS DISTINCT FROM captured#>>'{snapshot,parked_at}'
 OR captured#>'{snapshot,time_bank_snapshot,players}' IS DISTINCT FROM custody->'parked_time_banks'
 THEN RAISE EXCEPTION 'F06_STOPPED_BANK_CAPTURE_UNPROVEN'; END IF;
 durable:=captured->'snapshot';
 END IF;
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
 RETURN jsonb_build_object('table_id',engine->>'table_id','custody',custody,'presence',durable);
END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_custody_snapshot(t uuid,g uuid,local_proof jsonb) RETURNS jsonb
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
 IF x->>'allocation_epoch' IS NOT NULL AND x->'permit'='null'::jsonb AND (x->>'lifecycle' IS NULL OR NOT (x->'bank_custody' ? 'stopped_capture')) THEN
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
 IF x#>'{bank_custody,stopped_capture}' IS NOT NULL THEN
 b:=x#>'{bank_custody,stopped_capture}';
 IF local_proof#>>'{stopped_bank_owner,kind}' IS DISTINCT FROM 'mtt_pre_disposal_bank_v1'
 OR local_proof#>>'{stopped_bank_owner,tournament_id}' IS DISTINCT FROM t::text
 OR local_proof#>>'{stopped_bank_owner,generation}' IS DISTINCT FROM g::text
 OR b->>'generation' IS DISTINCT FROM g::text
 OR COALESCE(local_proof#>>'{stopped_bank_owner,instance_id}','')=''
 OR COALESCE(local_proof#>>'{stopped_bank_owner,version}','') !~ '^[0-9a-f]{8}$'
 OR local_proof#>>'{stopped_bank_owner,version}'='8825af51'
 OR (x#>>'{bank_custody,hand_number}')::bigint IS DISTINCT FROM GREATEST(
 COALESCE((SELECT max(hand_number) FROM public.hand_history WHERE table_id=(x->>'table_id')::uuid),0),
 COALESCE((SELECT max(hand_number) FROM smarter_private.f06_hand_permits WHERE table_id=(x->>'table_id')::uuid),0))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(x#>'{bank_custody,roster}') occupant WHERE NOT EXISTS(
 SELECT 1 FROM public.table_seats seat WHERE seat.table_id=(x->>'table_id')::uuid AND seat.user_id=(occupant->>0)::uuid
 AND seat.occupancy_id=(occupant->>1)::uuid AND seat.seat_number=(occupant->>2)::integer))
 THEN RAISE EXCEPTION 'F06_STOPPED_BANK_ORIGINAL_CHANGED'; END IF;
 END IF;
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
 WHERE e->>'break_id'=o.break_id::text AND e->>'table_id'=o.source_table_id::text AND engine->>'lifecycle'=o.lifecycle::text) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(smarter_private.f06_historical_loss_pending(t,local_proof,false)) hp WHERE hp#>>'{source,table_id}'=o.source_table_id::text AND hp#>>'{proof,historical_loss,observations,0,original,break_id}'=o.break_id::text)) THEN
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
 value:=smarter_private.f06_historical_loss_snapshot(t,g,local_proof);
 IF value IS NOT NULL THEN result:=result||jsonb_build_object('historical_loss',value); END IF;
 RETURN result;
END $$;
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
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_local->'engines') e WHERE e#>'{bank_custody,stopped_capture}' IS NOT NULL) THEN
 IF retired_origin OR p_local#>>'{stopped_bank_owner,instance_id}' IS DISTINCT FROM l.instance_id
 OR p_local#>>'{stopped_bank_owner,version}' IS DISTINCT FROM l.engine_version
 THEN RAISE EXCEPTION 'F06_STOPPED_BANK_OWNER_CHANGED'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_local->'engines') e WHERE e#>'{bank_custody,historical_loss}' IS NOT NULL) AND (NOT retired_origin OR checkpoint IS NULL) THEN
 RAISE EXCEPTION 'F06_HISTORICAL_LOSS_RETIRED_CHECKPOINT_REQUIRED'; END IF;
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
CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_adopt_presence(t uuid,local_proof jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE bank_proof jsonb; historical boolean; engine jsonb; custody jsonb; durable jsonb; banks jsonb; fsm jsonb; user_key text; original_stay uuid;
 target public.table_seats; bank jsonb; presence jsonb; targets jsonb:='{}'; item jsonb; table_key text;
 hand bigint; at_time timestamptz:=clock_timestamp(); receipt jsonb; receipts jsonb:='[]'; n integer;
BEGIN
 FOR item IN SELECT jsonb_build_object('source',e,'proof',smarter_private.f06_mixed_bank_proof(t,e)) FROM jsonb_array_elements(local_proof->'engines') e UNION ALL SELECT value FROM jsonb_array_elements(smarter_private.f06_historical_loss_pending(t,local_proof,true)) LOOP
 engine:=item->'source';
 bank_proof:=item->'proof';
 durable:=bank_proof->'presence'; custody:=engine->'bank_custody';
 historical:=bank_proof ? 'historical_loss';
 IF historical THEN
 -- Only this new normal session uses a completion timestamp. The original raw
 -- custody remains in the immutable transfer; it is never labelled preserved.
 custody:=jsonb_set(custody,'{roster}',bank_proof->'source_roster');
 durable:=jsonb_set(durable,'{parked_at}',to_jsonb(at_time));
 END IF;
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
 IF historical THEN
 item:=item||jsonb_build_object('initializationKind','historical_loss_normal_session_v1',
 'originalReceiptId',engine#>>'{bank_custody,historical_loss,receipt_id}');
 END IF;
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
 'source_occupancy',original_stay,'destination_table',target.table_id,'destination_occupancy',target.occupancy_id,'move_receipt',receipt,'bank',bank,'presence',presence)||CASE WHEN historical THEN jsonb_build_object('historical_loss',bank_proof->'historical_loss') ELSE '{}'::jsonb END);
 END LOOP;
 END LOOP;
 FOR table_key,item IN SELECT * FROM jsonb_each(targets) ORDER BY key LOOP
 IF item->>'initializationKind'='historical_loss_normal_session_v1' AND EXISTS(
 SELECT 1 FROM public.table_seats seat WHERE seat.table_id=table_key::uuid AND seat.left_at IS NULL AND seat.stack>0
 AND (item#>ARRAY['banks',seat.user_id::text] IS NULL OR item#>>ARRAY['banks',seat.user_id::text,'occupancyId'] IS DISTINCT FROM seat.occupancy_id::text))
 THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DESTINATION_CUSTODY_MISSING'; END IF;
 SELECT COALESCE(max(hand_number),0) INTO hand FROM public.hand_history WHERE table_id=table_key::uuid;
 INSERT INTO public.engine_presence_parked(table_id,disconnect_states,parked_at,engine_instance,time_bank_snapshot)
 VALUES(table_key::uuid,item->'presence',(item->>'parked_at')::timestamptz,'f06_mixed_custody',jsonb_build_object('version',1,'parkedAt',item->'parked_at','handNumber',hand,'players',item->'banks')||CASE WHEN item ? 'initializationKind' THEN jsonb_build_object('initializationKind',item->>'initializationKind','originalReceiptId',item->>'originalReceiptId') ELSE '{}'::jsonb END)
 ON CONFLICT(table_id) DO UPDATE SET disconnect_states=EXCLUDED.disconnect_states,parked_at=EXCLUDED.parked_at,
 engine_instance=EXCLUDED.engine_instance,time_bank_snapshot=EXCLUDED.time_bank_snapshot;
 END LOOP;
 RETURN receipts;
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
 ('smarter_private.f06_historical_bank_loss_cohort(uuid)'),
 ('smarter_private.f06_historical_loss_bank_proof(uuid,jsonb,jsonb)'),
 ('smarter_private.f06_historical_loss_snapshot(uuid,uuid,jsonb)'),
 ('smarter_private.f06_historical_loss_pending(uuid,jsonb,boolean)'),
 ('public.fn_time_bank_allowance_v2(uuid[])'),
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
