-- Mixed original generations share one event disposition, never per-table generation receipts.
CREATE TABLE smarter_private.f06_mixed_aborts(
 receipt_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, expected jsonb NOT NULL,
 outcome text NOT NULL DEFAULT 'aborted_unsettled' CHECK(outcome='aborted_unsettled'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(receipt_id,tournament_id));
CREATE TABLE smarter_private.f06_mixed_abort_generations(
 tournament_id uuid NOT NULL, generation uuid NOT NULL, receipt_id uuid NOT NULL,
 PRIMARY KEY(tournament_id,generation), UNIQUE(receipt_id,tournament_id,generation),
 FOREIGN KEY(receipt_id,tournament_id) REFERENCES smarter_private.f06_mixed_aborts(receipt_id,tournament_id));
CREATE TABLE smarter_private.f06_mixed_abort_hands(
 permit_id uuid PRIMARY KEY, receipt_id uuid NOT NULL, tournament_id uuid NOT NULL,
 generation uuid NOT NULL, table_id uuid NOT NULL, hand_number bigint NOT NULL,
 snapshot_id uuid, break_id uuid UNIQUE, prior_hand_id uuid, prior_abort_receipt_id uuid, expected jsonb NOT NULL,
 CHECK((snapshot_id IS NOT NULL)::integer+(prior_hand_id IS NOT NULL)::integer+(prior_abort_receipt_id IS NOT NULL)::integer=1), UNIQUE(table_id,hand_number),
 FOREIGN KEY(receipt_id,tournament_id,generation) REFERENCES smarter_private.f06_mixed_abort_generations(receipt_id,tournament_id,generation));
ALTER TABLE smarter_private.f06_mixed_aborts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_mixed_abort_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_mixed_abort_hands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_mixed_aborts,smarter_private.f06_mixed_abort_generations,
 smarter_private.f06_mixed_abort_hands FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_mixed_receipt_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_mixed_aborts
 FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER f06_mixed_generations_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_mixed_abort_generations
 FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER f06_mixed_hands_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_mixed_abort_hands
 FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();

-- Called only while the owning mixed RPC holds the event/hand/player/seat lanes.
-- This proves a retained stack boundary, NOT whether the later hand started.
CREATE FUNCTION smarter_private.f06_prior_committed_stacks(p_permit uuid,p_expected jsonb,p_roster jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE h smarter_private.f06_hand_permits; a public.hand_atomic_commits; history public.hand_history;
 s jsonb; r jsonb; payload jsonb; submitted jsonb; actual jsonb; n integer;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit;
 IF NOT FOUND OR h.state<>'reserved' OR h.evidence_id IS NOT NULL
 OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR jsonb_typeof(p_roster) IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_IDENTITY' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=h.table_id
 AND hand_number=(p_expected->>'hand_number')::bigint FOR SHARE;
 IF NOT FOUND OR a.hand_number>=h.hand_number OR a.hand_id IS DISTINCT FROM (p_expected->>'atomic_hand_id')::uuid
 OR a.payload_hash !~ '^[0-9a-f]{64}$' OR a.payload_hash IS NULL
 OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at)
 OR a.post_commit_completed_at<a.committed_at
 OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 SELECT * INTO history FROM public.hand_history WHERE id=a.hand_id AND table_id=a.table_id AND hand_number=a.hand_number FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id
 AND (hand_number>a.hand_number OR committed_at>a.committed_at))
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number>a.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id AND hand_number>a.hand_number)
 -- Completed historical snapshots do not establish accepted settlement or no-start.
 -- Only active custody must be absent; use the existing live-table partial index.
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND NOT is_complete) THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_NOT_LAST_BOUNDARY' USING ERRCODE='55000'; END IF;
 payload:=a.post_commit_payload;
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload->>'version' IS DISTINCT FROM '1'
 OR jsonb_typeof(payload->'accepted_hand_facts') IS DISTINCT FROM 'object'
 OR encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_payload_hash THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 submitted:=payload-'accepted_hand_facts';
 IF jsonb_typeof(submitted->'pending_addons')='object' THEN
 IF jsonb_typeof(submitted#>'{pending_addons,ids}') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 submitted:=submitted#-'{pending_addons,ids}'; END IF;
 IF encode(extensions.digest(convert_to(submitted::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_request_hash THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 s:=a.stack_result; n:=jsonb_array_length(p_roster);
 IF s->'success' IS DISTINCT FROM 'true'::jsonb OR s->>'mode' IS DISTINCT FROM 'delta'
 OR s->>'table_id' IS DISTINCT FROM h.table_id::text OR s->>'tournament_id' IS DISTINCT FROM h.tournament_id::text
 OR (s->>'hand_number')::bigint IS DISTINCT FROM a.hand_number
 -- The stack receipt and canonical atomic receipt have different identity domains.
 OR NULLIF(s->>'hand_id','') IS NULL OR s->>'hand_id' IS DISTINCT FROM p_expected->>'stack_hand_id'
 OR s->'conservation_checked' IS DISTINCT FROM 'true'::jsonb OR s->'tournament_players_synced' IS DISTINCT FROM 'true'::jsonb
 OR s->'rebased' IS DISTINCT FROM '{}'::jsonb OR s->'departed' IS DISTINCT FROM '[]'::jsonb
 OR (s->>'players')::integer IS DISTINCT FROM n OR (s->>'tournament_player_count')::integer IS DISTINCT FROM n
 OR (s->>'net_deltas')::numeric IS DISTINCT FROM 0 OR (s->>'inflow')::numeric IS DISTINCT FROM 0
 OR (s->>'rake')::numeric IS DISTINCT FROM 0 OR (s->>'bbj')::numeric IS DISTINCT FROM 0
 OR jsonb_typeof(s#>'{request,stacks}') IS DISTINCT FROM 'array'
 OR jsonb_typeof(s->'written') IS DISTINCT FROM 'object'
 OR jsonb_typeof(s->'tournament_player_chips') IS DISTINCT FROM 'array'
 OR jsonb_array_length(s#>'{request,stacks}') IS DISTINCT FROM n
 OR jsonb_array_length(s->'tournament_player_chips') IS DISTINCT FROM n
 OR (SELECT count(*) FROM jsonb_object_keys(s->'written'))<>n
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(s#>'{request,stacks}') x)<>n
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(s->'tournament_player_chips') x)<>n THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_roster) LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s#>'{request,stacks}') x
 WHERE x->>'user_id'=r->>'user_id' AND x->>'seat_id'=r->>'seat_id'
 AND (x->>'seat_joined_at')::timestamptz=(r->>'joined_at')::timestamptz
 AND (x->>'stack')::numeric=(r->>'stack')::numeric)
 OR (s->'written'->>(r->>'user_id'))::numeric IS DISTINCT FROM (r->>'stack')::numeric
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'tournament_player_chips') x
 WHERE x->>'user_id'=r->>'user_id' AND (x->>'chips')::numeric=(r->>'chips')::numeric) THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 actual:=jsonb_build_object('hand_number',a.hand_number,'atomic_hand_id',a.hand_id,
 'stack_hand_id',s->>'hand_id','atomic_hash',md5(to_jsonb(a)::text),'history_hash',md5(to_jsonb(history)::text),
 'payload_hash',a.payload_hash,'post_commit_payload_hash',a.post_commit_payload_hash,
 'post_commit_request_hash',a.post_commit_request_hash,'post_commit_completed_at',a.post_commit_completed_at);
 IF actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_MIXED_PRIOR_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 RETURN actual;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_prior_committed_stacks(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- An original zero-credit disposition is a different boundary from an atomic
-- accepted hand. Never put its receipt UUID into the atomic-hand identity domain.
CREATE FUNCTION smarter_private.f06_prior_aborted_stacks(p_permit uuid,p_expected jsonb,p_roster jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE h smarter_private.f06_hand_permits; a smarter_private.f06_unsettled_hand_aborts;
 original smarter_private.f06_hand_permits; park smarter_private.f06_operations;
 snap public.hand_state_snapshots; projected jsonb; actual jsonb;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit;
 IF NOT FOUND OR h.state<>'reserved' OR h.evidence_id IS NOT NULL
 OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR p_expected->>'kind' IS DISTINCT FROM 'aborted_unsettled'
 OR jsonb_typeof(p_roster) IS DISTINCT FROM 'array' OR jsonb_array_length(p_roster)<>2 THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_ABORT_IDENTITY' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM smarter_private.f06_unsettled_hand_aborts WHERE receipt_id=(p_expected->>'receipt_id')::uuid FOR SHARE;
 IF NOT FOUND OR a.tournament_id IS DISTINCT FROM h.tournament_id OR a.table_id IS DISTINCT FROM h.table_id
 OR a.hand_number>=h.hand_number OR a.outcome IS DISTINCT FROM 'aborted_unsettled' OR a.retired_lease_generation IS NOT NULL
 OR NOT smarter_private.f06_generation_aborted(a.tournament_id,a.generation)
 OR a.expected->>'tournament_id' IS DISTINCT FROM a.tournament_id::text
 OR a.expected->>'table_id' IS DISTINCT FROM a.table_id::text
 OR a.expected->>'generation' IS DISTINCT FROM a.generation::text THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_ABORT_BOUNDARY' USING ERRCODE='55000'; END IF;
 SELECT * INTO original FROM smarter_private.f06_hand_permits WHERE permit_id=a.permit_id;
 SELECT * INTO park FROM smarter_private.f06_operations WHERE break_id=a.break_id;
 SELECT * INTO snap FROM public.hand_state_snapshots WHERE id=(a.expected->>'snapshot_id')::uuid;
 IF original.permit_id IS NULL OR original.state IS DISTINCT FROM 'aborted_unsettled'
 OR original.evidence_id IS DISTINCT FROM a.receipt_id OR original.lifecycle IS DISTINCT FROM h.lifecycle
 OR (original.tournament_id,original.table_id,original.generation,original.hand_number)
 IS DISTINCT FROM (a.tournament_id,a.table_id,a.generation,a.hand_number)
 OR jsonb_set(jsonb_set(to_jsonb(original),'{state}','"reserved"'),'{evidence_id}','null') IS DISTINCT FROM a.expected->'permit'
 OR park.break_id IS NULL OR park.state IS DISTINCT FROM 'withdrawn_before_manifest' OR park.abort_receipt_id IS DISTINCT FROM a.receipt_id
 OR park.lifecycle IS DISTINCT FROM h.lifecycle OR park.source_table_id IS DISTINCT FROM h.table_id
 OR jsonb_set(to_jsonb(park)-'abort_receipt_id','{state}','"park_requested"') IS DISTINCT FROM a.expected->'park'
 OR snap.id IS NULL OR snap.is_complete IS DISTINCT FROM true OR snap.table_id IS DISTINCT FROM h.table_id OR snap.hand_number IS DISTINCT FROM a.hand_number
 OR md5(jsonb_set(to_jsonb(snap),'{is_complete}','false')::text) IS DISTINCT FROM a.expected->>'snapshot_hash' THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_ABORT_TERMINAL_CHANGED' USING ERRCODE='55000'; END IF;
 -- The old immutable receipt predates joined_at capture. Its preserved unique
 -- occupancy identity establishes continuity; current joined_at is bound by
 -- the new full DTO, never fabricated inside the old receipt.
 SELECT jsonb_agg(x-'joined_at'-'table_id' ORDER BY x->>'user_id') INTO projected FROM jsonb_array_elements(p_roster) x;
 IF projected IS DISTINCT FROM (SELECT jsonb_agg(x ORDER BY x->>'user_id') FROM jsonb_array_elements(a.expected->'roster') x) THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_ABORT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number>=a.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number>=a.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id AND hand_number>=a.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id AND hand_number>a.hand_number AND state='accepted')
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND NOT is_complete) THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_ABORT_NOT_LAST_BOUNDARY' USING ERRCODE='55000'; END IF;
 actual:=jsonb_build_object('kind','aborted_unsettled','receipt_id',a.receipt_id,'receipt_hash',md5(to_jsonb(a)::text));
 IF actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_MIXED_PRIOR_ABORT_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 RETURN actual;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_prior_aborted_stacks(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_f06_abort_mixed_unsettled_generation(p_receipt_id uuid,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_expected->>'tournament_id')::uuid;
 g uuid:=(p_expected->>'generation')::uuid;
 lease public.engine_tournament_leases;
 event public.tournaments;
 h smarter_private.f06_hand_permits;
 o smarter_private.f06_operations;
 snap public.hand_state_snapshots;
 prior smarter_private.f06_mixed_aborts;
 generations uuid[]; prior_proof jsonb; expected_item jsonb; known_started integer:=0; prior_based integer:=0;
 item jsonb; hands jsonb:='[]'; parks jsonb; open_tables jsonb; roster jsonb; event_roster jsonb;
 accepted jsonb; actual jsonb; users uuid[]; u uuid; tab_ids uuid[]; reserved_ids uuid[];
 v_break_id uuid; player_count integer; hu boolean;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role'
 OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_receipt_id IS NULL OR t IS NULL OR g IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_expected->'hands') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_GENERATION_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:'||p_receipt_id::text,0));
 SELECT * INTO prior FROM smarter_private.f06_mixed_aborts WHERE receipt_id=p_receipt_id;
 IF FOUND THEN
 IF prior.expected IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_ABORT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome',prior.outcome,'receipt_id',p_receipt_id,
 'hands',jsonb_array_length(prior.expected->'hands'),'credit',0);
 END IF;

 -- The lease FOR UPDATE drains protocol-2 HTTP requests admitted FOR KEY SHARE.
 -- Never wait on an earlier lane while holding it: direct SQL may own that lane.
 SELECT * INTO lease FROM public.engine_tournament_leases
 WHERE tournament_id=t AND lease_generation=g AND protocol_version=2 FOR UPDATE;
 IF NOT FOUND OR lease.instance_id IS DISTINCT FROM p_expected->>'instance_id'
 OR lease.engine_version IS DISTINCT FROM p_expected->>'engine_version' THEN
 RAISE EXCEPTION 'F06_GENERATION_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_try_lane(t);
 SELECT array_agg(permit_id ORDER BY permit_id) INTO reserved_ids FROM smarter_private.f06_hand_permits
 WHERE tournament_id=t AND state='reserved';
 IF reserved_ids IS NULL OR (SELECT count(DISTINCT generation) FROM smarter_private.f06_hand_permits WHERE permit_id=ANY(reserved_ids)) NOT BETWEEN 1 AND 2
 OR reserved_ids IS DISTINCT FROM (SELECT array_agg((x->'permit'->>'permit_id')::uuid ORDER BY (x->'permit'->>'permit_id')::uuid)
 FROM jsonb_array_elements(p_expected->'hands') x) THEN
 RAISE EXCEPTION 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED' USING ERRCODE='55000'; END IF;
SELECT array_agg(DISTINCT x ORDER BY x) INTO generations FROM (SELECT generation x FROM smarter_private.f06_hand_permits WHERE permit_id=ANY(reserved_ids) UNION SELECT g) q;
 IF EXISTS(SELECT 1 FROM unnest(generations) x WHERE smarter_private.f06_generation_aborted(t,x)) THEN
 RAISE EXCEPTION 'F06_MIXED_GENERATION_ALREADY_DISPOSED' USING ERRCODE='55000'; END IF;
  FOR u IN SELECT unnest(reserved_ids) LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT array_agg(id ORDER BY id) INTO tab_ids FROM public.tables
 WHERE tournament_id=t AND lower(status)<>'closed' AND NOT COALESCE(is_deleted,false);
 SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO users FROM public.table_seats
 WHERE table_id=ANY(tab_ids) AND left_at IS NULL;
 FOR u IN SELECT unnest(users) LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT * INTO event FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats WHERE table_id=ANY(tab_ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t ORDER BY permit_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id=t ORDER BY break_id FOR UPDATE;
 IF event.status IS DISTINCT FROM 'RUNNING' OR event.format_contract NOT IN ('mtt-v1','mtt-v2','spin-v1','sng-v1')
 OR event.format_contract IS NULL OR tab_ids IS NULL
 OR (event.format_contract='spin-v1' AND cardinality(tab_ids)<>1)
 OR EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(tab_ids)
 AND (lower(status) NOT IN ('waiting','running') OR f06_lifecycle IS NULL)) THEN
 RAISE EXCEPTION 'F06_GENERATION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 hu:=event.format_contract='sng-v1';
 IF hu AND (event.table_size IS DISTINCT FROM 2 OR cardinality(tab_ids)<>1
 OR EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(tab_ids) AND max_players IS DISTINCT FROM 2)) THEN
 RAISE EXCEPTION 'F06_MIXED_HU_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- Every occupied chair in the complete open-table generation has one exact
 -- playing registration; every playing registration has that current chair.
 IF EXISTS(SELECT 1 FROM public.table_seats s LEFT JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(tab_ids) AND s.left_at IS NULL AND (p.id IS NULL OR s.occupancy_id IS NULL
 OR s.joined_at IS NULL OR s.terminal_closed_at IS NOT NULL OR s.stack IS DISTINCT FROM p.chips::numeric
 OR s.stack IS NULL OR s.stack<0 OR s.stack::text IN ('NaN','Infinity','-Infinity')))
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=t AND p.status='playing'
 AND NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=ANY(tab_ids) AND s.table_id=p.table_id
 AND s.user_id=p.user_id AND s.seat_number=p.seat_number AND s.left_at IS NULL)) THEN
 RAISE EXCEPTION 'F06_GENERATION_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'deleted',is_deleted,'lifecycle',f06_lifecycle) ORDER BY id)
 INTO open_tables FROM public.tables WHERE id=ANY(tab_ids);
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
 'user_id',s.user_id,'joined_at',s.joined_at,'table_id',s.table_id,'seat_number',s.seat_number,'stack',s.stack,'chips',p.chips) ORDER BY s.id)
 INTO event_roster FROM public.table_seats s JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(tab_ids) AND s.left_at IS NULL;
 IF (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(event_roster) x)<>jsonb_array_length(event_roster) THEN
 RAISE EXCEPTION 'F06_GENERATION_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 -- The explicitly supported HU boundary is one real two-chair event. A stale
 -- display counter cannot replace exact live seat/registration identity.
 IF hu AND (jsonb_array_length(event_roster) IS DISTINCT FROM 2
 OR (SELECT count(DISTINCT (x->>'seat_number')::integer) FROM jsonb_array_elements(event_roster) x)<>2
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(event_roster) x WHERE (x->>'seat_number')::integer NOT BETWEEN 1 AND 2)) THEN
 RAISE EXCEPTION 'F06_MIXED_HU_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- Pending post-commit work is an accepted financial outcome, never an abort.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.tournament_id=t AND p.table_id=ANY(tab_ids)
 AND p.state='accepted' AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits later WHERE later.table_id=p.table_id AND later.hand_number>p.hand_number) AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c
 WHERE c.table_id=p.table_id AND c.hand_number=p.hand_number AND c.hand_id=p.evidence_id AND c.post_commit_completed_at IS NOT NULL
 AND c.post_commit_result->'ok'='true'::jsonb)) THEN
 RAISE EXCEPTION 'F06_GENERATION_ACCEPTED_PROOF_INCOMPLETE' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('permit',to_jsonb(p),'atomic_hash',md5(to_jsonb(c)::text)) ORDER BY p.permit_id),'[]')
 INTO accepted FROM smarter_private.f06_hand_permits p JOIN public.hand_atomic_commits c
 ON c.table_id=p.table_id AND c.hand_number=p.hand_number
 WHERE p.tournament_id=t AND p.table_id=ANY(tab_ids) AND p.state='accepted' AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits later WHERE later.table_id=p.table_id AND later.hand_number>p.hand_number);
 -- Keep accepted-source parks intact for the genuine new-generation F06 owner.
 -- Only a target hand's pre-manifest park can receive a truthful withdrawal.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations p WHERE p.tournament_id=t
 AND p.state NOT IN ('acknowledged','withdrawn_before_manifest') AND
 (p.state<>'park_requested' OR p.manifest IS NOT NULL OR p.close_receipt IS NOT NULL OR p.cleanup_kind IS NOT NULL
 OR p.abort_receipt_id IS NOT NULL OR NOT p.source_table_id=ANY(tab_ids)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=p.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=p.break_id))) THEN
 RAISE EXCEPTION 'F06_GENERATION_PARK_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.break_id),'[]') INTO parks FROM smarter_private.f06_operations p
 WHERE p.tournament_id=t AND p.state NOT IN ('acknowledged','withdrawn_before_manifest');

 FOR h IN SELECT * FROM smarter_private.f06_hand_permits WHERE permit_id=ANY(reserved_ids) ORDER BY permit_id LOOP
 IF h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=h.table_id AND id=ANY(tab_ids) AND f06_lifecycle=h.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id AND hand_number>h.hand_number) THEN
 RAISE EXCEPTION 'F06_GENERATION_PERMIT_CHANGED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO roster FROM jsonb_array_elements(event_roster) x
 WHERE x->>'table_id'=h.table_id::text;
 prior_proof:=NULL;
 SELECT * INTO snap FROM public.hand_state_snapshots
 WHERE table_id=h.table_id AND hand_number=h.hand_number AND NOT is_complete FOR UPDATE;
 IF FOUND THEN
 known_started:=known_started+1;
 IF snap.stage IS DISTINCT FROM 'preflop'
 OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
 OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10 THEN
 RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 player_count:=jsonb_array_length(roster);
 IF player_count IS DISTINCT FROM jsonb_array_length(snap.state_json->'players')
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)<>player_count
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(roster) r WHERE r->>'user_id'=x->>'user_id'
 AND (r->>'seat_number')::integer=(x->>'seat')::integer
 AND (r->>'stack')::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric
 AND (x->>'stack')::numeric>=0 AND (x->>'totalInvested')::numeric>=0
 AND (x->>'stack')::numeric::text NOT IN ('NaN','Infinity','-Infinity')
 AND (x->>'totalInvested')::numeric::text NOT IN ('NaN','Infinity','-Infinity')
 -- BBA dead investment is already part of totalInvested. Do not credit it twice.
 AND COALESCE((x->>'deadInvested')::numeric,0) BETWEEN 0 AND (x->>'totalInvested')::numeric
 AND COALESCE((x->>'returnedUncalled')::numeric,0)=0
 AND COALESCE((x->>'individualAnteInvested')::numeric,0)=0))
 OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
 (SELECT sum((x->>'totalInvested')::numeric) FROM jsonb_array_elements(snap.state_json->'players') x) THEN
 RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 prior_based:=prior_based+1;
 SELECT x INTO expected_item FROM jsonb_array_elements(p_expected->'hands') x WHERE x->'permit'->>'permit_id'=h.permit_id::text;
 IF expected_item#>>'{prior,kind}'='aborted_unsettled' THEN
 IF NOT hu THEN RAISE EXCEPTION 'F06_MIXED_PRIOR_ABORT_HU_ONLY' USING ERRCODE='55000'; END IF;
 prior_proof:=smarter_private.f06_prior_aborted_stacks(h.permit_id,expected_item->'prior',roster);
 ELSE
 prior_proof:=smarter_private.f06_prior_committed_stacks(h.permit_id,expected_item->'prior',roster);
 END IF;
 END IF;
 v_break_id:=NULL;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE source_table_id=h.table_id
 AND state NOT IN ('acknowledged','withdrawn_before_manifest');
 IF FOUND THEN
 IF o.origin_generation IS DISTINCT FROM h.generation OR o.lifecycle IS DISTINCT FROM h.lifecycle
 OR (o.custody_generation IS NOT NULL AND o.custody_generation<>h.generation) THEN
 RAISE EXCEPTION 'F06_GENERATION_PARK_CHANGED' USING ERRCODE='55000'; END IF;
 v_break_id:=o.break_id;
 END IF;
 hands:=hands||jsonb_build_array(jsonb_build_object('permit',to_jsonb(h),'snapshot_id',snap.id,
 'snapshot_hash',CASE WHEN snap.id IS NULL THEN NULL ELSE md5(to_jsonb(snap)::text) END,'roster',roster,'break_id',v_break_id,'prior',prior_proof));
 END LOOP;
 IF prior_based>1
 OR (hu AND (prior_based<>1 OR known_started<>0 OR cardinality(reserved_ids)<>1 OR jsonb_array_length(parks)<>0))
 OR (NOT hu AND prior_based=1 AND (event.format_contract NOT IN ('mtt-v1','mtt-v2') OR known_started<1)) THEN
 RAISE EXCEPTION 'F06_MIXED_BOUNDARIES_REQUIRED' USING ERRCODE='55000'; END IF;
 actual:=jsonb_build_object('tournament_id',t,'generations',to_jsonb(generations),'generation',g,'instance_id',lease.instance_id,
 'engine_version',lease.engine_version,'format_contract',event.format_contract,'open_tables',open_tables,
 'roster',event_roster,'parks',parks,'accepted',accepted,'hands',hands);
 IF actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_ABORT_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_mixed_aborts(receipt_id,tournament_id,expected) VALUES(p_receipt_id,t,actual);
 INSERT INTO smarter_private.f06_mixed_abort_generations(tournament_id,generation,receipt_id) SELECT t,x,p_receipt_id FROM unnest(generations) x;
 FOR item IN SELECT value FROM jsonb_array_elements(hands) LOOP
 INSERT INTO smarter_private.f06_mixed_abort_hands
 (permit_id,receipt_id,tournament_id,generation,table_id,hand_number,snapshot_id,break_id,prior_hand_id,prior_abort_receipt_id,expected)
 VALUES((item->'permit'->>'permit_id')::uuid,p_receipt_id,t,(item->'permit'->>'generation')::uuid,(item->'permit'->>'table_id')::uuid,
 (item->'permit'->>'hand_number')::bigint,(item->>'snapshot_id')::uuid,(item->>'break_id')::uuid,(item#>>'{prior,atomic_hand_id}')::uuid,(item#>>'{prior,receipt_id}')::uuid,item);
 END LOOP;
 UPDATE smarter_private.f06_hand_permits SET state='aborted_unsettled',evidence_id=p_receipt_id WHERE permit_id=ANY(reserved_ids);
 UPDATE public.hand_state_snapshots SET is_complete=true
 WHERE id IN(SELECT a.snapshot_id FROM smarter_private.f06_mixed_abort_hands a WHERE a.receipt_id=p_receipt_id);
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=p_receipt_id
 WHERE break_id IN(SELECT a.break_id FROM smarter_private.f06_mixed_abort_hands a WHERE a.receipt_id=p_receipt_id);
 PERFORM public.release_tournament_leases_v2(lease.instance_id,
 jsonb_build_array(jsonb_build_object('tournament_id',t,'lease_generation',g)));
 IF EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND lease_generation=g) THEN
 RAISE EXCEPTION 'F06_ABORT_LEASE_NOT_WITHDRAWN' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',p_receipt_id,
 'hands',jsonb_array_length(hands),'credit',0);
END $function$;
REVOKE ALL ON FUNCTION public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) TO service_role;
