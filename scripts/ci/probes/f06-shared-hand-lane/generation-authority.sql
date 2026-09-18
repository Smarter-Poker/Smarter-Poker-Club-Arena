CREATE TABLE smarter_private.f06_generation_aborts(
 receipt_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, generation uuid NOT NULL,
 expected jsonb NOT NULL, outcome text NOT NULL DEFAULT 'aborted_unsettled'
 CHECK(outcome='aborted_unsettled'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tournament_id,generation), UNIQUE(receipt_id,tournament_id,generation));
CREATE TABLE smarter_private.f06_generation_abort_hands(
 permit_id uuid PRIMARY KEY, receipt_id uuid NOT NULL,
 tournament_id uuid NOT NULL, generation uuid NOT NULL, table_id uuid NOT NULL, hand_number bigint NOT NULL,
 snapshot_id uuid NOT NULL, break_id uuid UNIQUE, expected jsonb NOT NULL,
 UNIQUE(table_id,hand_number), FOREIGN KEY(receipt_id,tournament_id,generation)
 REFERENCES smarter_private.f06_generation_aborts(receipt_id,tournament_id,generation));
ALTER TABLE smarter_private.f06_generation_aborts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_generation_abort_hands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_generation_aborts,smarter_private.f06_generation_abort_hands
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_generation_receipt_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.f06_generation_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER f06_generation_child_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.f06_generation_abort_hands FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();

