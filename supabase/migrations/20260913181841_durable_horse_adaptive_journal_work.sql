-- Reserved at 2026-09-13 18:18:41 UTC. Isolated, bounded journal work only.
-- No settlement/table trigger, hot-table foreign key, timer or live activation.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE TABLE public.horse_adaptive_journal_work (
  batch_key text PRIMARY KEY CHECK(batch_key ~ '^[a-f0-9]{64}$'),
  batch_digest text NOT NULL CHECK(batch_digest ~ '^[a-f0-9]{64}$'),
  observations integer NOT NULL CHECK(observations BETWEEN 0 AND 20000),
  payload text CHECK(octet_length(payload)<=16777216),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','completed','quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1000000),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK(payload IS NOT NULL OR state='completed'),
  CHECK(state<>'leased' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX horse_adaptive_work_ready ON public.horse_adaptive_journal_work(available_at,created_at,batch_key)
  WHERE state IN ('queued','leased');
CREATE INDEX horse_adaptive_work_unfinished ON public.horse_adaptive_journal_work(state,batch_key) WHERE state<>'completed';
ALTER TABLE public.horse_adaptive_journal_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_adaptive_journal_work FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_queue_horse_adaptive_batch(p_payload text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE
  b jsonb; key text; fingerprint text; n integer; occupied integer; used_bytes bigint;
  prior public.horse_adaptive_journal_work%ROWTYPE;
  receipt public.horse_adaptive_observation_batches%ROWTYPE;
BEGIN
  IF p_payload IS NULL OR octet_length(p_payload)>16777216 THEN RAISE EXCEPTION 'ADAPTIVE_WORK_INVALID_BATCH'; END IF;
  b:=p_payload::jsonb;
  IF jsonb_typeof(b) IS DISTINCT FROM 'array' OR jsonb_array_length(b)<>8 THEN RAISE EXCEPTION 'ADAPTIVE_WORK_INVALID_BATCH'; END IF;
  IF b->0 IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(b->1) IS DISTINCT FROM 'string'
     OR b->>1 !~ '^[a-f0-9]{64}$' OR jsonb_typeof(b->2) IS DISTINCT FROM 'string'
     OR b->>2 !~ '^[a-f0-9]{64}$' OR jsonb_typeof(b->3) IS DISTINCT FROM 'number'
     OR b->>3 !~ '^[0-9]{1,16}$' OR jsonb_typeof(b->4) IS DISTINCT FROM 'number'
     OR b->>4 !~ '^[0-9]{1,16}$' OR jsonb_typeof(b->5) IS DISTINCT FROM 'string'
     OR b->>5 !~ '^[a-f0-9]{64}$' OR jsonb_typeof(b->6) IS DISTINCT FROM 'array'
     OR jsonb_array_length(b->6)>64 OR jsonb_typeof(b->7) IS DISTINCT FROM 'array'
     OR jsonb_array_length(b->7)>20000 THEN RAISE EXCEPTION 'ADAPTIVE_WORK_INVALID_BATCH'; END IF;
  key:=b->>1;fingerprint:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');n:=jsonb_array_length(b->7);
  IF (b->>4)::bigint<=(b->>3)::bigint OR (b->>4)::bigint-(b->>3)::bigint>21600000
     OR (b->>4)::bigint>9007199254740991
     OR key<>encode(sha256(convert_to(concat_ws('|','adaptive-journal-v1',b->>2,b->>5,b->>3,b->>4),'UTF8')),'hex')
     THEN RAISE EXCEPTION 'ADAPTIVE_WORK_INVALID_BATCH'; END IF;
  SELECT * INTO prior FROM public.horse_adaptive_journal_work w WHERE w.batch_key=key FOR UPDATE;
  IF FOUND THEN
    IF prior.batch_digest<>fingerprint THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','batch_conflict'); END IF;
    RETURN jsonb_build_object('version',1,'status','durable','batchKey',key,'batchDigest',fingerprint,'observations',n);
  END IF;
  SELECT * INTO receipt FROM public.horse_adaptive_observation_batches q WHERE q.batch_key=key;
  IF FOUND THEN
    IF receipt.batch_digest<>fingerprint THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','batch_conflict'); END IF;
    IF receipt.canonical_payload IS NULL THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','legacy_batch_payload_unavailable'); END IF;
  END IF;
  -- Try, never wait behind another capacity reservation. Existing jobs remain
  -- replayable even while the bounded new-work buffer is full.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','capacity_busy');
  END IF;
  -- Another enqueue may have committed after the first read but before this
  -- capacity reservation. Re-read its immutable receipt under the same key.
  SELECT * INTO prior FROM public.horse_adaptive_journal_work w WHERE w.batch_key=key FOR UPDATE;
  IF FOUND THEN
    IF prior.batch_digest<>fingerprint THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','batch_conflict'); END IF;
    RETURN jsonb_build_object('version',1,'status','durable','batchKey',key,'batchDigest',fingerprint,'observations',n);
  END IF;
  SELECT count(*),coalesce(sum(octet_length(w.payload)),0) INTO occupied,used_bytes
    FROM public.horse_adaptive_journal_work w WHERE w.state<>'completed';
  IF occupied>=256 OR used_bytes+octet_length(p_payload)>67108864 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','queue_full');
  END IF;
  INSERT INTO public.horse_adaptive_journal_work(batch_key,batch_digest,observations,payload)
    VALUES(key,fingerprint,n,p_payload);
  RETURN jsonb_build_object('version',1,'status','durable','batchKey',key,'batchDigest',fingerprint,'observations',n);
END
$function$;

CREATE FUNCTION public.fn_claim_horse_adaptive_batch(p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE w public.horse_adaptive_journal_work%ROWTYPE;
BEGIN
  IF p_lease_token IS NULL THEN RAISE EXCEPTION 'ADAPTIVE_WORK_INVALID_LEASE'; END IF;
  WITH candidate AS (
    SELECT q.batch_key FROM public.horse_adaptive_journal_work q
    WHERE (q.state='queued' AND q.available_at<=clock_timestamp())
       OR (q.state='leased' AND q.lease_until<=clock_timestamp())
    ORDER BY q.available_at,q.created_at,q.batch_key LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE public.horse_adaptive_journal_work q
      SET state='leased',lease_token=p_lease_token,lease_until=clock_timestamp()+interval '30 seconds',
          attempts=least(q.attempts+1,1000000)
      FROM candidate c WHERE q.batch_key=c.batch_key RETURNING q.* INTO w;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'status','idle'); END IF;
  RETURN jsonb_build_object('version',1,'status','claimed','batchKey',w.batch_key,
    'batchDigest',w.batch_digest,'observations',w.observations,'payload',w.payload,'leaseToken',w.lease_token);
END
$function$;

CREATE FUNCTION public.fn_finish_horse_adaptive_batch(p_batch_key text,p_lease_token uuid,p_outcome text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE w public.horse_adaptive_journal_work%ROWTYPE;
BEGIN
  IF p_batch_key IS NULL OR p_batch_key !~ '^[a-f0-9]{64}$' OR p_lease_token IS NULL
     OR p_outcome IS NULL OR p_outcome NOT IN ('recorded','unknown','rejected') THEN
    RAISE EXCEPTION 'ADAPTIVE_WORK_INVALID_ACK';
  END IF;
  SELECT * INTO w FROM public.horse_adaptive_journal_work q WHERE q.batch_key=p_batch_key FOR UPDATE;
  IF NOT FOUND OR w.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('version',1,'status','lease_lost','batchKey',p_batch_key);
  END IF;
  IF w.state='completed' AND p_outcome='recorded' THEN
    RETURN jsonb_build_object('version',1,'status','completed','batchKey',p_batch_key);
  END IF;
  IF w.state<>'leased' OR w.lease_until<=clock_timestamp() THEN
    RETURN jsonb_build_object('version',1,'status','lease_lost','batchKey',p_batch_key);
  END IF;
  IF p_outcome='recorded' THEN
    IF NOT EXISTS(SELECT 1 FROM public.horse_adaptive_observation_batches b
      WHERE b.batch_key=w.batch_key AND b.batch_digest=w.batch_digest
        AND b.observation_count=w.observations AND b.canonical_payload=w.payload) THEN
      RETURN jsonb_build_object('version',1,'status','receipt_unconfirmed','batchKey',p_batch_key);
    END IF;
    UPDATE public.horse_adaptive_journal_work q SET state='completed',payload=NULL,
      completed_at=clock_timestamp(),lease_until=NULL WHERE q.batch_key=p_batch_key;
    RETURN jsonb_build_object('version',1,'status','completed','batchKey',p_batch_key);
  ELSIF p_outcome='rejected' THEN
    UPDATE public.horse_adaptive_journal_work q SET state='quarantined',lease_token=NULL,lease_until=NULL
      WHERE q.batch_key=p_batch_key;
    RETURN jsonb_build_object('version',1,'status','quarantined','batchKey',p_batch_key);
  ELSE
    UPDATE public.horse_adaptive_journal_work q SET state='queued',lease_token=NULL,lease_until=NULL,
      available_at=clock_timestamp()+make_interval(secs=>least(60,power(2,least(w.attempts,6))::integer))
      WHERE q.batch_key=p_batch_key;
    RETURN jsonb_build_object('version',1,'status','deferred','batchKey',p_batch_key);
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_queue_horse_adaptive_batch(text),
  public.fn_claim_horse_adaptive_batch(uuid),public.fn_finish_horse_adaptive_batch(text,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_queue_horse_adaptive_batch(text),
  public.fn_claim_horse_adaptive_batch(uuid),public.fn_finish_horse_adaptive_batch(text,uuid,text) TO service_role;
COMMENT ON TABLE public.horse_adaptive_journal_work IS
  'Service-only immutable-payload work. At most 256 unfinished items and64MiB via enqueue; leases fence acknowledgments, recorded completion requires the exact journal receipt. No source-discovery watermark or learner activation.';
COMMIT;
