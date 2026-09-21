-- Preserve actual pre-disposal banks in the existing immutable owner-transfer receipt.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $pins$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_mixed_bank_proof(uuid,jsonb)') AND md5(prosrc)='a22bf6241dba96e747c0aca01a504899' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_STOPPED_BANK_DEPENDENCY_DRIFT: smarter_private.f06_mixed_bank_proof'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)') AND md5(prosrc)='882162fbb2ebaa3eaf2a0a6e567e9824' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_STOPPED_BANK_DEPENDENCY_DRIFT: smarter_private.f06_mixed_custody_snapshot'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)') AND md5(prosrc)='af89bc29c2d839e950f678fedad1ad75' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_STOPPED_BANK_DEPENDENCY_DRIFT: public.fn_f06_prepare_mixed_manager_custody'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_mixed_adopt_presence(uuid,jsonb)') AND md5(prosrc)='9dab70e0012b7550c7d8378df998f09a' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_STOPPED_BANK_DEPENDENCY_DRIFT: smarter_private.f06_mixed_adopt_presence'; END IF;
END $pins$;
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
DECLARE engine jsonb; custody jsonb; durable jsonb; banks jsonb; fsm jsonb; user_key text; original_stay uuid;
 target public.table_seats; bank jsonb; presence jsonb; targets jsonb:='{}'; item jsonb; table_key text;
 hand bigint; at_time timestamptz:=clock_timestamp(); receipt jsonb; receipts jsonb:='[]'; n integer;
BEGIN
 FOR engine IN SELECT * FROM jsonb_array_elements(local_proof->'engines') LOOP
 durable:=smarter_private.f06_mixed_bank_proof(t,engine)->'presence';
 custody:=engine->'bank_custody';
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
COMMIT;
