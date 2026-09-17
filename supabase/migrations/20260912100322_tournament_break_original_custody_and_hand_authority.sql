SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN
IF md5(pg_get_functiondef('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'::regprocedure))<>'370f962335e66c6c0ad7c9d2d09a8bf0' THEN RAISE EXCEPTION 'F06_PREIMAGE_CHANGED fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'; END IF;
IF md5(pg_get_functiondef('public.fn_close_empty_tournament_table(uuid,uuid,uuid)'::regprocedure))<>'0af954ab1264dc12ebce7741b7845343' THEN RAISE EXCEPTION 'F06_PREIMAGE_CHANGED fn_close_empty_tournament_table(uuid,uuid,uuid)'; END IF;
IF md5(pg_get_functiondef('public.fn_stamp_seat_occupancy()'::regprocedure))<>'4d2645a24bd3b88d7ffc51097b37d640' THEN RAISE EXCEPTION 'F06_PREIMAGE_CHANGED fn_stamp_seat_occupancy()'; END IF;
IF md5(pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure))<>'227533d1fd920a4782b50bbf1ebbc09b' THEN RAISE EXCEPTION 'F06_PREIMAGE_CHANGED fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'; END IF;
END $$;
-- F06 task-local candidate. No production application authorized.
CREATE SEQUENCE smarter_private.f06_lifecycle_seq AS bigint NO CYCLE;
CREATE FUNCTION smarter_private.f06_new_lifecycle() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT nextval('smarter_private.f06_lifecycle_seq') $$;
ALTER TABLE public.tables ADD COLUMN f06_lifecycle bigint NOT NULL DEFAULT smarter_private.f06_new_lifecycle();
CREATE TABLE smarter_private.f06_operations (
 break_id uuid PRIMARY KEY, ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 tournament_id uuid NOT NULL, source_table_id uuid NOT NULL REFERENCES public.tables(id),
 lifecycle bigint NOT NULL, boundary_id uuid NOT NULL UNIQUE, origin_generation uuid NOT NULL,
 state text NOT NULL DEFAULT 'park_requested' CHECK(state IN ('park_requested','begun','close_confirmed','acknowledged')),
 manifest jsonb, revision bigint NOT NULL DEFAULT 0,
 custody_id uuid, custody_generation uuid, cleanup_kind text,
 close_receipt jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((state IN ('close_confirmed','acknowledged'))=(close_receipt IS NOT NULL))
);
CREATE UNIQUE INDEX f06_one_source ON smarter_private.f06_operations(source_table_id) WHERE state<>'acknowledged';
CREATE TABLE smarter_private.f06_members (
 break_id uuid NOT NULL REFERENCES smarter_private.f06_operations, user_id uuid NOT NULL,
 source_seat_id uuid NOT NULL, source_seat_number integer NOT NULL CHECK(source_seat_number BETWEEN 1 AND 10),
 occupancy_id uuid NOT NULL UNIQUE, PRIMARY KEY(break_id,user_id), UNIQUE(break_id,source_seat_id)
);
CREATE TABLE smarter_private.f06_attempts (
 request_id uuid PRIMARY KEY, break_id uuid NOT NULL, user_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), predecessor uuid UNIQUE REFERENCES smarter_private.f06_attempts,
 amendment_id uuid UNIQUE, amendment_payload jsonb,
 destination_table_id uuid NOT NULL, destination_seat_number integer NOT NULL CHECK(destination_seat_number BETWEEN 1 AND 10),
 generation uuid NOT NULL, state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','fenced','winner')),
 receipt jsonb, FOREIGN KEY(break_id,user_id) REFERENCES smarter_private.f06_members,
 UNIQUE(break_id,user_id,revision), CHECK((state='winner')=(receipt IS NOT NULL))
);
CREATE UNIQUE INDEX f06_one_active ON smarter_private.f06_attempts(break_id,user_id) WHERE state='active';
CREATE UNIQUE INDEX f06_one_winner ON smarter_private.f06_attempts(break_id,user_id) WHERE state='winner';
CREATE TABLE smarter_private.f06_dispatch (
 request_id uuid PRIMARY KEY REFERENCES smarter_private.f06_attempts, xid bigint NOT NULL,
 occupancy_id uuid NOT NULL, source_seat_id uuid NOT NULL, lifecycle bigint NOT NULL
);
CREATE TABLE smarter_private.f06_cursors(tournament_id uuid PRIMARY KEY, ordinal bigint NOT NULL DEFAULT 0, revision bigint NOT NULL DEFAULT 0);
CREATE TABLE smarter_private.f06_hand_permits (
 permit_id uuid PRIMARY KEY,tournament_id uuid NOT NULL,table_id uuid NOT NULL REFERENCES public.tables(id),
 lifecycle bigint NOT NULL,hand_number bigint NOT NULL,custody_id uuid NOT NULL,generation uuid NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','accepted','never_started')), evidence_id uuid,
 UNIQUE(table_id,hand_number)
);
CREATE TABLE smarter_private.f06_hand_dispatch(permit_id uuid PRIMARY KEY REFERENCES smarter_private.f06_hand_permits,xid bigint NOT NULL);
CREATE UNIQUE INDEX f06_one_hand ON smarter_private.f06_hand_permits(table_id) WHERE state='reserved';

CREATE FUNCTION smarter_private.f06_authority(t uuid,g uuid, take_lock boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager'
 OR NULLIF(current_setting('app.smarter_tournament_id',true),'')::uuid IS DISTINCT FROM t
 OR NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid IS DISTINCT FROM g OR t IS NULL OR g IS NULL THEN
 RAISE EXCEPTION 'F06_PROTOCOL2_REQUIRED' USING ERRCODE='42501'; END IF;
 IF take_lock THEN
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds' FOR KEY SHARE;
 ELSE
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds';
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_LEASE_FENCED' USING ERRCODE='42501'; END IF;
END $$;

-- Triggers can run after their physical row was acquired. Never WAIT on a
-- newly acquired earlier lane there: fail/retry instead of row->lane inversion.
CREATE FUNCTION smarter_private.f06_try_lane(t uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF t IS NOT NULL AND (NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0))) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF;
END $$;
CREATE FUNCTION smarter_private.f06_prefix(t uuid,g uuid,users uuid[],ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE u uuid;
BEGIN
 PERFORM smarter_private.f06_authority(t,g);
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(t);
 PERFORM smarter_private.f06_authority(t,g,false);
 FOR u IN SELECT DISTINCT x FROM unnest(users) x ORDER BY x LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)); END LOOP;
 PERFORM 1 FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t AND user_id=ANY(users) ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
 WHERE tb.tournament_id=t AND (s.user_id=ANY(users) OR s.table_id=ANY(ids)) ORDER BY s.id FOR UPDATE OF s;
END $$;
CREATE FUNCTION smarter_private.f06_lock_break(t uuid,g uuid,b uuid,extra uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE users uuid[];ids uuid[];
BEGIN
 PERFORM smarter_private.f06_authority(t,g);
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(t);
 -- Read active destinations only AFTER acquiring the lane, then physical rows.
 SELECT array_agg(user_id ORDER BY user_id) INTO users FROM smarter_private.f06_members WHERE break_id=b;
 SELECT array_agg(DISTINCT x) INTO ids FROM (
 SELECT source_table_id x FROM smarter_private.f06_operations WHERE break_id=b AND tournament_id=t
 UNION SELECT destination_table_id FROM smarter_private.f06_attempts WHERE break_id=b UNION SELECT extra) q;
 PERFORM smarter_private.f06_prefix(t,g,COALESCE(users,'{}'),ids);
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE break_id=b AND tournament_id=t) THEN
 RAISE EXCEPTION 'F06_UNKNOWN_BREAK' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM smarter_private.f06_operations WHERE break_id=b FOR UPDATE;
END $$;
CREATE FUNCTION smarter_private.f06_state(b uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
 SELECT jsonb_build_object('ok',true,'reason',NULL,'break_id',o.break_id,'tournament_id',o.tournament_id,'source_table_id',o.source_table_id,
 'lifecycle',o.lifecycle::text,'state',o.state,'revision',o.revision::text,'custody_id',o.custody_id,'custody_generation',o.custody_generation,
 'terminal_handoff_required',upper(t.status)<>'RUNNING' AND o.state NOT IN ('close_confirmed','acknowledged'),
 'members',COALESCE((SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('request_id',initial.request_id,'active_request_id',a.request_id,'winner_request_id',w.request_id,
 'destination_table_id',COALESCE(a.destination_table_id,w.destination_table_id),'destination_seat_number',COALESCE(a.destination_seat_number,w.destination_seat_number),
 'original_destination_table_id',initial.destination_table_id,'original_destination_seat_number',initial.destination_seat_number,'winning_receipt',w.receipt,'attempt_revision',COALESCE(a.revision,w.revision)) ORDER BY m.user_id)
 FROM smarter_private.f06_members m JOIN smarter_private.f06_attempts initial ON initial.break_id=m.break_id AND initial.user_id=m.user_id AND initial.revision=1 LEFT JOIN smarter_private.f06_attempts a ON a.break_id=m.break_id AND a.user_id=m.user_id AND a.state='active'
 LEFT JOIN smarter_private.f06_attempts w ON w.break_id=m.break_id AND w.user_id=m.user_id AND w.state='winner' WHERE m.break_id=o.break_id),'[]'::jsonb))
 FROM smarter_private.f06_operations o JOIN public.tournaments t ON t.id=o.tournament_id WHERE o.break_id=b
