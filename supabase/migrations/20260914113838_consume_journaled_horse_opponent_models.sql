-- Reserved 2026-09-14 11:38:38 UTC. Scoped model code had no durable live
-- consumer. This private serial sweep reconstructs journal-only diagnostics;
-- it never certifies source closure or authorizes any strategy adjustment.
-- No hand/chip/outbox writes, trigger, live action-clock caller or scheduler.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE TABLE public.horse_journaled_model_sweep (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cursor_actor text NOT NULL DEFAULT '', cursor_scope text NOT NULL DEFAULT '',
  lease_token uuid, lease_until timestamptz,
  actor_key text, scope_key text, from_ms bigint, to_ms bigint,
  snapshot_id text, evidence_digest text, population_status text,
  completed_token uuid, completed_digest text,
  capacity_refusals bigint NOT NULL DEFAULT 0, last_capacity_actor text, last_capacity_scope text
);
INSERT INTO public.horse_journaled_model_sweep(singleton) VALUES(true);
CREATE TABLE public.horse_journaled_opponent_models (
  actor_key text NOT NULL, scope_key text NOT NULL,
  report_digest text NOT NULL, report_payload text NOT NULL CHECK(octet_length(report_payload)<=65536),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(actor_key,scope_key)
);
CREATE INDEX horse_journaled_models_age ON public.horse_journaled_opponent_models(recorded_at);
ALTER TABLE public.horse_journaled_model_sweep ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.horse_journaled_opponent_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_journaled_model_sweep,public.horse_journaled_opponent_models
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_claim_horse_journaled_model(p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $fn$
DECLARE
  s public.horse_journaled_model_sweep%ROWTYPE;
  a text; k text; v_to bigint:=floor(extract(epoch FROM statement_timestamp())*1000)::bigint;
  v_from bigint; n integer; b bigint; rows jsonb; ev text; snap text; pop text;
BEGIN
  IF p_lease_token IS NULL THEN RAISE EXCEPTION 'MODEL_INVALID_TOKEN'; END IF;
  SELECT * INTO s FROM public.horse_journaled_model_sweep WHERE singleton FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR s.lease_until>statement_timestamp() THEN
    RETURN jsonb_build_object('version',1,'status','idle');
  END IF;
  -- Cursor means sweep position only, never an ingestion watermark. Inserts
  -- behind it are visited on the next wrap. An expired lease retries the same
  -- coordinate because only the finish operation advances this cursor.
  SELECT actor_key,scope_key INTO a,k FROM public.horse_adaptive_observation_journal
    WHERE (actor_key,scope_key)>(s.cursor_actor,s.cursor_scope)
    ORDER BY actor_key,scope_key LIMIT 1;
  IF NOT FOUND THEN
    SELECT actor_key,scope_key INTO a,k FROM public.horse_adaptive_observation_journal
      ORDER BY actor_key,scope_key LIMIT 1;
  END IF;
  IF a IS NULL THEN RETURN jsonb_build_object('version',1,'status','idle'); END IF;
  v_from:=v_to-2592000000;
  -- One MVCC statement snapshot for both cohorts and both partitions. The
  -- index bounds acquisition before aggregation; never return a partial fit.
  WITH candidates AS MATERIALIZED (
    SELECT o.observation_id,o.payload
    FROM (VALUES ('training','player'),('training','pre_action'),('training','horse_policy'),
      ('holdout','player'),('holdout','pre_action'),('holdout','horse_policy')) arm(partition,origin)
    CROSS JOIN LATERAL (
      SELECT j.observation_id,j.payload FROM public.horse_adaptive_observation_journal j
      WHERE j.actor_key=a AND j.scope_key=k AND j.partition=arm.partition AND j.origin=arm.origin
        AND j.observed_at_ms>=v_from AND j.observed_at_ms<v_to LIMIT 20001
    ) o LIMIT 20001
  ), totals AS (SELECT count(*)::integer AS n,coalesce(sum(octet_length(payload)),0)::bigint AS b FROM candidates)
  SELECT t.n,t.b,
    CASE WHEN t.n<=20000 AND t.b<=16777216 THEN
      (SELECT coalesce(jsonb_agg(payload ORDER BY observation_id),'[]'::jsonb) FROM candidates)
      ELSE '[]'::jsonb END,
    CASE WHEN t.n<=20000 AND t.b<=16777216 THEN
      (SELECT encode(sha256(convert_to(coalesce(string_agg(payload,E'\n' ORDER BY observation_id),''),'UTF8')),'hex') FROM candidates)
      ELSE encode(sha256(convert_to(concat_ws('|','bounded-refusal',t.n,t.b),'UTF8')),'hex') END
    ,pg_current_snapshot()::text INTO n,b,rows,ev,snap FROM totals t;
  pop:=CASE WHEN n>20000 THEN 'observation_budget_exceeded'
            WHEN b>16777216 THEN 'byte_budget_exceeded' ELSE 'snapshot' END;
  UPDATE public.horse_journaled_model_sweep SET
    lease_token=p_lease_token,lease_until=statement_timestamp()+interval '60 seconds',
    actor_key=a,scope_key=k,from_ms=v_from,to_ms=v_to,snapshot_id=snap,evidence_digest=ev,population_status=pop
    WHERE singleton;
  RETURN jsonb_build_object('version',1,'status','claimed','leaseToken',p_lease_token,
    'actorKey',a,'scopeKey',k,'fromMs',v_from,'toMs',v_to,'snapshotId',snap,
    'populationStatus',pop,'evidenceDigest',ev,'observations',n,'bytes',b,'rows',rows);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_claim_horse_journaled_model(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_claim_horse_journaled_model(uuid) TO service_role;

CREATE FUNCTION public.fn_finish_horse_journaled_model(p_lease_token uuid,p_report text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $fn$
DECLARE s public.horse_journaled_model_sweep%ROWTYPE; r jsonb; d text; n integer;
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
      UPDATE public.horse_journaled_model_sweep SET cursor_actor=s.actor_key,cursor_scope=s.scope_key,
        lease_token=NULL,lease_until=NULL,capacity_refusals=capacity_refusals+1,
        last_capacity_actor=s.actor_key,last_capacity_scope=s.scope_key WHERE singleton;
      RETURN jsonb_build_object('version',1,'status','capacity_full');
    END IF;
  END IF;
  INSERT INTO public.horse_journaled_opponent_models(actor_key,scope_key,report_digest,report_payload)
    VALUES(s.actor_key,s.scope_key,d,p_report)
    ON CONFLICT(actor_key,scope_key) DO UPDATE SET report_digest=excluded.report_digest,
      report_payload=excluded.report_payload,recorded_at=transaction_timestamp();
  UPDATE public.horse_journaled_model_sweep SET cursor_actor=s.actor_key,cursor_scope=s.scope_key,
    lease_token=NULL,lease_until=NULL,completed_token=p_lease_token,completed_digest=d WHERE singleton;
  RETURN jsonb_build_object('version',1,'status','recorded','reportDigest',d);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_finish_horse_journaled_model(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_finish_horse_journaled_model(uuid,text) TO service_role;
COMMENT ON TABLE public.horse_journaled_opponent_models IS
  'Private latest journal-population diagnostics. No source completeness, calibrated population prior, causal EV, selection-corrected holdout, activation authority or immutable history claim.';
COMMIT;
