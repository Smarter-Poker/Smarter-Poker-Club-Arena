-- Reserved by scripts/reserve-migration-version.sh on 2026-09-13 17:07:29 UTC.
-- Qualified evidence previously had no durable identity ledger. Retrying an
-- acquisition must neither increment a counter nor replace an earlier fact.
-- This isolated journal atomically records an immutable batch and its unique
-- observations. It has no live consumer, money writes, hot-table foreign key,
-- trigger, scheduler or activation side effect. Native proof covers replay,
-- cross-batch conflict rollback, concurrency, isolation and service-only ACLs.
BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE TABLE public.horse_adaptive_observation_journal (
  observation_id text PRIMARY KEY,
  hand_id uuid NOT NULL,
  actor_key text NOT NULL,
  session_key text NOT NULL,
  observed_at_ms bigint NOT NULL,
  partition text NOT NULL CHECK (partition IN ('training','holdout')),
  scope_key text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('player','pre_action','horse_policy')),
  payload text NOT NULL CHECK (octet_length(payload) <= 16384),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX horse_adaptive_journal_scope_window
  ON public.horse_adaptive_observation_journal
  (actor_key,scope_key,partition,origin,observed_at_ms,observation_id);

CREATE TABLE public.horse_adaptive_observation_batches (
  batch_key text PRIMARY KEY,
  batch_digest text NOT NULL,
  actor_key text NOT NULL,
  source_digest text NOT NULL,
  from_ms bigint NOT NULL,
  through_ms bigint NOT NULL,
  observation_count integer NOT NULL,
  rejected jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE public.horse_adaptive_observation_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.horse_adaptive_observation_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_adaptive_observation_journal,
  public.horse_adaptive_observation_batches FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_append_horse_adaptive_observations(p_batch text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET lock_timeout TO '2s'
AS $function$
DECLARE
  b jsonb; o jsonb; s jsonb; row_text text;
  v_batch_key text; v_batch_digest text; v_actor_key text; v_source_digest text;
  v_from_ms bigint; v_through_ms bigint; n integer;
  now_ms bigint := floor(extract(epoch FROM statement_timestamp())*1000)::bigint;
  prior public.horse_adaptive_observation_batches%ROWTYPE;
  stored text; rejection jsonb;
BEGIN
  IF p_batch IS NULL OR octet_length(p_batch)>16777216 THEN
    RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_BATCH';
  END IF;
  b := p_batch::jsonb;
  IF jsonb_typeof(b) IS DISTINCT FROM 'array' OR jsonb_array_length(b)<>8 THEN
    RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_BATCH';
  END IF;
  IF b->0 IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(b->1) IS DISTINCT FROM 'string'
     OR (b->>1) !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(b->2) IS DISTINCT FROM 'string'
     OR (b->>2) !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(b->3) IS DISTINCT FROM 'number'
     OR (b->>3) !~ '^[0-9]{1,16}$'
     OR jsonb_typeof(b->4) IS DISTINCT FROM 'number'
     OR (b->>4) !~ '^[0-9]{1,16}$'
     OR jsonb_typeof(b->5) IS DISTINCT FROM 'string'
     OR (b->>5) !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(b->6) IS DISTINCT FROM 'array'
     OR jsonb_typeof(b->7) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_BATCH';
  END IF;
  v_batch_key:=b->>1; v_actor_key:=b->>2; v_from_ms:=(b->>3)::bigint;
  v_through_ms:=(b->>4)::bigint; v_source_digest:=b->>5;
  n:=jsonb_array_length(b->7);
  IF v_through_ms<=v_from_ms OR v_through_ms-v_from_ms>21600000
     OR v_through_ms>9007199254740991 OR n>20000
     OR jsonb_array_length(b->6)>64 OR octet_length((b->6)::text)>8192
     OR v_batch_key<>encode(sha256(convert_to(concat_ws('|','adaptive-journal-v1',
          v_actor_key,v_source_digest,v_from_ms::text,v_through_ms::text),'UTF8')),'hex') THEN
    RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_BATCH';
  END IF;
  v_batch_digest:=encode(sha256(convert_to(p_batch,'UTF8')),'hex');
  SELECT * INTO prior FROM public.horse_adaptive_observation_batches q WHERE q.batch_key=v_batch_key;
  IF FOUND THEN
    IF prior.batch_digest<>v_batch_digest THEN RAISE EXCEPTION 'ADAPTIVE_JOURNAL_BATCH_CONFLICT'; END IF;
    RETURN jsonb_build_object('version',1,'status','recorded','batchKey',v_batch_key,
      'batchDigest',v_batch_digest,'observations',prior.observation_count);
  END IF;
  IF v_from_ms<now_ms-2592000000 OR v_through_ms>now_ms THEN
    RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_BATCH';
  END IF;
  FOR rejection IN SELECT value FROM jsonb_array_elements(b->6) LOOP
    IF jsonb_typeof(rejection) IS DISTINCT FROM 'array' OR jsonb_array_length(rejection)<>2
       OR jsonb_typeof(rejection->0) IS DISTINCT FROM 'string'
       OR (rejection->>0) !~ '^[a-z_]{1,64}$'
       OR jsonb_typeof(rejection->1) IS DISTINCT FROM 'number'
       OR (rejection->>1) !~ '^[0-9]{1,8}$' THEN
      RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_BATCH';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT ((value #>> '{}')::jsonb->>1))
      FROM jsonb_array_elements(b->7))<>n THEN
    RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_BATCH';
  END IF;
  -- Each key is acquired in a common order across overlapping batches. A
  -- conflicting payload raises and rolls back every insertion in this call.
  FOR row_text IN SELECT value #>> '{}' FROM jsonb_array_elements(b->7)
                  ORDER BY (value #>> '{}')::jsonb->>1 LOOP
    IF row_text IS NULL OR octet_length(row_text)>16384 THEN
      RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_OBSERVATION';
    END IF;
    o:=row_text::jsonb;
    IF jsonb_typeof(o) IS DISTINCT FROM 'array' OR jsonb_array_length(o)<>12 THEN
      RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_OBSERVATION';
    END IF;
    IF o->0 IS DISTINCT FROM '1'::jsonb
       OR jsonb_typeof(o->1) IS DISTINCT FROM 'string'
       OR (o->>1) !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}:(0|[1-9][0-9]{0,3})$'
       OR jsonb_typeof(o->2) IS DISTINCT FROM 'string'
       OR split_part(o->>1,':',1)<>o->>2
       OR split_part(o->>1,':',2)::integer>=4096
       OR o->3 IS DISTINCT FROM to_jsonb(v_actor_key)
       OR jsonb_typeof(o->4) IS DISTINCT FROM 'string'
       OR (o->>4) !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(o->5) IS DISTINCT FROM 'number'
       OR (o->>5) !~ '^[0-9]{1,16}$'
       OR jsonb_typeof(o->6) IS DISTINCT FROM 'string'
       OR (o->>6) NOT IN ('training','holdout')
       OR jsonb_typeof(o->7) IS DISTINCT FROM 'string'
       OR (o->>7) !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(o->8) IS DISTINCT FROM 'string'
       OR octet_length(o->>8)>8192
       OR jsonb_typeof(o->9) IS DISTINCT FROM 'string'
       OR (o->>9) NOT IN ('fold','check','call','bet','raise')
       OR jsonb_typeof(o->10) IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(o->11) IS DISTINCT FROM 'string'
       OR (o->>11) NOT IN ('player','pre_action','horse_policy') THEN
      RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_OBSERVATION';
    END IF;
    s:=(o->>8)::jsonb;
    IF (o->>5)::bigint<now_ms-2592000000 OR (o->>5)::bigint>now_ms
       OR jsonb_typeof(s) IS DISTINCT FROM 'array' OR jsonb_array_length(s)<>29
       OR s->0 IS DISTINCT FROM '"adaptive-public-node-v1"'::jsonb
       OR (o->>8) ~ '[{}]'
       OR o->>7<>encode(sha256(convert_to(o->>8,'UTF8')),'hex')
       OR o->>6<>(CASE WHEN ('x'||left(o->>4,8))::bit(32)::bigint % 5=0
                         THEN 'holdout' ELSE 'training' END) THEN
      RAISE EXCEPTION 'ADAPTIVE_JOURNAL_INVALID_OBSERVATION';
    END IF;
    INSERT INTO public.horse_adaptive_observation_journal
      (observation_id,hand_id,actor_key,session_key,observed_at_ms,partition,scope_key,origin,payload)
    VALUES(o->>1,(o->>2)::uuid,o->>3,o->>4,(o->>5)::bigint,o->>6,o->>7,o->>11,row_text)
    ON CONFLICT (observation_id) DO NOTHING;
    SELECT q.payload INTO stored FROM public.horse_adaptive_observation_journal q
      WHERE q.observation_id=o->>1;
    IF stored IS DISTINCT FROM row_text THEN RAISE EXCEPTION 'ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT'; END IF;
  END LOOP;
  INSERT INTO public.horse_adaptive_observation_batches
    (batch_key,batch_digest,actor_key,source_digest,from_ms,through_ms,observation_count,rejected)
  VALUES(v_batch_key,v_batch_digest,v_actor_key,v_source_digest,v_from_ms,v_through_ms,n,b->6)
  ON CONFLICT ON CONSTRAINT horse_adaptive_observation_batches_pkey DO NOTHING;
  SELECT * INTO prior FROM public.horse_adaptive_observation_batches q WHERE q.batch_key=v_batch_key;
  IF prior.batch_digest IS DISTINCT FROM v_batch_digest THEN RAISE EXCEPTION 'ADAPTIVE_JOURNAL_BATCH_CONFLICT'; END IF;
  RETURN jsonb_build_object('version',1,'status','recorded','batchKey',v_batch_key,
    'batchDigest',v_batch_digest,'observations',n);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_append_horse_adaptive_observations(text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_append_horse_adaptive_observations(text) TO service_role;
COMMENT ON FUNCTION public.fn_append_horse_adaptive_observations(text) IS
  'Bounded service-only immutable qualified observation journal. One transaction for the batch and all observation identities. No aggregate counters, action-clock caller or tuning activation.';

CREATE FUNCTION public.fn_horse_adaptive_journal_snapshot(
  p_actor_key text,p_scope_key text,p_partition text,p_cohort text,p_from_ms bigint,p_to_ms bigint
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
AS $function$
DECLARE
  n integer; bytes bigint; rows jsonb;
  now_ms bigint:=floor(extract(epoch FROM statement_timestamp())*1000)::bigint;
BEGIN
  IF p_actor_key IS NULL OR p_actor_key !~ '^[a-f0-9]{64}$'
     OR p_scope_key IS NULL OR p_scope_key !~ '^[a-f0-9]{64}$'
     OR p_partition IS NULL OR p_partition NOT IN ('training','holdout')
     OR p_cohort IS NULL OR p_cohort NOT IN ('human','horse_policy')
     OR p_from_ms IS NULL OR p_to_ms IS NULL OR p_to_ms<=p_from_ms
     OR p_to_ms>now_ms OR p_from_ms<now_ms-2592000000 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT q.observation_id,q.observed_at_ms,q.payload
    FROM public.horse_adaptive_observation_journal q
    WHERE q.actor_key=p_actor_key AND q.scope_key=p_scope_key AND q.partition=p_partition
      AND q.origin=ANY(CASE WHEN p_cohort='human' THEN ARRAY['player','pre_action']
                            ELSE ARRAY['horse_policy'] END)
      AND q.observed_at_ms>=p_from_ms AND q.observed_at_ms<p_to_ms
    LIMIT 20001
  ), totals AS (
    SELECT count(*)::integer n,coalesce(sum(octet_length(payload)),0)::bigint bytes FROM candidates
  )
  SELECT t.n,t.bytes,CASE WHEN t.n<=20000 AND t.bytes<=16777216
    THEN (SELECT coalesce(jsonb_agg(payload ORDER BY observed_at_ms,observation_id),'[]'::jsonb)
          FROM candidates) ELSE '[]'::jsonb END INTO n,bytes,rows FROM totals t;
  RETURN jsonb_build_object('version',1,
    'status',CASE WHEN n>20000 OR bytes>16777216 THEN 'unavailable' ELSE 'snapshot' END,
    'reason',CASE WHEN n>20000 THEN 'observation_budget_exceeded'
                  WHEN bytes>16777216 THEN 'byte_budget_exceeded' ELSE NULL END,
    'coverage','journaled_qualified_observations','actorKey',p_actor_key,'scopeKey',p_scope_key,
    'partition',p_partition,'cohort',p_cohort,'fromMs',p_from_ms,'toMs',p_to_ms,
    'readAtMs',now_ms,'snapshotId',pg_current_snapshot()::text,
    'observations',n,'bytes',bytes,'rows',rows);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_adaptive_journal_snapshot(text,text,text,text,bigint,bigint)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_adaptive_journal_snapshot(text,text,text,text,bigint,bigint)
  TO service_role;
COMMENT ON FUNCTION public.fn_horse_adaptive_journal_snapshot(text,text,text,text,bigint,bigint) IS
  'One bounded snapshot of journaled qualified observations only. Not a watermark for uncommitted, uncaptured or uningested actions. A partial or oversized result is unavailable, never a complete model window.';

COMMIT;
