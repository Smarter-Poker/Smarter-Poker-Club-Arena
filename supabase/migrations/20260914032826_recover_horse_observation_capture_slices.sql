-- Reserved 2026-09-14 03:28:26 UTC. Sequential source recovery in one durable
-- request slot. No financial source writers, triggers or completeness claims.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM (VALUES
    ('fn_admit_horse_observation_capture','b4c1f4554301dab76feaba5ddfa3290f'),
    ('fn_claim_horse_observation_capture','8372d6459b9d396f518897f09d40ad87'),
    ('fn_finish_horse_observation_capture','97b1b4033f721aff4a4ebc217f2d52b8'),
    ('fn_prune_horse_observation_captures','d7a77f60b45c8e7db81d64b31f8c1aee'),
    ('fn_horse_learning_work_health','ccc38085718dbbfbe681cf04086fd934')
  ) expected(name,body) LEFT JOIN pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=expected.name
    WHERE p.oid IS NULL OR md5(p.prosrc) IS DISTINCT FROM expected.body) THEN
    RAISE EXCEPTION 'HORSE_CAPTURE_BODY_CHANGED';
  END IF;
END
$guard$;
ALTER TABLE public.horse_observation_capture_work
  DROP CONSTRAINT horse_observation_capture_work_state_check,
  ADD CONSTRAINT horse_observation_capture_work_state_check CHECK(state IN ('queued','leased','admitted','captured','gap')),
  ADD COLUMN cursor_ms bigint,
  ADD COLUMN slice_through_ms bigint,
  ADD COLUMN segments integer NOT NULL DEFAULT 0 CHECK(segments BETWEEN 0 AND 2048),
  ADD COLUMN captured_observations bigint NOT NULL DEFAULT 0 CHECK(captured_observations BETWEEN 0 AND 40960000 AND captured_observations<=segments*20000),
  ADD CONSTRAINT horse_capture_cursor_bounds CHECK(
    (cursor_ms IS NULL AND slice_through_ms IS NULL) OR
    (cursor_ms IS NOT NULL AND slice_through_ms IS NOT NULL AND cursor_ms>=from_ms AND cursor_ms<=through_ms
      AND slice_through_ms>=cursor_ms AND slice_through_ms<=through_ms)),
  ADD CONSTRAINT horse_capture_completed_slices CHECK(state<>'captured' OR
    (cursor_ms IS NOT NULL AND slice_through_ms IS NOT NULL AND cursor_ms=through_ms
      AND slice_through_ms=through_ms AND segments>=2 AND admitted_at IS NOT NULL));
CREATE TABLE public.horse_observation_capture_receipts (
  request_key text NOT NULL REFERENCES public.horse_observation_capture_work(request_key),
  lease_token uuid NOT NULL,
  from_ms bigint NOT NULL,
  through_ms bigint NOT NULL CHECK(through_ms>from_ms),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  acknowledgment jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(request_key,lease_token),
  UNIQUE(request_key,from_ms)
);
ALTER TABLE public.horse_observation_capture_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_observation_capture_receipts FROM PUBLIC,anon,authenticated,service_role;
DROP INDEX public.horse_capture_unfinished;
CREATE INDEX horse_capture_unfinished ON public.horse_observation_capture_work(state) WHERE state NOT IN ('admitted','captured');
DROP INDEX public.horse_capture_retention;
CREATE INDEX horse_capture_retention ON public.horse_observation_capture_work(admitted_at,request_key) WHERE state IN ('admitted','captured');