$$;
CREATE FUNCTION public.fn_f06_table_state(p_tournament_id uuid,p_lease_generation uuid,p_table_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE v jsonb; recovery jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 recovery:=public.fn_f06_hand_number_state(p_tournament_id,p_lease_generation,p_table_id);
 SELECT jsonb_build_object('ok',true,'table_id',t.id,'lifecycle',t.f06_lifecycle::text,'excluded',o.break_id IS NOT NULL,'break_id',o.break_id) INTO v
 FROM public.tables t LEFT JOIN smarter_private.f06_operations o ON o.source_table_id=t.id AND o.state<>'acknowledged'
 WHERE t.id=p_table_id AND t.tournament_id=p_tournament_id;
 IF v IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','table_not_found'); END IF;
 RETURN v||jsonb_build_object('hand_number_high_water',recovery->'used_hand_number_max',
 'unresolved_permits',CASE WHEN recovery->'unresolved_permit'='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(recovery->'unresolved_permit') END,
 'unresolved_overflow',false,'can_reserve',recovery->'can_reserve','blocked_reason',recovery->'blocked_reason');
END $$;
-- Recovery projection only: it does not allocate a number or settle an old permit.
CREATE FUNCTION public.fn_f06_hand_number_state(p_tournament_id uuid,p_lease_generation uuid,p_table_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE life bigint; used bigint; pending jsonb; blocked text;
BEGIN
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT tb.f06_lifecycle,CASE WHEN upper(t.status)<>'RUNNING' THEN 'tournament_not_running'
 WHEN lower(tb.status)='closed' OR COALESCE(tb.is_deleted,false) THEN 'table_closed' END INTO life,blocked
 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id
 WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','table_not_found'); END IF;
 SELECT GREATEST(0,
 COALESCE((SELECT max(hand_number) FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id),0),
 COALESCE((SELECT max(hand_number) FROM public.hand_atomic_commits WHERE table_id=p_table_id),0),
 COALESCE((SELECT max(hand_number) FROM public.hand_history WHERE table_id=p_table_id),0)) INTO used;
 SELECT jsonb_build_object('permit_id',h.permit_id,'tournament_id',h.tournament_id,'table_id',h.table_id,
 'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text,'custody_id',h.custody_id,'generation',h.generation,'state',h.state)
 INTO pending FROM smarter_private.f06_hand_permits h WHERE h.table_id=p_table_id AND h.state='reserved';
 IF pending IS NOT NULL THEN blocked:='hand_permit_unresolved';
 ELSIF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=p_table_id AND state<>'acknowledged') THEN blocked:='source_excluded';
 ELSIF used=9223372036854775807 THEN blocked:='hand_number_exhausted'; END IF;
 RETURN jsonb_build_object('ok',true,'table_id',p_table_id,'lifecycle',life::text,
 'used_hand_number_max',used::text,'next_hand_number_candidate',CASE WHEN blocked IS NULL THEN (used+1)::text ELSE NULL END,
 'can_reserve',blocked IS NULL,'blocked_reason',blocked,'unresolved_permit',pending);
END $$;
CREATE FUNCTION public.fn_f06_request_park(p_tournament_id uuid,p_lease_generation uuid,p_break_id uuid,p_table_id uuid,p_lifecycle bigint,p_boundary_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE o smarter_private.f06_operations;
BEGIN
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id;
 IF FOUND THEN
 IF (o.tournament_id,o.source_table_id,o.lifecycle,o.boundary_id) IS DISTINCT FROM (p_tournament_id,p_table_id,p_lifecycle,p_boundary_id) THEN
 RAISE EXCEPTION 'F06_CHANGED_PARK_REPLAY' USING ERRCODE='22023'; END IF;
 RETURN smarter_private.f06_state(p_break_id); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND upper(status)='RUNNING') THEN
 RETURN jsonb_build_object('ok',false,'reason','tournament_not_running'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=p_table_id AND tournament_id=p_tournament_id AND f06_lifecycle=p_lifecycle
 AND NOT COALESCE(is_deleted,false) AND lower(status)<>'closed') THEN RAISE EXCEPTION 'F06_SOURCE_LIFECYCLE' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation)
 VALUES(p_break_id,p_tournament_id,p_table_id,p_lifecycle,p_boundary_id,p_lease_generation);
 RETURN smarter_private.f06_state(p_break_id);
END $$;
CREATE FUNCTION smarter_private.f06_validate_destination(t uuid,src uuid,dst uuid,chair integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
BEGIN
 IF src=dst OR chair IS NULL OR chair NOT BETWEEN 1 AND 10 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=dst AND tournament_id=t
 AND NOT COALESCE(is_deleted,false) AND lower(status)<>'closed' AND chair<=COALESCE(max_players,9))
 OR EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=dst AND seat_number=chair AND left_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=t AND table_id=dst AND seat_number=chair AND status IN ('registered','playing'))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=dst AND state<>'acknowledged') THEN
 RAISE EXCEPTION 'F06_CAPACITY_UNAVAILABLE' USING ERRCODE='55000'; END IF;
END $$;
CREATE FUNCTION public.fn_f06_begin_break(p_tournament_id uuid,p_lease_generation uuid,p_break_id uuid,p_members jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE o smarter_private.f06_operations; x record; norm jsonb; users uuid[];ids uuid[];
BEGIN
 IF jsonb_typeof(p_members) IS DISTINCT FROM 'array' OR jsonb_array_length(p_members) NOT BETWEEN 1 AND 10 THEN
 RAISE EXCEPTION 'F06_INVALID_MANIFEST' USING ERRCODE='22023'; END IF;
 SELECT jsonb_agg(value ORDER BY value->>'user_id') INTO norm FROM jsonb_array_elements(p_members);
 SELECT array_agg((value->>'user_id')::uuid),array_agg((value->>'destination_table_id')::uuid) INTO users,ids FROM jsonb_array_elements(norm);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id AND tournament_id=p_tournament_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_UNKNOWN_BREAK' USING ERRCODE='22023'; END IF;
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,users,array_append(ids,o.source_table_id));
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id FOR UPDATE;
 IF o.manifest IS NOT NULL THEN
 IF o.manifest IS DISTINCT FROM norm THEN RAISE EXCEPTION 'F06_CHANGED_MANIFEST' USING ERRCODE='22023'; END IF;
 RETURN smarter_private.f06_state(p_break_id); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=o.source_table_id AND state='reserved') THEN
 RETURN jsonb_build_object('ok',false,'reason','park_not_drained'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND upper(status)='RUNNING') THEN
 RETURN jsonb_build_object('ok',false,'reason','terminal_handoff_required'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=o.source_table_id AND f06_lifecycle=o.lifecycle AND lower(status)<>'closed' AND NOT COALESCE(is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_SOURCE_LIFECYCLE' USING ERRCODE='55000'; END IF;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=o.source_table_id AND left_at IS NULL)<>jsonb_array_length(norm)
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id AND table_id=o.source_table_id AND status IN ('playing','registered'))<>jsonb_array_length(norm)
 OR (SELECT count(DISTINCT member_user) FROM unnest(users) member_user)<>jsonb_array_length(norm) THEN
 RAISE EXCEPTION 'F06_WHOLE_ROSTER_REQUIRED' USING ERRCODE='22023'; END IF;
 FOR x IN SELECT * FROM jsonb_to_recordset(norm) AS m(user_id uuid,source_seat_id uuid,source_seat_number integer,occupancy_id uuid,request_id uuid,destination_table_id uuid,destination_seat_number integer) LOOP
 IF NOT EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tournament_players p ON p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number
 WHERE s.id=x.source_seat_id AND s.table_id=o.source_table_id AND s.user_id=x.user_id AND s.seat_number=x.source_seat_number AND s.occupancy_id=x.occupancy_id
 AND s.left_at IS NULL AND s.stack>0 AND s.stack::text NOT IN ('NaN','Infinity','-Infinity') AND p.tournament_id=p_tournament_id AND p.status='playing' AND abs(s.stack-p.chips::numeric)<=0.5)
 OR EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts WHERE request_id=x.request_id) THEN RAISE EXCEPTION 'F06_SOURCE_NOT_EXACT' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_validate_destination(p_tournament_id,o.source_table_id,x.destination_table_id,x.destination_seat_number);
 INSERT INTO smarter_private.f06_members VALUES(p_break_id,x.user_id,x.source_seat_id,x.source_seat_number,x.occupancy_id);
 INSERT INTO smarter_private.f06_attempts(request_id,break_id,user_id,revision,destination_table_id,destination_seat_number,generation)
 VALUES(x.request_id,p_break_id,x.user_id,1,x.destination_table_id,x.destination_seat_number,p_lease_generation);
 END LOOP;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=p_break_id GROUP BY destination_table_id,destination_seat_number HAVING count(*)>1) THEN
 RAISE EXCEPTION 'F06_DUPLICATE_DESTINATION' USING ERRCODE='22023'; END IF;
 UPDATE smarter_private.f06_operations SET manifest=norm,state='begun' WHERE break_id=p_break_id;
 RETURN smarter_private.f06_state(p_break_id);
