-- 20260924225647_an_epoch_that_never_reserved_a_hand_is_witnessed_by_its_abse.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- AN EPOCH THAT NEVER RESERVED A HAND IS WITNESSED BY ITS ABSENCE (2026-09-24).
--
-- Run 36068474418 (the 21:36 UTC recovery window) was the first engine release
-- since smarter_private.f06_mixed_custody_snapshot was written to reach it: the
-- legacy checkpoint cleared every capture refusal, every row proof, the
-- previous-work join, wrote and read back 62 tables, proved 11 dead
-- generations' rows, and sent fn_f06_prepare_mixed_manager_custody for the
-- first retained 8825 manager. The database answered
--
--   F06_MIXED_ALLOCATION_WITNESS_UNPROVEN
--   PL/pgSQL function f06_mixed_custody_snapshot(uuid,uuid,jsonb) line 42 at RAISE
--
-- Line 42 witnesses an allocation-backed engine (an allocator epoch, no local
-- permit) from the f06_hand_permits rows reserved under that epoch, on the
-- premise that "historical allocator custody is the native witness after a
-- permit clears". That premise has a second case it did not name. An engine
-- holds exactly one allocator epoch for its life (installF06Allocator refuses
-- a second, TournamentManagerBase.ts:1600 on 8825af51: custodyId :=
-- randomUUID() at admission), and every hand it deals reserves a permit under
-- that epoch. An epoch with NO permit row is therefore an engine that dealt
-- nothing in this generation - a table admitted and left waiting for players.
-- The retained managers hold exactly those: tournament 5a387a75 (the $100
-- Freeroll) carries, read from the rows, seven waiting single-seat tables
-- (09f5e9eb, 49a444ac, 623b526d, 66b1cb1d, 6d8512e3, 815d35dd, 9bf11d84) with
-- no permit under generation 66291622 beside the three tables that dealt
-- (2c621856, dbd8b7ea, fcbbd2ea). Nothing was ever allocated under those seven
-- epochs, so nothing is transferred from them, and refusing the whole transfer
-- for them keeps the wedge behind the wedge (CLAUDE.md 10.86 rule 4).
--
-- The absent case is now witnessed by its absence, under the same locks:
--   - no permit row under (tournament, generation, table, epoch)  [the case]
--   - no reserved permit anywhere on the table (a hand in the air is never
--     absent; F06_MIXED_ORIGINAL_OMITTED would refuse it too, one loop later)
--   - the table's own f06_lifecycle is the witnessed lifecycle, which this
--     engine never moved, and a lifecycle the caller asserts that differs from
--     it still refuses exactly as before
-- and the engine_lifecycles entry carries permits=[] and witness=
-- 'never_reserved' so the caller (the legacy checkpoint guard) can hold it to
-- that shape and nothing else. Every engine that DID reserve is witnessed
-- exactly as before, now marked witness='permits'.
--
-- The contract pins (engine-release-database-proof.py MIXED_CUSTODY_CONTRACT and
-- tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json) are
-- moved to the new body_md5/definition_md5 in the same commit.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $pins$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)') AND md5(prosrc)='4e678c1f3d06edf6538ce5365e1b643b' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_NEVER_RESERVED_WITNESS_DEPENDENCY_DRIFT: smarter_private.f06_mixed_custody_snapshot'; END IF;
END $pins$;
CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_custody_snapshot(t uuid,g uuid,local_proof jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE ids uuid[]; users uuid[]; u uuid; x jsonb; b jsonb; r record; result jsonb:='{}'; value jsonb; original_row smarter_private.f06_hand_permits; witness jsonb; original_evidence jsonb:='[]'; pending jsonb:='[]'; lifecycles jsonb:='[]'; witnesses jsonb; witnessed_lifecycle text; witness_kind text;
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
 IF witnesses IS NULL THEN
 -- AN EPOCH THAT NEVER RESERVED A HAND IS WITNESSED BY ITS ABSENCE (2026-09-24).
 -- An engine holds exactly one allocator epoch for its life (installF06Allocator
 -- refuses a second), and every hand it deals reserves a permit under that
 -- epoch. So an epoch with no permit row is an engine that dealt NOTHING in this
 -- generation: a table admitted and left waiting for players. The rule above
 -- assumed a cleared permit always preceded an absent one, and refused the whole
 -- transfer for a waiting table (run 36068474418, the 21:36 recovery window,
 -- the first release to reach this function since it was written). Nothing was
 -- ever allocated under this epoch, so nothing is transferred from it; its
 -- lifecycle is the table's own, which this engine never moved. Still refused:
 -- a reserved hand anywhere on the table (a hand in the air is never absent),
 -- and a lifecycle the caller asserts that the table does not carry.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.table_id=(x->>'table_id')::uuid AND h.state='reserved')
 THEN RAISE EXCEPTION 'F06_MIXED_ALLOCATION_WITNESS_UNPROVEN'; END IF;
 SELECT f06_lifecycle::text INTO witnessed_lifecycle FROM public.tables WHERE id=(x->>'table_id')::uuid AND tournament_id=t;
 IF witnessed_lifecycle IS NULL OR (x->>'lifecycle' IS NOT NULL AND x->>'lifecycle' IS DISTINCT FROM witnessed_lifecycle)
 THEN RAISE EXCEPTION 'F06_MIXED_ALLOCATION_WITNESS_UNPROVEN'; END IF;
 witnesses:='[]'::jsonb; witness_kind:='never_reserved';
 ELSE
 IF (SELECT count(DISTINCT h->>'lifecycle') FROM jsonb_array_elements(witnesses) h)<>1
 OR (x->>'lifecycle' IS NOT NULL AND x->>'lifecycle' IS DISTINCT FROM witnessed_lifecycle)
 THEN RAISE EXCEPTION 'F06_MIXED_ALLOCATION_WITNESS_UNPROVEN'; END IF;
 witness_kind:='permits';
 END IF;
 lifecycles:=lifecycles||jsonb_build_array(jsonb_build_object('table_id',x->>'table_id','allocation_epoch',x->>'allocation_epoch','lifecycle',witnessed_lifecycle,'permits',witnesses,'witness',witness_kind));
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
DO $verify$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)') AND md5(prosrc)='5422e7f73fdbdd34bf73d46e514e844e' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_NEVER_RESERVED_WITNESS_NOT_INSTALLED'; END IF;
END $verify$;
COMMIT;
