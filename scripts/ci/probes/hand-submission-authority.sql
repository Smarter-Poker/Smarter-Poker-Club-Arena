-- Exact original requests, not inferred hand outcomes. No foreign keys to hot gameplay rows.
CREATE TABLE smarter_private.hand_submissions (
 submission_id uuid PRIMARY KEY,
 table_id uuid NOT NULL,
 hand_number bigint NOT NULL CHECK (hand_number>0),
 instance_id text NOT NULL CHECK (length(btrim(instance_id))>0),
 lease_generation uuid NOT NULL,
 request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 retained_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(table_id,hand_number)
);
CREATE TABLE smarter_private.hand_submission_dispositions (
 table_id uuid NOT NULL,
 hand_number bigint NOT NULL CHECK(hand_number>0),
 permit_id uuid UNIQUE,
 disposition text NOT NULL CHECK(disposition IN ('retained','disposed')),
 submission_id uuid,
 PRIMARY KEY(table_id,hand_number),
 CHECK((disposition='retained')=(submission_id IS NOT NULL))
);
ALTER TABLE smarter_private.hand_submissions OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_dispositions OWNER TO postgres;
ALTER TABLE smarter_private.hand_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submission_dispositions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.hand_submissions,smarter_private.hand_submission_dispositions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.hand_submission_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'HAND_SUBMISSION_IMMUTABLE' USING ERRCODE='55000'; END
$function$;
REVOKE ALL ON FUNCTION smarter_private.hand_submission_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_submission_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submissions
 FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_disposition_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_dispositions
 FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();

CREATE TRIGGER hand_submission_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submissions
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_disposition_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_dispositions
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();

-- First committed unique fence wins even when a contender has an old MVCC snapshot.
-- The existing F06 owner still validates every disposition; this only rejects loss
-- of a retained settlement request. It never accepts, withdraws or fabricates a hand.
CREATE FUNCTION smarter_private.f06_retained_submission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NEW.state NOT IN ('never_started','aborted_unsettled') THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,permit_id,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,NEW.permit_id,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' OR (d.permit_id IS NOT NULL AND d.permit_id IS DISTINCT FROM NEW.permit_id) THEN
  RAISE EXCEPTION 'F06_RETAINED_HAND_SUBMISSION_REQUIRES_ACCEPTED_DISPOSITION' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_retained_submission_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_retained_submission_guard AFTER UPDATE OF state ON smarter_private.f06_hand_permits
 FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_retained_submission_guard();

-- A legacy startup/cleanup may not certify an unaccepted retained hand.
-- The unique fence also serializes a snapshot closer whose MVCC snapshot
-- predates retention: ON CONFLICT cannot silently ignore the winning row.
CREATE FUNCTION smarter_private.hand_submission_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NOT NEW.is_complete THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=NEW.table_id
   AND a.hand_number=NEW.hand_number AND a.hand_id IS NOT NULL AND a.post_commit_payload IS NOT NULL) THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_REQUIRED_FOR_COMPLETION' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.hand_submission_snapshot_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_submission_snapshot_guard AFTER INSERT OR UPDATE OF is_complete ON public.hand_state_snapshots
 FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_snapshot_guard();