END $$;
CREATE FUNCTION smarter_private.f06_move_guard(t uuid,u uuid,src uuid,dst uuid,chair integer,req uuid,mode text,seat uuid,occ uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE a smarter_private.f06_attempts;o smarter_private.f06_operations;m smarter_private.f06_members;g uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=dst AND state<>'acknowledged') THEN
 RAISE EXCEPTION 'F06_DESTINATION_EXCLUDED' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM smarter_private.f06_attempts WHERE request_id=req;
 IF NOT FOUND THEN
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=src AND state<>'acknowledged')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members mm JOIN smarter_private.f06_operations oo USING(break_id) WHERE oo.tournament_id=t AND mm.user_id=u AND oo.state<>'acknowledged'
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts w WHERE w.break_id=mm.break_id AND w.user_id=mm.user_id AND w.state='winner')) THEN
 RAISE EXCEPTION 'F06_UNBOUND_MOVE' USING ERRCODE='55000'; END IF;
 RETURN; END IF;
 -- The injected pre-lane prefix already acquired lease KEY SHARE for manager.
 -- Legacy/service direct calls never acquire a late lease here; reject them.
 g:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
 PERFORM smarter_private.f06_authority(t,g,false);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=a.break_id FOR UPDATE;
 SELECT * INTO m FROM smarter_private.f06_members WHERE break_id=a.break_id AND user_id=a.user_id;
 IF a.state<>'active' OR o.state<>'begun' OR mode<>'live_source'
 OR (o.tournament_id,a.user_id,o.source_table_id,a.destination_table_id,a.destination_seat_number,m.source_seat_id,m.occupancy_id)
 IS DISTINCT FROM (t,u,src,dst,chair,seat,occ)
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=src AND f06_lifecycle=o.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=a.break_id AND user_id=u AND state='winner') THEN
 RAISE EXCEPTION 'F06_ATTEMPT_FENCED_OR_SOURCE_CHANGED' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_dispatch VALUES(req,txid_current(),occ,seat,o.lifecycle);
END $$;
CREATE FUNCTION smarter_private.f06_receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE a smarter_private.f06_attempts;d smarter_private.f06_dispatch;o smarter_private.f06_operations;m smarter_private.f06_members;
BEGIN
 SELECT * INTO a FROM smarter_private.f06_attempts WHERE request_id=NEW.request_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO d FROM smarter_private.f06_dispatch WHERE request_id=NEW.request_id AND xid=txid_current();
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_RECEIPT_WITHOUT_DISPATCH' USING ERRCODE='55000'; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=a.break_id;
 SELECT * INTO m FROM smarter_private.f06_members WHERE break_id=a.break_id AND user_id=a.user_id;
 IF a.state<>'active' OR (NEW.tournament_id,NEW.user_id,NEW.source_table_id,NEW.destination_table_id,NEW.source_seat_id,NEW.source_seat_number,NEW.destination_seat_number,NEW.source_mode)
 IS DISTINCT FROM (o.tournament_id,a.user_id,o.source_table_id,a.destination_table_id,m.source_seat_id,m.source_seat_number,a.destination_seat_number,'live_source'::text) THEN
 RAISE EXCEPTION 'F06_RECEIPT_CONFLICT' USING ERRCODE='55000'; END IF;
 UPDATE smarter_private.f06_attempts SET state='winner',receipt=to_jsonb(NEW)||jsonb_build_object('source_occupancy_id',d.occupancy_id,'source_lifecycle',d.lifecycle::text,'break_id',a.break_id)
 WHERE request_id=NEW.request_id;
 DELETE FROM smarter_private.f06_dispatch WHERE request_id=NEW.request_id;
 RETURN NEW;
END $$;
CREATE TRIGGER f06_bind_move_receipt AFTER INSERT ON public.tournament_seat_move_receipts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_receipt_guard();
CREATE FUNCTION public.fn_f06_amend_attempt(p_tournament_id uuid,p_lease_generation uuid,p_break_id uuid,p_user_id uuid,p_expected_request_id uuid,p_amendment_id uuid,p_new_request_id uuid,p_destination_table_id uuid,p_destination_seat_number integer,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE a smarter_private.f06_attempts;o smarter_private.f06_operations;m smarter_private.f06_members;payload jsonb; prior smarter_private.f06_attempts;
BEGIN
 payload:=jsonb_build_object('break',p_break_id,'user',p_user_id,'predecessor',p_expected_request_id,'new',p_new_request_id,'destination',p_destination_table_id,'seat',p_destination_seat_number,'reason',p_reason);
 PERFORM smarter_private.f06_lock_break(p_tournament_id,p_lease_generation,p_break_id,p_destination_table_id);
 SELECT * INTO prior FROM smarter_private.f06_attempts WHERE amendment_id=p_amendment_id;
 IF FOUND THEN
 IF prior.amendment_payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'F06_CHANGED_AMENDMENT' USING ERRCODE='22023'; END IF;
 RETURN smarter_private.f06_state(p_break_id); END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id;
 SELECT * INTO m FROM smarter_private.f06_members WHERE break_id=p_break_id AND user_id=p_user_id;
 SELECT * INTO a FROM smarter_private.f06_attempts WHERE request_id=p_expected_request_id AND break_id=p_break_id AND user_id=p_user_id;
 IF NOT FOUND OR p_amendment_id IS NULL OR p_new_request_id IS NULL OR p_new_request_id=p_expected_request_id OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 512 THEN
 RAISE EXCEPTION 'F06_INVALID_AMENDMENT' USING ERRCODE='22023'; END IF;
 IF a.state IN ('winner','fenced') THEN RETURN smarter_private.f06_state(p_break_id); END IF;
 IF o.state<>'begun' OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND upper(status)='RUNNING') THEN
 RETURN jsonb_build_object('ok',false,'reason','terminal_handoff_required'); END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts WHERE request_id IN(p_expected_request_id,p_new_request_id)) THEN
 RAISE EXCEPTION 'F06_UNBOUND_RECEIPT_CONFLICT' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
 WHERE s.id=m.source_seat_id AND s.occupancy_id=m.occupancy_id AND s.left_at IS NULL AND s.user_id=p_user_id AND s.table_id=o.source_table_id AND t.f06_lifecycle=o.lifecycle) THEN
 RAISE EXCEPTION 'F06_SOURCE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_validate_destination(p_tournament_id,o.source_table_id,p_destination_table_id,p_destination_seat_number);
 UPDATE smarter_private.f06_attempts SET state='fenced' WHERE request_id=p_expected_request_id;
 INSERT INTO smarter_private.f06_attempts(request_id,break_id,user_id,revision,predecessor,amendment_id,amendment_payload,destination_table_id,destination_seat_number,generation)
 VALUES(p_new_request_id,p_break_id,p_user_id,a.revision+1,p_expected_request_id,p_amendment_id,payload,p_destination_table_id,p_destination_seat_number,p_lease_generation);
 RETURN smarter_private.f06_state(p_break_id);
END $$;
CREATE FUNCTION public.fn_f06_reconcile_break(p_tournament_id uuid,p_lease_generation uuid,p_break_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
BEGIN
 PERFORM smarter_private.f06_lock_break(p_tournament_id,p_lease_generation,p_break_id);
 -- Winners are bound in the SAME transaction by the original receipt trigger.
 -- A legacy receipt without that provenance cannot be promoted here.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_attempts a JOIN public.tournament_seat_move_receipts r USING(request_id) WHERE a.break_id=p_break_id AND a.state<>'winner') THEN
 RAISE EXCEPTION 'F06_UNBOUND_RECEIPT_CONFLICT' USING ERRCODE='55000'; END IF;
 RETURN smarter_private.f06_state(p_break_id);
END $$;
CREATE FUNCTION public.fn_f06_close_break(p_tournament_id uuid,p_lease_generation uuid,p_break_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE o smarter_private.f06_operations;v jsonb;
BEGIN
 PERFORM smarter_private.f06_lock_break(p_tournament_id,p_lease_generation,p_break_id);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id;
 IF o.state IN ('close_confirmed','acknowledged') THEN RETURN smarter_private.f06_state(p_break_id); END IF;
 IF o.state<>'begun' OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=p_break_id AND state='active')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE break_id=p_break_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=m.break_id AND a.user_id=m.user_id AND a.state='winner')) THEN
 RETURN jsonb_build_object('ok',false,'reason','members_unresolved'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=o.source_table_id AND f06_lifecycle=o.lifecycle) THEN RAISE EXCEPTION 'F06_LIFECYCLE_CHANGED' USING ERRCODE='55000'; END IF;
 v:=public.fn_close_empty_tournament_table(p_tournament_id,o.source_table_id,p_lease_generation);
 IF (v->>'ok')::boolean IS DISTINCT FROM true THEN RETURN v; END IF;
 UPDATE smarter_private.f06_operations SET state='close_confirmed',close_receipt=v WHERE break_id=p_break_id;
 RETURN smarter_private.f06_state(p_break_id);
