-- Reserved 2026-09-14 04:13:05 UTC. Retain the exact source read boundary
-- alongside newly acquired slices. No source-completeness or activation claim.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_claim_horse_observation_capture(uuid)'::regprocedure)
      IS DISTINCT FROM 'aae52235c8f6f6239d3b2e542d537c91'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_finish_horse_observation_capture(text,uuid,text,text)'::regprocedure)
      IS DISTINCT FROM 'c4851c48d6be944246e135c5c7142b7f' THEN
    RAISE EXCEPTION 'HORSE_CAPTURE_WITNESS_PREIMAGE_CHANGED';
  END IF;
END
$guard$;
ALTER TABLE public.horse_observation_capture_receipts
  ADD COLUMN source_witness text,
  ADD COLUMN source_witness_digest text,
  ADD CONSTRAINT horse_capture_source_witness CHECK(
    (source_witness IS NULL AND source_witness_digest IS NULL) OR
    (source_witness IS NOT NULL AND source_witness_digest IS NOT NULL
      AND octet_length(source_witness)<=8192
      AND source_witness_digest=encode(sha256(convert_to(source_witness,'UTF8')),'hex')));

CREATE FUNCTION public.fn_finish_horse_observation_capture_witness(
  p_request_key text,p_lease_token uuid,p_payload text,p_reason text,p_source_witness text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE w jsonb; b jsonb; r public.horse_observation_capture_work%ROWTYPE;
  prior public.horse_observation_capture_receipts%ROWTYPE;
  result jsonb; fingerprint text; source_fingerprint text; i integer;
BEGIN
  IF p_payload IS NULL THEN
    IF p_source_witness IS NOT NULL THEN RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_WITHOUT_BATCH'; END IF;
    RETURN public.fn_finish_horse_observation_capture(p_request_key,p_lease_token,NULL,p_reason);
  END IF;
  IF p_request_key IS NULL OR p_request_key !~ '^[a-f0-9]{64}$' OR p_lease_token IS NULL
    OR octet_length(p_payload)>16777216 OR p_source_witness IS NULL
    OR octet_length(p_source_witness)>8192 THEN RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_INVALID'; END IF;
  w:=p_source_witness::jsonb; b:=p_payload::jsonb;
  IF jsonb_typeof(w) IS DISTINCT FROM 'array' OR jsonb_array_length(w)<>11
    OR w->0 IS DISTINCT FROM '1'::jsonb OR w->>9 IS DISTINCT FROM 'retained_committed_roster_rows'
    OR w->>10 IS DISTINCT FROM 'atomic_hand_receipts'
    OR jsonb_typeof(b) IS DISTINCT FROM 'array' OR jsonb_array_length(b)<>8 OR b->0 IS DISTINCT FROM '1'::jsonb
    OR w->>1 IS DISTINCT FROM b->>2 OR w->>2 IS DISTINCT FROM b->>3 OR w->>3 IS DISTINCT FROM b->>4
    OR w->>8 IS DISTINCT FROM b->>5
    OR coalesce(w->>1,'') !~ '^[a-f0-9]{64}$' OR coalesce(w->>8,'') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(w->5) IS DISTINCT FROM 'string'
    OR coalesce(w->>5,'') !~ '^[0-9]+:[0-9]+:([0-9]+(,[0-9]+)*)?$' THEN
    RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_SCOPE_INVALID';
  END IF;
  FOREACH i IN ARRAY ARRAY[2,3,4,6,7] LOOP
    IF jsonb_typeof(w->i) IS DISTINCT FROM 'number' OR (w->>i) !~ '^(0|[1-9][0-9]*)$'
      OR (w->>i)::numeric>9007199254740991 THEN RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_NUMBER_INVALID'; END IF;
  END LOOP;
  IF (w->>3)::bigint<=(w->>2)::bigint OR (w->>3)::bigint-(w->>2)::bigint>21600000
    OR (w->>4)::bigint<(w->>3)::bigint OR (w->>2)::bigint<(w->>4)::bigint-86400000
    OR (w->>6)::integer>512 OR (w->>7)::bigint>8388608 THEN RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_BUDGET'; END IF;
  -- Check the actual PostgreSQL snapshot vocabulary as well as text bounds.
  PERFORM (w->>5)::pg_snapshot;
  fingerprint:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
  source_fingerprint:=encode(sha256(convert_to(p_source_witness,'UTF8')),'hex');
  SELECT * INTO r FROM public.horse_observation_capture_work WHERE request_key=p_request_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'status','lease_lost','requestKey',p_request_key); END IF;
  SELECT * INTO prior FROM public.horse_observation_capture_receipts
    WHERE request_key=p_request_key AND lease_token=p_lease_token;
  IF FOUND THEN
    IF prior.payload_digest IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'HORSE_CAPTURE_BATCH_CONFLICT'; END IF;
    IF prior.source_witness IS NULL THEN RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_UNAVAILABLE'; END IF;
    IF prior.source_witness_digest IS DISTINCT FROM source_fingerprint
      OR prior.source_witness IS DISTINCT FROM p_source_witness THEN RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_CONFLICT'; END IF;
    RETURN prior.acknowledgment;
  END IF;
  -- Dynamic clock checks apply only to a new write. Exact committed receipts
  -- remain replayable if the wall clock later moves backwards.
  IF (w->>4)::bigint>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_FUTURE';
  END IF;
  result:=public.fn_finish_horse_observation_capture(p_request_key,p_lease_token,p_payload,p_reason);
  IF result->>'status' IN ('admitted','continued','captured') THEN
    -- A historical pre-slice admission is not evidence of this new source read.
    IF r.state<>'leased' OR r.lease_token IS DISTINCT FROM p_lease_token THEN
      RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_UNAVAILABLE';
    END IF;
    result:=result||jsonb_build_object('sourceWitnessDigest',source_fingerprint);
    UPDATE public.horse_observation_capture_receipts
      SET source_witness=p_source_witness,source_witness_digest=source_fingerprint,acknowledgment=result
      WHERE request_key=p_request_key AND lease_token=p_lease_token
        AND payload_digest=fingerprint AND source_witness IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'HORSE_SOURCE_WITNESS_NOT_RECORDED'; END IF;
  END IF;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_finish_horse_observation_capture_witness(text,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_finish_horse_observation_capture_witness(text,uuid,text,text,text) TO service_role;

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
    'sourceWitnessVersion',1,'actorId',r.actor_id,'fromMs',r.from_ms,'throughMs',r.through_ms,'sliceFromMs',first_ms,
    'sliceThroughMs',last_ms,'leaseToken',p_lease_token);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_claim_horse_observation_capture(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_horse_observation_capture(uuid) TO service_role;
COMMIT;
