-- Reserved 2026-09-14 01:22:49 UTC. Before a source snapshot reached the
-- journal queue, a process loss could erase its acquisition request. Persist
-- bounded immutable actor/window requests first; bind admission to the exact
-- queued public payload in the same transaction. Unreadable/expired sources
-- remain unknown or explicit gaps, never a complete observation watermark.
-- Isolated learner metadata only: no financial trigger, hot-table FK or policy.
BEGIN;
SET LOCAL lock_timeout='2s';
CREATE TABLE public.horse_observation_capture_work (
  request_key text PRIMARY KEY CHECK(request_key ~ '^[a-f0-9]{64}$'),
  actor_id uuid NOT NULL,
  from_ms bigint NOT NULL CHECK(from_ms>=0),
  through_ms bigint NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','admitted','gap')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1000000),
  reason text,
  batch_key text,
  batch_digest text,
  observations integer,
  admitted_at timestamptz,
  CHECK(through_ms>from_ms AND through_ms-from_ms<=21600000 AND through_ms<=9007199254740991),
  CHECK(state<>'admitted' OR (batch_key IS NOT NULL AND batch_digest IS NOT NULL AND observations IS NOT NULL AND admitted_at IS NOT NULL)),
  CHECK(batch_key IS NULL OR batch_key ~ '^[a-f0-9]{64}$'),
  CHECK(batch_digest IS NULL OR batch_digest ~ '^[a-f0-9]{64}$'),
  CHECK(observations IS NULL OR observations BETWEEN 0 AND 20000)
);
CREATE INDEX horse_capture_pending ON public.horse_observation_capture_work(available_at,created_at,request_key) WHERE state IN ('queued','leased');
CREATE INDEX horse_capture_unfinished ON public.horse_observation_capture_work(state) WHERE state<>'admitted';
CREATE INDEX horse_capture_retention ON public.horse_observation_capture_work(admitted_at,request_key) WHERE state='admitted';
ALTER TABLE public.horse_observation_capture_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_observation_capture_work FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_admit_horse_observation_capture(p_actor uuid,p_from_ms bigint,p_through_ms bigint)
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
      SELECT count(*) INTO n FROM (SELECT 1 FROM public.horse_observation_capture_work w WHERE w.state<>'admitted' LIMIT 257) q;
      IF n>=256 THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','capture_queue_full'); END IF;
      INSERT INTO public.horse_observation_capture_work(request_key,actor_id,from_ms,through_ms)
        VALUES(key,p_actor,p_from_ms,p_through_ms) RETURNING * INTO r;
    END IF;
  END IF;
  RETURN jsonb_build_object('version',1,'status','durable','requestKey',key,'state',r.state,
    'batchKey',r.batch_key,'batchDigest',r.batch_digest,'observations',r.observations,'reason',r.reason);
END;
$function$;

CREATE FUNCTION public.fn_claim_horse_observation_capture(p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE r public.horse_observation_capture_work%ROWTYPE;
BEGIN
  IF p_lease_token IS NULL THEN RAISE EXCEPTION 'HORSE_CAPTURE_INVALID_TOKEN'; END IF;
  SELECT * INTO r FROM public.horse_observation_capture_work w
    WHERE w.state IN ('queued','leased') AND ((w.state='queued' AND w.available_at<=clock_timestamp())
      OR (w.state='leased' AND w.lease_until<=clock_timestamp()))
    ORDER BY w.available_at,w.created_at,w.request_key LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'status','idle'); END IF;
  IF r.from_ms<floor(extract(epoch FROM clock_timestamp())*1000)::bigint-86400000 THEN
    UPDATE public.horse_observation_capture_work SET state='gap',reason='source_expired',lease_token=NULL,lease_until=NULL WHERE request_key=r.request_key;
    RETURN jsonb_build_object('version',1,'status','gap','requestKey',r.request_key,'reason','source_expired');
  END IF;
  UPDATE public.horse_observation_capture_work SET state='leased',lease_token=p_lease_token,
    lease_until=clock_timestamp()+interval '30 seconds',attempts=least(attempts+1,1000000)
    WHERE request_key=r.request_key;
  RETURN jsonb_build_object('version',1,'status','claimed','requestKey',r.request_key,
    'actorId',r.actor_id,'fromMs',r.from_ms,'throughMs',r.through_ms,'leaseToken',p_lease_token);
END;
$function$;