CREATE FUNCTION public.fn_f06_abort_unsettled_generation(p_receipt_id uuid,p_expected jsonb)
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
 prior smarter_private.f06_generation_aborts;
 item jsonb; hands jsonb:='[]'; parks jsonb; open_tables jsonb; roster jsonb; event_roster jsonb;
 accepted jsonb; actual jsonb; users uuid[]; u uuid; tab_ids uuid[]; reserved_ids uuid[];
 v_break_id uuid; player_count integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role'
 OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_receipt_id IS NULL OR t IS NULL OR g IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_expected->'hands') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_GENERATION_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:'||p_receipt_id::text,0));
 SELECT * INTO prior FROM smarter_private.f06_generation_aborts WHERE receipt_id=p_receipt_id;
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
 IF reserved_ids IS NULL OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits
 WHERE tournament_id=t AND state='reserved' AND generation<>g)
 OR reserved_ids IS DISTINCT FROM (SELECT array_agg((x->'permit'->>'permit_id')::uuid ORDER BY (x->'permit'->>'permit_id')::uuid)
 FROM jsonb_array_elements(p_expected->'hands') x) THEN
 RAISE EXCEPTION 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED' USING ERRCODE='55000'; END IF;
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
 IF event.status IS DISTINCT FROM 'RUNNING' OR event.format_contract NOT IN ('mtt-v1','mtt-v2','spin-v1')
 OR event.format_contract IS NULL OR tab_ids IS NULL
 OR (event.format_contract='spin-v1' AND cardinality(tab_ids)<>1)
 OR EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(tab_ids)
 AND (lower(status) NOT IN ('waiting','running') OR f06_lifecycle IS NULL)) THEN
 RAISE EXCEPTION 'F06_GENERATION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- Every occupied chair in the complete open-table generation has one exact
 -- playing registration; every playing registration has that current chair.
 IF EXISTS(SELECT 1 FROM public.table_seats s LEFT JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(tab_ids) AND s.left_at IS NULL AND (p.id IS NULL OR s.occupancy_id IS NULL
 OR s.terminal_closed_at IS NOT NULL OR s.stack IS DISTINCT FROM p.chips::numeric
 OR s.stack IS NULL OR s.stack<0 OR s.stack::text IN ('NaN','Infinity','-Infinity')))
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=t AND p.status='playing'
 AND NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=ANY(tab_ids) AND s.table_id=p.table_id
 AND s.user_id=p.user_id AND s.seat_number=p.seat_number AND s.left_at IS NULL)) THEN
 RAISE EXCEPTION 'F06_GENERATION_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'deleted',is_deleted,'lifecycle',f06_lifecycle) ORDER BY id)
 INTO open_tables FROM public.tables WHERE id=ANY(tab_ids);
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
 'user_id',s.user_id,'table_id',s.table_id,'seat_number',s.seat_number,'stack',s.stack,'chips',p.chips) ORDER BY s.id)
 INTO event_roster FROM public.table_seats s JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(tab_ids) AND s.left_at IS NULL;
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
 IF h.generation IS DISTINCT FROM g OR h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=h.table_id AND id=ANY(tab_ids) AND f06_lifecycle=h.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id AND hand_number>h.hand_number) THEN
 RAISE EXCEPTION 'F06_GENERATION_PERMIT_CHANGED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;
 SELECT * INTO snap FROM public.hand_state_snapshots
 WHERE table_id=h.table_id AND hand_number=h.hand_number AND NOT is_complete FOR UPDATE;
 IF NOT FOUND OR snap.stage IS DISTINCT FROM 'preflop'
 OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
 OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10 THEN
 RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO roster FROM jsonb_array_elements(event_roster) x
 WHERE x->>'table_id'=h.table_id::text;
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
 v_break_id:=NULL;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE source_table_id=h.table_id
 AND state NOT IN ('acknowledged','withdrawn_before_manifest');
 IF FOUND THEN
 IF o.origin_generation IS DISTINCT FROM g OR o.lifecycle IS DISTINCT FROM h.lifecycle
 OR (o.custody_generation IS NOT NULL AND o.custody_generation<>g) THEN
 RAISE EXCEPTION 'F06_GENERATION_PARK_CHANGED' USING ERRCODE='55000'; END IF;
 v_break_id:=o.break_id;
 END IF;
 hands:=hands||jsonb_build_array(jsonb_build_object('permit',to_jsonb(h),'snapshot_id',snap.id,
 'snapshot_hash',md5(to_jsonb(snap)::text),'roster',roster,'break_id',v_break_id));
 END LOOP;
 actual:=jsonb_build_object('tournament_id',t,'generation',g,'instance_id',lease.instance_id,
 'engine_version',lease.engine_version,'format_contract',event.format_contract,'open_tables',open_tables,
 'roster',event_roster,'parks',parks,'accepted',accepted,'hands',hands);
 IF actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_ABORT_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_generation_aborts(receipt_id,tournament_id,generation,expected)
 VALUES(p_receipt_id,t,g,actual);
 FOR item IN SELECT value FROM jsonb_array_elements(hands) LOOP
 INSERT INTO smarter_private.f06_generation_abort_hands
 (permit_id,receipt_id,tournament_id,generation,table_id,hand_number,snapshot_id,break_id,expected)
 VALUES((item->'permit'->>'permit_id')::uuid,p_receipt_id,t,g,(item->'permit'->>'table_id')::uuid,
 (item->'permit'->>'hand_number')::bigint,(item->>'snapshot_id')::uuid,(item->>'break_id')::uuid,item);
 END LOOP;
 UPDATE smarter_private.f06_hand_permits SET state='aborted_unsettled',evidence_id=p_receipt_id WHERE permit_id=ANY(reserved_ids);
 UPDATE public.hand_state_snapshots SET is_complete=true
 WHERE id IN(SELECT a.snapshot_id FROM smarter_private.f06_generation_abort_hands a WHERE a.receipt_id=p_receipt_id);
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=p_receipt_id
 WHERE break_id IN(SELECT a.break_id FROM smarter_private.f06_generation_abort_hands a WHERE a.receipt_id=p_receipt_id);
 PERFORM public.release_tournament_leases_v2(lease.instance_id,
 jsonb_build_array(jsonb_build_object('tournament_id',t,'lease_generation',g)));
 IF EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND lease_generation=g) THEN
 RAISE EXCEPTION 'F06_ABORT_LEASE_NOT_WITHDRAWN' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',p_receipt_id,
 'hands',jsonb_array_length(hands),'credit',0);
END $function$;
REVOKE ALL ON FUNCTION public.fn_f06_abort_unsettled_generation(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_unsettled_generation(uuid,jsonb) TO service_role;