END $$;
CREATE FUNCTION public.fn_f06_claim_custody(p_tournament_id uuid,p_lease_generation uuid,p_break_id uuid,p_custody_id uuid,p_expected_revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE o smarter_private.f06_operations;
BEGIN
 PERFORM smarter_private.f06_lock_break(p_tournament_id,p_lease_generation,p_break_id);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id;
 IF o.custody_id=p_custody_id AND o.custody_generation=p_lease_generation THEN RETURN smarter_private.f06_state(p_break_id); END IF;
 IF o.revision IS DISTINCT FROM p_expected_revision OR o.state='acknowledged' THEN RETURN jsonb_build_object('ok',false,'reason','custody_revision_conflict'); END IF;
 IF p_custody_id IS NULL THEN RAISE EXCEPTION 'F06_CUSTODY_REQUIRED' USING ERRCODE='22023'; END IF;
 UPDATE smarter_private.f06_operations SET custody_id=p_custody_id,custody_generation=p_lease_generation,revision=revision+1 WHERE break_id=p_break_id;
 RETURN smarter_private.f06_state(p_break_id);
END $$;
CREATE FUNCTION public.fn_f06_ack_cleanup(p_tournament_id uuid,p_lease_generation uuid,p_break_id uuid,p_custody_id uuid,p_revision bigint,p_cleanup_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE o smarter_private.f06_operations;
BEGIN
 PERFORM smarter_private.f06_lock_break(p_tournament_id,p_lease_generation,p_break_id);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id;
 IF (o.custody_id,o.custody_generation,o.revision) IS DISTINCT FROM(p_custody_id,p_lease_generation,p_revision) OR p_custody_id IS NULL THEN
 RETURN jsonb_build_object('ok',false,'reason','custody_revision_conflict'); END IF;
 IF o.state NOT IN ('close_confirmed','acknowledged') THEN RETURN jsonb_build_object('ok',false,'reason','terminal_handoff_required'); END IF;
 IF p_cleanup_kind NOT IN ('retired','verified_absent') OR p_cleanup_kind IS NULL THEN RAISE EXCEPTION 'F06_CLEANUP_KIND' USING ERRCODE='22023'; END IF;
 IF o.state='acknowledged' AND o.cleanup_kind IS DISTINCT FROM p_cleanup_kind THEN RAISE EXCEPTION 'F06_CHANGED_ACK' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=o.source_table_id AND f06_lifecycle=o.lifecycle AND lower(status)='closed') THEN RAISE EXCEPTION 'F06_LIFECYCLE_CHANGED' USING ERRCODE='55000'; END IF;
 UPDATE smarter_private.f06_operations SET state='acknowledged',cleanup_kind=p_cleanup_kind WHERE break_id=p_break_id;
 RETURN smarter_private.f06_state(p_break_id);
END $$;
CREATE FUNCTION public.fn_f06_discover_breaks(p_tournament_id uuid,p_lease_generation uuid,p_expected_cursor_revision bigint,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE c smarter_private.f06_cursors;items jsonb;last_id bigint;wrapped boolean:=false;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 32 OR p_limit IS NULL THEN RAISE EXCEPTION 'F06_PAGE_SIZE' USING ERRCODE='22023'; END IF;
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}','{}');
 INSERT INTO smarter_private.f06_cursors(tournament_id) VALUES(p_tournament_id) ON CONFLICT DO NOTHING;
 SELECT * INTO c FROM smarter_private.f06_cursors WHERE tournament_id=p_tournament_id FOR UPDATE;
 IF c.revision IS DISTINCT FROM p_expected_cursor_revision THEN RETURN jsonb_build_object('ok',false,'reason','cursor_revision_conflict','cursor_revision',c.revision::text,'wrapped',false,'operations','[]'::jsonb); END IF;
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id AND state<>'acknowledged' AND ordinal>c.ordinal) THEN c.ordinal:=0;wrapped:=true; END IF;
 SELECT jsonb_agg(smarter_private.f06_state(q.break_id) ORDER BY q.ordinal),max(q.ordinal) INTO items,last_id FROM
 (SELECT break_id,ordinal FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id AND state<>'acknowledged' AND ordinal>c.ordinal ORDER BY ordinal LIMIT p_limit) q;
 UPDATE smarter_private.f06_cursors SET ordinal=COALESCE(last_id,0),revision=revision+1 WHERE tournament_id=p_tournament_id;
 RETURN jsonb_build_object('ok',true,'reason',NULL,'cursor_revision',(c.revision+1)::text,'wrapped',wrapped,'operations',COALESCE(items,'[]'::jsonb));
END $$;
CREATE FUNCTION smarter_private.f06_table_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE blocked boolean; reopening boolean;
BEGIN
 IF TG_OP='INSERT' THEN NEW.f06_lifecycle:=nextval('smarter_private.f06_lifecycle_seq');RETURN NEW; END IF;
 PERFORM smarter_private.f06_try_lane(OLD.tournament_id);
 SELECT EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=OLD.id AND state<>'acknowledged') INTO blocked;
 IF TG_OP='DELETE' THEN
 IF blocked THEN RAISE EXCEPTION 'F06_PENDING_CUSTODY' USING ERRCODE='55000'; END IF; RETURN OLD; END IF;
 reopening:=(lower(COALESCE(OLD.status,'')) IN ('closed','completed','cancelled','finished') OR OLD.lifecycle='closed' OR COALESCE(OLD.is_deleted,false))
 AND NOT (lower(COALESCE(NEW.status,'')) IN ('closed','completed','cancelled','finished') OR NEW.lifecycle='closed' OR COALESCE(NEW.is_deleted,false));
 IF NEW.f06_lifecycle IS DISTINCT FROM OLD.f06_lifecycle THEN RAISE EXCEPTION 'F06_LIFECYCLE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF blocked AND (reopening OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id) THEN
 RAISE EXCEPTION 'F06_PENDING_CUSTODY' USING ERRCODE='55000'; END IF;
 IF reopening THEN NEW.f06_lifecycle:=nextval('smarter_private.f06_lifecycle_seq'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a00_f06_lifecycle BEFORE INSERT OR DELETE OR UPDATE OF id,tournament_id,status,lifecycle,is_deleted,f06_lifecycle ON public.tables
FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_table_guard();
CREATE FUNCTION smarter_private.f06_source_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 PERFORM smarter_private.f06_try_lane(t);
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state<>'acknowledged');
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,u,oldj->>'seat_number') IS NOT DISTINCT FROM(dst,(oldj->>'user_id')::uuid,newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id,user_id,seat_number,left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id,user_id,seat_number,status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
CREATE FUNCTION public.fn_f06_begin_hand(p_tournament_id uuid,p_lease_generation uuid,p_table_id uuid,p_lifecycle bigint,p_permit_id uuid,p_hand_number bigint,p_custody_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id;
 IF FOUND THEN
 IF (h.tournament_id,h.table_id,h.lifecycle,h.hand_number,h.custody_id,h.generation) IS DISTINCT FROM(p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) THEN
 RAISE EXCEPTION 'F06_CHANGED_HAND_PERMIT' USING ERRCODE='22023'; END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',h.state='reserved','lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=p_table_id AND state<>'acknowledged') THEN
 RETURN jsonb_build_object('ok',false,'reason','source_excluded'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id WHERE tb.id=p_table_id AND t.id=p_tournament_id AND upper(t.status)='RUNNING' AND tb.f06_lifecycle=p_lifecycle
 AND lower(tb.status)<>'closed' AND NOT COALESCE(tb.is_deleted,false)) THEN RAISE EXCEPTION 'F06_HAND_LIFECYCLE' USING ERRCODE='55000'; END IF;
 IF p_hand_number IS NULL OR p_hand_number<1 OR p_custody_id IS NULL THEN RAISE EXCEPTION 'F06_HAND_IDENTITY' USING ERRCODE='22023'; END IF;
 -- Hand numbers are permanently unique for the physical table, across every lifecycle.
 -- Exact permit replay above is lawful; a new permit cannot adopt historical evidence.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number=p_hand_number) THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_number_already_used'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND state='reserved') THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_permit_unresolved'); END IF;
 INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
 VALUES(p_permit_id,p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) RETURNING * INTO h;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $$;
-- Evidence adapter only accepts the canonical accepted-hand record. It never
-- equates hand_history existence alone with completion of atomic obligations.
CREATE FUNCTION public.fn_f06_finish_hand(p_tournament_id uuid,p_lease_generation uuid,p_permit_id uuid,p_outcome text,p_evidence_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id AND tournament_id=p_tournament_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_UNKNOWN_PERMIT' USING ERRCODE='22023'; END IF;
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[h.table_id]);
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id FOR UPDATE;
 IF h.state<>'reserved' THEN
 IF h.state IS DISTINCT FROM p_outcome OR h.evidence_id IS DISTINCT FROM p_evidence_id THEN RAISE EXCEPTION 'F06_CHANGED_HAND_OUTCOME' USING ERRCODE='22023'; END IF;
 ELSE
 IF p_outcome='accepted' THEN
 IF NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number AND c.hand_id=p_evidence_id AND c.post_commit_completed_at IS NOT NULL) THEN
 RAISE EXCEPTION 'F06_HAND_EVIDENCE_REQUIRED' USING ERRCODE='55000'; END IF;
 ELSIF p_outcome='never_started' THEN
 -- Lease must have drained the exact original custody under its held both-map
 -- reservation before claiming this park's new custody receipt. A successor
 -- generation is not evidence that the original dealer never started.
 IF h.generation IS DISTINCT FROM p_lease_generation OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
 WHERE o.source_table_id=h.table_id AND o.lifecycle=h.lifecycle AND o.state='park_requested' AND o.custody_id=p_evidence_id
 AND o.custody_generation=p_lease_generation AND o.revision>0)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=p_permit_id) THEN
 RAISE EXCEPTION 'F06_EXACT_QUIESCENT_CUSTODY_REQUIRED' USING ERRCODE='55000'; END IF;
 ELSE RAISE EXCEPTION 'F06_HAND_OUTCOME' USING ERRCODE='22023'; END IF;
 UPDATE smarter_private.f06_hand_permits SET state=p_outcome,evidence_id=p_evidence_id WHERE permit_id=p_permit_id RETURNING * INTO h;
 END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $$;
