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
