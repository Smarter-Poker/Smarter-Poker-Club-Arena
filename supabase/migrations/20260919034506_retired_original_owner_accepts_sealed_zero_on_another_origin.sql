-- The original owner stopped every cohort engine. A sealed zero on another
-- original table classifies that player only; it never eliminates or pays them.
-- Keep the generic retained snapshot's selected-table rule unchanged.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $pins$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_retired_origin_snapshot(jsonb)')
 AND md5(prosrc)='5e64168fd92de18b7794f8d5ccb7cabf' AND proowner='postgres'::regrole AND prosecdef
 AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
THEN RAISE EXCEPTION 'F06_RETIRED_ZERO_DEPENDENCY_DRIFT'; END IF;
END $pins$;
CREATE OR REPLACE FUNCTION smarter_private.f06_retired_origin_snapshot(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_input->>'tournament_id')::uuid; g uuid:=(p_input->>'generation')::uuid;
 h smarter_private.f06_hand_permits; lease public.engine_tournament_leases;
 event public.tournaments; snap public.hand_state_snapshots; a public.hand_atomic_commits;
 zero_key public.settlement_idempotency_keys; zero_settlement public.ca_settlements;
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
 OR reg.chips IS DISTINCT FROM 0
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=reg.table_id AND tournament_id=t)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(physical->'engines') e WHERE e->>'table_id'=reg.table_id::text)
 OR oldseat.id IS NULL OR (oldseat.user_id,oldseat.table_id,oldseat.seat_number)
 IS DISTINCT FROM (reg.user_id,reg.table_id,reg.seat_number)
 OR oldseat.left_at IS NULL OR oldseat.occupancy_id IS NULL OR oldseat.joined_at IS NULL
 OR a.hand_id IS NULL OR a.table_id IS DISTINCT FROM reg.table_id
 OR (reg.table_id=h.table_id AND a.hand_number>=h.hand_number)
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
 OR a.stack_result->>'table_id' IS DISTINCT FROM reg.table_id::text
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
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits later WHERE later.table_id=ANY(ids)
 AND (later.committed_at>a.committed_at OR (later.table_id=a.table_id AND later.hand_number>a.hand_number))
 AND later.stack_result->'written' ? reg.user_id::text) THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 -- The target-table financial scan cannot certify another original table.
 -- Lock and retain this accepted hand's independent succeeded key and exactly
 -- one final stack settlement. No amount, rank, occupancy or move is changed.
 SELECT * INTO zero_key FROM public.settlement_idempotency_keys
 WHERE table_id=a.table_id AND hand_id=(r->>'stack_hand_id')::uuid FOR SHARE;
 PERFORM 1 FROM public.ca_settlements
 WHERE table_id=a.table_id AND hand_id=(r->>'stack_hand_id')::uuid ORDER BY id FOR SHARE;
 SELECT * INTO zero_settlement FROM public.ca_settlements
 WHERE table_id=a.table_id AND hand_id=(r->>'stack_hand_id')::uuid;
 IF zero_key.hand_id IS NULL OR zero_key.status IS DISTINCT FROM 'succeeded'
 OR zero_key.result IS DISTINCT FROM a.stack_result OR zero_key.error IS NOT NULL
 OR zero_key.completed_at IS NULL OR NOT isfinite(zero_key.completed_at)
 OR (SELECT count(*) FROM public.ca_settlements
 WHERE table_id=a.table_id AND hand_id=(r->>'stack_hand_id')::uuid)<>1
 OR zero_settlement.settlement_type IS DISTINCT FROM 'hand_stacks'
 OR zero_settlement.state IS DISTINCT FROM 'final' OR zero_settlement.error_detail IS NOT NULL THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED' USING ERRCODE='55000'; END IF;

 zeros:=zeros||jsonb_build_array(jsonb_build_object('registration_id',reg.id,'seat_id',oldseat.id,
 'atomic_hand_id',a.hand_id,'stack_hand_id',a.stack_result->>'hand_id','registration',to_jsonb(reg),
 'seat',to_jsonb(oldseat),'stack_key',to_jsonb(zero_key),'stack_settlement',to_jsonb(zero_settlement),'atomic_hash',md5(to_jsonb(a)::text),'history_hash',md5(to_jsonb(history)::text)));
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
COMMIT;
