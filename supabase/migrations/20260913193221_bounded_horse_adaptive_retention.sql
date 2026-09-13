-- Reserved 2026-09-13 19:32:21 UTC. Journal storage previously had no retention.
-- Delete only bounded expired rows in these three isolated learner tables;
-- protect every referenced batch until completed work metadata expires first.
-- New-work admission and pruning share a non-waiting reservation. Existing
-- durable work remains replayable. No scheduler, source watermark or activation.
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_queue_horse_adaptive_batch(text)'::regprocedure)
       IS DISTINCT FROM '0ec8ee994678c192c123c51ba91499ac' THEN
    RAISE EXCEPTION 'ADAPTIVE_WORK_QUEUE_BODY_CHANGED';
  END IF;
END
$guard$;
CREATE INDEX horse_adaptive_journal_retention ON public.horse_adaptive_observation_journal(recorded_at,observation_id);
CREATE INDEX horse_adaptive_batches_retention ON public.horse_adaptive_observation_batches(recorded_at,batch_key);
CREATE INDEX horse_adaptive_work_completed_retention ON public.horse_adaptive_journal_work(completed_at,batch_key) WHERE state='completed';

CREATE OR REPLACE FUNCTION public.fn_queue_horse_adaptive_batch(p_payload text)
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
  -- Only new work needs a live source window. Existing durable work above can
  -- always replay. Retention shares this capacity lock, so it cannot remove a
  -- receipt between admitting new work and persisting its payload.
  IF (b->>3)::bigint < floor(extract(epoch FROM clock_timestamp())*1000)::bigint-2592000000
     OR (b->>4)::bigint > floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','source_expired');
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

CREATE FUNCTION public.fn_prune_horse_adaptive_journal()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE
  retention_at timestamptz; observed_cutoff bigint; source_cutoff bigint;
  work_count integer; batch_count integer; observation_count integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','capacity_busy');
  END IF;
  retention_at:=clock_timestamp()-interval '32 days';
  observed_cutoff:=floor(extract(epoch FROM (retention_at+interval '2 days'))*1000)::bigint;
  source_cutoff:=floor(extract(epoch FROM retention_at)*1000)::bigint;
  -- Unfinished and quarantined work never expires here. Completed metadata
  -- remains available for acknowledgement replay for at least32 days.
  WITH candidate AS (
    SELECT w.batch_key FROM public.horse_adaptive_journal_work w
    WHERE w.state='completed' AND w.completed_at<retention_at
    ORDER BY w.completed_at,w.batch_key LIMIT 100 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.horse_adaptive_journal_work w USING candidate c WHERE w.batch_key=c.batch_key;
  GET DIAGNOSTICS work_count=ROW_COUNT;
  -- Completed jobs have cleared their buffer and depend on the batch payload.
  -- Protect them too; a count-limited metadata pass may leave some behind.
  WITH candidate AS (
    SELECT b.batch_key FROM public.horse_adaptive_observation_batches b
    WHERE b.recorded_at<retention_at AND b.through_ms<source_cutoff
      AND NOT EXISTS(SELECT 1 FROM public.horse_adaptive_journal_work w WHERE w.batch_key=b.batch_key)
    ORDER BY b.recorded_at,b.batch_key LIMIT 100 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.horse_adaptive_observation_batches b USING candidate c WHERE b.batch_key=c.batch_key;
  GET DIAGNOSTICS batch_count=ROW_COUNT;
  -- Transaction timestamps can predate later observations. Both clocks must
  -- be expired so a still-readable30-day observation is never removed.
  WITH candidate AS (
    SELECT j.observation_id FROM public.horse_adaptive_observation_journal j
    WHERE j.recorded_at<retention_at AND j.observed_at_ms<observed_cutoff
    ORDER BY j.recorded_at,j.observation_id LIMIT 1000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.horse_adaptive_observation_journal j USING candidate c WHERE j.observation_id=c.observation_id;
  GET DIAGNOSTICS observation_count=ROW_COUNT;
  RETURN jsonb_build_object('version',1,'status','pruned','completedWork',work_count,
    'batches',batch_count,'observations',observation_count);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_queue_horse_adaptive_batch(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_queue_horse_adaptive_batch(text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_prune_horse_adaptive_journal() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_prune_horse_adaptive_journal() TO service_role;
COMMENT ON FUNCTION public.fn_prune_horse_adaptive_journal() IS
  'One bounded isolated-journal retention pass:100completed jobs,100unreferenced batches,1000expired facts. Minimum32-day retention and independent30-day observation guard. No claim of a fully drained backlog or source completeness.';
COMMIT;