CREATE FUNCTION public.fn_finish_horse_observation_capture(p_request_key text,p_lease_token uuid,p_payload text,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE r public.horse_observation_capture_work%ROWTYPE; b jsonb; queued jsonb; actor_key text; fingerprint text; v_reason text;
BEGIN
  IF p_request_key IS NULL OR p_request_key !~ '^[a-f0-9]{64}$' OR p_lease_token IS NULL
     OR octet_length(p_payload)>16777216 THEN RAISE EXCEPTION 'HORSE_CAPTURE_INVALID_FINISH'; END IF;
  SELECT * INTO r FROM public.horse_observation_capture_work w WHERE w.request_key=p_request_key FOR UPDATE;
  IF NOT FOUND OR r.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('version',1,'status','lease_lost','requestKey',p_request_key);
  END IF;
  IF p_payload IS NOT NULL THEN
    b:=p_payload::jsonb;
    actor_key:=encode(sha256(convert_to(format('["adaptive-actor-v1","%s"]',r.actor_id),'UTF8')),'hex');
    IF jsonb_typeof(b) IS DISTINCT FROM 'array' OR jsonb_array_length(b)<>8
      OR b->0 IS DISTINCT FROM '1'::jsonb OR b->>2 IS DISTINCT FROM actor_key
      OR b->>3 IS DISTINCT FROM r.from_ms::text OR b->>4 IS DISTINCT FROM r.through_ms::text THEN
      RAISE EXCEPTION 'HORSE_CAPTURE_SCOPE_MISMATCH';
    END IF;
    fingerprint:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
    IF r.state='admitted' THEN
      IF r.batch_digest IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'HORSE_CAPTURE_BATCH_CONFLICT'; END IF;
      RETURN jsonb_build_object('version',1,'status','admitted','requestKey',p_request_key,
        'batchKey',r.batch_key,'batchDigest',r.batch_digest,'observations',r.observations);
    END IF;
  END IF;
  IF r.state<>'leased' OR r.lease_until<=clock_timestamp() THEN
    RETURN jsonb_build_object('version',1,'status','lease_lost','requestKey',p_request_key);
  END IF;
  IF p_payload IS NOT NULL THEN
    queued:=public.fn_queue_horse_adaptive_batch(p_payload);
    IF queued->>'status'='durable' AND queued->>'batchDigest'=fingerprint
      AND queued->>'batchKey'=b->>1 AND (queued->>'observations')::integer=jsonb_array_length(b->7) THEN
      UPDATE public.horse_observation_capture_work SET state='admitted',batch_key=queued->>'batchKey',
        batch_digest=fingerprint,observations=(queued->>'observations')::integer,
        admitted_at=clock_timestamp(),lease_until=NULL,reason=NULL WHERE request_key=p_request_key;
      RETURN jsonb_build_object('version',1,'status','admitted','requestKey',p_request_key,
        'batchKey',queued->>'batchKey','batchDigest',fingerprint,'observations',queued->'observations');
    END IF;
    v_reason:=CASE WHEN queued->>'reason' IN ('queue_full','capacity_busy') THEN queued->>'reason' ELSE 'queue_unavailable' END;
  ELSE
    v_reason:=CASE WHEN p_reason IN ('source_budget_exceeded','invalid_source') THEN p_reason ELSE 'source_unavailable' END;
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

CREATE FUNCTION public.fn_prune_horse_observation_captures()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE n integer;
BEGIN
  WITH candidates AS (
    SELECT w.request_key FROM public.horse_observation_capture_work w
      WHERE w.state='admitted' AND w.admitted_at<clock_timestamp()-interval '32 days'
      ORDER BY w.admitted_at,w.request_key LIMIT 100 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.horse_observation_capture_work w USING candidates c WHERE w.request_key=c.request_key;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN jsonb_build_object('version',1,'status','pruned','requests',n);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_admit_horse_observation_capture(uuid,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_claim_horse_observation_capture(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_finish_horse_observation_capture(text,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_prune_horse_observation_captures() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_admit_horse_observation_capture(uuid,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_claim_horse_observation_capture(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_finish_horse_observation_capture(text,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_prune_horse_observation_captures() TO service_role;
CREATE FUNCTION public.fn_horse_learning_work_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
AS $function$
  WITH bounded AS MATERIALIZED (
    SELECT state,created_at,available_at,lease_until,attempts
      FROM public.horse_observation_capture_work WHERE state<>'admitted' LIMIT 257
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
REVOKE ALL ON FUNCTION public.fn_horse_learning_work_health() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_learning_work_health() TO service_role;
COMMIT;
