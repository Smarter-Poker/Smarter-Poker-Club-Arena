-- Horse Brain telemetry only. This is a batch receipt, not a decision ledger.
CREATE TABLE public.horse_brain_flush_receipts (
  batch_id uuid PRIMARY KEY,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  worker_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  source_release text CHECK (source_release IS NULL OR source_release ~ '^[0-9a-f]{40}$'),
  day date NOT NULL,
  collected_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  fires jsonb NOT NULL,
  latency jsonb NOT NULL,
  UNIQUE (worker_id, sequence)
);
CREATE INDEX horse_brain_flush_receipts_source_day
  ON public.horse_brain_flush_receipts (source_release, day, collected_at, batch_id);
CREATE INDEX horse_brain_flush_receipts_expiry ON public.horse_brain_flush_receipts (collected_at, batch_id);
ALTER TABLE public.horse_brain_flush_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_brain_flush_receipts FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_horse_brain_flush_receipt(p_payload text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '2s'
SET statement_timeout = '5s'
AS $function$
DECLARE
  v jsonb; r jsonb; b jsonb;
  v_id uuid; v_worker uuid; v_sequence bigint; v_release text;
  v_day date; v_collected timestamptz; v_digest text; v_existing text;
  v_n numeric; v_total numeric; v_max numeric; v_bucket_sum numeric;
  v_inserted integer;
BEGIN
  IF p_payload IS NULL OR octet_length(p_payload) > 524288 THEN
    RAISE EXCEPTION 'HORSE_FLUSH_INVALID_PAYLOAD';
  END IF;
  v := p_payload::jsonb;
  IF jsonb_typeof(v) IS DISTINCT FROM 'object'
     OR v->'version' IS DISTINCT FROM '1'::jsonb
     OR (SELECT count(*) FROM jsonb_object_keys(v)) <> 9
     OR NOT (v ?& ARRAY['version','batchId','workerId','sequence','sourceRelease','day','collectedAt','fires','latency'])
     OR jsonb_typeof(v->'batchId') IS DISTINCT FROM 'string'
     OR (v->>'batchId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR jsonb_typeof(v->'workerId') IS DISTINCT FROM 'string'
     OR (v->>'workerId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR jsonb_typeof(v->'sequence') IS DISTINCT FROM 'number'
     OR (v->>'sequence')::numeric NOT BETWEEN 1 AND 9007199254740991
     OR trunc((v->>'sequence')::numeric) <> (v->>'sequence')::numeric
     OR (v->'sourceRelease' <> 'null'::jsonb AND
         (jsonb_typeof(v->'sourceRelease') <> 'string' OR (v->>'sourceRelease') !~ '^[0-9a-f]{40}$'))
     OR jsonb_typeof(v->'day') IS DISTINCT FROM 'string'
     OR (v->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR jsonb_typeof(v->'collectedAt') IS DISTINCT FROM 'string'
     OR (v->>'collectedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     OR jsonb_typeof(v->'fires') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v->'latency') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'HORSE_FLUSH_INVALID_HEADER';
  END IF;
  v_id := (v->>'batchId')::uuid; v_worker := (v->>'workerId')::uuid;
  v_sequence := (v->>'sequence')::bigint; v_release := v->>'sourceRelease';
  v_day := (v->>'day')::date; v_collected := (v->>'collectedAt')::timestamptz;
  IF v_collected < transaction_timestamp() - interval '32 days' THEN
    RAISE EXCEPTION 'HORSE_FLUSH_EXPIRED';
  END IF;
  IF v_day <> (v_collected AT TIME ZONE 'UTC')::date
     OR jsonb_array_length(v->'fires') > 4096 OR jsonb_array_length(v->'latency') > 256
     OR jsonb_array_length(v->'fires') + jsonb_array_length(v->'latency') = 0 THEN
    RAISE EXCEPTION 'HORSE_FLUSH_INVALID_BOUNDS';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(v->'fires') LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(r)) <> 2
       OR NOT (r ?& ARRAY['feature','fires'])
       OR jsonb_typeof(r->'feature') IS DISTINCT FROM 'string'
       OR length(r->>'feature') NOT BETWEEN 1 AND 128
       OR jsonb_typeof(r->'fires') IS DISTINCT FROM 'number'
       OR (r->>'fires')::numeric NOT BETWEEN 1 AND 9007199254740991
       OR trunc((r->>'fires')::numeric) <> (r->>'fires')::numeric THEN
      RAISE EXCEPTION 'HORSE_FLUSH_INVALID_COUNTER';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'feature') FROM jsonb_array_elements(v->'fires')) <> jsonb_array_length(v->'fires') THEN
    RAISE EXCEPTION 'HORSE_FLUSH_DUPLICATE_FEATURE';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(v->'latency') LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(r)) <> 5
       OR NOT (r ?& ARRAY['scope','samples','totalMs','maxMs','buckets'])
       OR jsonb_typeof(r->'scope') IS DISTINCT FROM 'string'
       OR length(r->>'scope') NOT BETWEEN 1 AND 128
       OR jsonb_typeof(r->'samples') IS DISTINCT FROM 'number'
       OR jsonb_typeof(r->'totalMs') IS DISTINCT FROM 'number'
       OR jsonb_typeof(r->'maxMs') IS DISTINCT FROM 'number'
       OR jsonb_typeof(r->'buckets') IS DISTINCT FROM 'array'
       OR jsonb_array_length(r->'buckets') <> 10 THEN
      RAISE EXCEPTION 'HORSE_FLUSH_INVALID_LATENCY';
    END IF;
    v_n := (r->>'samples')::numeric; v_total := (r->>'totalMs')::numeric; v_max := (r->>'maxMs')::numeric;
    IF v_n NOT BETWEEN 1 AND 9007199254740991 OR trunc(v_n) <> v_n
       OR v_total NOT BETWEEN 0 AND 9007199254740991 OR v_max NOT BETWEEN 0 AND 9007199254740991
       OR v_total + 0.000001 < v_max OR v_total > v_n * v_max * 1.000000001 + 0.000001 THEN
      RAISE EXCEPTION 'HORSE_FLUSH_INVALID_LATENCY_TOTAL';
    END IF;
    v_bucket_sum := 0;
    FOR b IN SELECT value FROM jsonb_array_elements(r->'buckets') LOOP
      IF jsonb_typeof(b) IS DISTINCT FROM 'number' OR b::numeric NOT BETWEEN 0 AND v_n
         OR trunc(b::numeric) <> b::numeric THEN
        RAISE EXCEPTION 'HORSE_FLUSH_INVALID_BUCKET';
      END IF;
      v_bucket_sum := v_bucket_sum + b::numeric;
    END LOOP;
    IF v_bucket_sum <> v_n THEN RAISE EXCEPTION 'HORSE_FLUSH_BUCKET_COUNT_MISMATCH'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'scope') FROM jsonb_array_elements(v->'latency')) <> jsonb_array_length(v->'latency') THEN
    RAISE EXCEPTION 'HORSE_FLUSH_DUPLICATE_SCOPE';
  END IF;
  v_digest := encode(extensions.digest(convert_to(p_payload, 'UTF8'), 'sha256'), 'hex');
  INSERT INTO public.horse_brain_flush_receipts
    (batch_id,payload_sha256,worker_id,sequence,source_release,day,collected_at,fires,latency)
  VALUES (v_id,v_digest,v_worker,v_sequence,v_release,v_day,v_collected,v->'fires',v->'latency')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    SELECT payload_sha256 INTO v_existing FROM public.horse_brain_flush_receipts WHERE batch_id = v_id;
    IF v_existing IS NULL THEN RAISE EXCEPTION 'HORSE_FLUSH_SEQUENCE_COLLISION'; END IF;
    IF v_existing IS DISTINCT FROM v_digest THEN RAISE EXCEPTION 'HORSE_FLUSH_BATCH_COLLISION'; END IF;
    RETURN jsonb_build_object('version',1,'status','replayed','batchId',v_id,'payloadSha256',v_digest);
  END IF;
  INSERT INTO public.horse_brain_telemetry AS h (day,feature,fires)
    SELECT v_day, value->>'feature', (value->>'fires')::bigint
    FROM jsonb_array_elements(v->'fires') ORDER BY value->>'feature'
    ON CONFLICT (day,feature) DO UPDATE SET fires = h.fires + EXCLUDED.fires, updated_at = transaction_timestamp();
  INSERT INTO public.horse_decision_latency AS h (day,scope,samples,total_ms,max_ms,buckets,updated_at)
    SELECT v_day, value->>'scope', (value->>'samples')::bigint,
      (value->>'totalMs')::double precision, (value->>'maxMs')::double precision,
      ARRAY(SELECT (x#>>'{}')::bigint FROM jsonb_array_elements(value->'buckets') WITH ORDINALITY AS a(x,i) ORDER BY i),
      transaction_timestamp()
    FROM jsonb_array_elements(v->'latency') ORDER BY value->>'scope'
    ON CONFLICT (day,scope) DO UPDATE SET
      samples = h.samples + EXCLUDED.samples, total_ms = h.total_ms + EXCLUDED.total_ms,
      max_ms = greatest(h.max_ms,EXCLUDED.max_ms),
      buckets = ARRAY(SELECT coalesce(h.buckets[i],0) + coalesce(EXCLUDED.buckets[i],0) FROM generate_series(1,greatest(coalesce(array_length(h.buckets,1),0),10)) AS i ORDER BY i),
      updated_at = transaction_timestamp();
  -- Only this new receipt table is retained for 32 days. Expired replays
  -- are refused above, so pruning can never make a retry additive again.
  WITH expired AS (
    SELECT batch_id FROM public.horse_brain_flush_receipts
    WHERE collected_at < transaction_timestamp() - interval '32 days'
    ORDER BY collected_at, batch_id LIMIT 64 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.horse_brain_flush_receipts WHERE batch_id IN (SELECT batch_id FROM expired);
  RETURN jsonb_build_object('version',1,'status','recorded','batchId',v_id,'payloadSha256',v_digest);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_brain_flush_receipt(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_brain_flush_receipt(text) TO service_role;
COMMENT ON TABLE public.horse_brain_flush_receipts IS
  'Private atomic telemetry-batch receipts. Complete only for accepted batches; source release may be unknown. Retained 32 days; expired writes are refused before aggregation. Not a complete action ledger or proof against process-crash loss.';
