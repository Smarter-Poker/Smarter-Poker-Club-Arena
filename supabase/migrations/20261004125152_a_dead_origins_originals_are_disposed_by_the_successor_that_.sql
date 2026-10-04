-- 20261004125152_a_dead_origins_originals_are_disposed_by_the_successor_that_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9 / 10.11 / 10.12: the reasoning is in this header. This file
-- schedules nothing and retries nothing on a timer. It moves no chip: the
-- only writes are absence records, the reviewed stranded void's misdeal
-- receipts, and (once, below) the same two doors applied to the fifteen
-- events this defect froze on 2026-10-03.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-10-04)
--
-- Fifteen RUNNING events (twelve heads-up SNG / Spin, one 6-player satellite
-- 9ff52091 "Sunday Funday Main Event Satellite", two more SNG) have dealt
-- nothing since 23:42-23:43Z on 2026-10-03. At 23:43:51-55Z, during a
-- database stall, the engine (cc4cacb6's predecessor) lost their leases and
-- prepared fifteen mixed custody transfers, each with ONE original hand in
-- the air. The process was replaced at 23:55Z before any original reached a
-- terminal disposition, and since then every resume (about 90 an hour) is
-- refused:
--
--   postgres: F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED
--   engine:   [GameServer.Tournament_resume_failed_for_t] Error:
--             f06_mixed_successor_custody_unproven (mixedF06Custody.js:122)
--   /health:  tournamentResumesFailing: 15, no lease row for any of them
--
-- Twelve originals are 'reserved' permits of the dead origin generation:
-- dealt preflop, never dispatched, never committed. Three originals
-- (9a8e68e9, fe0582bd, e8bfda49) have NO permit row at all: the origin's
-- fn_f06_begin_hand never committed (the stall). The engine itself recorded
-- each absence at 23:43:47-48Z (fn_park_stopped_time_bank_custody wrote the
-- f06_absent_permit_releases rows fn_f06_begin_hand obeys), four seconds
-- before the transfers were prepared, but the snapshot reads only permit
-- rows, so it listed those tables as pending for ever.
--
-- Only the dead origin could give either kind a terminal disposition. This
-- is the fourth time the class has frozen events (2026-09-26 x71, 09-28,
-- 10-01 x2, now x15); each time an operator migration called
-- fn_f06_void_stranded_mixed_original by hand. Nothing in the live path ever
-- did, so every engine replacement during a stall strands events again.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- 1. smarter_private.f06_mixed_custody_snapshot: an original whose permit
--    row does not exist is witnessed by its f06_absent_permit_releases row
--    (the absence record fn_park_stopped_time_bank_custody already writes and
--    fn_f06_begin_hand already obeys). Without one it stays pending, exactly
--    as before. One ELSIF; every other line is byte-identical (asserted).
--
-- 2. public.fn_f06_void_stranded_mixed_original: an original whose permit
--    never reached the database counts toward the original set once its
--    absence is recorded for the origin. One comparison; asserted.
--
-- 3. smarter_private.f06_dispose_dead_origin(transfer): under the event's
--    lane, with no lease but the successor's, records the absence of every
--    original whose permit never reached the database (refusing if anything
--    of that hand or a later one exists on the table), then runs the
--    reviewed stranded void if any original is still reserved. Idempotent.
--
-- 4. public.fn_f06_dispose_dead_origin_originals(t, g, transfer): the same,
--    asked by the SUCCESSOR itself from its durable admission
--    (GameServer.performTournamentManagerAdmission, before
--    admitMixedF06Transfer), gated by f06_authority(t, g): service_role, the
--    tournament-manager actor, and a live protocol-2 lease at exactly the
--    transfer's successor generation. The origin generation is fenced by
--    that lease, so nothing it holds can reach a commit; a process that
--    still holds the original engines in memory (a drained packet) never
--    takes this branch and recovers them itself as before.
--
-- 5. Once: the fifteen transfers above are disposed through (3).
--
-- Contract: f06_mixed_custody_snapshot is part of fn_f06_mixed_custody_contract,
-- so its new digests are carried by MIXED_CUSTODY_CONTRACT in
-- server/scripts/engine-release-database-proof.py and by
-- tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json, and the
-- shared-hand lane installs the snapshot section of this file.
--
-- Applied to production as version <recorded version> (the apply transport
-- stamps its own version; match by name, never by version).
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The snapshot (the shared-hand lane installs from here to its post-image).
DO $dead_origin_snapshot_preimage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)')
                    AND md5(p.prosrc) = '5422e7f73fdbdd34bf73d46e514e844e'
                    AND p.proowner = 'postgres'::regrole AND p.prosecdef
                    AND p.proacl::text = '{postgres=X/postgres}'
                    AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']) THEN
    RAISE EXCEPTION 'PREIMAGE: smarter_private.f06_mixed_custody_snapshot is not the 20260924225647 definition';
  END IF;
