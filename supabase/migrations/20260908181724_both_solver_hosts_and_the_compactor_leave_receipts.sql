-- ==========================================================================
-- BOTH SOLVER HOSTS AND THE COMPACTOR LEAVE RECEIPTS
--
-- A solver process that looks the same when it is idle, dead or producing
-- invalid output is not observable. Heartbeats are append-only, sequence
-- guarded and independently attributed to M1 or M2. A separate compact-build
-- pulse records source lag so fresh solves cannot silently remain unavailable
-- to the horse runtime.
-- ==========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.solver_worker_heartbeats (
  machine_id                    text NOT NULL CHECK (machine_id IN ('M1','M2')),
  run_id                        uuid NOT NULL,
  sequence                      bigint NOT NULL CHECK (sequence >= 0),
  received_at                  timestamptz NOT NULL DEFAULT now(),
  run_started_at               timestamptz NOT NULL,
  phase_id                      text NOT NULL CHECK (phase_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  worker_state                  text NOT NULL CHECK (worker_state IN
    ('starting','self_test','solving','harvesting','compacting','paused','completed','failed')),
  rows_planned                  bigint NOT NULL CHECK (rows_planned >= 0),
  rows_done                     bigint NOT NULL CHECK (rows_done >= 0),
  rows_written                  bigint NOT NULL CHECK (rows_written >= 0),
  rows_per_hour                 numeric NOT NULL CHECK (rows_per_hour >= 0),
  eta_at                        timestamptz,
  invalid_rows                  bigint NOT NULL CHECK (invalid_rows >= 0),
  solver_version                text NOT NULL,
  solver_binary_checksum        text NOT NULL CHECK (solver_binary_checksum ~ '^[0-9a-f]{64}$' AND solver_binary_checksum <> repeat('0',64)),
  pipeline_commit               text NOT NULL CHECK (pipeline_commit ~ '^[0-9a-f]{40}$'),
  pipeline_bundle_checksum      text NOT NULL CHECK (pipeline_bundle_checksum ~ '^[0-9a-f]{64}$' AND pipeline_bundle_checksum <> repeat('0',64)),
  manifest_version              text NOT NULL,
  manifest_checksum             text NOT NULL CHECK (manifest_checksum ~ '^[0-9a-f]{64}$' AND manifest_checksum <> repeat('0',64)),
  range_bundle_checksum         text NOT NULL CHECK (range_bundle_checksum ~ '^[0-9a-f]{64}$' AND range_bundle_checksum <> repeat('0',64)),
  source_combo_order_checksum   text NOT NULL CHECK (source_combo_order_checksum ~ '^[0-9a-f]{64}$' AND source_combo_order_checksum <> repeat('0',64)),
  last_artifact_id              uuid,
  last_artifact_checksum        text CHECK (last_artifact_checksum IS NULL OR last_artifact_checksum ~ '^[0-9a-f]{64}$'),
  last_artifact_at              timestamptz,
  error_detail                  text,
  payload_checksum              text NOT NULL CHECK (payload_checksum ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (machine_id, run_id, sequence),
  CHECK (rows_done <= rows_planned),
  CHECK (rows_written <= rows_done),
  CHECK (invalid_rows <= rows_done),
  CHECK ((rows_written = 0 AND last_artifact_id IS NULL AND last_artifact_checksum IS NULL) OR
         (rows_written > 0 AND last_artifact_id IS NOT NULL AND
          last_artifact_checksum ~ '^[0-9a-f]{64}$' AND last_artifact_checksum <> repeat('0',64))),
  CHECK ((worker_state = 'failed' AND nullif(btrim(error_detail),'') IS NOT NULL) OR
         (worker_state <> 'failed'))
);

CREATE INDEX IF NOT EXISTS solver_worker_heartbeats_recent
  ON public.solver_worker_heartbeats (machine_id, received_at DESC);

CREATE TABLE IF NOT EXISTS public.solver_worker_liveness (
  machine_id                    text PRIMARY KEY CHECK (machine_id IN ('M1','M2')),
  run_id                        uuid NOT NULL,
  sequence                      bigint NOT NULL CHECK (sequence >= 0),
  received_at                  timestamptz NOT NULL,
  run_started_at               timestamptz NOT NULL,
  phase_id                      text NOT NULL,
  worker_state                  text NOT NULL,
  rows_planned                  bigint NOT NULL,
  rows_done                     bigint NOT NULL,
  rows_written                  bigint NOT NULL,
  rows_per_hour                 numeric NOT NULL,
  eta_at                        timestamptz,
  invalid_rows                  bigint NOT NULL,
  solver_version                text NOT NULL,
  solver_binary_checksum        text NOT NULL,
  pipeline_commit               text NOT NULL,
  pipeline_bundle_checksum      text NOT NULL,
  manifest_version              text NOT NULL,
  manifest_checksum             text NOT NULL,
  range_bundle_checksum         text NOT NULL,
  source_combo_order_checksum   text NOT NULL,
  last_artifact_id              uuid,
  last_artifact_checksum        text,
  last_artifact_at              timestamptz,
  error_detail                  text,
  payload_checksum              text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.solver_compact_heartbeats (
  run_id                        uuid NOT NULL,
  sequence                      bigint NOT NULL CHECK (sequence >= 0),
  received_at                  timestamptz NOT NULL DEFAULT now(),
  run_started_at               timestamptz NOT NULL,
  compact_state                text NOT NULL CHECK (compact_state IN
    ('starting','scanning','building','validating','candidate','active','paused','completed','failed')),
  dataset_key                  text NOT NULL CHECK (dataset_key ~ '^[a-z0-9][a-z0-9._:-]{2,127}$'),
  source_rows                  bigint NOT NULL CHECK (source_rows >= 0),
  receipt_rows                 bigint NOT NULL CHECK (receipt_rows >= 0),
  cells                        bigint NOT NULL CHECK (cells >= 0),
  invalid_rows                 bigint NOT NULL CHECK (invalid_rows >= 0),
  source_max_at                timestamptz,
  compacted_through            timestamptz,
  compact_lag_seconds          bigint CHECK (compact_lag_seconds IS NULL OR compact_lag_seconds >= 0),
  pipeline_commit              text NOT NULL CHECK (pipeline_commit ~ '^[0-9a-f]{40}$'),
  pipeline_bundle_checksum      text NOT NULL CHECK (pipeline_bundle_checksum ~ '^[0-9a-f]{64}$' AND pipeline_bundle_checksum <> repeat('0',64)),
  manifest_version              text NOT NULL,
  manifest_checksum             text NOT NULL CHECK (manifest_checksum ~ '^[0-9a-f]{64}$' AND manifest_checksum <> repeat('0',64)),
  range_bundle_checksum         text NOT NULL CHECK (range_bundle_checksum ~ '^[0-9a-f]{64}$' AND range_bundle_checksum <> repeat('0',64)),
  dataset_checksum              text CHECK (dataset_checksum IS NULL OR dataset_checksum ~ '^[0-9a-f]{64}$'),
  error_detail                  text,
  payload_checksum              text NOT NULL CHECK (payload_checksum ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (run_id, sequence),
  CHECK ((compact_state IN ('candidate','active','completed') AND
          dataset_checksum ~ '^[0-9a-f]{64}$' AND dataset_checksum <> repeat('0',64)) OR
         compact_state NOT IN ('candidate','active','completed')),
  CHECK ((compact_state = 'failed' AND nullif(btrim(error_detail),'') IS NOT NULL) OR
         compact_state <> 'failed')
);

CREATE INDEX IF NOT EXISTS solver_compact_heartbeats_recent
  ON public.solver_compact_heartbeats (received_at DESC);

CREATE TABLE IF NOT EXISTS public.solver_compact_liveness (
  singleton                     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  run_id                        uuid NOT NULL,
  sequence                      bigint NOT NULL,
  received_at                  timestamptz NOT NULL,
  run_started_at               timestamptz NOT NULL,
  compact_state                text NOT NULL,
  dataset_key                  text NOT NULL,
  source_rows                  bigint NOT NULL,
  receipt_rows                 bigint NOT NULL,
  cells                        bigint NOT NULL,
  invalid_rows                 bigint NOT NULL,
  source_max_at                timestamptz,
  compacted_through            timestamptz,
  compact_lag_seconds          bigint,
  pipeline_commit              text NOT NULL,
  pipeline_bundle_checksum      text NOT NULL,
  manifest_version              text NOT NULL,
  manifest_checksum             text NOT NULL,
  range_bundle_checksum         text NOT NULL,
  dataset_checksum              text,
  error_detail                  text,
  payload_checksum              text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.solver_ingress_nonces (
  principal                     text NOT NULL CHECK (principal IN ('M1','M2','COMPACTOR')),
  nonce                         uuid NOT NULL,
  operation                     text NOT NULL CHECK (operation IN (
    'dataset_contract','worker_heartbeat','ingest_artifact','register_dataset',
    'build_cell','seal_dataset','compact_heartbeat','certification_status'
  )),
  signed_at                     timestamptz NOT NULL,
  body_sha256                   text NOT NULL CHECK (
    body_sha256 ~ '^[0-9a-f]{64}$' AND body_sha256 <> repeat('0',64)
  ),
  received_at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal, nonce)
);

CREATE INDEX IF NOT EXISTS solver_ingress_nonces_received
  ON public.solver_ingress_nonces (received_at);

ALTER TABLE public.solver_worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solver_worker_liveness ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solver_compact_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solver_compact_liveness ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solver_ingress_nonces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solver_worker_heartbeats FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.solver_worker_liveness FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.solver_compact_heartbeats FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.solver_compact_liveness FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.solver_ingress_nonces FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_solver_ingress_claim(
  p_principal text,
  p_nonce uuid,
  p_operation text,
  p_signed_at timestamptz,
  p_body_sha256 text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_inserted integer;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_principal NOT IN ('M1','M2','COMPACTOR')
     OR p_operation NOT IN ('dataset_contract','worker_heartbeat','ingest_artifact',
       'register_dataset','build_cell','seal_dataset','compact_heartbeat',
       'certification_status')
     OR p_signed_at IS NULL OR abs(extract(epoch FROM (clock_timestamp()-p_signed_at)))>300
     OR COALESCE(p_body_sha256,'') !~ '^[0-9a-f]{64}$'
     OR p_body_sha256=repeat('0',64) THEN
    RAISE EXCEPTION 'solver ingress identity is invalid or stale';
  END IF;

  DELETE FROM public.solver_ingress_nonces WHERE received_at<now()-interval '2 days';
  INSERT INTO public.solver_ingress_nonces(principal,nonce,operation,signed_at,body_sha256)
  VALUES(p_principal,p_nonce,p_operation,p_signed_at,p_body_sha256)
  ON CONFLICT (principal,nonce) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted<>1 THEN RAISE EXCEPTION 'solver ingress nonce was replayed'; END IF;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_solver_worker_heartbeat(p_heartbeat jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_machine text := p_heartbeat->>'machine_id';
  v_run uuid;
  v_sequence bigint;
  v_current public.solver_worker_liveness%ROWTYPE;
  v_payload_checksum text;
  v_rows_planned bigint;
  v_rows_done bigint;
  v_rows_written bigint;
  v_invalid bigint;
  v_rate numeric := 0;
  v_eta timestamptz;
  v_started timestamptz;
  v_last_artifact_at timestamptz;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_heartbeat IS NULL OR jsonb_typeof(p_heartbeat) <> 'object'
     OR p_heartbeat->>'contract' IS DISTINCT FROM 'smarter-poker.solver-worker-heartbeat.v1'
     OR COALESCE(v_machine,'') NOT IN ('M1','M2')
     OR COALESCE(p_heartbeat->>'run_id','') !~ '^[0-9a-fA-F-]{36}$'
     OR COALESCE((p_heartbeat->>'sequence')::bigint,-1) < 0
     OR COALESCE(p_heartbeat->>'phase_id','') !~ '^[A-Za-z0-9_.:-]{1,160}$'
     OR COALESCE(p_heartbeat->>'state','') NOT IN
       ('starting','self_test','solving','harvesting','compacting','paused','completed','failed')
     OR COALESCE(p_heartbeat->>'solver_version','') = ''
     OR COALESCE(p_heartbeat->>'solver_binary_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'solver_binary_checksum' = repeat('0',64)
     OR COALESCE(p_heartbeat->>'pipeline_commit','') !~ '^[0-9a-f]{40}$'
     OR COALESCE(p_heartbeat->>'pipeline_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'pipeline_bundle_checksum' = repeat('0',64)
     OR COALESCE(p_heartbeat->>'manifest_version','') = ''
     OR COALESCE(p_heartbeat->>'manifest_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'manifest_checksum' = repeat('0',64)
     OR COALESCE(p_heartbeat->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'range_bundle_checksum' = repeat('0',64)
     OR COALESCE(p_heartbeat->>'source_combo_order_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'source_combo_order_checksum' = repeat('0',64) THEN
    RAISE EXCEPTION 'invalid solver worker heartbeat';
  END IF;

  v_run := (p_heartbeat->>'run_id')::uuid;
  v_sequence := (p_heartbeat->>'sequence')::bigint;
  v_rows_planned := COALESCE((p_heartbeat->>'rows_planned')::bigint,-1);
  v_rows_done := COALESCE((p_heartbeat->>'rows_done')::bigint,-1);
  v_rows_written := COALESCE((p_heartbeat->>'rows_written')::bigint,-1);
  v_invalid := COALESCE((p_heartbeat->>'invalid_rows')::bigint,-1);
  IF v_rows_planned < 0 OR v_rows_done < 0 OR v_rows_written < 0 OR v_invalid < 0
     OR v_rows_done > v_rows_planned OR v_rows_written > v_rows_done OR v_invalid > v_rows_done
     OR (v_rows_written = 0 AND (p_heartbeat->>'last_artifact_id' IS NOT NULL OR
         p_heartbeat->>'last_artifact_checksum' IS NOT NULL))
     OR (v_rows_written > 0 AND (COALESCE(p_heartbeat->>'last_artifact_id','') !~ '^[0-9a-fA-F-]{36}$' OR
         COALESCE(p_heartbeat->>'last_artifact_checksum','') !~ '^[0-9a-f]{64}$' OR
         p_heartbeat->>'last_artifact_checksum' = repeat('0',64)))
     OR (p_heartbeat->>'state' = 'failed' AND nullif(btrim(p_heartbeat->>'error_detail'),'') IS NULL) THEN
    RAISE EXCEPTION 'solver worker heartbeat counters or terminal state are invalid';
  END IF;

  v_payload_checksum := public.fn_gto_v31_json_checksum(p_heartbeat);
  IF EXISTS (
    SELECT 1 FROM public.solver_worker_heartbeats
     WHERE machine_id=v_machine AND run_id=v_run AND sequence=v_sequence
       AND payload_checksum=v_payload_checksum
  ) THEN
    RETURN jsonb_build_object('accepted',true,'idempotent',true,'machine_id',v_machine,
      'run_id',v_run,'sequence',v_sequence);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.solver_worker_heartbeats
     WHERE machine_id=v_machine AND run_id=v_run AND sequence=v_sequence
  ) THEN RAISE EXCEPTION 'solver heartbeat idempotency key was reused with another payload'; END IF;

  SELECT * INTO v_current FROM public.solver_worker_liveness
   WHERE machine_id=v_machine FOR UPDATE;
  IF FOUND AND v_current.run_id=v_run THEN
    IF v_sequence <= v_current.sequence THEN RAISE EXCEPTION 'solver heartbeat sequence did not advance'; END IF;
    IF v_rows_planned <> v_current.rows_planned OR v_rows_done < v_current.rows_done
       OR v_rows_written < v_current.rows_written OR v_invalid < v_current.invalid_rows THEN
      RAISE EXCEPTION 'solver heartbeat counters regressed within a run';
    END IF;
    IF p_heartbeat->>'pipeline_commit' <> v_current.pipeline_commit
       OR p_heartbeat->>'pipeline_bundle_checksum' <> v_current.pipeline_bundle_checksum
       OR p_heartbeat->>'manifest_version' <> v_current.manifest_version
       OR p_heartbeat->>'manifest_checksum' <> v_current.manifest_checksum
       OR p_heartbeat->>'solver_binary_checksum' <> v_current.solver_binary_checksum
       OR p_heartbeat->>'range_bundle_checksum' <> v_current.range_bundle_checksum
       OR p_heartbeat->>'source_combo_order_checksum' <> v_current.source_combo_order_checksum THEN
      RAISE EXCEPTION 'solver provenance changed inside a run';
    END IF;
    v_started := v_current.run_started_at;
    IF extract(epoch FROM (v_now-v_current.received_at)) > 0 THEN
      v_rate := greatest(0,(v_rows_done-v_current.rows_done) * 3600.0 /
        extract(epoch FROM (v_now-v_current.received_at)));
    END IF;
    v_last_artifact_at := CASE WHEN v_rows_written>v_current.rows_written
      THEN v_now ELSE v_current.last_artifact_at END;
  ELSE
    IF v_sequence <> 0 THEN RAISE EXCEPTION 'a new solver run must start at sequence zero'; END IF;
    IF FOUND AND v_current.worker_state NOT IN ('paused','completed','failed')
       AND v_current.received_at > v_now-interval '10 minutes' THEN
      RAISE EXCEPTION 'a live solver run cannot be replaced';
    END IF;
    v_started := v_now;
    v_last_artifact_at := CASE WHEN v_rows_written>0 THEN v_now END;
  END IF;
  IF v_rate > 0 AND v_rows_planned > v_rows_done THEN
    v_eta := v_now + make_interval(secs => ((v_rows_planned-v_rows_done)*3600.0/v_rate)::double precision);
  END IF;

  INSERT INTO public.solver_worker_heartbeats (
    machine_id,run_id,sequence,received_at,run_started_at,phase_id,worker_state,
    rows_planned,rows_done,rows_written,rows_per_hour,eta_at,invalid_rows,
    solver_version,solver_binary_checksum,pipeline_commit,pipeline_bundle_checksum,
    manifest_version,manifest_checksum,range_bundle_checksum,source_combo_order_checksum,
    last_artifact_id,last_artifact_checksum,last_artifact_at,error_detail,payload_checksum
  ) VALUES (
    v_machine,v_run,v_sequence,v_now,v_started,p_heartbeat->>'phase_id',p_heartbeat->>'state',
    v_rows_planned,v_rows_done,v_rows_written,v_rate,v_eta,v_invalid,
    p_heartbeat->>'solver_version',p_heartbeat->>'solver_binary_checksum',p_heartbeat->>'pipeline_commit',
    p_heartbeat->>'pipeline_bundle_checksum',p_heartbeat->>'manifest_version',p_heartbeat->>'manifest_checksum',
    p_heartbeat->>'range_bundle_checksum',p_heartbeat->>'source_combo_order_checksum',
    (p_heartbeat->>'last_artifact_id')::uuid,p_heartbeat->>'last_artifact_checksum',
    v_last_artifact_at,p_heartbeat->>'error_detail',v_payload_checksum
  );
  INSERT INTO public.solver_worker_liveness AS current (
    machine_id,run_id,sequence,received_at,run_started_at,phase_id,worker_state,
    rows_planned,rows_done,rows_written,rows_per_hour,eta_at,invalid_rows,
    solver_version,solver_binary_checksum,pipeline_commit,pipeline_bundle_checksum,
    manifest_version,manifest_checksum,range_bundle_checksum,source_combo_order_checksum,
    last_artifact_id,last_artifact_checksum,last_artifact_at,error_detail,payload_checksum
  ) SELECT machine_id,run_id,sequence,received_at,run_started_at,phase_id,worker_state,
    rows_planned,rows_done,rows_written,rows_per_hour,eta_at,invalid_rows,
    solver_version,solver_binary_checksum,pipeline_commit,pipeline_bundle_checksum,
    manifest_version,manifest_checksum,range_bundle_checksum,source_combo_order_checksum,
    last_artifact_id,last_artifact_checksum,last_artifact_at,error_detail,payload_checksum
    FROM public.solver_worker_heartbeats
   WHERE machine_id=v_machine AND run_id=v_run AND sequence=v_sequence
  ON CONFLICT (machine_id) DO UPDATE SET
    run_id=excluded.run_id,sequence=excluded.sequence,received_at=excluded.received_at,
    run_started_at=excluded.run_started_at,phase_id=excluded.phase_id,worker_state=excluded.worker_state,
    rows_planned=excluded.rows_planned,rows_done=excluded.rows_done,
    rows_written=excluded.rows_written,rows_per_hour=excluded.rows_per_hour,eta_at=excluded.eta_at,
    invalid_rows=excluded.invalid_rows,solver_version=excluded.solver_version,
    solver_binary_checksum=excluded.solver_binary_checksum,pipeline_commit=excluded.pipeline_commit,
    pipeline_bundle_checksum=excluded.pipeline_bundle_checksum,manifest_version=excluded.manifest_version,
    manifest_checksum=excluded.manifest_checksum,range_bundle_checksum=excluded.range_bundle_checksum,
    source_combo_order_checksum=excluded.source_combo_order_checksum,last_artifact_id=excluded.last_artifact_id,
    last_artifact_checksum=excluded.last_artifact_checksum,last_artifact_at=excluded.last_artifact_at,
    error_detail=excluded.error_detail,payload_checksum=excluded.payload_checksum;
  RETURN jsonb_build_object('accepted',true,'idempotent',false,'machine_id',v_machine,
    'run_id',v_run,'sequence',v_sequence,'rows_per_hour',round(v_rate,2),'eta_at',v_eta);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_solver_worker_heartbeat(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_solver_worker_heartbeat(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_solver_compact_heartbeat(p_heartbeat jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_run uuid;
  v_sequence bigint;
  v_current public.solver_compact_liveness%ROWTYPE;
  v_checksum text;
  v_source_rows bigint;
  v_receipts bigint;
  v_cells bigint;
  v_invalid bigint;
  v_source_max timestamptz;
  v_compacted timestamptz;
  v_lag bigint;
  v_started timestamptz;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_heartbeat IS NULL OR jsonb_typeof(p_heartbeat) <> 'object'
     OR p_heartbeat->>'contract' IS DISTINCT FROM 'smarter-poker.solver-compact-heartbeat.v1'
     OR COALESCE(p_heartbeat->>'run_id','') !~ '^[0-9a-fA-F-]{36}$'
     OR COALESCE((p_heartbeat->>'sequence')::bigint,-1) < 0
     OR COALESCE(p_heartbeat->>'state','') NOT IN
       ('starting','scanning','building','validating','candidate','active','paused','completed','failed')
     OR COALESCE(p_heartbeat->>'dataset_key','') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR COALESCE(p_heartbeat->>'pipeline_commit','') !~ '^[0-9a-f]{40}$'
     OR COALESCE(p_heartbeat->>'pipeline_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'pipeline_bundle_checksum' = repeat('0',64)
     OR COALESCE(p_heartbeat->>'manifest_version','') = ''
     OR COALESCE(p_heartbeat->>'manifest_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'manifest_checksum' = repeat('0',64)
     OR COALESCE(p_heartbeat->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'range_bundle_checksum' = repeat('0',64) THEN
    RAISE EXCEPTION 'invalid solver compact heartbeat';
  END IF;
  v_run := (p_heartbeat->>'run_id')::uuid;
  v_sequence := (p_heartbeat->>'sequence')::bigint;
  v_source_rows := COALESCE((p_heartbeat->>'source_rows')::bigint,-1);
  v_receipts := COALESCE((p_heartbeat->>'receipt_rows')::bigint,-1);
  v_cells := COALESCE((p_heartbeat->>'cells')::bigint,-1);
  v_invalid := COALESCE((p_heartbeat->>'invalid_rows')::bigint,-1);
  v_source_max := (p_heartbeat->>'source_max_at')::timestamptz;
  v_compacted := (p_heartbeat->>'compacted_through')::timestamptz;
  IF v_source_rows<0 OR v_receipts<0 OR v_cells<0 OR v_invalid<0
     OR (v_source_max IS NULL AND v_compacted IS NOT NULL)
     OR (p_heartbeat->>'state' IN ('candidate','active','completed') AND
         (v_source_max IS NULL OR v_compacted IS NULL))
     OR (p_heartbeat->>'state' IN ('candidate','active','completed') AND
         (COALESCE(p_heartbeat->>'dataset_checksum','') !~ '^[0-9a-f]{64}$' OR
          p_heartbeat->>'dataset_checksum'=repeat('0',64)))
     OR (p_heartbeat->>'state'='failed' AND nullif(btrim(p_heartbeat->>'error_detail'),'') IS NULL) THEN
    RAISE EXCEPTION 'solver compact heartbeat counters or terminal state are invalid';
  END IF;
  v_lag := CASE WHEN v_source_max IS NOT NULL THEN greatest(0,extract(epoch FROM (v_source_max-v_compacted))::bigint) END;
  v_checksum := public.fn_gto_v31_json_checksum(p_heartbeat);
  IF EXISTS (SELECT 1 FROM public.solver_compact_heartbeats
      WHERE run_id=v_run AND sequence=v_sequence AND payload_checksum=v_checksum) THEN
    RETURN jsonb_build_object('accepted',true,'idempotent',true,'run_id',v_run,'sequence',v_sequence);
  END IF;
  IF EXISTS (SELECT 1 FROM public.solver_compact_heartbeats WHERE run_id=v_run AND sequence=v_sequence) THEN
    RAISE EXCEPTION 'compact heartbeat idempotency key was reused with another payload';
  END IF;
  SELECT * INTO v_current FROM public.solver_compact_liveness WHERE singleton FOR UPDATE;
  IF FOUND AND v_current.run_id=v_run THEN
    IF v_sequence<=v_current.sequence OR v_source_rows<v_current.source_rows
       OR v_receipts<v_current.receipt_rows OR v_cells<v_current.cells OR v_invalid<v_current.invalid_rows THEN
      RAISE EXCEPTION 'compact heartbeat sequence or counters regressed';
    END IF;
    IF p_heartbeat->>'pipeline_commit'<>v_current.pipeline_commit
       OR p_heartbeat->>'pipeline_bundle_checksum'<>v_current.pipeline_bundle_checksum
       OR p_heartbeat->>'manifest_version'<>v_current.manifest_version
       OR p_heartbeat->>'manifest_checksum'<>v_current.manifest_checksum
       OR p_heartbeat->>'range_bundle_checksum'<>v_current.range_bundle_checksum THEN
      RAISE EXCEPTION 'compact provenance changed inside a run';
    END IF;
    v_started := v_current.run_started_at;
  ELSE
    IF v_sequence<>0 THEN RAISE EXCEPTION 'a new compact run must start at sequence zero'; END IF;
    IF FOUND AND v_current.compact_state NOT IN ('paused','completed','failed','active')
       AND v_current.received_at>v_now-interval '10 minutes' THEN
      RAISE EXCEPTION 'a live compact run cannot be replaced';
    END IF;
    v_started := v_now;
  END IF;

  INSERT INTO public.solver_compact_heartbeats (
    run_id,sequence,received_at,run_started_at,compact_state,dataset_key,
    source_rows,receipt_rows,cells,invalid_rows,source_max_at,compacted_through,
    compact_lag_seconds,pipeline_commit,pipeline_bundle_checksum,manifest_version,
    manifest_checksum,range_bundle_checksum,dataset_checksum,error_detail,payload_checksum
  ) VALUES (
    v_run,v_sequence,v_now,v_started,p_heartbeat->>'state',p_heartbeat->>'dataset_key',
    v_source_rows,v_receipts,v_cells,v_invalid,v_source_max,v_compacted,v_lag,
    p_heartbeat->>'pipeline_commit',p_heartbeat->>'pipeline_bundle_checksum',
    p_heartbeat->>'manifest_version',p_heartbeat->>'manifest_checksum',
    p_heartbeat->>'range_bundle_checksum',p_heartbeat->>'dataset_checksum',
    p_heartbeat->>'error_detail',v_checksum
  );
  INSERT INTO public.solver_compact_liveness AS current
  SELECT true,run_id,sequence,received_at,run_started_at,compact_state,dataset_key,
    source_rows,receipt_rows,cells,invalid_rows,source_max_at,compacted_through,
    compact_lag_seconds,pipeline_commit,pipeline_bundle_checksum,manifest_version,
    manifest_checksum,range_bundle_checksum,dataset_checksum,error_detail,payload_checksum
    FROM public.solver_compact_heartbeats WHERE run_id=v_run AND sequence=v_sequence
  ON CONFLICT (singleton) DO UPDATE SET
    run_id=excluded.run_id,sequence=excluded.sequence,received_at=excluded.received_at,
    run_started_at=excluded.run_started_at,compact_state=excluded.compact_state,
    dataset_key=excluded.dataset_key,source_rows=excluded.source_rows,
    receipt_rows=excluded.receipt_rows,cells=excluded.cells,invalid_rows=excluded.invalid_rows,
    source_max_at=excluded.source_max_at,compacted_through=excluded.compacted_through,
    compact_lag_seconds=excluded.compact_lag_seconds,pipeline_commit=excluded.pipeline_commit,
    pipeline_bundle_checksum=excluded.pipeline_bundle_checksum,manifest_version=excluded.manifest_version,
    manifest_checksum=excluded.manifest_checksum,range_bundle_checksum=excluded.range_bundle_checksum,
    dataset_checksum=excluded.dataset_checksum,error_detail=excluded.error_detail,
    payload_checksum=excluded.payload_checksum;
  RETURN jsonb_build_object('accepted',true,'idempotent',false,'run_id',v_run,
    'sequence',v_sequence,'compact_lag_seconds',v_lag);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_solver_compact_heartbeat(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_solver_compact_heartbeat(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_audit_solver_pipeline_liveness(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_findings jsonb := '[]'::jsonb;
  v_machine text;
  v_worker public.solver_worker_liveness%ROWTYPE;
  v_compact public.solver_compact_liveness%ROWTYPE;
  v_peer public.solver_worker_liveness%ROWTYPE;
  v_progress bigint;
  v_workers_healthy boolean := true;
  v_provenance_matches boolean := true;
BEGIN
  FOREACH v_machine IN ARRAY ARRAY['M1','M2'] LOOP
    SELECT * INTO v_worker FROM public.solver_worker_liveness WHERE machine_id=v_machine;
    IF NOT FOUND THEN
      v_workers_healthy := false;
      v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
        'code','solver_worker_missing','title','Solver host '||v_machine||' has no heartbeat',
        'evidence',jsonb_build_object('machine_id',v_machine,'day',p_day),
        'recommendation','Start the checksum-pinned supervised worker on '||v_machine||' and confirm fn_solver_worker_heartbeat is accepted.');
      CONTINUE;
    END IF;
    IF v_worker.received_at < now()-interval '15 minutes' THEN
      v_workers_healthy := false;
      v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
        'code','solver_worker_stale','title','Solver host '||v_machine||' heartbeat is stale',
        'evidence',jsonb_build_object('machine_id',v_machine,'last_heartbeat',v_worker.received_at,
          'state',v_worker.worker_state,'phase',v_worker.phase_id,'rows_done',v_worker.rows_done),
        'recommendation','Restore the supervised worker. A stale host cannot satisfy the two-machine provenance gate.');
    ELSIF v_worker.worker_state='failed' OR v_worker.invalid_rows>0 THEN
      v_workers_healthy := false;
      v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
        'code','solver_worker_failed','title','Solver host '||v_machine||' reports failure or invalid rows',
        'evidence',jsonb_build_object('machine_id',v_machine,'state',v_worker.worker_state,
          'invalid_rows',v_worker.invalid_rows,'error',v_worker.error_detail),
        'recommendation','Quarantine the run; correct the solver/export contract and restart from a new run id.');
    ELSIF v_worker.worker_state IN ('solving','harvesting','compacting')
       AND v_worker.run_started_at < now() - (CASE WHEN v_worker.worker_state='solving'
         THEN interval '2 hours' ELSE interval '15 minutes' END) THEN
      SELECT COALESCE(max(rows_done)-min(rows_done),0) INTO v_progress
        FROM public.solver_worker_heartbeats
       WHERE machine_id=v_machine AND run_id=v_worker.run_id
         AND received_at>=now()-(CASE WHEN v_worker.worker_state='solving'
           THEN interval '2 hours' ELSE interval '15 minutes' END);
      IF v_progress=0 THEN
        v_workers_healthy := false;
        v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
          'code','solver_worker_stalled','title','Solver host '||v_machine||' made no progress inside its phase ceiling',
          'evidence',jsonb_build_object('machine_id',v_machine,'state',v_worker.worker_state,
            'phase',v_worker.phase_id,'rows_done',v_worker.rows_done,'rows_per_hour',v_worker.rows_per_hour),
          'recommendation','Inspect the Pio UPI process and worker log. Solves have a two-hour ceiling; harvest and compaction have a 15-minute ceiling. A fresh heartbeat with frozen counters is not progress.');
      END IF;
    END IF;
  END LOOP;

  SELECT * INTO v_worker FROM public.solver_worker_liveness WHERE machine_id='M1';
  SELECT * INTO v_peer FROM public.solver_worker_liveness WHERE machine_id='M2';
  IF v_worker.machine_id IS NOT NULL AND v_peer.machine_id IS NOT NULL AND (
    v_worker.pipeline_commit<>v_peer.pipeline_commit OR
    v_worker.pipeline_bundle_checksum<>v_peer.pipeline_bundle_checksum OR
    v_worker.manifest_version<>v_peer.manifest_version OR
    v_worker.manifest_checksum<>v_peer.manifest_checksum OR
    v_worker.solver_binary_checksum<>v_peer.solver_binary_checksum OR
    v_worker.range_bundle_checksum<>v_peer.range_bundle_checksum OR
    v_worker.source_combo_order_checksum<>v_peer.source_combo_order_checksum
  ) THEN
    v_provenance_matches := false;
    v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
      'code','solver_worker_provenance_split','title','M1 and M2 are not running identical approved inputs',
      'evidence',jsonb_build_object('M1',jsonb_build_object('commit',v_worker.pipeline_commit,
        'manifest',v_worker.manifest_checksum,'binary',v_worker.solver_binary_checksum),
        'M2',jsonb_build_object('commit',v_peer.pipeline_commit,'manifest',v_peer.manifest_checksum,
        'binary',v_peer.solver_binary_checksum)),
      'recommendation','Stop both workers and redeploy one protected commit, manifest, binary and range bundle to both hosts.');
  END IF;

  SELECT * INTO v_compact FROM public.solver_compact_liveness WHERE singleton;
  IF NOT FOUND THEN
    v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
      'code','solver_compactor_missing','title','Certified V31 compactor has no heartbeat',
      'evidence',jsonb_build_object('day',p_day),
      'recommendation','Start the pinned compact builder. Solver rows are not runtime policy until source receipts and held-out gates produce a certified candidate.');
  ELSIF v_compact.received_at<now()-interval '20 minutes' OR v_compact.compact_state='failed'
     OR v_compact.invalid_rows>0 OR COALESCE(v_compact.compact_lag_seconds,0)>21600 THEN
    v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
      'code','solver_compactor_unhealthy','title','Certified V31 compact build is stale, failed, invalid, or over six hours behind',
      'evidence',jsonb_build_object('last_heartbeat',v_compact.received_at,'state',v_compact.compact_state,
        'invalid_rows',v_compact.invalid_rows,'lag_seconds',v_compact.compact_lag_seconds,
        'source_rows',v_compact.source_rows,'receipt_rows',v_compact.receipt_rows,'cells',v_compact.cells,
        'error',v_compact.error_detail),
      'recommendation','Repair the compact builder and source reconciliation. Keep the candidate inactive until invalid rows are zero and lag recovers.');
  ELSIF v_workers_healthy AND v_provenance_matches THEN
    v_findings := v_findings || jsonb_build_object('severity','info','category','gto',
      'code','solver_pipeline_live','title','Both solver-host slots and the V31 compactor are instrumented',
      'evidence',jsonb_build_object('M1_at',v_worker.received_at,'M2_at',v_peer.received_at,
        'compact_at',v_compact.received_at,'compact_lag_seconds',v_compact.compact_lag_seconds,
        'dataset',v_compact.dataset_key),
      'recommendation','Continue monitoring independent host progress, checksums, invalid rows and compact lag.');
  END IF;
  RETURN v_findings;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_audit_solver_pipeline_liveness(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_solver_pipeline_liveness(date) TO service_role;

CREATE OR REPLACE FUNCTION public.ca_solver_pipeline_liveness()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.fn_is_horse_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  RETURN jsonb_build_object(
    'workers',COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.machine_id)
      FROM public.solver_worker_liveness w),'[]'::jsonb),
    'compactor',(SELECT to_jsonb(c) FROM public.solver_compact_liveness c WHERE singleton),
    'generated_at',now()
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_solver_pipeline_liveness() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_solver_pipeline_liveness() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_gto_v31_certification_status(
  p_dataset_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_datasets jsonb;
  v_active jsonb;
  v_agreement jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND NOT public.fn_is_horse_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'created_at' DESC),'[]'::jsonb)
    INTO v_datasets
    FROM (
      SELECT jsonb_build_object(
        'dataset_id',d.dataset_id,
        'dataset_key',d.dataset_key,
        'state',d.state,
        'quality_status',d.quality_status,
        'dataset_checksum',d.dataset_checksum,
        'source_artifact_checksum',d.source_artifact_checksum,
        'solver_version',d.solver_version,
        'solver_binary_checksum',d.solver_binary_checksum,
        'pipeline_commit',d.pipeline_commit,
        'pipeline_bundle_checksum',d.pipeline_bundle_checksum,
        'manifest_version',d.manifest_version,
        'manifest_checksum',d.manifest_checksum,
        'input_bundle_checksum',d.input_bundle_checksum,
        'input_approval_status',b.approval_status,
        'machine_ids',d.machine_ids,
        'source_rows',d.source_rows,
        'train_source_rows',d.train_source_rows,
        'holdout_source_rows',d.holdout_source_rows,
        'invalid_rows',d.invalid_rows,
        'ingested_source_artifacts',(SELECT count(*)
          FROM public.gto_v31_source_artifacts a WHERE a.dataset_id=d.dataset_id),
        'ingested_source_nodes',COALESCE((SELECT sum(a.node_count)
          FROM public.gto_v31_source_artifacts a WHERE a.dataset_id=d.dataset_id),0),
        'runtime_cells',(SELECT count(*) FROM public.gto_v31_runtime_cells c
          WHERE c.dataset_id=d.dataset_id),
        'source_receipt_rows',(SELECT count(*) FROM public.gto_v31_cell_source_receipts r
          WHERE r.dataset_id=d.dataset_id),
        'source_max_at',(SELECT max(a.solved_at) FROM public.gto_v31_source_artifacts a
          WHERE a.dataset_id=d.dataset_id),
        'coverage',d.coverage,
        'heldout_metrics',d.heldout_metrics,
        'created_at',d.created_at,
        'sealed_at',d.sealed_at,
        'candidate_at',d.candidate_at,
        'promoted_at',d.promoted_at,
        'evaluations',COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'evaluation_id',e.evaluation_id,
            'kind',e.evaluation_kind,
            'game_family',e.game_family,
            'verdict',e.verdict,
            'metrics',e.metrics,
            'result_checksum',e.result_checksum,
            'evaluated_at',e.evaluated_at
          ) ORDER BY e.evaluation_kind,e.game_family)
            FROM public.gto_v31_release_evaluations e
           WHERE e.dataset_id=d.dataset_id
        ),'[]'::jsonb)
      ) AS item
        FROM public.gto_v31_datasets d
        JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
       WHERE (p_dataset_id IS NULL OR d.dataset_id=p_dataset_id)
       ORDER BY d.created_at DESC
       LIMIT CASE WHEN p_dataset_id IS NULL THEN 20 ELSE 1 END
    ) recent;

  SELECT item INTO v_active
    FROM jsonb_array_elements(v_datasets) item
   WHERE item->>'state'='active' LIMIT 1;
  SELECT to_jsonb(a) INTO v_agreement
    FROM public.horse_solver_agreement a
   ORDER BY a.run_date DESC,a.created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'contract','smarter-poker.gto-v31-certification-status.v1',
    'generated_at',now(),
    'active_dataset',v_active,
    'datasets',v_datasets,
    'workers',COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.machine_id)
      FROM public.solver_worker_liveness w),'[]'::jsonb),
    'compactor',(SELECT to_jsonb(c) FROM public.solver_compact_liveness c WHERE singleton),
    'latest_agreement',v_agreement
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_gto_v31_certification_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_gto_v31_certification_status(uuid)
  TO authenticated, service_role;

DO $patch$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('public.fn_run_horse_daily_audit(date)'::regprocedure) INTO d;
  IF position('fn_audit_gto_v31_certified(p_day)' IN d)>0
     AND position('fn_audit_solver_pipeline_liveness(p_day)' IN d)>0 THEN RETURN; END IF;
  IF position('v_findings := v_findings || fn_audit_solver_agreement(p_day);' IN d)=0 THEN
    RAISE EXCEPTION 'daily audit solver-agreement splice target is missing';
  END IF;
  d := replace(d,
    'v_findings := v_findings || fn_audit_solver_agreement(p_day);',
    'v_findings := v_findings || fn_audit_solver_agreement(p_day);'||chr(10)||
    '  -- 2026-09-08 Phase 4: certified corpus and independent pipeline liveness.'||chr(10)||
    '  v_findings := v_findings || fn_audit_gto_v31_certified(p_day);'||chr(10)||
    '  v_findings := v_findings || fn_audit_solver_pipeline_liveness(p_day);');
  EXECUTE d;
END;
$patch$;

COMMENT ON TABLE public.solver_worker_heartbeats IS
  'Append-only, monotonic Phase 4 receipts from the independently attributed M1 and M2 supervised solver workers.';
COMMENT ON TABLE public.solver_compact_heartbeats IS
  'Append-only receipts from the certified V31 compact builder, including source-to-runtime lag and invalid-row count.';

COMMIT;
