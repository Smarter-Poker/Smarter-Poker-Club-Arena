-- Reserved by scripts/reserve-migration-version.sh at 2026-09-13 17:59:35 UTC.
-- Keep the exact submitted PUBLIC batch for retrieval/replay after the caller
-- loses its in-memory source snapshot. Existing receipts remain immutable:
-- legacy NULL payloads are explicitly unavailable, never guessed or backfilled.
-- No live caller, timer, trigger, hot-table FK or money/settlement change.
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid =
      'public.fn_append_horse_adaptive_observations(text)'::regprocedure)
      IS DISTINCT FROM '582623a15183e1c07a5807fb7cac705d' THEN
    RAISE EXCEPTION 'Unexpected adaptive journal writer; preserve it for review';
  END IF;
END
$guard$;
ALTER TABLE public.horse_adaptive_observation_batches
  ADD COLUMN canonical_payload text CHECK (octet_length(canonical_payload)<=16777216);
COMMENT ON COLUMN public.horse_adaptive_observation_batches.canonical_payload IS
  'Exact canonical submitted public batch. NULL means a legacy receipt whose original payload is unavailable. Never replace it with a later acquisition.';

CREATE OR REPLACE FUNCTION public.fn_append_horse_adaptive_observations(p_batch text)
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
    (batch_key,batch_digest,actor_key,source_digest,from_ms,through_ms,observation_count,rejected,canonical_payload)
  VALUES(v_batch_key,v_batch_digest,v_actor_key,v_source_digest,v_from_ms,v_through_ms,n,b->6,p_batch)
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

CREATE FUNCTION public.fn_horse_adaptive_journal_batch(p_batch_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
AS $function$
DECLARE
  b public.horse_adaptive_observation_batches%ROWTYPE;
BEGIN
  IF p_batch_key IS NULL OR p_batch_key !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  SELECT * INTO b FROM public.horse_adaptive_observation_batches q WHERE q.batch_key=p_batch_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','batch_not_found');
  END IF;
  IF b.canonical_payload IS NULL THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','legacy_batch_payload_unavailable');
  END IF;
  RETURN jsonb_build_object('version',1,'status','recorded','batchKey',b.batch_key,
    'batchDigest',b.batch_digest,'observations',b.observation_count,'payload',b.canonical_payload);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_adaptive_journal_batch(text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_adaptive_journal_batch(text) TO service_role;
COMMENT ON FUNCTION public.fn_horse_adaptive_journal_batch(text) IS
  'Service-only exact public batch recovery. A receipt is historical recording evidence, not current observation-window completeness, acquisition progress or activation authority.';
COMMIT;