END
$dead_origin_snapshot_preimage$;

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
 ELSIF original_row.permit_id IS NULL THEN
 -- A permit that never reached the database is witnessed by its recorded
 -- absence (20261004125152): the f06_absent_permit_releases row fn_f06_begin_hand
 -- reads, so a begin that arrives later is refused for ever.
 SELECT jsonb_build_object('absent_release',to_jsonb(apr)) INTO witness FROM smarter_private.f06_absent_permit_releases apr
 WHERE (apr.permit_id,apr.tournament_id,apr.generation,apr.table_id,apr.hand_number)=
 ((b->>'permit_id')::uuid,t,g,(b->>'table_id')::uuid,(b->>'hand_number')::bigint);
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

DO $dead_origin_snapshot_postimage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)')
                    AND md5(p.prosrc) = 'c0d85cbbd162a208efe73855374e2518'
                    AND p.proowner = 'postgres'::regrole AND p.prosecdef
                    AND p.proacl::text = '{postgres=X/postgres}'
                    AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']) THEN
    RAISE EXCEPTION 'POSTIMAGE: smarter_private.f06_mixed_custody_snapshot is not the reviewed definition';
  END IF;
END
$dead_origin_snapshot_postimage$;

-- ---------------------------------------------------------------------------
-- 2. The stranded void counts a recorded absence.
DO $dead_origin_void_preimage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.fn_f06_void_stranded_mixed_original(uuid)')
                    AND md5(p.prosrc) = '92466252b142a745157d2ba69c1aa35b') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_f06_void_stranded_mixed_original is not the 20260928041447 definition';
  END IF;
  IF to_regprocedure('smarter_private.f06_dispose_dead_origin(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_f06_dispose_dead_origin_originals(uuid,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE: the dead-origin doors already exist';
  END IF;
END
$dead_origin_void_preimage$;

CREATE OR REPLACE FUNCTION public.fn_f06_void_stranded_mixed_original(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  t uuid := p_tournament_id;
  xfer smarter_private.f06_manager_custody_transfers;
  event public.tournaments;
  h smarter_private.f06_hand_permits;
  snap public.hand_state_snapshots;
  b jsonb;
  reserved_ids uuid[];
  original_ids uuid[];
  tab_ids uuid[];
  users uuid[];
  u uuid;
  n integer;
  roster jsonb;
  hands jsonb := '[]'::jsonb;
  item jsonb;
  actual jsonb;
  v_receipt uuid;
  v_snap_ids uuid[] := ARRAY[]::uuid[];
  v_before jsonb;
  v_after jsonb;
  v_busts jsonb;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'F06_STRANDED_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: stranded mixed void refused' USING ERRCODE = '55000';
  END IF;

  -- The event's own lane, taken only when it is free (never queued).
  PERFORM smarter_private.f06_try_lane(t);

  -- Exactly one custody transfer is still open, and its successor was never
  -- admitted: nobody but the dead origin ever held the hands it reserved.
  SELECT c.* INTO xfer FROM smarter_private.f06_manager_custody_transfers c
   WHERE c.tournament_id = t
     AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions d
                      WHERE d.transfer_id = c.transfer_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'F06_STRANDED_TRANSFER_REQUIRED' USING ERRCODE = '55000';
  END IF;
  v_receipt := md5('f06:stranded-mixed-original:' || xfer.transfer_id::text)::uuid;
  IF EXISTS (SELECT 1 FROM smarter_private.f06_mixed_aborts WHERE receipt_id = v_receipt) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'receipt_id', v_receipt,
                              'tournament_id', t, 'credit', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_admissions a
              WHERE a.transfer_id = xfer.transfer_id) THEN
    RAISE EXCEPTION 'F06_STRANDED_TRANSFER_ADMITTED' USING ERRCODE = '55000';
  END IF;
  IF smarter_private.f06_generation_aborted(t, xfer.origin_generation)
     OR smarter_private.f06_generation_aborted(t, xfer.successor_generation) THEN
    RAISE EXCEPTION 'F06_STRANDED_GENERATION_DISPOSED' USING ERRCODE = '55000';
  END IF;
  -- Nobody but the never-admitted successor may hold the event. The engine
  -- claims the successor generation and is refused admission until this
  -- receipt exists, so that holder has built nothing and can act on nothing
  -- (every F06 write needs the lane this transaction holds). Any other holder
  -- is retried, never raced.
  IF EXISTS (SELECT 1 FROM public.engine_tournament_leases
              WHERE tournament_id = t
                AND lease_generation IS DISTINCT FROM xfer.successor_generation) THEN
    RAISE EXCEPTION 'F06_STRANDED_EVENT_OWNED' USING ERRCODE = '40001';
  END IF;

  -- The reserved set is exactly the transfer's original hands.
  SELECT array_agg(permit_id ORDER BY permit_id) INTO reserved_ids
    FROM smarter_private.f06_hand_permits WHERE tournament_id = t AND state = 'reserved';
  SELECT array_agg((e#>>'{permit,binding,permit_id}')::uuid ORDER BY (e#>>'{permit,binding,permit_id}')::uuid)
    INTO original_ids
    FROM jsonb_array_elements(xfer.local_proof->'engines') e
   WHERE e->'permit' IS DISTINCT FROM 'null'::jsonb;
  -- Every reserved hand is one of the transfer's originals. An original that
  -- is not reserved any more reached its own positive terminal disposition
  -- after the transfer was prepared (the one legal change before admission):
  -- it was accepted by the origin generation, with the exact committed hand
  -- the successor's snapshot reads as its witness. Only the reserved hands
  -- are voided; the committed one is left exactly as it settled.
  IF reserved_ids IS NULL OR original_ids IS NULL OR NOT (reserved_ids <@ original_ids)
     OR (SELECT count(*) FROM smarter_private.f06_hand_permits o
          WHERE o.permit_id = ANY (original_ids))
        -- An original whose permit never reached the database counts once its
        -- absence is recorded for the origin (20261004125152); it has no hand.
        + (SELECT count(*) FROM smarter_private.f06_absent_permit_releases r
            WHERE r.permit_id = ANY (original_ids) AND r.tournament_id = t
              AND r.generation = xfer.origin_generation
              AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits o
                               WHERE o.permit_id = r.permit_id)) <> cardinality(original_ids)
     OR EXISTS (
          SELECT 1 FROM smarter_private.f06_hand_permits o
           WHERE o.permit_id = ANY (original_ids) AND NOT (o.permit_id = ANY (reserved_ids))
             AND NOT (o.state = 'accepted' AND o.tournament_id = t
                      AND o.generation = xfer.origin_generation
                      AND EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                                    JOIN public.hand_history hh ON hh.id = a.hand_id
                                     AND hh.table_id = a.table_id AND hh.hand_number = a.hand_number
                                   WHERE a.hand_id = o.evidence_id AND a.table_id = o.table_id
                                     AND a.hand_number = o.hand_number
                                     AND a.post_commit_completed_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'F06_STRANDED_ORIGINALS_CHANGED' USING ERRCODE = '55000';
  END IF;
  FOREACH u IN ARRAY reserved_ids LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:' || u::text, 0)) THEN
      RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE = '40001';
    END IF;
  END LOOP;
  SELECT array_agg(DISTINCT table_id ORDER BY table_id) INTO tab_ids
    FROM smarter_private.f06_hand_permits WHERE permit_id = ANY (reserved_ids);
  SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO users
    FROM public.table_seats WHERE table_id = ANY (tab_ids) AND left_at IS NULL;
  IF users IS NOT NULL THEN
    FOREACH u IN ARRAY users LOOP
      IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:' || u::text, 0)) THEN
        RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE = '40001';
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO event FROM public.tournaments WHERE id = t FOR UPDATE;
  PERFORM 1 FROM public.tournament_players WHERE tournament_id = t ORDER BY user_id FOR UPDATE;
  PERFORM 1 FROM public.tables WHERE tournament_id = t ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.table_seats WHERE table_id = ANY (tab_ids) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM smarter_private.f06_hand_permits
   WHERE permit_id = ANY (reserved_ids) ORDER BY permit_id FOR UPDATE;
  PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id = t ORDER BY break_id FOR UPDATE;

  IF event.id IS NULL OR event.status IS DISTINCT FROM 'RUNNING'
     OR event.format_contract IS NULL
     OR event.format_contract NOT IN ('mtt-v1', 'mtt-v2', 'spin-v1', 'sng-v1') THEN
    RAISE EXCEPTION 'F06_STRANDED_EVENT_NOT_RUNNING' USING ERRCODE = '55000';
  END IF;
  -- No table break of any origin is open: nothing but the hands is in the air.
  IF EXISTS (SELECT 1 FROM smarter_private.f06_operations
              WHERE tournament_id = t AND state NOT IN ('acknowledged', 'withdrawn_before_manifest')) THEN
    RAISE EXCEPTION 'F06_STRANDED_PARK_OPEN' USING ERRCODE = '55000';
  END IF;

  -- Every chip and registration of the affected tables, before.
  SELECT jsonb_build_object(
           'seats', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'user_id', s.user_id,
                              'stack', s.stack, 'left_at', s.left_at) ORDER BY s.id), '[]'::jsonb)
                       FROM public.table_seats s WHERE s.table_id = ANY (tab_ids)),
           'registrations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status,
                              'chips', p.chips, 'table_id', p.table_id, 'seat_number', p.seat_number) ORDER BY p.id), '[]'::jsonb)
                       FROM public.tournament_players p WHERE p.tournament_id = t))
    INTO v_before;

  FOR h IN SELECT * FROM smarter_private.f06_hand_permits
            WHERE permit_id = ANY (reserved_ids) ORDER BY permit_id LOOP
    SELECT e#>'{permit,binding}' INTO b FROM jsonb_array_elements(xfer.local_proof->'engines') e
     WHERE e#>>'{permit,binding,permit_id}' = h.permit_id::text;
    IF h.generation IS DISTINCT FROM xfer.origin_generation OR h.evidence_id IS NOT NULL
       OR b->>'tournament_id' IS DISTINCT FROM t::text
       OR b->>'table_id' IS DISTINCT FROM h.table_id::text
       OR b->>'hand_number' IS DISTINCT FROM h.hand_number::text
       OR b->>'lifecycle' IS DISTINCT FROM h.lifecycle::text
       OR b->>'custody_id' IS DISTINCT FROM h.custody_id::text
       OR b->>'lease_generation' IS DISTINCT FROM h.generation::text
       OR NOT EXISTS (SELECT 1 FROM public.tables tb
                       WHERE tb.id = h.table_id AND tb.tournament_id = t
                         AND NOT COALESCE(tb.is_deleted, false)
                         AND lower(COALESCE(tb.status, '')) IN ('waiting', 'running')
                         AND tb.f06_lifecycle = h.lifecycle)
       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits q
                   WHERE q.table_id = h.table_id AND q.hand_number > h.hand_number) THEN
      RAISE EXCEPTION 'F06_STRANDED_PERMIT_CHANGED' USING ERRCODE = '55000';
    END IF;
    -- The hand never reached the platform: no commit, history, private state,
    -- dispatch, submission, disposition or recorded action.
    IF EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                WHERE c.table_id = h.table_id AND c.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_history hh
                   WHERE hh.table_id = h.table_id AND hh.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_private_state hp
                   WHERE hp.table_id = h.table_id AND hp.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = h.permit_id) THEN
      RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM smarter_private.hand_submissions s
                WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number)
       OR EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispositions d
                   WHERE d.table_id = h.table_id AND d.hand_number = h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_discards z
                   WHERE z.table_id = h.table_id AND z.hand_number = h.hand_number) THEN
      RAISE EXCEPTION 'F06_STRANDED_HAND_HAS_A_SUBMISSION' USING ERRCODE = '55000';
    END IF;

    -- Every live chair is one playing registration holding the same chips,
    -- and every playing registration at this table has its live chair.
    SELECT jsonb_agg(jsonb_build_object(
             'seat_id', s.id, 'occupancy_id', s.occupancy_id, 'user_id', s.user_id,
             'seat_number', s.seat_number, 'stack', s.stack,
             'registration_id', tp.id, 'chips', tp.chips) ORDER BY s.user_id)
      INTO roster
      FROM public.table_seats s
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = t AND tp.user_id = s.user_id AND tp.table_id = s.table_id
       AND tp.seat_number = s.seat_number AND tp.status = 'playing'
     WHERE s.table_id = h.table_id AND s.left_at IS NULL;
    IF roster IS NULL
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                   WHERE r->>'registration_id' IS NULL OR r->>'stack' IS NULL
                      OR (r->>'stack')::numeric < 0
                      OR (r->>'stack')::numeric IS DISTINCT FROM (r->>'chips')::numeric)
       OR EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = t AND tp.table_id = h.table_id AND tp.status = 'playing'
                     AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                                      WHERE s.table_id = h.table_id AND s.user_id = tp.user_id
                                        AND s.seat_number = tp.seat_number AND s.left_at IS NULL)
                     -- A bust whose elimination is still pending holds nothing
                     -- (the abandoned-generation door's ruling of 2026-09-26):
                     -- zero chips, and no chair it ever had in the event is
                     -- live or holds a chip. It was not dealt into this hand
                     -- either: the snapshot must name exactly the live chairs.
                     AND NOT (tp.chips = 0
                              AND NOT EXISTS (SELECT 1 FROM public.table_seats bs
                                                JOIN public.tables bt ON bt.id = bs.table_id
                                               WHERE bt.tournament_id = t AND bs.user_id = tp.user_id
                                                 AND (bs.left_at IS NULL OR bs.stack IS DISTINCT FROM 0)))) THEN
      RAISE EXCEPTION 'F06_STRANDED_ROSTER_CHANGED' USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'registration_id', tp.id, 'user_id', tp.user_id,
             'seat_number', tp.seat_number, 'chips', tp.chips) ORDER BY tp.user_id), '[]'::jsonb)
      INTO v_busts
      FROM public.tournament_players tp
     WHERE tp.tournament_id = t AND tp.table_id = h.table_id AND tp.status = 'playing'
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                        WHERE s.table_id = h.table_id AND s.user_id = tp.user_id
                          AND s.seat_number = tp.seat_number AND s.left_at IS NULL);

    -- One open preflop snapshot, and every chair still holds exactly what it
    -- held before the deal: its snapshot stack plus everything it put in. No
    -- blind, ante or bet of this hand ever left a durable chair.
    SELECT count(*) INTO n FROM public.hand_state_snapshots s
     WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number;
    IF n <> 1 THEN
      RAISE EXCEPTION 'F06_STRANDED_SNAPSHOT_REQUIRED' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO snap FROM public.hand_state_snapshots s
     WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number FOR UPDATE;
    IF snap.is_complete IS DISTINCT FROM false
       OR snap.stage IS DISTINCT FROM 'preflop'
       OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
       OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
       OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10
       OR jsonb_array_length(snap.state_json->'players') <> jsonb_array_length(roster)
       OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)
            IS DISTINCT FROM jsonb_array_length(snap.state_json->'players')::bigint
       OR NOT COALESCE(pg_input_is_valid(snap.state_json->>'pot', 'numeric'), false)
       OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
             WHERE NOT (CASE
               WHEN COALESCE(pg_input_is_valid(x->>'user_id', 'uuid'), false)
                AND COALESCE(pg_input_is_valid(x->>'seat', 'integer'), false)
                AND COALESCE(pg_input_is_valid(x->>'stack', 'numeric'), false)
                AND COALESCE(pg_input_is_valid(x->>'totalInvested', 'numeric'), false)
                AND COALESCE(pg_input_is_valid(COALESCE(x->>'deadInvested', '0'), 'numeric'), false)
               THEN
                 (x->>'stack')::numeric >= 0
                 AND (x->>'totalInvested')::numeric >= 0
                 AND COALESCE((x->>'deadInvested')::numeric, 0) BETWEEN 0 AND (x->>'totalInvested')::numeric
                 AND (x->>'stack')::numeric::text NOT IN ('NaN', 'Infinity', '-Infinity')
                 AND (x->>'totalInvested')::numeric::text NOT IN ('NaN', 'Infinity', '-Infinity')
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                              WHERE r->>'user_id' = x->>'user_id'
                                AND (r->>'seat_number')::integer = (x->>'seat')::integer
                                AND (r->>'stack')::numeric
                                      = (x->>'stack')::numeric + (x->>'totalInvested')::numeric)
               ELSE false END))
       OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
            (SELECT sum((x->>'totalInvested')::numeric)
               FROM jsonb_array_elements(snap.state_json->'players') x) THEN
      RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE = '55000';
    END IF;
    -- Every hole card went to a live chair of this table.
    IF EXISTS (SELECT 1 FROM public.table_hole_cards c
                WHERE c.table_id = h.table_id AND c.hand_number = h.hand_number
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                                   WHERE r->>'user_id' = c.user_id::text)) THEN
      RAISE EXCEPTION 'F06_STRANDED_CARDS_CHANGED' USING ERRCODE = '55000';
    END IF;

    hands := hands || jsonb_build_array(jsonb_build_object(
      'permit', to_jsonb(h), 'ruling', 'misdeal_voided', 'shape', 'stranded_mixed_original',
      'snapshot_id', snap.id, 'snapshot_hash', md5(to_jsonb(snap)::text),
      'snapshot_created_at', snap.created_at, 'pot_returned_to_chairs', snap.state_json->'pot',
      'hole_cards', (SELECT count(*) FROM public.table_hole_cards c
                      WHERE c.table_id = h.table_id AND c.hand_number = h.hand_number),
      'binding', b, 'roster', roster, 'busts_pending_elimination', v_busts, 'break_id', NULL));
    v_snap_ids := v_snap_ids || snap.id;
  END LOOP;

  actual := jsonb_build_object(
    'kind', 'stranded_mixed_original', 'tournament_id', t, 'format_contract', event.format_contract,
    'transfer_id', xfer.transfer_id, 'origin_generation', xfer.origin_generation,
    'successor_generation', xfer.successor_generation, 'transfer_created_at', xfer.created_at,
    'hands', hands, 'credit', 0,
    'reason', 'The origin generation reserved and dealt these hands and died before any reached a commit; its successor can only be admitted once each has a terminal disposition, and only the origin could give one. Every chair already holds its pre-deal stack, so the hands are misdeals and nothing moves.');
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: stranded mixed void refused' USING ERRCODE = '55000';
  END IF;

  -- The receipt the mixed custody snapshot reads as the original's terminal
  -- disposition. Only the ORIGIN generation is disposed; the successor stays
  -- claimable, and is admitted by the engine exactly as designed.
  INSERT INTO smarter_private.f06_mixed_aborts (receipt_id, tournament_id, expected)
  VALUES (v_receipt, t, actual);
  INSERT INTO smarter_private.f06_mixed_abort_generations (tournament_id, generation, receipt_id)
  VALUES (t, xfer.origin_generation, v_receipt);
  FOR item IN SELECT value FROM jsonb_array_elements(hands) LOOP
    INSERT INTO smarter_private.f06_mixed_abort_hands
      (permit_id, receipt_id, tournament_id, generation, table_id, hand_number,
       snapshot_id, break_id, prior_hand_id, prior_abort_receipt_id, expected)
    VALUES ((item->'permit'->>'permit_id')::uuid, v_receipt, t, xfer.origin_generation,
            (item->'permit'->>'table_id')::uuid, (item->'permit'->>'hand_number')::bigint,
            (item->>'snapshot_id')::uuid, NULL, NULL, NULL, item);
  END LOOP;
  UPDATE smarter_private.f06_hand_permits SET state = 'aborted_unsettled', evidence_id = v_receipt
   WHERE permit_id = ANY (reserved_ids) AND state = 'reserved';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(reserved_ids) THEN
    RAISE EXCEPTION 'F06_STRANDED_PERMIT_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;
  UPDATE public.hand_state_snapshots SET is_complete = true
   WHERE id = ANY (v_snap_ids) AND NOT is_complete;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(v_snap_ids) THEN
    RAISE EXCEPTION 'F06_STRANDED_SNAPSHOT_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;

  -- After: nothing reserved, the origin disposed and the successor not, every
  -- original carries the evidence the successor's admission reads, and not
  -- one chip or registration moved.
  SELECT jsonb_build_object(
           'seats', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'user_id', s.user_id,
                              'stack', s.stack, 'left_at', s.left_at) ORDER BY s.id), '[]'::jsonb)
                       FROM public.table_seats s WHERE s.table_id = ANY (tab_ids)),
           'registrations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status,
                              'chips', p.chips, 'table_id', p.table_id, 'seat_number', p.seat_number) ORDER BY p.id), '[]'::jsonb)
                       FROM public.tournament_players p WHERE p.tournament_id = t))
    INTO v_after;
  IF v_after IS DISTINCT FROM v_before
     OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id = t AND state = 'reserved')
     OR NOT smarter_private.f06_generation_aborted(t, xfer.origin_generation)
     OR smarter_private.f06_generation_aborted(t, xfer.successor_generation)
     OR EXISTS (
          SELECT 1 FROM smarter_private.f06_hand_permits o
           WHERE o.permit_id = ANY (reserved_ids)
             AND NOT EXISTS (
               SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
                 JOIN smarter_private.f06_mixed_aborts c USING (receipt_id, tournament_id)
                WHERE (a.permit_id, a.receipt_id, a.tournament_id, a.generation, a.table_id, a.hand_number)
                      = (o.permit_id, o.evidence_id, o.tournament_id, o.generation, o.table_id, o.hand_number)
                  AND o.state = 'aborted_unsettled' AND c.outcome = 'aborted_unsettled'
                  AND a.expected->'permit' = (to_jsonb(o) || jsonb_build_object('state', 'reserved', 'evidence_id', NULL)))) THEN
    RAISE EXCEPTION 'F06_STRANDED_POSTIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'aborted_unsettled', 'receipt_id', v_receipt,
    'tournament_id', t, 'transfer_id', xfer.transfer_id, 'origin_generation', xfer.origin_generation,
    'successor_generation', xfer.successor_generation, 'hands_voided', cardinality(reserved_ids),
    'credit', 0);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_f06_void_stranded_mixed_original(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3 and 4. The doors.
CREATE OR REPLACE FUNCTION smarter_private.f06_dispose_dead_origin(p_transfer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  xfer smarter_private.f06_manager_custody_transfers;
  e jsonb;
  b jsonb;
  pid uuid;
  tab uuid;
  hn bigint;
  custody bigint;
  rel smarter_private.f06_absent_permit_releases;
  released integer := 0;
  v_void jsonb := NULL;
BEGIN
  SELECT * INTO xfer FROM smarter_private.f06_manager_custody_transfers WHERE transfer_id = p_transfer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F06_DEAD_ORIGIN_TRANSFER_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- The event's own lane, taken only when it is free (never queued). It is
  -- the lane fn_f06_begin_hand shares, so no begin of any generation is in
  -- flight while absence is read below.
  PERFORM smarter_private.f06_try_lane(xfer.tournament_id);

  IF EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_admissions a
              WHERE a.transfer_id = xfer.transfer_id) THEN
    RETURN jsonb_build_object('ok', true, 'transfer_id', xfer.transfer_id,
      'tournament_id', xfer.tournament_id, 'admitted', true, 'absent_released', 0, 'void', NULL);
  END IF;
  -- Nobody but the never-admitted successor may hold the event: the origin
  -- generation is fenced, so nothing it reserved or dealt can reach a commit.
  IF EXISTS (SELECT 1 FROM public.engine_tournament_leases
              WHERE tournament_id = xfer.tournament_id
                AND lease_generation IS DISTINCT FROM xfer.successor_generation) THEN
    RAISE EXCEPTION 'F06_STRANDED_EVENT_OWNED' USING ERRCODE = '40001';
  END IF;

  -- An original whose permit never reached the database: its begin either
  -- never ran or timed out and rolled back. Record the absence the way
  -- fn_park_stopped_time_bank_custody does, so fn_f06_begin_hand refuses that
  -- permit for ever and the successor's snapshot reads it as the original's
  -- terminal disposition.
  FOR e IN SELECT value FROM jsonb_array_elements(xfer.local_proof->'engines')
            WHERE value->'permit' IS DISTINCT FROM 'null'::jsonb LOOP
    b := e#>'{permit,binding}';
    pid := (b->>'permit_id')::uuid;
    tab := (b->>'table_id')::uuid;
    hn := (b->>'hand_number')::bigint;
    CONTINUE WHEN EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.permit_id = pid);
    SELECT * INTO rel FROM smarter_private.f06_absent_permit_releases r WHERE r.permit_id = pid;
    IF FOUND THEN
      IF (rel.tournament_id, rel.generation, rel.table_id, rel.hand_number)
         IS DISTINCT FROM (xfer.tournament_id, xfer.origin_generation, tab, hn) THEN
        RAISE EXCEPTION 'F06_DEAD_ORIGIN_ABSENCE_CHANGED' USING ERRCODE = '55000';
      END IF;
      CONTINUE;
    END IF;
    IF pid IS NULL OR tab IS NULL OR hn IS NULL OR hn < 1
       OR b->>'tournament_id' IS DISTINCT FROM xfer.tournament_id::text
       OR b->>'lease_generation' IS DISTINCT FROM xfer.origin_generation::text
       OR NOT EXISTS (SELECT 1 FROM public.tables tb
                       WHERE tb.id = tab AND tb.tournament_id = xfer.tournament_id) THEN
      RAISE EXCEPTION 'F06_DEAD_ORIGIN_BINDING_INVALID' USING ERRCODE = '22023';
    END IF;
    -- No start witness of this hand, or of any later hand, on the table.
    IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.table_id = tab AND h.hand_number >= hn)
       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = pid)
       OR EXISTS (SELECT 1 FROM public.hand_atomic_commits h WHERE h.table_id = tab AND h.hand_number >= hn)
       OR EXISTS (SELECT 1 FROM public.hand_history h WHERE h.table_id = tab AND h.hand_number >= hn)
       OR EXISTS (SELECT 1 FROM public.hand_state_snapshots h WHERE h.table_id = tab AND h.hand_number >= hn)
       OR EXISTS (SELECT 1 FROM public.hand_private_state h WHERE h.table_id = tab AND h.hand_number >= hn)
       OR EXISTS (SELECT 1 FROM public.table_hole_cards h WHERE h.table_id = tab AND h.hand_number >= hn) THEN
      RAISE EXCEPTION 'F06_DEAD_ORIGIN_HAND_STARTED' USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(max(h.hand_number), 0) INTO custody
      FROM public.hand_history h WHERE h.table_id = tab AND h.hand_number < hn;
    INSERT INTO smarter_private.f06_absent_permit_releases
      (permit_id, tournament_id, generation, table_id, hand_number, custody_hand_number)
    VALUES (pid, xfer.tournament_id, xfer.origin_generation, tab, hn, custody);
    released := released + 1;
  END LOOP;

  -- An original the origin reserved and dealt but never committed: the
  -- reviewed stranded void proves every chair holds its pre-deal stack and
  -- disposes the origin generation only. Not asked when nothing is reserved
  -- (an original accepted after the prepare is already terminal).
  IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h
              WHERE h.tournament_id = xfer.tournament_id AND h.state = 'reserved'
                AND h.permit_id::text IN (SELECT x#>>'{permit,binding,permit_id}'
                                            FROM jsonb_array_elements(xfer.local_proof->'engines') x)) THEN
    v_void := public.fn_f06_void_stranded_mixed_original(xfer.tournament_id);
  END IF;

  RETURN jsonb_build_object('ok', true, 'transfer_id', xfer.transfer_id,
    'tournament_id', xfer.tournament_id, 'admitted', false,
    'absent_released', released, 'void', v_void);