CREATE OR REPLACE FUNCTION public.fn_admit_horse_observation_capture(p_actor uuid,p_from_ms bigint,p_through_ms bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE key text; r public.horse_observation_capture_work%ROWTYPE; n integer; at_ms bigint;
BEGIN
  IF p_actor IS NULL OR p_from_ms IS NULL OR p_through_ms IS NULL OR p_from_ms<0
    OR p_through_ms<=p_from_ms OR p_through_ms>9007199254740991
    OR p_through_ms-p_from_ms>21600000 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  key:=encode(sha256(convert_to(concat_ws('|','horse-source-request-v1',p_actor::text,p_from_ms::text,p_through_ms::text),'UTF8')),'hex');
  SELECT * INTO r FROM public.horse_observation_capture_work w WHERE w.request_key=key;
  IF NOT FOUND THEN
    IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-source-capacity-v1',0)) THEN
      RETURN jsonb_build_object('version',1,'status','unavailable','reason','capacity_busy');
    END IF;
    SELECT * INTO r FROM public.horse_observation_capture_work w WHERE w.request_key=key;
    IF NOT FOUND THEN
      at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
      IF p_from_ms<at_ms-86400000 OR p_through_ms>at_ms THEN
        RETURN jsonb_build_object('version',1,'status','unavailable','reason','source_expired');
      END IF;
      SELECT count(*) INTO n FROM (SELECT 1 FROM public.horse_observation_capture_work w WHERE w.state NOT IN ('admitted','captured') LIMIT 257) q;
      IF n>=256 THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','capture_queue_full'); END IF;
      INSERT INTO public.horse_observation_capture_work(request_key,actor_id,from_ms,through_ms)
        VALUES(key,p_actor,p_from_ms,p_through_ms) RETURNING * INTO r;
    END IF;
  END IF;
  RETURN jsonb_build_object('version',1,'status','durable','requestKey',key,'state',r.state,
    'batchKey',r.batch_key,'batchDigest',r.batch_digest,'observations',r.observations,'reason',r.reason,'segments',r.segments,'capturedObservations',r.captured_observations);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_horse_learning_work_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
AS $function$
  WITH bounded AS MATERIALIZED (
    SELECT state,created_at,available_at,lease_until,attempts
      FROM public.horse_observation_capture_work WHERE state NOT IN ('admitted','captured') LIMIT 257
  ), totals AS (
    SELECT count(*) n,count(*) FILTER(WHERE state='queued') queued,
      count(*) FILTER(WHERE state='leased') leased,count(*) FILTER(WHERE state='gap') gaps,
      count(*) FILTER(WHERE (state='queued' AND available_at<=statement_timestamp()) OR (state='leased' AND lease_until<=statement_timestamp())) ready,
      count(*) FILTER(WHERE state='leased' AND lease_until<=statement_timestamp()) expired,
      greatest(0,coalesce(floor(extract(epoch FROM statement_timestamp()-min(created_at))*1000),0))::bigint oldest,
      coalesce(max(attempts),0) attempts FROM bounded
  ) SELECT jsonb_build_object('version',1,'journal',public.fn_horse_adaptive_journal_work_health(),
    'capture',CASE WHEN n>256 THEN jsonb_build_object('version',1,'status','unavailable','reason','queue_budget_exceeded')
      ELSE jsonb_build_object('version',1,'status','snapshot','sampledAtMs',floor(extract(epoch FROM statement_timestamp())*1000)::bigint,
        'unfinished',n,'queued',queued,'leased',leased,'gaps',gaps,'ready',ready,'expiredLeases',expired,'oldestWorkAgeMs',oldest,'maxAttempts',attempts) END) FROM totals;
$function$;

CREATE OR REPLACE FUNCTION public.fn_claim_horse_observation_capture(p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE r public.horse_observation_capture_work%ROWTYPE; first_ms bigint; last_ms bigint; gap_reason text;
BEGIN
  IF p_lease_token IS NULL THEN RAISE EXCEPTION 'HORSE_CAPTURE_INVALID_TOKEN'; END IF;
  SELECT * INTO r FROM public.horse_observation_capture_work w
    WHERE w.state NOT IN ('admitted','captured') AND ((w.state='queued' AND w.available_at<=clock_timestamp())
       OR (w.state='leased' AND w.lease_until<=clock_timestamp())
       OR (w.state='gap' AND w.reason='source_budget_exceeded' AND w.available_at<=clock_timestamp()
           AND coalesce(w.slice_through_ms,w.through_ms)-coalesce(w.cursor_ms,w.from_ms)>1))
    ORDER BY w.available_at,w.created_at,w.request_key LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'status','idle'); END IF;
  IF EXISTS(SELECT 1 FROM public.horse_observation_capture_receipts s
    WHERE s.request_key=r.request_key AND s.lease_token=p_lease_token) THEN
    RAISE EXCEPTION 'HORSE_CAPTURE_TOKEN_REUSED';
  END IF;
  first_ms:=coalesce(r.cursor_ms,r.from_ms); last_ms:=coalesce(r.slice_through_ms,r.through_ms);
  IF first_ms<floor(extract(epoch FROM clock_timestamp())*1000)::bigint-86400000 THEN gap_reason:='source_expired';
  ELSIF r.segments>=2048 AND first_ms<r.through_ms THEN gap_reason:='segment_budget_exceeded';
  END IF;
  IF gap_reason IS NOT NULL THEN
    UPDATE public.horse_observation_capture_work SET state='gap',reason=gap_reason,lease_token=NULL,lease_until=NULL WHERE request_key=r.request_key;
    RETURN jsonb_build_object('version',1,'status','gap','requestKey',r.request_key,'reason',gap_reason);
  END IF;
  IF first_ms>=last_ms THEN RAISE EXCEPTION 'HORSE_CAPTURE_INVALID_CURSOR'; END IF;
  UPDATE public.horse_observation_capture_work SET state='leased',lease_token=p_lease_token,
    lease_until=clock_timestamp()+interval '30 seconds',attempts=least(attempts+1,1000000),
    cursor_ms=first_ms,slice_through_ms=last_ms WHERE request_key=r.request_key;
  RETURN jsonb_build_object('version',1,'status','claimed','requestKey',r.request_key,
    'actorId',r.actor_id,'fromMs',r.from_ms,'throughMs',r.through_ms,'sliceFromMs',first_ms,
    'sliceThroughMs',last_ms,'leaseToken',p_lease_token);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_finish_horse_observation_capture(p_request_key text,p_lease_token uuid,p_payload text,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE r public.horse_observation_capture_work%ROWTYPE; prior public.horse_observation_capture_receipts%ROWTYPE;
  b jsonb; queued jsonb; actor_key text; fingerprint text; v_reason text; first_ms bigint; last_ms bigint;
  next_ms bigint; n integer; total bigint; new_state text; ack jsonb;
BEGIN
  IF p_request_key IS NULL OR p_request_key !~ '^[a-f0-9]{64}$' OR p_lease_token IS NULL
     OR octet_length(p_payload)>16777216 THEN RAISE EXCEPTION 'HORSE_CAPTURE_INVALID_FINISH'; END IF;
  SELECT * INTO r FROM public.horse_observation_capture_work w WHERE w.request_key=p_request_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'status','lease_lost','requestKey',p_request_key); END IF;
  IF p_payload IS NOT NULL THEN
    fingerprint:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
    SELECT * INTO prior FROM public.horse_observation_capture_receipts s
      WHERE s.request_key=p_request_key AND s.lease_token=p_lease_token;
    IF FOUND THEN
      IF prior.payload_digest IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'HORSE_CAPTURE_BATCH_CONFLICT'; END IF;
      RETURN prior.acknowledgment;
    END IF;
  END IF;
  IF r.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('version',1,'status','lease_lost','requestKey',p_request_key);
  END IF;
  first_ms:=coalesce(r.cursor_ms,r.from_ms); last_ms:=coalesce(r.slice_through_ms,r.through_ms);
  IF p_payload IS NOT NULL THEN
    b:=p_payload::jsonb;
    actor_key:=encode(sha256(convert_to(format('["adaptive-actor-v1","%s"]',r.actor_id),'UTF8')),'hex');
    -- Exact pre-upgrade receipts remain replayable without another enqueue.
    IF r.state='admitted' AND r.segments=0 THEN
      IF r.batch_digest IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'HORSE_CAPTURE_BATCH_CONFLICT'; END IF;
      RETURN jsonb_build_object('version',1,'status','admitted','requestKey',p_request_key,
        'batchKey',r.batch_key,'batchDigest',r.batch_digest,'observations',r.observations);
    END IF;
    IF jsonb_typeof(b) IS DISTINCT FROM 'array' OR jsonb_array_length(b)<>8
      OR b->0 IS DISTINCT FROM '1'::jsonb OR b->>2 IS DISTINCT FROM actor_key
      OR b->>3 IS DISTINCT FROM first_ms::text OR b->>4 IS DISTINCT FROM last_ms::text THEN
      RAISE EXCEPTION 'HORSE_CAPTURE_SCOPE_MISMATCH';
    END IF;
  END IF;
  IF r.state<>'leased' OR r.lease_until<=clock_timestamp() THEN
    RETURN jsonb_build_object('version',1,'status','lease_lost','requestKey',p_request_key);
  END IF;
  IF p_payload IS NOT NULL THEN
    IF r.segments>=2048 THEN RAISE EXCEPTION 'HORSE_CAPTURE_SEGMENT_BUDGET'; END IF;
    queued:=public.fn_queue_horse_adaptive_batch(p_payload);
    IF queued->>'status'='durable' AND queued->>'batchDigest'=fingerprint
      AND queued->>'batchKey'=b->>1 AND (queued->>'observations')::integer=jsonb_array_length(b->7) THEN
      n:=r.segments+1; total:=r.captured_observations+(queued->>'observations')::integer;
      next_ms:=least(r.through_ms,last_ms+2*(last_ms-first_ms));
      new_state:=CASE WHEN last_ms<r.through_ms THEN 'queued' WHEN n=1 THEN 'admitted' ELSE 'captured' END;
      ack:=jsonb_build_object('version',1,'status',CASE WHEN new_state='queued' THEN 'continued' ELSE new_state END,
        'requestKey',p_request_key,'batchKey',queued->>'batchKey','batchDigest',fingerprint,'observations',queued->'observations',
        'sliceFromMs',first_ms,'sliceThroughMs',last_ms,'nextFromMs',last_ms,'nextThroughMs',next_ms,
        'segments',n,'capturedObservations',total);
      INSERT INTO public.horse_observation_capture_receipts(request_key,lease_token,from_ms,through_ms,payload_digest,acknowledgment)
        VALUES(p_request_key,p_lease_token,first_ms,last_ms,fingerprint,ack);
      UPDATE public.horse_observation_capture_work SET state=new_state,cursor_ms=last_ms,slice_through_ms=next_ms,
        segments=n,captured_observations=total,
        batch_key=CASE WHEN new_state='admitted' THEN queued->>'batchKey' ELSE NULL END,
        batch_digest=CASE WHEN new_state='admitted' THEN fingerprint ELSE NULL END,
        observations=CASE WHEN new_state='admitted' THEN (queued->>'observations')::integer ELSE NULL END,
        admitted_at=CASE WHEN new_state IN ('admitted','captured') THEN clock_timestamp() ELSE NULL END,
        lease_until=NULL,reason=NULL,available_at=clock_timestamp() WHERE request_key=p_request_key;
      RETURN ack;
    END IF;
    v_reason:=CASE WHEN queued->>'reason' IN ('queue_full','capacity_busy') THEN queued->>'reason' ELSE 'queue_unavailable' END;
  ELSE v_reason:=CASE WHEN p_reason IN ('source_budget_exceeded','invalid_source') THEN p_reason ELSE 'source_unavailable' END;
  END IF;
  IF v_reason='source_budget_exceeded' AND last_ms-first_ms>1 THEN
    next_ms:=first_ms+(last_ms-first_ms)/2;
    UPDATE public.horse_observation_capture_work SET state='queued',slice_through_ms=next_ms,lease_until=NULL,
      reason='source_budget_refined',available_at=clock_timestamp() WHERE request_key=p_request_key;
    RETURN jsonb_build_object('version',1,'status','refined','requestKey',p_request_key,
      'nextFromMs',first_ms,'nextThroughMs',next_ms);
  END IF;
  IF v_reason IN ('source_budget_exceeded','invalid_source') THEN
    UPDATE public.horse_observation_capture_work SET state='gap',reason=v_reason,lease_until=NULL WHERE request_key=p_request_key;
    RETURN jsonb_build_object('version',1,'status','gap','requestKey',p_request_key,'reason',v_reason);
  END IF;
  UPDATE public.horse_observation_capture_work SET state='queued',reason=v_reason,lease_until=NULL,
    available_at=clock_timestamp()+make_interval(secs=>least(60,power(2,least(r.attempts,6))::integer)) WHERE request_key=p_request_key;
  RETURN jsonb_build_object('version',1,'status','deferred','requestKey',p_request_key,'reason',v_reason);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_prune_horse_observation_captures()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE n integer; slices integer; keys text[];
BEGIN
  SELECT array_agg(request_key) INTO keys FROM (
    SELECT w.request_key FROM public.horse_observation_capture_work w
      WHERE w.state IN ('admitted','captured') AND w.admitted_at<clock_timestamp()-interval '32 days'
      ORDER BY w.admitted_at,w.request_key LIMIT 100 FOR UPDATE SKIP LOCKED
  ) bounded;
  WITH candidates AS (
    SELECT s.request_key,s.lease_token FROM public.horse_observation_capture_receipts s
      WHERE s.request_key=ANY(keys) LIMIT 1000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.horse_observation_capture_receipts s USING candidates c
      WHERE s.request_key=c.request_key AND s.lease_token=c.lease_token;
  GET DIAGNOSTICS slices=ROW_COUNT;
  DELETE FROM public.horse_observation_capture_work w WHERE w.request_key=ANY(keys)
    AND NOT EXISTS(SELECT 1 FROM public.horse_observation_capture_receipts s WHERE s.request_key=w.request_key);
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN jsonb_build_object('version',1,'status','pruned','requests',n,'sliceReceipts',slices);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_admit_horse_observation_capture(uuid,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_claim_horse_observation_capture(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_finish_horse_observation_capture(text,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_prune_horse_observation_captures() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_horse_learning_work_health() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_admit_horse_observation_capture(uuid,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_claim_horse_observation_capture(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_finish_horse_observation_capture(text,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_prune_horse_observation_captures() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_learning_work_health() TO service_role;
COMMIT;
