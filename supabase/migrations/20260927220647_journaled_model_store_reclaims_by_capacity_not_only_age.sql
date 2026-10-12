-- The journaled opponent model store is a bounded latest-report store. Its
-- only way to reclaim a slot was age: rows older than 30 days, 25 per finish.
-- The sweep admits far more distinct (actor,scope) coordinates than 30-day
-- expiry can ever free, so once the store reached its 10000-row cap it could
-- never admit another coordinate. Measured 2026-09-27: 10000/10000 rows, none
-- older than 30 days, capacity_refusals=7683, last admission 2026-09-22
-- 00:28:55 - every finish since returned capacity_full, so the layer wrote
-- nothing for five days while looking like ordinary refusal traffic.
--
-- Capacity is now reclaimed by capacity, not only by age: at the cap the
-- oldest reports yield their slot, which is what "latest-report store, not
-- history" already meant. The cap, the payload bound, the lease fencing and
-- the refusal contract are unchanged; capacity_full now means only that every
-- eviction candidate was concurrently locked, which is transient by
-- construction. capacity_evictions makes a cycling store distinguishable from
-- a wedged one, the signal whose absence hid this for five days.

ALTER TABLE public.horse_journaled_model_sweep
  ADD COLUMN IF NOT EXISTS capacity_evictions bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.fn_finish_horse_journaled_model(p_lease_token uuid, p_report text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET lock_timeout TO '2s'
AS $function$
DECLARE s public.horse_journaled_model_sweep%ROWTYPE; r jsonb; d text; n integer; evicted integer;
BEGIN
  IF p_lease_token IS NULL OR p_report IS NULL OR octet_length(p_report)>65536 THEN
    RAISE EXCEPTION 'MODEL_INVALID_REPORT'; END IF;
  r:=p_report::jsonb; d:=encode(sha256(convert_to(p_report,'UTF8')),'hex');
  SELECT * INTO s FROM public.horse_journaled_model_sweep WHERE singleton FOR UPDATE;
  IF s.completed_token=p_lease_token AND s.completed_digest=d THEN
    RETURN jsonb_build_object('version',1,'status','recorded','reportDigest',d); END IF;
  IF s.lease_token IS DISTINCT FROM p_lease_token OR s.lease_until<=statement_timestamp() THEN
    RETURN jsonb_build_object('version',1,'status','lease_lost'); END IF;
  IF jsonb_typeof(r) IS DISTINCT FROM 'object'
     OR r->>'version' IS DISTINCT FROM 'horse-journaled-model-report-v1'
     OR r->>'population' IS DISTINCT FROM 'journaled_qualified_observations'
     OR r->>'sourceCoverage' IS DISTINCT FROM 'not_established'
     OR r->'activationAuthorized' IS DISTINCT FROM 'false'::jsonb
     OR r->'causalEvEstablished' IS DISTINCT FROM 'false'::jsonb
     OR r->>'actorKey' IS DISTINCT FROM s.actor_key OR r->>'scopeKey' IS DISTINCT FROM s.scope_key
     OR r->'fromMs' IS DISTINCT FROM to_jsonb(s.from_ms) OR r->'toMs' IS DISTINCT FROM to_jsonb(s.to_ms)
     OR r->>'snapshotId' IS DISTINCT FROM s.snapshot_id OR r->>'evidenceDigest' IS DISTINCT FROM s.evidence_digest
     OR coalesce(r->>'sourceRelease','') !~ '^[a-f0-9]{40}$'
     OR r->>'priorPurpose' IS DISTINCT FROM 'unconditional_action_frequency_diagnostic'
     OR r->>'holdoutUse' IS DISTINCT FROM 'repeated_diagnostic_no_selection_correction'
     OR (r-ARRAY['version','sourceRelease','population','sourceCoverage','activationAuthorized','causalEvEstablished',
       'actorKey','scopeKey','fromMs','toMs','snapshotId','evidenceDigest','prior','priorPurpose','holdoutUse',
       'status','reason','observations','cohorts'])<>'{}'::jsonb THEN RAISE EXCEPTION 'MODEL_INVALID_REPORT'; END IF;
  IF s.population_status='snapshot' THEN
    IF r->>'status' IS DISTINCT FROM 'computed' OR jsonb_typeof(r->'cohorts') IS DISTINCT FROM 'array'
      THEN RAISE EXCEPTION 'MODEL_INVALID_REPORT'; END IF;
    IF jsonb_array_length(r->'cohorts')<>2 THEN RAISE EXCEPTION 'MODEL_INVALID_REPORT'; END IF;
  ELSE
    IF r->>'status' IS DISTINCT FROM 'refused' OR r->>'reason' IS DISTINCT FROM s.population_status
      OR r ? 'cohorts' THEN RAISE EXCEPTION 'MODEL_INVALID_REPORT'; END IF;
  END IF;
  -- Own diagnostic store only. Keep storage bounded without touching source
  -- retention, financial data or external owners. Expired records are not
  -- advertised as current models. This is a latest-report store, not history.
  DELETE FROM public.horse_journaled_opponent_models WHERE (actor_key,scope_key) IN (
    SELECT actor_key,scope_key FROM public.horse_journaled_opponent_models
    WHERE recorded_at<statement_timestamp()-interval '30 days' ORDER BY recorded_at LIMIT 25);
  IF NOT EXISTS(SELECT 1 FROM public.horse_journaled_opponent_models WHERE actor_key=s.actor_key AND scope_key=s.scope_key) THEN
    SELECT count(*) INTO n FROM (SELECT 1 FROM public.horse_journaled_opponent_models LIMIT 10000) q;
    IF n>=10000 THEN
      -- At the cap the oldest reports yield their slot, so a full store keeps
      -- turning over instead of refusing every new coordinate for good. The
      -- batch is bounded and amortises one eviction per admission; the row
      -- being admitted is absent by the enclosing test, so it is never a
      -- victim. Skipping locked candidates keeps concurrent finishes off each
      -- other's rows.
      WITH victim AS (
        SELECT m.actor_key,m.scope_key FROM public.horse_journaled_opponent_models m
        ORDER BY m.recorded_at,m.actor_key,m.scope_key LIMIT 25 FOR UPDATE SKIP LOCKED)
      DELETE FROM public.horse_journaled_opponent_models t USING victim v
        WHERE t.actor_key=v.actor_key AND t.scope_key=v.scope_key;
      GET DIAGNOSTICS evicted=ROW_COUNT;
      IF evicted=0 THEN
        UPDATE public.horse_journaled_model_sweep SET cursor_actor=s.actor_key,cursor_scope=s.scope_key,
          lease_token=NULL,lease_until=NULL,capacity_refusals=capacity_refusals+1,
          last_capacity_actor=s.actor_key,last_capacity_scope=s.scope_key WHERE singleton;
        RETURN jsonb_build_object('version',1,'status','capacity_full');
      END IF;
      UPDATE public.horse_journaled_model_sweep
        SET capacity_evictions=capacity_evictions+evicted WHERE singleton;
    END IF;
  END IF;
  INSERT INTO public.horse_journaled_opponent_models(actor_key,scope_key,report_digest,report_payload)
    VALUES(s.actor_key,s.scope_key,d,p_report)
    ON CONFLICT(actor_key,scope_key) DO UPDATE SET report_digest=excluded.report_digest,
      report_payload=excluded.report_payload,recorded_at=transaction_timestamp();
  UPDATE public.horse_journaled_model_sweep SET cursor_actor=s.actor_key,cursor_scope=s.scope_key,
    lease_token=NULL,lease_until=NULL,completed_token=p_lease_token,completed_digest=d WHERE singleton;
  RETURN jsonb_build_object('version',1,'status','recorded','reportDigest',d);
END $function$;