END
$function$;

REVOKE ALL ON FUNCTION smarter_private.f06_dispose_dead_origin(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_f06_dispose_dead_origin_originals(
  p_tournament_id uuid, p_lease_generation uuid, p_transfer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  xfer smarter_private.f06_manager_custody_transfers;
  r jsonb;
BEGIN
  -- The caller is the tournament manager holding a LIVE protocol-2 lease for
  -- this event at exactly the transfer's successor generation.
  PERFORM smarter_private.f06_authority(p_tournament_id, p_lease_generation);
  SELECT * INTO xfer FROM smarter_private.f06_manager_custody_transfers
   WHERE transfer_id = p_transfer_id;
  IF NOT FOUND OR xfer.tournament_id IS DISTINCT FROM p_tournament_id
     OR xfer.successor_generation IS DISTINCT FROM p_lease_generation THEN
    RAISE EXCEPTION 'F06_MIXED_SUCCESSOR_CHANGED' USING ERRCODE = '55000';
  END IF;
  r := smarter_private.f06_dispose_dead_origin(p_transfer_id);
  PERFORM smarter_private.f06_authority(p_tournament_id, p_lease_generation, false);
  RETURN r;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_f06_dispose_dead_origin_originals(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_dispose_dead_origin_originals(uuid, uuid, uuid)
  TO service_role;

DO $dead_origin_postimage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.fn_f06_void_stranded_mixed_original(uuid)'::regprocedure
                    AND md5(p.prosrc) = 'f9a4e4187953347b613ac505d9828127'
                    AND p.proowner = 'postgres'::regrole AND p.prosecdef
                    AND p.proacl::text = '{postgres=X/postgres}') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_f06_void_stranded_mixed_original is not the reviewed definition';
  END IF;
  IF has_function_privilege('anon', 'public.fn_f06_dispose_dead_origin_originals(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_f06_dispose_dead_origin_originals(uuid,uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_f06_dispose_dead_origin_originals(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'smarter_private.f06_dispose_dead_origin(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'smarter_private.f06_dispose_dead_origin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTIMAGE: the dead-origin doors carry the wrong privileges';
  END IF;
END
$dead_origin_postimage$;

-- ---------------------------------------------------------------------------
-- 5. Once: the fifteen events frozen since 2026-10-03 23:43Z. A transfer that
-- was admitted or no longer exists is skipped. A busy lane (40001) is asked
-- again briefly; anything else aborts the whole file.
DO $dead_origin_once$
DECLARE
  x uuid;
  r jsonb;
  tries integer;
  done jsonb := '[]'::jsonb;
BEGIN
  FOR x IN SELECT c.transfer_id FROM smarter_private.f06_manager_custody_transfers c
            WHERE c.transfer_id = ANY (ARRAY[
    '08d9062a-3d12-438a-bc3e-c78daf0b3585', 'b06932a8-b8ef-40ae-a00c-d4394fbadb47', 'ff283fa1-d483-4018-af13-ef3bed58c8d2',
    'b18319ac-e649-49e0-8eb2-54293f7f5cda', '91d9da90-98b8-451f-9608-e0ad267f11ad', 'f75dd0ab-f1e1-4bc5-8de3-7e29cdd40a4b',
    '7348355c-b472-4ee7-9f48-3462091454eb', '449163b9-c402-44fb-8d5d-e392987f72a0', 'd33be3fd-86a2-4cd0-b120-a79f85ea63ff',
    'ad01b863-1792-4f39-93f9-8749b21d618e', 'fdfab309-e6d3-4905-840c-b46558656b9f', 'a974ce77-c87d-4913-90b3-4e1754c6a146',
    '188f51eb-9758-4abf-84e0-ae9f2b9b3b2e', 'ed015f6f-6491-434e-8a35-6dc2d5e6c414', '5ead7028-302b-42e9-b54a-94aa5e61c563'
                  ]::uuid[])
              AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_admissions a
                               WHERE a.transfer_id = c.transfer_id)
            ORDER BY c.created_at, c.transfer_id LOOP
    tries := 0;
    LOOP
      BEGIN
        r := smarter_private.f06_dispose_dead_origin(x);
        EXIT;
      EXCEPTION WHEN SQLSTATE '40001' THEN
        tries := tries + 1;
        IF tries >= 40 THEN RAISE; END IF;
        PERFORM pg_sleep(0.05);
      END;
    END LOOP;
    done := done || jsonb_build_array(jsonb_build_object('transfer_id', x,
      'absent_released', r->'absent_released', 'hands_voided', r#>'{void,hands_voided}'));
  END LOOP;
  RAISE NOTICE 'dead-origin disposal: %', done;
END
$dead_origin_once$;

COMMIT;