CREATE FUNCTION smarter_private.f06_accept_hand() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
BEGIN
 IF NEW.post_commit_completed_at IS NOT NULL THEN
 UPDATE smarter_private.f06_hand_permits SET state='accepted',evidence_id=NEW.hand_id
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number AND state='reserved';
 DELETE FROM smarter_private.f06_hand_dispatch d USING smarter_private.f06_hand_permits h WHERE h.permit_id=d.permit_id AND h.table_id=NEW.table_id AND h.hand_number=NEW.hand_number;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zzzz_f06_accepted_hand AFTER INSERT OR UPDATE OF post_commit_completed_at ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_accept_hand();
-- All durable metadata is private. Only the SECURITY DEFINER RPC surface is
-- service-callable; new bound mutations additionally require protocol2.
DO $$ DECLARE x record;BEGIN
 FOR x IN SELECT tablename FROM pg_tables WHERE schemaname='smarter_private' AND tablename LIKE 'f06_%' LOOP
 EXECUTE format('ALTER TABLE smarter_private.%I ENABLE ROW LEVEL SECURITY',x.tablename);
 EXECUTE format('REVOKE ALL ON smarter_private.%I FROM PUBLIC,anon,authenticated,service_role',x.tablename);
 END LOOP;
 FOR x IN SELECT p.oid::regprocedure sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='smarter_private' AND p.proname LIKE 'f06_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',x.sig);END LOOP;
 FOR x IN SELECT p.oid::regprocedure sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'fn_f06_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',x.sig);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',x.sig);END LOOP;
 REVOKE ALL ON SEQUENCE smarter_private.f06_lifecycle_seq FROM PUBLIC,anon,authenticated,service_role;
END $$;

