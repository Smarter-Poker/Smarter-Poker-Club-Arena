-- New authoritative operation. Expected values are comparisons, never evidence
-- supplied by a caller: every prerequisite below is re-read under its own locks.
CREATE FUNCTION public.fn_f06_abort_unsettled_hand(p_receipt_id uuid,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_expected->>'tournament_id')::uuid;
 tab uuid:=(p_expected->>'table_id')::uuid;
 g uuid:=(p_expected->>'generation')::uuid;
 h smarter_private.f06_hand_permits;
 o smarter_private.f06_operations;
 lease public.engine_tournament_leases;
 snap public.hand_state_snapshots;
 prior smarter_private.f06_unsettled_hand_aborts;
 actual jsonb; roster jsonb; users uuid[]; u uuid;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role'
 OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_receipt_id IS NULL OR t IS NULL OR tab IS NULL OR g IS NULL
 OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
 RAISE EXCEPTION 'F06_ABORT_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN
 RAISE EXCEPTION 'PLATFORM_FROZEN: interrupted-hand abort refused' USING ERRCODE='55000'; END IF;

 -- Serializes duplicate receipts, including the replay after lease withdrawal.
 PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:'||p_receipt_id::text,0));
 SELECT * INTO prior FROM smarter_private.f06_unsettled_hand_aborts WHERE receipt_id=p_receipt_id;
 IF FOUND THEN
 IF prior.expected IS DISTINCT FROM p_expected THEN
 RAISE EXCEPTION 'F06_ABORT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',prior.receipt_id,'credit',0);
 END IF;

 -- Linearization: drain every already admitted protocol-2 HTTP mutation.
 -- Never block on G/T while holding this lease: direct SQL can own T first.
 SELECT * INTO lease FROM public.engine_tournament_leases
 WHERE tournament_id=t AND lease_generation=g AND protocol_version=2 FOR UPDATE;
 IF NOT FOUND OR lease.instance_id IS DISTINCT FROM p_expected->>'instance_id'
 OR lease.engine_version IS DISTINCT FROM p_expected->>'engine_version' THEN
 RAISE EXCEPTION 'F06_ABORT_ORIGINAL_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_try_lane(t);
 SELECT * INTO h FROM smarter_private.f06_hand_permits
 WHERE permit_id=(p_expected->'permit'->>'permit_id')::uuid;
 IF NOT FOUND OR h.tournament_id IS DISTINCT FROM t OR h.table_id IS DISTINCT FROM tab
 OR h.generation IS DISTINCT FROM g OR h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL THEN
 RAISE EXCEPTION 'F06_ABORT_ORIGINAL_PERMIT_CHANGED' USING ERRCODE='55000'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.table_seats
 WHERE table_id=tab AND left_at IS NULL;
 FOR u IN SELECT x FROM unnest(users) x ORDER BY x LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE='40001'; END IF;
 END LOOP;
 PERFORM 1 FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats WHERE table_id=tab ORDER BY id FOR UPDATE;
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=h.permit_id FOR UPDATE;
 SELECT * INTO o FROM smarter_private.f06_operations
 WHERE break_id=(p_expected->'park'->>'break_id')::uuid FOR UPDATE;
 IF NOT FOUND OR o.tournament_id IS DISTINCT FROM t OR o.source_table_id IS DISTINCT FROM tab
 OR o.lifecycle IS DISTINCT FROM h.lifecycle OR o.origin_generation IS DISTINCT FROM g
 OR o.custody_generation IS DISTINCT FROM g OR o.custody_id IS NULL
 OR o.state IS DISTINCT FROM 'park_requested' OR o.manifest IS NOT NULL
 OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
 OR o.abort_receipt_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=o.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=o.break_id) THEN
 RAISE EXCEPTION 'F06_ABORT_PARK_NOT_PREMANIFEST' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=t AND status='RUNNING'
 AND format_contract='sng-v1' AND table_size=2 AND current_players=2)
 OR (SELECT count(*) FROM public.tables WHERE tournament_id=t
 AND lower(status)<>'closed' AND NOT COALESCE(is_deleted,false))<>1
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=tab AND tournament_id=t
 AND f06_lifecycle=h.lifecycle AND lower(status) IN ('waiting','running')
 AND NOT COALESCE(is_deleted,false))
 OR cardinality(users) IS DISTINCT FROM 2
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=t AND status='playing')<>2
 OR EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=tab AND left_at IS NULL
 AND (occupancy_id IS NULL OR terminal_closed_at IS NOT NULL))
 OR (SELECT count(*) FROM smarter_private.f06_hand_permits
 WHERE table_id=tab AND state='reserved')<>1
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits
 WHERE table_id=tab AND hand_number>h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=tab AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=tab AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=tab AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;
 SELECT * INTO snap FROM public.hand_state_snapshots
 WHERE table_id=tab AND hand_number=h.hand_number AND NOT is_complete FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'players')<>2 THEN
 RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,
 'registration_id',p.id,'user_id',s.user_id,'seat_number',s.seat_number,
 'stack',s.stack,'chips',p.chips) ORDER BY s.user_id) INTO roster
 FROM public.table_seats s JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number
 WHERE s.table_id=tab AND s.left_at IS NULL AND p.status='playing';
 IF jsonb_array_length(roster) IS DISTINCT FROM 2
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)<>2
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r
 WHERE r->>'user_id'=x->>'user_id' AND (r->>'seat_number')::integer=(x->>'seat')::integer
 AND (r->>'stack')::numeric=(r->>'chips')::numeric
 AND (r->>'stack')::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric
 AND (x->>'stack')::numeric>=0 AND (x->>'totalInvested')::numeric>=0
 AND COALESCE((x->>'deadInvested')::numeric,0)=0
 AND COALESCE((x->>'returnedUncalled')::numeric,0)=0
 AND COALESCE((x->>'individualAnteInvested')::numeric,0)=0)) THEN
 RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE='55000'; END IF;
 actual:=jsonb_build_object('tournament_id',t,'table_id',tab,'generation',g,
 'instance_id',lease.instance_id,'engine_version',lease.engine_version,
 'permit',to_jsonb(h),'park',to_jsonb(o)-'abort_receipt_id',
 'snapshot_id',snap.id,'snapshot_hash',md5(to_jsonb(snap)::text),'roster',roster);
 IF actual IS DISTINCT FROM p_expected THEN
 RAISE EXCEPTION 'F06_ABORT_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 IF public.fn_platform_frozen() THEN
 RAISE EXCEPTION 'PLATFORM_FROZEN: interrupted-hand abort refused' USING ERRCODE='55000'; END IF;

 -- No hand is accepted and no chips, wallet, escrow, ledger, prize or history
 -- is rewritten. This immutable receipt permanently revokes the old writer.
 INSERT INTO smarter_private.f06_unsettled_hand_aborts
 (receipt_id,tournament_id,table_id,generation,permit_id,hand_number,break_id,expected)
 VALUES(p_receipt_id,t,tab,g,h.permit_id,h.hand_number,o.break_id,actual);
 UPDATE smarter_private.f06_hand_permits SET state='aborted_unsettled',evidence_id=p_receipt_id
 WHERE permit_id=h.permit_id;
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=p_receipt_id
 WHERE break_id=o.break_id;
 UPDATE public.hand_state_snapshots SET is_complete=true WHERE id=snap.id;
 PERFORM public.release_tournament_leases_v2(lease.instance_id,
 jsonb_build_array(jsonb_build_object('tournament_id',t,'lease_generation',g)));
 IF EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND lease_generation=g) THEN
 RAISE EXCEPTION 'F06_ABORT_LEASE_NOT_WITHDRAWN' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',p_receipt_id,'credit',0);
END $function$;