CREATE FUNCTION smarter_private.assert_retained_hand_submission(p_request jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE s smarter_private.hand_submissions;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||(p_request->>'p_table_id')||':'||(p_request->>'p_hand_number'),0));
 SELECT * INTO s FROM smarter_private.hand_submissions
 WHERE table_id=(p_request->>'p_table_id')::uuid AND hand_number=(p_request->>'p_hand_number')::bigint;
 IF FOUND AND s.request IS DISTINCT FROM p_request THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED' USING ERRCODE='55000';
 END IF;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.assert_retained_hand_submission(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_retain_hand_submission(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,extensions AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 d smarter_private.hand_submission_dispositions;
 tid uuid; hn bigint; sid uuid; instance text; generation uuid; tour uuid; locked_tour uuid;
 holder text; lease uuid; protocol integer; beat timestamptz; request_hash text;
BEGIN
 IF jsonb_typeof(p_request) IS DISTINCT FROM 'object'
 OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request) k) IS DISTINCT FROM
 ARRAY['p_bbj','p_hand_number','p_hand_row','p_inflow','p_instance_id','p_lease_generation','p_post_commit_obligations','p_rake','p_ref','p_stacks','p_table_id','p_units']
 OR jsonb_typeof(p_request->'p_stacks') IS DISTINCT FROM 'array'
 OR jsonb_typeof(p_request->'p_hand_row') IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_request->'p_post_commit_obligations') IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_request->'p_units') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_INVALID_REQUEST' USING ERRCODE='22023';
 END IF;
 tid:=(p_request->>'p_table_id')::uuid; hn:=(p_request->>'p_hand_number')::bigint;
 sid:=(p_request->'p_hand_row'->>'id')::uuid;
 instance:=p_request->>'p_instance_id'; generation:=(p_request->>'p_lease_generation')::uuid;
 IF tid IS NULL OR hn IS NULL OR hn<=0 OR sid IS NULL OR generation IS NULL OR length(btrim(COALESCE(instance,'')))=0
 OR (p_request->'p_hand_row'->>'table_id')::uuid IS DISTINCT FROM tid
 OR (p_request->'p_hand_row'->>'hand_number')::bigint IS DISTINCT FROM hn THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_INVALID_IDENTITY' USING ERRCODE='22023';
 END IF;
 PERFORM public.fn_ca_share_settlement_lane_for_table(tid);
 PERFORM smarter_private.assert_retained_hand_submission(p_request);
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
  RETURN jsonb_build_object('retained',true,'submission_id',s.submission_id,'request_hash',s.request_hash,'replay',true);
 END IF;
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
   RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
  SELECT * INTO STRICT h FROM smarter_private.f06_hand_permits WHERE permit_id=h.permit_id;
  IF h.state NOT IN ('reserved','accepted') OR h.generation IS DISTINCT FROM generation THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=tid;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_MISSING' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL AND (h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM tour) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF tour IS NULL THEN
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,lease,protocol,beat
  FROM public.engine_table_leases WHERE table_id=tid FOR KEY SHARE;
 ELSE
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,lease,protocol,beat
  FROM public.engine_tournament_leases WHERE tournament_id=tour FOR KEY SHARE;
 END IF;
 IF holder IS DISTINCT FROM instance OR lease IS DISTINCT FROM generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL THEN PERFORM 1 FROM public.tournaments WHERE id=tour FOR SHARE; END IF;
 SELECT tournament_id INTO locked_tour FROM public.tables WHERE id=tid FOR UPDATE;
 IF NOT FOUND OR locked_tour IS DISTINCT FROM tour THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,permit_id,disposition,submission_id)
 VALUES(tid,hn,h.permit_id,'retained',sid) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=tid AND hand_number=hn;
 IF d.disposition<>'retained' OR d.submission_id IS DISTINCT FROM sid OR d.permit_id IS DISTINCT FROM h.permit_id THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_DISPOSED' USING ERRCODE='55000'; END IF;
 request_hash:=encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex');
 INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash)
 VALUES(sid,tid,hn,instance,generation,p_request,request_hash);
 RETURN jsonb_build_object('retained',true,'submission_id',sid,'request_hash',request_hash,'replay',false);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_retain_hand_submission(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_retain_hand_submission(jsonb) TO service_role;

-- New receipt-only entry. Financial computation and exact-generation admission
-- remain in the existing public authority; the payload cannot be reconstructed.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
 VALUES('fn_ca_commit_hand_submission','approved',
 'Exact retained original hand payload delegates existing 12-argument settlement; snapshot completes only with accepted receipt.');
CREATE FUNCTION public.fn_ca_commit_hand_submission(p_submission_id uuid,p_instance_id text,p_lease_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE s smarter_private.hand_submissions; r jsonb; q jsonb; completed integer;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=p_submission_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_NOT_RETAINED' USING ERRCODE='55000'; END IF;
 IF s.instance_id IS DISTINCT FROM p_instance_id OR s.lease_generation IS DISTINCT FROM p_lease_generation THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_OWNER_REQUIRED' USING ERRCODE='55000'; END IF;
 q:=s.request;
 r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
 (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
 q->'p_hand_row',q->'p_units',s.instance_id,s.lease_generation,q->'p_post_commit_obligations');
 IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN RETURN r; END IF;
 IF r->>'history_id' IS DISTINCT FROM s.submission_id::text OR r->>'post_commit_obligations' IS DISTINCT FROM 'true'
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number
 AND hand_id=s.submission_id AND post_commit_payload IS NOT NULL) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
 UPDATE public.hand_state_snapshots SET is_complete=true,updated_at=clock_timestamp()
 WHERE table_id=s.table_id AND hand_number=s.hand_number AND NOT is_complete;
 GET DIAGNOSTICS completed=ROW_COUNT;
 RETURN r||jsonb_build_object('submission_id',s.submission_id,'submission_hash',s.request_hash,
 'snapshot_completed',true,'snapshots_completed',completed);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_submission(uuid,text,uuid) TO service_role;