CREATE FUNCTION smarter_private.f06_immutable_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'F06_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND ((to_jsonb(OLD)-'state'-'evidence_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'evidence_id') OR to_jsonb(OLD)->>'state'<>'reserved') THEN
 RAISE EXCEPTION 'F06_HAND_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_members' OR
 (TG_TABLE_NAME='f06_attempts' AND ((to_jsonb(OLD)-'state'-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'receipt') OR to_jsonb(OLD)->>'state'<>'active')) OR
 (TG_TABLE_NAME='f06_operations' AND ((to_jsonb(OLD)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt') OR (to_jsonb(OLD)->'manifest'<>'null'::jsonb AND to_jsonb(OLD)->'manifest' IS DISTINCT FROM to_jsonb(NEW)->'manifest') OR (to_jsonb(OLD)->'close_receipt'<>'null'::jsonb AND to_jsonb(OLD)->'close_receipt' IS DISTINCT FROM to_jsonb(NEW)->'close_receipt'))) THEN
 RAISE EXCEPTION 'F06_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER f06_members_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_members FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity();
CREATE TRIGGER f06_attempts_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_attempts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity();
CREATE TRIGGER f06_operations_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_operations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity();
CREATE TRIGGER f06_hand_permits_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity();
CREATE FUNCTION smarter_private.f06_hand_dispatch_guard(tid uuid,hn bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
 IF h.state='never_started' THEN RAISE EXCEPTION 'F06_HAND_PERMIT_FENCED' USING ERRCODE='55000'; END IF;
 IF h.state='reserved' THEN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 INSERT INTO smarter_private.f06_hand_dispatch VALUES(h.permit_id,txid_current()) ON CONFLICT(permit_id) DO UPDATE SET xid=EXCLUDED.xid;
 END IF;
 ELSIF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=tid AND state<>'acknowledged') THEN
 RAISE EXCEPTION 'F06_UNPERMITTED_HAND' USING ERRCODE='55000';
 END IF;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_immutable_identity(),smarter_private.f06_hand_dispatch_guard(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;

-- Preserve existing table insert privileges: token allocation alone grants no table write.
GRANT EXECUTE ON FUNCTION smarter_private.f06_new_lifecycle() TO anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_move_tournament_player(p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid, p_destination_table_id uuid, p_destination_seat_number integer, p_request_id uuid, p_source_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_tp public.tournament_players%ROWTYPE;
  v_source public.table_seats%ROWTYPE;
  v_destination public.table_seats%ROWTYPE;
  v_destination_id uuid;
  v_token uuid;
  v_moved_at timestamptz;
  v_rows integer;
  v_live_count integer;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_move_tournament_player requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_destination_table_id IS NULL
     OR p_request_id IS NULL OR p_source_table_id=p_destination_table_id
     OR p_source_mode NOT IN ('live_source','closed_orphan')
     OR p_destination_seat_number NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid tournament move identity' USING ERRCODE='22023';
  END IF;

  IF current_setting('app.smarter_data_actor',true)='tournament-manager' THEN
    PERFORM smarter_private.f06_authority(p_tournament_id,NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid);
  END IF;
  -- HOTFIX EDIT (b): G -> T via the 20260910035245 helper, not the raw global key.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock(
    hashtextextended('table_cap:'||p_user_id::text,0));

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NOT NULL THEN
    IF (v_result->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
       OR (v_result->>'user_id')::uuid IS DISTINCT FROM p_user_id
       OR (v_result->>'source_table_id')::uuid IS DISTINCT FROM p_source_table_id
       OR (v_result->>'destination_table_id')::uuid
            IS DISTINCT FROM p_destination_table_id
       OR v_result->>'source_mode' IS DISTINCT FROM p_source_mode
       OR (v_result->>'destination_seat_number')::integer
            IS DISTINCT FROM p_destination_seat_number THEN
      RAISE EXCEPTION 'tournament move request id belongs to another operation'
        USING ERRCODE='23505';
    END IF;
    RETURN v_result||jsonb_build_object('replayed',true);
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;
  IF upper(COALESCE(v_t.status,''))<>'RUNNING' THEN
    RAISE EXCEPTION 'tournament % is not RUNNING',p_tournament_id
      USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_tp FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_tp.status<>'playing'
     OR v_tp.table_id IS DISTINCT FROM p_source_table_id THEN
    RAISE EXCEPTION 'tournament move source roster is not exact'
      USING ERRCODE='P0404';
  END IF;

  PERFORM tb.id FROM public.tables tb
   WHERE tb.id IN (p_source_table_id,p_destination_table_id)
   ORDER BY tb.id FOR UPDATE;
  IF (SELECT count(*) FROM public.tables tb
       WHERE tb.id IN (p_source_table_id,p_destination_table_id)
         AND tb.tournament_id=p_tournament_id)<>2 THEN
    RAISE EXCEPTION 'tournament move tables do not share the event'
      USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_destination_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed'
         OR p_destination_seat_number>COALESCE(tb.max_players,9))) THEN
    RAISE EXCEPTION 'tournament move destination is not open'
      USING ERRCODE='55000';
  END IF;
  IF p_source_mode='closed_orphan' AND NOT EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_source_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed')) THEN
    RAISE EXCEPTION 'closed-orphan move source is not closed'
      USING ERRCODE='55000';
  END IF;
  IF p_source_mode='live_source' AND EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_source_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed')) THEN
    RAISE EXCEPTION 'live-source move source is closed'
      USING ERRCODE='55000';
  END IF;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     AND s.left_at IS NULL;
  IF v_live_count<>1 THEN
    RAISE EXCEPTION 'tournament move requires exactly one live source seat'
      USING ERRCODE='P0404';
  END IF;

  SELECT s.* INTO v_source FROM public.table_seats s
   WHERE s.table_id=p_source_table_id AND s.user_id=p_user_id
     AND s.left_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_source.seat_number IS DISTINCT FROM v_tp.seat_number
     OR v_source.stack IS NULL
     OR v_source.stack::text IN ('NaN','Infinity','-Infinity')
     OR v_source.stack<=0
     OR abs(v_source.stack-v_tp.chips::numeric)>0.5 THEN
    RAISE EXCEPTION 'tournament move source chips or coordinates are not exact'
      USING ERRCODE='P0404';
  END IF;

  SELECT s.* INTO v_destination FROM public.table_seats s
   WHERE s.table_id=p_destination_table_id
     AND s.seat_number=p_destination_seat_number FOR UPDATE;
  IF FOUND AND v_destination.left_at IS NULL THEN
    RAISE EXCEPTION 'tournament move destination seat is occupied'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.user_id<>p_user_id
       AND tp.status IN ('registered','playing')
       AND tp.table_id=p_destination_table_id
       AND tp.seat_number=p_destination_seat_number) THEN
    RAISE EXCEPTION 'tournament move destination roster is occupied'
      USING ERRCODE='23505';
  END IF;

  PERFORM smarter_private.f06_move_guard(p_tournament_id,p_user_id,p_source_table_id,p_destination_table_id,p_destination_seat_number,p_request_id,p_source_mode,v_source.id,v_source.occupancy_id);
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'move',p_user_id);
  v_moved_at:=clock_timestamp();
  BEGIN
    UPDATE public.table_seats s
       SET stack=0,left_at=v_moved_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,
           scheduled_leave_hands=NULL
     WHERE s.id=v_source.id AND s.left_at IS NULL
       AND s.stack=v_source.stack;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'tournament move lost its locked source seat'
        USING ERRCODE='40001';
    END IF;

    IF v_destination.id IS NULL THEN
      INSERT INTO public.table_seats(
        table_id,seat_number,user_id,player_id,member_id,stack,
        is_sitting_out,is_away,joined_at,horse_id,scheduled_leave_hands,
        left_at,status,leave_pending,auto_rebuy,time_bank_remaining,
        time_bank_uses_remaining,sit_out_at,entry_hold,entry_post_agreed)
      VALUES(
        p_destination_table_id,p_destination_seat_number,p_user_id,
        v_source.player_id,v_source.member_id,v_source.stack,
        false,false,v_moved_at,v_source.horse_id,NULL,NULL,'active',false,
        v_source.auto_rebuy,v_source.time_bank_remaining,
        v_source.time_bank_uses_remaining,NULL,NULL,
        v_source.entry_post_agreed)
      RETURNING id INTO v_destination_id;
    ELSE
      UPDATE public.table_seats s
         SET user_id=p_user_id,player_id=v_source.player_id,
             member_id=v_source.member_id,stack=v_source.stack,
             is_sitting_out=false,is_away=false,joined_at=v_moved_at,
             horse_id=v_source.horse_id,scheduled_leave_hands=NULL,
             left_at=NULL,status='active',leave_pending=false,
             auto_rebuy=v_source.auto_rebuy,
             time_bank_remaining=v_source.time_bank_remaining,
             time_bank_uses_remaining=v_source.time_bank_uses_remaining,
             sit_out_at=NULL,entry_hold=NULL,
             entry_post_agreed=v_source.entry_post_agreed
       WHERE s.id=v_destination.id AND s.left_at IS NOT NULL
       RETURNING id INTO v_destination_id;
      IF v_destination_id IS NULL THEN
        RAISE EXCEPTION 'tournament move could not reuse destination seat'
          USING ERRCODE='40001';
      END IF;
    END IF;

    UPDATE public.tournament_players tp
       SET table_id=p_destination_table_id,
           seat_number=p_destination_seat_number
     WHERE tp.id=v_tp.id AND tp.status='playing'
       AND tp.table_id=p_source_table_id
       AND tp.seat_number=v_source.seat_number;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'tournament move lost its locked roster row'
        USING ERRCODE='40001';
    END IF;

    UPDATE public.tables tb
       SET current_players=(
         SELECT count(*) FROM public.table_seats s
          WHERE s.table_id=tb.id AND s.left_at IS NULL),
           updated_at=now()
     WHERE tb.id IN (p_source_table_id,p_destination_table_id);

    IF (SELECT count(*) FROM public.table_seats s
        JOIN public.tables tb ON tb.id=s.table_id
       WHERE tb.tournament_id=p_tournament_id
         AND s.user_id=p_user_id AND s.left_at IS NULL)<>1
       OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_destination_id
            AND s.table_id=p_destination_table_id
            AND s.seat_number=p_destination_seat_number
            AND s.user_id=p_user_id AND s.left_at IS NULL
            AND s.stack=v_source.stack)
       OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_source.id AND s.left_at=v_moved_at AND s.stack=0)
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.id=v_tp.id AND tp.status='playing'
            AND tp.table_id=p_destination_table_id
            AND tp.seat_number=p_destination_seat_number) THEN
      RAISE EXCEPTION 'tournament move final proof is not exact'
        USING ERRCODE='P0404';
    END IF;

    INSERT INTO public.tournament_seat_move_receipts(
      request_id,tournament_id,user_id,source_table_id,destination_table_id,
      source_seat_id,destination_seat_id,source_seat_number,
      destination_seat_number,source_mode,stack,moved_at)
    VALUES(
      p_request_id,p_tournament_id,p_user_id,p_source_table_id,
      p_destination_table_id,v_source.id,v_destination_id,
      v_source.seat_number,p_destination_seat_number,p_source_mode,
      v_source.stack,v_moved_at);

    -- HOTFIX EDIT (a): the consuming guard trigger is not installed; rows are deleted, not counted.
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'tournament move receipt did not persist'
      USING ERRCODE='P0404';
  END IF;
  RETURN v_result||jsonb_build_object('replayed',false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid, p_post_commit_obligations jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_diamond boolean := false;
  v_hand_id uuid;
  v_request_hash text;
  v_hash text;
  v_existing_request_hash text;
  v_existing_hash text;
  v_payload jsonb;
  v_club_id uuid;
  v_tournament_id uuid;
  v_item jsonb;
  v_expected integer;
  v_updated integer;
  v_row_count integer;
  v_exact_seat_generation boolean := false;
BEGIN
  -- This public 12-argument door is the outermost accepted-hand authority.
  -- Take the lifecycle root before its preserved exact-generation core can
  -- lock a lease, tournament or table. The owner-only nine-argument core
  -- re-enters this shared transaction lock defensively; that acquisition is
  -- harmless and keeps the private core safe from future owner-only callers.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM smarter_private.f06_hand_dispatch_guard(p_table_id,p_hand_number);

  IF jsonb_typeof(p_post_commit_obligations) IS DISTINCT FROM 'object'
     OR p_post_commit_obligations->>'version' <> '1'
     OR jsonb_typeof(p_post_commit_obligations->'time_banks') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'promo_playthrough') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'insurance') IS DISTINCT FROM 'array'
     OR NOT (p_post_commit_obligations ? 'pending_addons')
     OR NOT (p_post_commit_obligations ? 'rake')
     OR NOT (p_post_commit_obligations ? 'bbj_contribution')
     OR p_post_commit_obligations ? 'accepted_hand_facts'
     OR jsonb_typeof(p_post_commit_obligations->'rake') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'pending_addons') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  -- Database-first expansion. The previous engine may send an entirely legacy
  -- roster while it drains, but exact and legacy identities never mix.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_stack_seat_generation)';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (mixed_stack_seat_generation_protocol)';
    END IF;
    SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
      INTO v_exact_seat_generation
      FROM jsonb_array_elements(p_stacks) x;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
          OR (x ? 'seat_id') IS DISTINCT FROM v_exact_seat_generation
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_time_bank_seat_generation)';
    END IF;

    IF v_exact_seat_generation AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_stacks) s
          WHERE s->>'user_id' = x->>'user_id'
            AND s->>'seat_id' = x->>'seat_id'
            AND (s->>'seat_joined_at')::timestamptz =
                (x->>'seat_joined_at')::timestamptz
       )
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_generation_mismatch)';
    END IF;
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'pot_size') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_hand_row->'big_blind') IS DISTINCT FROM 'number'
     OR COALESCE(p_rake, 0) < 0
     OR COALESCE(p_bbj, 0) < 0
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'contributions')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'insurance')
          IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_accepted_post_commit_facts)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'uses_remaining') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'seconds_remaining') IS DISTINCT FROM 'number'
        OR (x->>'uses_remaining') !~ '^[0-9]+$'
        OR (x->>'seconds_remaining') !~ '^[0-9]+$'
        OR CASE WHEN (x->>'uses_remaining') ~ '^[0-9]+$'
                THEN (x->>'uses_remaining')::numeric > 2147483647 ELSE false END
        OR CASE WHEN (x->>'seconds_remaining') ~ '^[0-9]+$'
                THEN (x->>'seconds_remaining')::numeric > 2147483647 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'wagered') IS DISTINCT FROM 'number'
        OR CASE WHEN jsonb_typeof(x->'wagered') = 'number'
                THEN (x->>'wagered')::numeric <= 0 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'player_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'equity_percent') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'premium') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'insured_amount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'payout') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'player_won') IS DISTINCT FROM 'boolean'
        OR COALESCE(x->>'kind', '') NOT IN ('insurance', 'ev_cashout')
        OR CASE WHEN jsonb_typeof(x->'equity_percent') = 'number'
                THEN (x->>'equity_percent')::numeric NOT BETWEEN 0 AND 100 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'premium') = 'number'
                THEN (x->>'premium')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'insured_amount') = 'number'
                THEN (x->>'insured_amount')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'payout') = 'number'
                THEN (x->>'payout')::numeric < 0 ELSE false END
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_item)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake'->'amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'bbj') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'pot') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'num_players') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'contributions') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'returned_uncalled') IS DISTINCT FROM 'object'
       OR (p_post_commit_obligations->'rake'->>'num_players') !~ '^[0-9]+$'
       OR COALESCE((p_post_commit_obligations->'rake'->>'amount')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'bbj')::numeric, 0) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'pot')::numeric, -1) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0)
            > 2147483647
       OR (p_post_commit_obligations->'rake'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_rake)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'amount')
         IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'big_blind')
         IS DISTINCT FROM 'number'
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric, 0)
            <= 0
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric, 0)
            <= 0
       OR (p_post_commit_obligations->'bbj_contribution'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_bbj)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled')
         IS DISTINCT FROM 'boolean'
       OR CASE
            WHEN jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled') = 'boolean'
            THEN COALESCE(
              (p_post_commit_obligations->'pending_addons'->>'enabled')::boolean,
              false
            ) IS NOT TRUE
            ELSE false
          END
       OR jsonb_typeof(p_post_commit_obligations->'pending_addons'->'max_buy_in')
            IS DISTINCT FROM 'number'
       OR COALESCE(
            (p_post_commit_obligations->'pending_addons'->>'max_buy_in')::numeric,
            0
          ) <= 0
       OR p_post_commit_obligations->'pending_addons' ? 'ids'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_addons)';
  END IF;

  IF p_hand_number > 2147483647
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
       OR jsonb_array_length(p_post_commit_obligations->'insurance') > 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_hand_number_out_of_range)';
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
    WHERE t.id=p_table_id AND c.asset='diamonds') INTO v_diamond;
  IF v_diamond AND (
    jsonb_array_length(p_post_commit_obligations->'promo_playthrough')<>0
    OR jsonb_array_length(p_post_commit_obligations->'insurance')<>0
    OR jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'pending_addons') IS DISTINCT FROM 'null'
    OR p_hand_row->>'game_variant' IS DISTINCT FROM 'nlh'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_units,'[]'::jsonb)) u
      WHERE (u->>'amount') IS NULL
         OR (u->>'amount')::numeric<>trunc((u->>'amount')::numeric))
    OR COALESCE(NULLIF(p_hand_row->'daily_mission_events','null'::jsonb),'[]'::jsonb)<>'[]'::jsonb
    OR (p_hand_row->>'pot_size')::numeric<>trunc((p_hand_row->>'pot_size')::numeric)
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
  ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (diamond_chip_obligation_or_fractional_fact)';
  END IF;

  v_request_hash := encode(
    extensions.digest(convert_to(p_post_commit_obligations::text, 'UTF8'), 'sha256'),
    'hex'
  );

  /* ONE SEAT WRITE PER HAND (2026-09-10). The time-bank items above are
     already proven well formed and bound to the exact stack roster. Publish
     them for this exact table+hand in a transaction-local setting so the
     stack core (fn_ca_settle_hand_stacks_absolute) can carry the two
     time-bank columns on its stack write instead of this door writing every
     seat row a second time. The setting is cleared as soon as the core
     returns; a stale value can only name a hand the core refuses as a
     replay. The loop below still proves the resulting seat state before it
     counts it, and still writes any seat the core did not carry. */
  PERFORM set_config(
    'app.ca_hand_time_banks',
    jsonb_build_object(
      'table_id', p_table_id,
      'hand_number', p_hand_number,
      'exact', v_exact_seat_generation,
      'items', p_post_commit_obligations->'time_banks'
    )::text,
    true
  );

  /* The owner-only exact-generation core locks and proves the cash-table or
     tournament generation, then runs the unchanged accepted-hand core. Its
     lease/table locks remain held until this outer transaction commits. */
  v_result := public.fn_ca_commit_hand_settlement_exact_before_obligations(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units,
    p_instance_id,
    p_lease_generation
  );
  PERFORM set_config('app.ca_hand_time_banks', '', true);

  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_hand_id := (v_result->>'history_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_history_receipt)';
  END;
  IF v_hand_id IS NULL THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_history_receipt)';
  END IF;

  SELECT t.club_id, t.tournament_id
    INTO v_club_id, v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND OR v_club_id IS NULL THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_table_scope_missing)';
  END IF;

  /* The envelope cannot contradict the accepted hand. Amounts bind to the
     settlement arguments; every per-player item binds to its authoritative
     stack roster; every money item binds to the table's club. */
  IF (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'amount')::numeric
             IS DISTINCT FROM p_rake
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'bbj')::numeric
             IS DISTINCT FROM COALESCE(p_bbj, 0)
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'pot')::numeric
             IS DISTINCT FROM (p_hand_row->>'pot_size')::numeric
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'num_players')::integer
             IS DISTINCT FROM (
               SELECT count(*)::integer
                 FROM jsonb_object_keys(
                   p_hand_row->'_accepted_post_commit_facts'->'contributions'
                 )
             )
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'contributions'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'contributions'
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'returned_uncalled'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
     )
     OR (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object')
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric
             IS DISTINCT FROM p_bbj
     )
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric
             IS DISTINCT FROM (p_hand_row->>'big_blind')::numeric
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_fee_mismatch)';
  END IF;

  IF p_post_commit_obligations->'insurance' IS DISTINCT FROM
       p_hand_row->'_accepted_post_commit_facts'->'insurance' THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_insurance_fact_mismatch)';
  END IF;

  IF (
       v_tournament_id IS NULL AND NOT v_diamond
       AND (
         jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
           IS DISTINCT FROM (
             SELECT count(*)::integer
               FROM jsonb_each(
                 p_hand_row->'_accepted_post_commit_facts'->'contributions'
               ) e
              WHERE (e.value::text)::numeric > 0
           )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
            WHERE (x->>'wagered')::numeric IS DISTINCT FROM
                  (
                    p_hand_row->'_accepted_post_commit_facts'->'contributions'->>
                    (x->>'user_id')
                  )::numeric
         )
       )
     ) OR (
       (v_tournament_id IS NOT NULL OR v_diamond)
       AND jsonb_array_length(p_post_commit_obligations->'promo_playthrough') <> 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_promo_fact_mismatch)';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'contributions'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'user_id'
        )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'player_id'
        )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_player_or_club_mismatch)';
  END IF;

  /* Repeated recipients would turn one accepted-hand fact into two additive
     mutations. Time-bank rows are exhaustive because omitting one would make
     the accepted seat state depend on whichever process ran before this one. */
  IF jsonb_array_length(p_post_commit_obligations->'time_banks')
       IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     ) IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
     OR (
       /* The durable insurance writer is unique per table/hand/player. Two
          different kinds for one player would look like two obligations here
          but collapse to one receipt downstream. Refuse that ambiguity. */
       SELECT count(DISTINCT x->>'player_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'insurance') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_duplicate_or_missing_recipient)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'contributions', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'returned_uncalled', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_rake_recipient_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND p_post_commit_obligations->'rake'->>'club_id' IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND p_post_commit_obligations->'bbj_contribution'->>'club_id'
           IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_bbj_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       COALESCE(p_post_commit_obligations->'rake'->>'tournament_id', '')
         IS DISTINCT FROM COALESCE(v_tournament_id::text, '')
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_scope_mismatch)';
  END IF;
  IF (v_tournament_id IS NULL AND NOT v_diamond) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object') THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_addon_scope_mismatch)';
  END IF;

  SELECT c.post_commit_request_hash, c.post_commit_payload_hash
    INTO v_existing_request_hash, v_existing_hash
    FROM public.hand_atomic_commits c
   WHERE c.table_id = p_table_id
     AND c.hand_number = p_hand_number
     AND c.hand_id = v_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_atomic_receipt)';
  END IF;
  IF v_existing_request_hash IS NOT NULL
     AND v_existing_request_hash IS DISTINCT FROM v_request_hash THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_payload_conflict)';
  END IF;

  IF v_existing_request_hash IS NULL THEN
    /* A rolling 11-argument engine may already have committed this hand and
       run its legacy post-commit steps. Never attach a new additive envelope
       to that receipt. A response-loss replay from this 12-argument door
       always finds the request hash written by its first transaction. */
    IF COALESCE((v_result->>'replay')::boolean, false) IS TRUE THEN
      RAISE EXCEPTION
        'atomic hand commit refused (legacy_receipt_has_no_post_commit_envelope)';
    END IF;

    /* Copy the independently accepted facts into the immutable stored envelope.
       The caller is forbidden from supplying this key itself. Besides the core
       hand hash, the durable processor/audit row can therefore show exactly
       which first-narrative facts every derived obligation was checked against. */
    v_payload := jsonb_set(
      p_post_commit_obligations,
      '{accepted_hand_facts}',
      p_hand_row->'_accepted_post_commit_facts',
      true
    );
    IF jsonb_typeof(v_payload->'pending_addons') = 'object' THEN
      /* Own the exact eligible rows through commit. A legacy/manual resolver
         cannot consume one after it was frozen but before the obligation
         transaction gets its causal wake. */
      PERFORM 1
        FROM public.table_pending_addons a
       WHERE a.table_id = p_table_id
         AND a.resolved_at IS NULL
         AND a.created_at <= transaction_timestamp()
       ORDER BY a.created_at, a.id
       FOR UPDATE;
      v_payload := jsonb_set(
        v_payload,
        '{pending_addons,ids}',
        COALESCE((
          SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
            FROM public.table_pending_addons a
           WHERE a.table_id = p_table_id
             AND a.resolved_at IS NULL
             AND a.created_at <= transaction_timestamp()
        ), '[]'::jsonb),
        true
      );
    END IF;
    v_hash := encode(
      extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
      'hex'
    );

    /* Time-bank state belongs to the accepted-hand boundary itself. Apply it
       while the exact lease/table/seat locks inherited from the owner-only
       exact-generation core are still held, never later from a stale envelope. */
    v_expected := jsonb_array_length(v_payload->'time_banks');
    v_updated := 0;
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(v_payload->'time_banks')
       ORDER BY value->>'user_id'
    LOOP
      IF (v_item->>'user_id') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR (v_item->>'uses_remaining') !~ '^[0-9]+$'
         OR (v_item->>'seconds_remaining') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION
          'atomic hand commit refused (invalid_time_bank_obligation)';
      END IF;
      /* ONE SEAT WRITE PER HAND (2026-09-10). The stack core carried these
         two columns on its stack write from the envelope published above.
         Prove that exact state on the exact row first (the same predicate
         the lawful-noop rule below has always used) and count it without a
         second write. Only a seat the core did not carry - a cash seat that
         left during the hand is settled against its wallet and gets no stack
         write - takes the UPDATE, exactly as before. */
      SELECT count(*)::integer INTO v_row_count
        FROM public.table_seats s
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
         AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      IF v_row_count = 0 THEN
      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* Preserve the stack writer's lawful-noop rule. If a redundant-update
         suppressor is installed, ROW_COUNT may be zero even though the exact
         row already stores the requested state. Prove that exact state before
         counting it; a missing or replaced generation still refuses whole. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
           AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
           AND (
             (v_exact_seat_generation
               AND s.id = (v_item->>'seat_id')::uuid
               AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
             OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
           )
      ) THEN
        v_row_count := 1;
      END IF;
      END IF;
      v_updated := v_updated + v_row_count;
    END LOOP;
    IF v_updated IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_mismatch)';
    END IF;

    UPDATE public.hand_atomic_commits c
       SET post_commit_payload = v_payload,
           post_commit_request_hash = v_request_hash,
           post_commit_payload_hash = v_hash
     WHERE c.table_id = p_table_id
       AND c.hand_number = p_hand_number
       AND c.hand_id = v_hand_id
       AND c.post_commit_request_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;
  ELSE
    v_hash := v_existing_hash;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash
  );
