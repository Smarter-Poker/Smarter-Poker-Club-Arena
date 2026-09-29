-- Reserved 2026-09-14 04:36:33 UTC. Private, bounded metadata recovery only.
-- The engine cannot directly read private acquisition receipts after restart.
-- Recover original witnesses in 64-row pages with 65-row lookahead and a 1MiB
-- ceiling. Bind pagination to request progress; compare independent journal
-- receipts without reading source history or asserting complete coverage.
-- Native PostgreSQL17: 63 groups, two actual worker witnesses after source
-- removal, 65 real admissions, cursor/revision/gap/conflict/role refusals.
-- No new table/index, financial writer or activation; existing receipt bytes
-- remain unchanged. New entry is STABLE and service-only.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_finish_horse_observation_capture_witness(text,uuid,text,text,text)'::regprocedure)
      IS DISTINCT FROM '13815d18084023c986afb2a9e383444b' THEN
    RAISE EXCEPTION 'HORSE_CAPTURE_EVIDENCE_PREIMAGE_CHANGED';
  END IF;
END
$guard$;
CREATE FUNCTION public.fn_horse_observation_capture_evidence(
  p_actor uuid,p_from_ms bigint,p_through_ms bigint,p_after_from_ms bigint DEFAULT NULL,p_revision text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
AS $function$
DECLARE r public.horse_observation_capture_work%ROWTYPE; prior public.horse_observation_capture_receipts%ROWTYPE;
  key text; v_actor_key text; revision text; rows_json jsonb; result jsonb;
  page_from bigint; after_segment integer:=0; after_observations bigint:=0; more boolean;
BEGIN
  IF p_actor IS NULL OR p_from_ms IS NULL OR p_through_ms IS NULL OR p_from_ms<0
    OR p_through_ms<=p_from_ms OR p_through_ms>9007199254740991 OR p_through_ms-p_from_ms>21600000
    OR (p_after_from_ms IS NULL)<>(p_revision IS NULL)
    OR (p_revision IS NOT NULL AND (p_revision !~ '^[a-f0-9]{64}$' OR p_after_from_ms<p_from_ms OR p_after_from_ms>=p_through_ms)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  key:=encode(sha256(convert_to(concat_ws('|','horse-source-request-v1',p_actor::text,p_from_ms::text,p_through_ms::text),'UTF8')),'hex');
  v_actor_key:=encode(sha256(convert_to(format('["adaptive-actor-v1","%s"]',p_actor),'UTF8')),'hex');
  SELECT * INTO r FROM public.horse_observation_capture_work WHERE request_key=key;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','request_not_found'); END IF;
  IF r.state='admitted' AND r.segments=0 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','legacy_request_without_slices');
  END IF;
  revision:=encode(sha256(convert_to(jsonb_build_array(key,r.state,coalesce(r.cursor_ms,r.from_ms),
    r.segments,r.captured_observations,coalesce(round(extract(epoch FROM r.admitted_at)*1000000)::bigint,-1))::text,'UTF8')),'hex');
  IF p_revision IS NOT NULL AND p_revision<>revision THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','request_changed');
  END IF;
  page_from:=r.from_ms;
  IF p_after_from_ms IS NOT NULL THEN
    SELECT * INTO prior FROM public.horse_observation_capture_receipts WHERE request_key=key AND from_ms=p_after_from_ms;
    IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','cursor_lost'); END IF;
    page_from:=prior.through_ms; after_segment:=(prior.acknowledgment->>'segments')::integer; after_observations:=(prior.acknowledgment->>'capturedObservations')::bigint;
  END IF;
  WITH bounded AS MATERIALIZED (
    SELECT s.from_ms,s.through_ms,s.source_witness,s.source_witness_digest,
      s.acknowledgment->>'batchKey' batch_key,s.payload_digest,
      (s.acknowledgment->>'observations')::integer observations,
      (s.acknowledgment->>'segments')::integer segment,
      (s.acknowledgment->>'capturedObservations')::bigint captured_observations
    FROM public.horse_observation_capture_receipts s WHERE s.request_key=key
      AND (p_after_from_ms IS NULL OR s.from_ms>p_after_from_ms)
    ORDER BY s.from_ms LIMIT 65
  ), page AS MATERIALIZED (SELECT * FROM bounded ORDER BY from_ms LIMIT 64),
  evidence AS (
    SELECT s.*, CASE WHEN b.batch_key IS NULL THEN 'missing'
      WHEN b.batch_digest IS DISTINCT FROM s.payload_digest OR b.observation_count IS DISTINCT FROM s.observations
        OR b.actor_key IS DISTINCT FROM v_actor_key OR b.from_ms IS DISTINCT FROM s.from_ms
        OR b.through_ms IS DISTINCT FROM s.through_ms
        OR (s.source_witness IS NOT NULL AND b.source_digest IS DISTINCT FROM (s.source_witness::jsonb->>8)) THEN 'conflict'
      WHEN b.canonical_payload IS NULL THEN 'payload_missing' ELSE 'matched' END journal_receipt,
      CASE WHEN q.batch_key IS NULL THEN 'missing'
        WHEN q.batch_digest IS DISTINCT FROM s.payload_digest OR q.observations IS DISTINCT FROM s.observations THEN 'conflict'
        ELSE q.state END queue_state
    FROM page s LEFT JOIN public.horse_adaptive_observation_batches b ON b.batch_key=s.batch_key
      LEFT JOIN public.horse_adaptive_journal_work q ON q.batch_key=s.batch_key
  ) SELECT (SELECT count(*)>64 FROM bounded),
    coalesce(jsonb_agg(jsonb_build_object('fromMs',e.from_ms,'throughMs',e.through_ms,'segment',e.segment,
      'capturedObservations',e.captured_observations,'batchKey',e.batch_key,'batchDigest',e.payload_digest,'observations',e.observations,
      'sourceWitness',e.source_witness,'sourceWitnessDigest',e.source_witness_digest,
      'journalReceipt',e.journal_receipt,'queueState',e.queue_state) ORDER BY e.from_ms),'[]'::jsonb)
    INTO more,rows_json FROM evidence e;
  result:=jsonb_build_object('version',1,'status','snapshot','requestKey',key,'actorKey',v_actor_key,
    'fromMs',r.from_ms,'throughMs',r.through_ms,'requestState',r.state,
    'capturedThroughMs',coalesce(r.cursor_ms,r.from_ms),'segments',r.segments,'observations',r.captured_observations,
    'revision',revision,'pageFromMs',page_from,'afterSegment',after_segment,'afterObservations',after_observations,'hasMore',more,
    'readAtMs',floor(extract(epoch FROM statement_timestamp())*1000)::bigint,
    'sourceCoverage','not_established','rows',rows_json);
  IF octet_length(result::text)>1048576 THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','evidence_budget_exceeded'); END IF;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_observation_capture_evidence(uuid,bigint,bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_observation_capture_evidence(uuid,bigint,bigint,bigint,text) TO service_role;
COMMIT;
