CREATE FUNCTION public.fn_f06_assert_drained_manager_custody(
 p_tournament_id uuid,p_lease_generation uuid,p_origin_generation uuid,
 p_sources jsonb,p_expected jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE o smarter_private.f06_operations; l public.engine_tournament_leases;
 x jsonb; permit_row smarter_private.f06_hand_permits; u uuid; ids uuid[]; users uuid[]; terminal jsonb:='[]'; witness jsonb; prior jsonb; parks jsonb:='[]'; originals jsonb; pending jsonb; proof jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR p_tournament_id IS NULL
 OR jsonb_typeof(p_sources) IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_lease_generation IS NOT NULL THEN
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 ELSE
 IF p_origin_generation IS NULL OR jsonb_array_length(p_sources)=0 OR p_expected IS NOT NULL THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_ORIGINAL_REQUIRED' USING ERRCODE='22023'; END IF;
 SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id FOR KEY SHARE;
 IF FOUND AND (l.lease_generation IS DISTINCT FROM p_origin_generation OR l.protocol_version<>2
 OR l.heartbeat_at>=clock_timestamp()-interval '30 seconds') THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 -- Same lease -> event lane order as the owning F06 request. This function
 -- never writes a lease even when the former row is absent.
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
 IF p_lease_generation IS NOT NULL THEN PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation,false); END IF;
 -- Same sorted physical row order as f06_prefix, including the old-owner
 -- read-only branch where no current generation may be fabricated.
 IF p_lease_generation IS NULL THEN
 SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id FOR KEY SHARE;
 IF FOUND AND (l.lease_generation IS DISTINCT FROM p_origin_generation OR l.protocol_version<>2
 OR l.heartbeat_at>=clock_timestamp()-interval '30 seconds') THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT COALESCE(array_agg((value->>'table_id')::uuid ORDER BY value->>'table_id'),'{}') INTO ids FROM jsonb_array_elements(p_sources);
 SELECT COALESCE(array_agg(DISTINCT user_id ORDER BY user_id),'{}') INTO users FROM public.table_seats
 WHERE table_id=ANY(ids) AND user_id IS NOT NULL;
 FOREACH u IN ARRAY users LOOP PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)); END LOOP;
 PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id AND upper(status)='RUNNING' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_DRAINED_CUSTODY_EVENT_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id AND user_id=ANY(users) ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
 WHERE tb.tournament_id=p_tournament_id AND (s.user_id=ANY(users) OR s.table_id=ANY(ids)) ORDER BY s.id FOR UPDATE OF s;
 IF (SELECT count(DISTINCT value->>'table_id') FROM jsonb_array_elements(p_sources))<>jsonb_array_length(p_sources)
 OR (SELECT count(DISTINCT value->>'break_id') FROM jsonb_array_elements(p_sources))<>jsonb_array_length(p_sources)
 OR (jsonb_array_length(p_sources)>0 AND p_origin_generation IS NULL) THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_SOURCE_CHANGED' USING ERRCODE='22023'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_sources) ORDER BY value->>'table_id' LOOP
 PERFORM 1 FROM public.tables WHERE id=(x->>'table_id')::uuid AND tournament_id=p_tournament_id
 AND f06_lifecycle::text=x->>'lifecycle' AND lower(status)<>'closed' AND NOT COALESCE(is_deleted,false) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_DRAINED_CUSTODY_SOURCE_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=(x->>'break_id')::uuid FOR SHARE;
 IF NOT FOUND OR (o.tournament_id,o.source_table_id,o.lifecycle,o.origin_generation)
 IS DISTINCT FROM (p_tournament_id,(x->>'table_id')::uuid,(x->>'lifecycle')::bigint,p_origin_generation)
 OR o.state<>'park_requested' OR o.revision<>0 OR o.manifest IS NOT NULL
 OR o.custody_id IS NOT NULL OR o.custody_generation IS NOT NULL OR o.close_receipt IS NOT NULL
 OR o.cleanup_kind IS NOT NULL OR o.abort_receipt_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=o.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=o.break_id) THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_NOT_PREMANIFEST' USING ERRCODE='55000'; END IF;
 -- The already-installed movement authority supplies the original completed
 -- source boundary, including its independent atomic and stack identities.
 prior:=smarter_private.f06_movement_prior(p_tournament_id,o.source_table_id);
 parks:=parks||jsonb_build_array(jsonb_build_object('park',to_jsonb(o),'prior',prior));
 END LOOP;
 SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.permit_id),'[]') INTO originals
 FROM smarter_private.f06_hand_permits h WHERE h.tournament_id=p_tournament_id AND h.state='reserved';
 SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]') INTO pending FROM
 (SELECT DISTINCT h.table_id id FROM smarter_private.f06_hand_permits h
 WHERE h.tournament_id=p_tournament_id AND h.state='reserved') q;
 proof:=jsonb_build_object('parks',parks,'originals',originals);
 IF p_expected IS NOT NULL THEN
 IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR p_expected->'parks' IS DISTINCT FROM parks
 OR jsonb_typeof(p_expected->'originals') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 IF (SELECT count(DISTINCT value->>'permit_id') FROM jsonb_array_elements(p_expected->'originals'))<>jsonb_array_length(p_expected->'originals')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_expected->'originals') e WHERE e->>'state' IS DISTINCT FROM 'reserved' OR e->'evidence_id' IS DISTINCT FROM 'null'::jsonb) THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_CAPTURE_INVALID' USING ERRCODE='22023'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_expected->'originals') LOOP
 SELECT * INTO permit_row FROM smarter_private.f06_hand_permits WHERE permit_id=(x->>'permit_id')::uuid FOR SHARE;
 IF NOT FOUND OR permit_row.tournament_id IS DISTINCT FROM p_tournament_id
 OR (to_jsonb(permit_row)-'state'-'evidence_id') IS DISTINCT FROM (x-'state'-'evidence_id') THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_ORIGINAL_CHANGED' USING ERRCODE='55000'; END IF;
 IF to_jsonb(permit_row)=x THEN CONTINUE; END IF;
 witness:=NULL;
 IF permit_row.state='accepted' THEN
 SELECT jsonb_build_object('atomic',to_jsonb(a),'history_id',hh.id) INTO witness
 FROM public.hand_atomic_commits a JOIN public.hand_history hh ON hh.id=a.hand_id
 AND hh.table_id=a.table_id AND hh.hand_number=a.hand_number
 WHERE a.hand_id=permit_row.evidence_id AND a.table_id=permit_row.table_id AND a.hand_number=permit_row.hand_number
 AND a.post_commit_completed_at IS NOT NULL AND isfinite(a.post_commit_completed_at)
 AND a.post_commit_completed_at>=a.committed_at AND a.post_commit_result->'ok'='true'::jsonb
 AND a.post_commit_result->>'hand_id'=a.hand_id::text
 AND (a.post_commit_result->>'hand_number')::bigint=a.hand_number;
 ELSIF permit_row.state='never_started' THEN
 -- Only the immutable preparation receipt is supported here. A generic state
 -- or an old mutable park custody label cannot substitute for original proof.
 SELECT to_jsonb(c) INTO witness FROM smarter_private.f06_prepared_hand_cancellations c
 WHERE c.permit_id=permit_row.permit_id AND permit_row.evidence_id=permit_row.permit_id
 AND (c.tournament_id,c.generation,c.table_id,c.lifecycle,c.hand_number,c.custody_id)
 =(permit_row.tournament_id,permit_row.generation,permit_row.table_id,permit_row.lifecycle,permit_row.hand_number,permit_row.custody_id);
 ELSIF permit_row.state='aborted_unsettled' AND smarter_private.f06_generation_aborted(permit_row.tournament_id,permit_row.generation) THEN
 SELECT r.receipt INTO witness FROM (
 SELECT a.permit_id,a.receipt_id,a.tournament_id,a.generation,a.table_id,a.hand_number,a.expected,
 to_jsonb(a) receipt FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.outcome='aborted_unsettled'
 UNION ALL
 SELECT a.permit_id,a.receipt_id,a.tournament_id,a.generation,a.table_id,a.hand_number,a.expected,
 jsonb_build_object('hand',to_jsonb(a),'receipt',to_jsonb(r)) FROM smarter_private.f06_generation_abort_hands a
 JOIN smarter_private.f06_generation_aborts r USING(receipt_id,tournament_id,generation) WHERE r.outcome='aborted_unsettled'
 UNION ALL
 SELECT a.permit_id,a.receipt_id,a.tournament_id,a.generation,a.table_id,a.hand_number,a.expected,
 jsonb_build_object('hand',to_jsonb(a),'receipt',to_jsonb(r)) FROM smarter_private.f06_mixed_abort_hands a
 JOIN smarter_private.f06_mixed_aborts r USING(receipt_id,tournament_id) WHERE r.outcome='aborted_unsettled') r
 WHERE (r.permit_id,r.receipt_id,r.tournament_id,r.generation,r.table_id,r.hand_number)
 =(permit_row.permit_id,permit_row.evidence_id,permit_row.tournament_id,permit_row.generation,permit_row.table_id,permit_row.hand_number)
 AND r.expected->'permit'=x;
 END IF;
 IF witness IS NULL OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=permit_row.permit_id) THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_TERMINAL_EVIDENCE_REQUIRED' USING ERRCODE='55000'; END IF;
 terminal:=terminal||jsonb_build_array(jsonb_build_object('permit',to_jsonb(permit_row),'evidence',witness));
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(originals) h WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(p_expected->'originals') e WHERE e=h)) THEN
 RAISE EXCEPTION 'F06_DRAINED_CUSTODY_NEW_ORIGINAL' USING ERRCODE='55000'; END IF;
 proof:=p_expected;
 END IF;
 RETURN jsonb_build_object('ok',true,'tournament_id',p_tournament_id,'lease_generation',p_lease_generation,
 'recovery_required',jsonb_array_length(pending)>0,'pending_tables',pending,'proof',proof,'terminal_proof',terminal);
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_assert_drained_manager_custody(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_assert_drained_manager_custody(uuid,uuid,uuid,jsonb,jsonb) TO service_role;