END;
$function$
;

-- Additive scratch adapter. Caller MUST hold accepted original-process custody
-- and positive Lease0010 no-actuation/process-release evidence throughout.
-- SQL verifies its durable binding; SQL absence is not process evidence.
CREATE FUNCTION public.fn_f06_finish_original_no_start(
 p_tournament_id uuid,p_lease_generation uuid,p_table_id uuid,p_lifecycle bigint,
 p_permit_id uuid,p_hand_number bigint,p_original_custody_id uuid,
 p_break_id uuid,p_park_custody_id uuid,p_park_revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE h smarter_private.f06_hand_permits; o smarter_private.f06_operations;
BEGIN
 IF p_table_id IS NULL OR p_lifecycle IS NULL OR p_permit_id IS NULL OR p_hand_number IS NULL
 OR p_hand_number<1 OR p_original_custody_id IS NULL OR p_break_id IS NULL
 OR p_park_custody_id IS NULL OR p_park_revision IS NULL OR p_park_revision<1 THEN
 RAISE EXCEPTION 'F06_ORIGINAL_DISPOSITION_IDENTITY' USING ERRCODE='22023'; END IF;
 -- Same prefix as BEGIN/finish: lease, tournament lane, physical table/seat rows.
 -- This serializes the absence decision against a late original BEGIN.
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id FOR UPDATE;
 IF NOT FOUND OR (o.tournament_id,o.source_table_id,o.lifecycle,o.origin_generation,o.state,
 o.custody_id,o.custody_generation,o.revision) IS DISTINCT FROM
 (p_tournament_id,p_table_id,p_lifecycle,p_lease_generation,'park_requested'::text,
 p_park_custody_id,p_lease_generation,p_park_revision) THEN
 RAISE EXCEPTION 'F06_EXACT_ORIGINAL_PARK_REQUIRED' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id
 WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id AND tb.f06_lifecycle=p_lifecycle
 AND upper(t.status)='RUNNING' AND lower(tb.status)<>'closed' AND NOT COALESCE(tb.is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_HAND_LIFECYCLE' USING ERRCODE='55000'; END IF;
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id FOR UPDATE;
 IF FOUND THEN
 IF (h.tournament_id,h.table_id,h.lifecycle,h.hand_number,h.custody_id,h.generation) IS DISTINCT FROM
 (p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_original_custody_id,p_lease_generation) THEN
 RAISE EXCEPTION 'F06_CHANGED_HAND_PERMIT' USING ERRCODE='22023'; END IF;
 -- Existing reserved or exact completed receipt uses the already accepted finisher.
 RETURN public.fn_f06_finish_hand(p_tournament_id,p_lease_generation,p_permit_id,'never_started',p_park_custody_id);
 END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND (hand_number=p_hand_number OR state='reserved'))
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=p_permit_id) THEN
 RAISE EXCEPTION 'F06_ORIGINAL_HAND_EVIDENCE_CONFLICT' USING ERRCODE='55000'; END IF;
 -- No new identity: persist the retained original tuple, not a replacement BEGIN.
 -- Permanent table/hand uniqueness and existing immutable terminal trigger apply.
 INSERT INTO smarter_private.f06_hand_permits
 (permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state,evidence_id)
 VALUES(p_permit_id,p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_original_custody_id,p_lease_generation,'never_started',p_park_custody_id)
 RETURNING * INTO h;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_finish_original_no_start(uuid,uuid,uuid,bigint,uuid,bigint,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_finish_original_no_start(uuid,uuid,uuid,bigint,uuid,bigint,uuid,uuid,uuid,bigint) TO service_role;



-- Scratch-only guarded integration proposal. No production application authorized.
DO $$ DECLARE seq oid:='public.global_hand_number_seq'::regclass; BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'F06_ALLOCATOR_INSTALL_OWNER'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_f06_hand_number_state(uuid,uuid,uuid)') AND md5(prosrc)='c60973ec307551fc91f2c7290267c07b' AND prosecdef AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_RECOVERY_PROJECTION_DRIFT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid WHERE c.oid=seq
 AND c.relkind='S' AND pg_get_userbyid(c.relowner)='postgres'
 AND c.relacl::text='{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}'
 AND s.seqtypid='bigint'::regtype AND s.seqstart=1000000 AND s.seqincrement=1 AND s.seqmax=9223372036854775807
 AND s.seqmin=1000000 AND s.seqcache=1 AND NOT s.seqcycle) THEN RAISE EXCEPTION 'F06_SEQUENCE_AUTHORITY_DRIFT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_next_hand_number()'::regprocedure
 AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
 AND prosecdef AND prorettype='bigint'::regtype
 AND md5(pg_get_functiondef(oid))='be5703f2b49111dc6cefb44ca860fdff') THEN RAISE EXCEPTION 'F06_ALLOCATOR_PREIMAGE_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_depend WHERE refclassid='pg_class'::regclass AND refobjid=seq AND classid='pg_attrdef'::regclass) THEN RAISE EXCEPTION 'F06_SEQUENCE_DEFAULT_DEPENDENCY'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','smarter_private') AND p.prokind IN ('f','p')
 AND p.oid<>'public.fn_next_hand_number()'::regprocedure
 AND position('global_hand_number_seq' in p.prosrc)>0) THEN RAISE EXCEPTION 'F06_SEQUENCE_ADDITIONAL_CALLER'; END IF;
