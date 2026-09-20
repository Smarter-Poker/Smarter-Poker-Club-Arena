-- A canonical failure is positive original-owner evidence, never inferred from
-- missing history, transport loss, an old snapshot, or a successor's presence.
CREATE TABLE smarter_private.hand_submission_failures (
 submission_id uuid PRIMARY KEY, transaction_id bigint NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL,
 CHECK(result->>'success'='false' AND result->>'reason'='atomic_hand_rolled_back'
   AND length(result->>'sqlstate')=5)
);
CREATE TABLE smarter_private.hand_submission_handoffs (
 submission_id uuid PRIMARY KEY, original_generation uuid NOT NULL,
 instance_id text NOT NULL, lease_generation uuid NOT NULL,
 request_hash text NOT NULL, transaction_id bigint NOT NULL,
 CHECK(original_generation<>lease_generation)
);
CREATE TABLE smarter_private.hand_submission_handoff_results (
 submission_id uuid PRIMARY KEY, result jsonb NOT NULL
);
-- A consumed capability is usable only inside the one owning transaction.
CREATE TABLE smarter_private.hand_submission_dispatch (
 transaction_id bigint NOT NULL, submission_id uuid NOT NULL,
 request_hash text NOT NULL, instance_id text NOT NULL, lease_generation uuid NOT NULL,
 PRIMARY KEY(transaction_id,submission_id)
);
ALTER TABLE smarter_private.hand_submission_failures OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_handoffs OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_handoff_results OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_dispatch OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submission_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submission_handoff_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submission_dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.hand_submission_failures,smarter_private.hand_submission_handoffs,
 smarter_private.hand_submission_handoff_results,smarter_private.hand_submission_dispatch
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_submission_failure_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_failures FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_failure_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_failures FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_handoff_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_handoffs FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_handoff_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_handoffs FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_handoff_result_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_handoff_results FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_handoff_result_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_handoff_results FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();

CREATE OR REPLACE FUNCTION smarter_private.assert_retained_hand_submission(p_request jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE s smarter_private.hand_submissions; consumed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||(p_request->>'p_table_id')||':'||(p_request->>'p_hand_number'),0));
 SELECT * INTO s FROM smarter_private.hand_submissions
 WHERE table_id=(p_request->>'p_table_id')::uuid AND hand_number=(p_request->>'p_hand_number')::bigint;
 IF NOT FOUND OR s.request IS NOT DISTINCT FROM p_request THEN RETURN; END IF;
 IF (s.request-'p_instance_id'-'p_lease_generation') IS NOT DISTINCT FROM
    (p_request-'p_instance_id'-'p_lease_generation') THEN
  DELETE FROM smarter_private.hand_submission_dispatch d WHERE d.transaction_id=txid_current()
   AND d.submission_id=s.submission_id AND d.request_hash=s.request_hash
   AND d.instance_id=p_request->>'p_instance_id'
   AND d.lease_generation=(p_request->>'p_lease_generation')::uuid;
  GET DIAGNOSTICS consumed=ROW_COUNT;
  IF consumed=1 THEN RETURN; END IF;
 END IF;
 RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED' USING ERRCODE='55000';