END $$;
REVOKE USAGE,UPDATE ON SEQUENCE public.global_hand_number_seq FROM PUBLIC,anon,authenticated,service_role;
-- Fail closed on inherited sequence mutation authority as well as direct grants.
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','authenticator'] LOOP
 IF has_sequence_privilege(r,'public.global_hand_number_seq','USAGE') OR has_sequence_privilege(r,'public.global_hand_number_seq','UPDATE') THEN
 RAISE EXCEPTION 'F06_SEQUENCE_INHERITED_AUTHORITY %',r; END IF; END LOOP;
END $$;
CREATE FUNCTION smarter_private.f06_allocate_number_above(floor_number bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET lock_timeout='2s' AS $$
DECLARE n bigint; prior bigint; called boolean;
BEGIN
 IF floor_number IS NULL OR floor_number<1000000 OR floor_number>9007199254740991 THEN
 RAISE EXCEPTION 'F06_HAND_NUMBER_UNSAFE' USING ERRCODE='22003'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('f06:global-hand-number-allocation',0));
 SELECT last_value,is_called INTO prior,called FROM public.global_hand_number_seq;
 IF prior<floor_number THEN
   -- Real sequence relation barrier also serializes pre-upgrade no-advisory callers.
   -- CACHE 1 is already preimage-guarded; this changes no sequence policy.
   ALTER SEQUENCE public.global_hand_number_seq CACHE 1;
   SELECT last_value,is_called INTO prior,called FROM public.global_hand_number_seq;
 END IF;
 IF prior>9007199254740991 OR (prior=9007199254740991 AND called) THEN
 RAISE EXCEPTION 'F06_HAND_NUMBER_UNSAFE' USING ERRCODE='22003'; END IF;
 n:=nextval('public.global_hand_number_seq');
 IF n>9007199254740991 THEN RAISE EXCEPTION 'F06_HAND_NUMBER_UNSAFE' USING ERRCODE='22003'; END IF;
 IF n<floor_number THEN n:=setval('public.global_hand_number_seq',floor_number,true); END IF;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_allocate_number_above(bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_next_hand_number() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT smarter_private.f06_allocate_number_above(1000000);
$$;
CREATE FUNCTION public.fn_f06_allocate_hand_number(p_tournament_id uuid,p_lease_generation uuid,p_table_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE s jsonb;n bigint;floor_number bigint;
BEGIN
 s:=public.fn_f06_hand_number_state(p_tournament_id,p_lease_generation,p_table_id);
 IF s->>'ok' IS DISTINCT FROM 'true' THEN RETURN s; END IF;
 IF s->>'can_reserve' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('ok',false,'reason',s->>'blocked_reason'); END IF;
 IF (s->>'used_hand_number_max')::bigint>=9007199254740991 THEN RETURN jsonb_build_object('ok',false,'reason','hand_number_unsafe'); END IF;
 floor_number:=GREATEST(1000000,(s->>'used_hand_number_max')::bigint+1);
 n:=smarter_private.f06_allocate_number_above(floor_number);
 RETURN jsonb_build_object('ok',true,'table_id',p_table_id,'lifecycle',s->>'lifecycle','hand_number',n::text,'hand_number_high_water',s->>'used_hand_number_max');
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_allocate_hand_number(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_allocate_hand_number(uuid,uuid,uuid) TO service_role;