END $function$;
REVOKE ALL ON FUNCTION smarter_private.assert_retained_hand_submission(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.acknowledge_hand_submission(p_submission_id uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE s smarter_private.hand_submissions; completed integer;
BEGIN
 SELECT * INTO STRICT s FROM smarter_private.hand_submissions WHERE submission_id=p_submission_id;
 IF p_result->>'success' IS DISTINCT FROM 'true' OR p_result->>'atomic_hand_commit' IS DISTINCT FROM 'true'
 OR p_result->>'history_id' IS DISTINCT FROM s.submission_id::text
 OR p_result->>'post_commit_obligations' IS DISTINCT FROM 'true'
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number
   AND a.hand_id=s.submission_id AND a.payload_hash=p_result->>'commit_hash'
   AND a.post_commit_request_hash=encode(extensions.digest(convert_to((s.request->'p_post_commit_obligations')::text,'UTF8'),'sha256'),'hex')
   AND a.post_commit_payload IS NOT NULL AND a.post_commit_payload_hash=p_result->>'post_commit_payload_hash') THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
 UPDATE public.hand_state_snapshots SET is_complete=true,updated_at=clock_timestamp()
 WHERE table_id=s.table_id AND hand_number=s.hand_number AND NOT is_complete;
 GET DIAGNOSTICS completed=ROW_COUNT;
 RETURN p_result||jsonb_build_object('submission_id',s.submission_id,'submission_hash',s.request_hash,
 'snapshot_completed',true,'snapshots_completed',completed);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.acknowledge_hand_submission(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_submission(p_submission_id uuid,p_instance_id text,p_lease_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE s smarter_private.hand_submissions; r jsonb; q jsonb;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=p_submission_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_NOT_RETAINED' USING ERRCODE='55000'; END IF;
 IF s.instance_id IS DISTINCT FROM p_instance_id OR s.lease_generation IS DISTINCT FROM p_lease_generation THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_OWNER_REQUIRED' USING ERRCODE='55000'; END IF;
 q:=s.request;
 r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
 (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
 q->'p_hand_row',q->'p_units',s.instance_id,s.lease_generation,q->'p_post_commit_obligations');
 IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN
  IF r->>'success'='false' AND r->>'reason'='atomic_hand_rolled_back' AND length(r->>'sqlstate')=5 THEN
   INSERT INTO smarter_private.hand_submission_failures(submission_id,transaction_id,request_hash,result)
   VALUES(s.submission_id,txid_current(),s.request_hash,r) ON CONFLICT(submission_id) DO NOTHING;
  END IF;
  RETURN r;
 END IF;
 RETURN smarter_private.acknowledge_hand_submission(s.submission_id,r);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_submission(uuid,text,uuid) TO service_role;

INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
 VALUES('fn_ca_resume_hand_submission','approved',
 'One exact failed-original handoff under the current lease, followed by repeatable accepted-receipt postcommit and original F06 finish.');
CREATE FUNCTION public.fn_ca_resume_hand_submission(p_table_id uuid,p_instance_id text,p_lease_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 a public.hand_atomic_commits; q jsonb; r jsonb; post jsonb; finished jsonb;
 tour uuid; locked_tour uuid; holder text; generation uuid; protocol integer; beat timestamptz;
 users uuid[]; code text; message text; claimed boolean:=false;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'HAND_SUBMISSION_ENGINE_ONLY' USING ERRCODE='42501'; END IF;
 SELECT j.* INTO s FROM smarter_private.hand_submissions j
 LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
 LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
 WHERE j.table_id=p_table_id AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
   OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
 ORDER BY j.hand_number LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
 -- This is startup continuation, not an in-flight original settlement. Keep
 -- both financial handoff and accepted postcommit behind the existing freeze
 -- boundary, before any lease or lifecycle lane. Refusal spends no claim.
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;
 IF public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=p_table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_MISSING' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL THEN
  SELECT array_agg((x->>'user_id')::uuid ORDER BY x->>'user_id') INTO users FROM jsonb_array_elements(s.request->'p_stacks') x;
  PERFORM smarter_private.f06_prefix(tour,p_lease_generation,users,ARRAY[p_table_id]);
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_tournament_leases WHERE tournament_id=tour FOR KEY SHARE;
 ELSE
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_table_leases WHERE table_id=p_table_id FOR KEY SHARE;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
  PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
  PERFORM 1 FROM public.table_seats WHERE table_id=p_table_id ORDER BY id FOR UPDATE;
 END IF;
 IF holder IS DISTINCT FROM p_instance_id OR generation IS DISTINCT FROM p_lease_generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO locked_tour FROM public.tables WHERE id=p_table_id;
 IF locked_tour IS DISTINCT FROM tour THEN RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF tour IS NOT NULL THEN
  IF h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM tour OR h.generation IS DISTINCT FROM s.lease_generation
   OR h.state NOT IN('reserved','accepted') THEN RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' USING ERRCODE='55000'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
   RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF FOUND THEN
  IF a.hand_id IS DISTINCT FROM s.submission_id OR a.post_commit_payload IS NULL THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
  r:=a.stack_result||jsonb_build_object('success',true,'atomic_hand_commit',true,'history_id',a.hand_id,
    'commit_hash',a.payload_hash,'post_commit_obligations',true,'post_commit_payload_hash',a.post_commit_payload_hash);
 ELSE
  IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs WHERE submission_id=s.submission_id) THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_claim_spent'); END IF;
  IF s.lease_generation=p_lease_generation OR NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures f
   WHERE f.submission_id=s.submission_id AND f.request_hash=s.request_hash) THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','original_failure_or_handoff_unproven'); END IF;
  -- The original exact generations and before-stacks must still occupy the
  -- whole table. No later hand/permit may have consumed this starting state.
  q:=s.request;
  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lifecycle='live' AND lower(status) IN ('waiting','running'))
   OR (tour IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=tour AND upper(status)='RUNNING')) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_NOT_ADMITTED' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(q->'p_stacks')=0 OR
   (SELECT count(*) FROM public.table_seats WHERE table_id=s.table_id AND left_at IS NULL)<>jsonb_array_length(q->'p_stacks')
   OR (SELECT count(DISTINCT x->>'seat_id') FROM jsonb_array_elements(q->'p_stacks') x)<>jsonb_array_length(q->'p_stacks')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE NOT EXISTS(
     SELECT 1 FROM public.table_seats seat WHERE seat.table_id=s.table_id AND seat.id=(x->>'seat_id')::uuid
       AND seat.user_id=(x->>'user_id')::uuid AND seat.joined_at=(x->>'seat_joined_at')::timestamptz
       AND seat.left_at IS NULL AND seat.stack=(x->>'stack_before')::numeric))
   OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number>s.hand_number) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_HANDOFF_STATE_CHANGED' USING ERRCODE='55000'; END IF;
  -- A wait for another lane may outlast the heartbeat or cross the existing
  -- announced freeze clock. Recheck immediately before the irreversible claim.
  IF public.fn_platform_frozen() THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
  IF tour IS NULL THEN
   SELECT heartbeat_at INTO beat FROM public.engine_table_leases WHERE table_id=s.table_id;
  ELSE
   SELECT heartbeat_at INTO beat FROM public.engine_tournament_leases WHERE tournament_id=tour;
  END IF;
  IF beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  INSERT INTO smarter_private.hand_submission_handoffs(submission_id,original_generation,instance_id,lease_generation,request_hash,transaction_id)
   VALUES(s.submission_id,s.lease_generation,p_instance_id,p_lease_generation,s.request_hash,txid_current());
  claimed:=true;
  BEGIN
   INSERT INTO smarter_private.hand_submission_dispatch VALUES(txid_current(),s.submission_id,s.request_hash,p_instance_id,p_lease_generation);
   r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
    (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
    q->'p_hand_row',q->'p_units',p_instance_id,p_lease_generation,q->'p_post_commit_obligations');
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
   r:=jsonb_build_object('success',false,'atomic_hand_commit',false,'reason','successor_authority_refused','sqlstate',code,'error',message);
  END;
  -- A lock/freeze/lease admission refusal is not the one financial attempt.
  -- Raise outside the caught subtransaction so its claim also rolls back.
  IF r->>'success' IS DISTINCT FROM 'true' AND (
    r->>'sqlstate' IN ('55P03','40001','40P01')
    OR r->>'reason' IN ('hand_lease_lost','hand_lease_stale','hand_lease_scope_changed','invalid_hand_lease_authority')
    OR (r->>'sqlstate'='42501' AND r->>'error'='F06_LEASE_FENCED')
    OR public.fn_platform_frozen()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ADMISSION_CHANGED: %',r USING ERRCODE='40001';
  END IF;
  DELETE FROM smarter_private.hand_submission_dispatch WHERE transaction_id=txid_current() AND submission_id=s.submission_id;
  INSERT INTO smarter_private.hand_submission_handoff_results VALUES(s.submission_id,r);
  IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_refused','outcome',r); END IF;
 END IF;
 r:=smarter_private.acknowledge_hand_submission(s.submission_id,r);
 -- A later current owner may replay this branch after acknowledgment loss.
 -- It never spends or recreates the one-time financial claim.
 BEGIN
  post:=public.fn_ca_process_hand_post_commit_obligations(s.submission_id);
  IF post->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits
    WHERE table_id=s.table_id AND hand_number=s.hand_number AND hand_id=s.submission_id
    AND post_commit_completed_at IS NOT NULL AND post_commit_result->>'ok'='true') THEN
   RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending'); END IF;
  IF tour IS NOT NULL THEN
   finished:=public.fn_f06_finish_hand(tour,p_lease_generation,h.permit_id,'accepted',s.submission_id);
   IF finished->>'ok' IS DISTINCT FROM 'true' OR finished->>'state' IS DISTINCT FROM 'accepted'
    OR finished->>'evidence_id' IS DISTINCT FROM s.submission_id::text THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_COMPLETION_UNPROVEN' USING ERRCODE='55000'; END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
  RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending','sqlstate',code,'error',message);
 END;
 RETURN r||jsonb_build_object('found',true,'completed',true,'hand_number',s.hand_number::text,
   'financial_handoff',claimed,'permit_id',h.permit_id,'post_commit_completed',true);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) TO service_role;
