-- ============================================================================
-- V31 CONTROL RECEIPTS USE EXACT JSON TYPES
--
-- The signed gateway authenticates bytes, but PostgreSQL remains the final
-- admission authority. JSON text extraction previously coerced strings,
-- booleans, and fractional numbers into plausible heartbeat counters and
-- source-artifact envelope values. Keep the signed contract one-language:
-- exact keys, exact JSON scalar types, canonical UUIDs, and safe integers.
-- ============================================================================

BEGIN;

-- Pio child codes are the immutable join key across frequencies, EVs, and
-- action metadata. Accepting an arbitrary JSON key (or allowing c/f/bN to be
-- relabeled as another family) can execute a different action from the one
-- whose solver frequency was harvested.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_action_specs_valid(p_specs jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_action record;
  v_family text;
  v_unit text;
  v_size numeric;
  v_call_family text;
BEGIN
  IF p_specs IS NULL OR jsonb_typeof(p_specs) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_specs)) < 2
     OR NOT (p_specs ? 'c')
     OR jsonb_typeof(p_specs#>'{c,family}') IS DISTINCT FROM 'string'
     OR p_specs#>>'{c,family}' NOT IN ('check','call') THEN
    RETURN false;
  END IF;
  v_call_family := p_specs#>>'{c,family}';
  IF v_call_family='call' AND NOT (p_specs ? 'f') THEN RETURN false; END IF;

  FOR v_action IN SELECT key,value FROM jsonb_each(p_specs) LOOP
    IF v_action.key !~ '^(c|f|b[1-9][0-9]{0,78})$'
       OR jsonb_typeof(v_action.value) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_action.value)) <> 4
       OR NOT (v_action.value ?& ARRAY['family','size_unit','size_value','all_in'])
       OR jsonb_typeof(v_action.value->'family') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_action.value->'size_unit') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_action.value->'all_in') IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
    v_family := v_action.value->>'family';
    v_unit := v_action.value->>'size_unit';
    IF v_family NOT IN ('check','fold','call','bet','raise','all_in')
       OR (v_action.key='c' AND v_family<>v_call_family)
       OR (v_action.key='f' AND v_family<>'fold')
       OR (v_action.key LIKE 'b%' AND v_call_family='check'
           AND v_family NOT IN ('bet','all_in'))
       OR (v_action.key LIKE 'b%' AND v_call_family='call'
           AND v_family NOT IN ('raise','all_in')) THEN
      RETURN false;
    END IF;
    IF v_family IN ('check','fold','call') THEN
      IF v_unit <> 'none'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN
        RETURN false;
      END IF;
    ELSIF v_family = 'all_in' THEN
      IF v_unit <> 'all_in'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM true THEN
        RETURN false;
      END IF;
    ELSE
      IF jsonb_typeof(v_action.value->'size_value') IS DISTINCT FROM 'number'
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN
        RETURN false;
      END IF;
      v_size := (v_action.value->>'size_value')::numeric;
      IF v_size <= 0 OR v_size > 20
         OR (v_family = 'bet' AND v_unit <> 'pot_fraction')
         OR (v_family = 'raise' AND v_unit <> 'pot_after_call_fraction') THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_action_specs_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_action_specs_valid(jsonb) TO service_role;

DO $existing_action_contract$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_runtime_cells c
     WHERE NOT public.fn_gto_v31_action_specs_valid(c.action_specs)
  ) OR EXISTS (
    SELECT 1 FROM public.solved_spots_gold s
    CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(node)
     WHERE s.game_type LIKE 'gto_v31_%'
       AND NOT public.fn_gto_v31_action_specs_valid(n.node->'action_specs')
  ) THEN
    RAISE EXCEPTION 'cannot bind Pio action identities while incompatible V31 rows exist';
  END IF;
END;
$existing_action_contract$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_source_node_scalar_types_valid(p_node jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_context jsonb := p_node->'node_context';
  v_line jsonb := p_node->'line_proof';
  v_key text;
  v_max constant numeric := 9007199254740991;
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node) <> 'object' THEN RETURN false; END IF;
  FOREACH v_key IN ARRAY ARRAY[
    'schema','node','node_checksum','source_combo_order_checksum','range_bundle_checksum'
  ] LOOP
    IF jsonb_typeof(p_node->v_key) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF length(p_node->>'node') NOT BETWEEN 3 AND 512
     OR p_node->>'node' !~
       '^r:0(:c|:f|:b[1-9][0-9]{0,78}|:[2-9TJQKA][cdhs])*$' THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(v_context) <> 'object' OR jsonb_typeof(v_line) <> 'object' THEN RETURN false; END IF;
  FOREACH v_key IN ARRAY ARRAY[
    'street','game_family','objective','utility_context','pot_type','hero_position',
    'opponent_position','texture_class','node_role','facing_kind','facing_size_bucket','board'
  ] LOOP
    IF jsonb_typeof(v_context->v_key) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF NOT public.fn_gto_v31_json_safe_integer(v_context->'table_size',2,10)
     OR NOT public.fn_gto_v31_json_safe_integer(v_context->'depth_bucket',10,150)
     OR NOT (
       v_context->'facing_target_chips'='null'::jsonb
       OR public.fn_gto_v31_json_safe_integer(v_context->'facing_target_chips',0,v_max)
     )
     OR NOT (
       v_context->'facing_actor_total_chips'='null'::jsonb
       OR public.fn_gto_v31_json_safe_integer(v_context->'facing_actor_total_chips',0,v_max)
     ) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(v_line->'schema') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_line->'manifest_checksum') IS DISTINCT FROM 'string'
     OR NOT public.fn_gto_v31_json_safe_integer(v_line->'hero_solver_player',0,1)
     OR NOT (
       v_line->'preflop_aggressor_solver_player'='null'::jsonb
       OR public.fn_gto_v31_json_safe_integer(v_line->'preflop_aggressor_solver_player',0,1)
     )
     OR NOT public.fn_gto_v31_json_safe_integer(v_line->'root_pot_chips',1,v_max)
     OR NOT public.fn_gto_v31_json_safe_integer(v_line->'effective_stack_chips',1,v_max)
     OR NOT public.fn_gto_v31_json_safe_integer(v_line->'chips_per_bb',1,v_max) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_source_node_scalar_types_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_source_node_scalar_types_valid(jsonb)
  TO service_role;

DO $existing_source_node_contract$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.solved_spots_gold s
    CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(node)
     WHERE s.game_type LIKE 'gto_v31_%'
       AND NOT public.fn_gto_v31_source_node_valid(n.node)
  ) THEN
    RAISE EXCEPTION 'cannot bind canonical Pio node identities while incompatible V31 rows exist';
  END IF;
END;
$existing_source_node_contract$;

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
     OR (SELECT count(*) FROM jsonb_object_keys(p_heartbeat)) <> 21
     OR NOT (p_heartbeat ?& ARRAY[
       'contract','machine_id','run_id','sequence','phase_id','state','rows_planned',
       'rows_done','rows_written','invalid_rows','last_artifact_id',
       'last_artifact_checksum','error_detail','solver_version','solver_binary_checksum',
       'pipeline_commit','pipeline_bundle_checksum','manifest_version','manifest_checksum',
       'range_bundle_checksum','source_combo_order_checksum'
     ])
     OR EXISTS (
       SELECT 1 FROM unnest(ARRAY[
         'contract','machine_id','run_id','phase_id','state','solver_version',
         'solver_binary_checksum','pipeline_commit','pipeline_bundle_checksum',
         'manifest_version','manifest_checksum','range_bundle_checksum',
         'source_combo_order_checksum'
       ]) field(key) WHERE jsonb_typeof(p_heartbeat->field.key) <> 'string'
     )
     OR EXISTS (
       SELECT 1 FROM unnest(ARRAY[
         'sequence','rows_planned','rows_done','rows_written','invalid_rows'
       ]) field(key) WHERE jsonb_typeof(p_heartbeat->field.key) <> 'number'
     )
     OR jsonb_typeof(p_heartbeat->'last_artifact_id') NOT IN ('string','null')
     OR jsonb_typeof(p_heartbeat->'last_artifact_checksum') NOT IN ('string','null')
     OR jsonb_typeof(p_heartbeat->'error_detail') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'invalid solver worker heartbeat';
  END IF;

  IF p_heartbeat->>'contract' IS DISTINCT FROM 'smarter-poker.solver-worker-heartbeat.v1'
     OR COALESCE(v_machine,'') NOT IN ('M1','M2')
     OR p_heartbeat->>'run_id' !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR NOT public.fn_gto_v31_json_safe_integer(
       p_heartbeat->'sequence',0,9007199254740991)
     OR COALESCE(p_heartbeat->>'phase_id','') !~ '^[A-Za-z0-9_.:-]{1,160}$'
     OR COALESCE(p_heartbeat->>'state','') NOT IN
       ('starting','self_test','solving','harvesting','compacting','paused','completed','failed')
     OR length(p_heartbeat->>'solver_version') NOT BETWEEN 1 AND 160
     OR p_heartbeat->>'solver_version' <> btrim(p_heartbeat->>'solver_version')
     OR COALESCE(p_heartbeat->>'solver_binary_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'solver_binary_checksum' = repeat('0',64)
     OR COALESCE(p_heartbeat->>'pipeline_commit','') !~ '^[0-9a-f]{40}$'
     OR COALESCE(p_heartbeat->>'pipeline_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'pipeline_bundle_checksum' = repeat('0',64)
     OR length(p_heartbeat->>'manifest_version') NOT BETWEEN 1 AND 160
     OR p_heartbeat->>'manifest_version' <> btrim(p_heartbeat->>'manifest_version')
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
  IF NOT public.fn_gto_v31_json_safe_integer(p_heartbeat->'rows_planned',0,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(p_heartbeat->'rows_done',0,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(p_heartbeat->'rows_written',0,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(p_heartbeat->'invalid_rows',0,9007199254740991) THEN
    RAISE EXCEPTION 'solver worker heartbeat counters or terminal state are invalid';
  END IF;
  v_rows_planned := (p_heartbeat->>'rows_planned')::bigint;
  v_rows_done := (p_heartbeat->>'rows_done')::bigint;
  v_rows_written := (p_heartbeat->>'rows_written')::bigint;
  v_invalid := (p_heartbeat->>'invalid_rows')::bigint;
  IF v_rows_done > v_rows_planned OR v_rows_written > v_rows_done OR v_invalid > v_rows_done
     OR v_rows_written + v_invalid <> v_rows_done
     OR (v_sequence = 0 AND (p_heartbeat->>'state' <> 'starting'
         OR v_rows_done <> 0 OR v_rows_written <> 0 OR v_invalid <> 0))
     OR (p_heartbeat->>'state' = 'completed' AND
         (v_rows_planned = 0 OR v_rows_done <> v_rows_planned
          OR v_rows_written <> v_rows_planned OR v_invalid <> 0))
     OR (v_rows_written = 0 AND (p_heartbeat->'last_artifact_id' <> 'null'::jsonb OR
         p_heartbeat->'last_artifact_checksum' <> 'null'::jsonb))
     OR (v_rows_written > 0 AND (COALESCE(p_heartbeat->>'last_artifact_id','') !~ '^[0-9a-fA-F-]{36}$' OR
         COALESCE(p_heartbeat->>'last_artifact_checksum','') !~ '^[0-9a-f]{64}$' OR
         p_heartbeat->>'last_artifact_checksum' = repeat('0',64)))
     OR (p_heartbeat->'last_artifact_id' <> 'null'::jsonb AND
         p_heartbeat->>'last_artifact_id' !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     OR (p_heartbeat->>'state' = 'failed' AND
         (p_heartbeat->'error_detail' = 'null'::jsonb OR
          length(btrim(p_heartbeat->>'error_detail')) NOT BETWEEN 1 AND 2000))
     OR (p_heartbeat->>'state' <> 'failed' AND p_heartbeat->'error_detail' <> 'null'::jsonb) THEN
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
    IF v_current.worker_state IN ('completed','failed') THEN
      RAISE EXCEPTION 'a terminal solver run cannot advance';
    END IF;
    IF v_rows_planned <> v_current.rows_planned OR v_rows_done < v_current.rows_done
       OR v_rows_written < v_current.rows_written OR v_invalid < v_current.invalid_rows THEN
      RAISE EXCEPTION 'solver heartbeat counters regressed within a run';
    END IF;
    IF p_heartbeat->>'solver_version' <> v_current.solver_version
       OR p_heartbeat->>'pipeline_commit' <> v_current.pipeline_commit
       OR p_heartbeat->>'pipeline_bundle_checksum' <> v_current.pipeline_bundle_checksum
       OR p_heartbeat->>'manifest_version' <> v_current.manifest_version
       OR p_heartbeat->>'manifest_checksum' <> v_current.manifest_checksum
       OR p_heartbeat->>'solver_binary_checksum' <> v_current.solver_binary_checksum
       OR p_heartbeat->>'range_bundle_checksum' <> v_current.range_bundle_checksum
       OR p_heartbeat->>'source_combo_order_checksum' <> v_current.source_combo_order_checksum THEN
      RAISE EXCEPTION 'solver provenance changed inside a run';
    END IF;
    IF v_rows_written = v_current.rows_written AND
       ((p_heartbeat->>'last_artifact_id')::uuid IS DISTINCT FROM v_current.last_artifact_id
        OR p_heartbeat->>'last_artifact_checksum' IS DISTINCT FROM v_current.last_artifact_checksum) THEN
      RAISE EXCEPTION 'solver artifact identity changed without write progress';
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
     OR (SELECT count(*) FROM jsonb_object_keys(p_heartbeat)) <> 18
     OR NOT (p_heartbeat ?& ARRAY[
       'contract','run_id','sequence','state','source_rows','receipt_rows','cells',
       'invalid_rows','source_max_at','compacted_through','dataset_checksum','error_detail',
       'dataset_key','pipeline_commit','pipeline_bundle_checksum','manifest_version',
       'manifest_checksum','range_bundle_checksum'
     ])
     OR EXISTS (
       SELECT 1 FROM unnest(ARRAY[
         'contract','run_id','state','dataset_key','pipeline_commit',
         'pipeline_bundle_checksum','manifest_version','manifest_checksum',
         'range_bundle_checksum'
       ]) field(key) WHERE jsonb_typeof(p_heartbeat->field.key) <> 'string'
     )
     OR EXISTS (
       SELECT 1 FROM unnest(ARRAY[
         'sequence','source_rows','receipt_rows','cells','invalid_rows'
       ]) field(key) WHERE jsonb_typeof(p_heartbeat->field.key) <> 'number'
     )
     OR jsonb_typeof(p_heartbeat->'source_max_at') NOT IN ('string','null')
     OR jsonb_typeof(p_heartbeat->'compacted_through') NOT IN ('string','null')
     OR jsonb_typeof(p_heartbeat->'dataset_checksum') NOT IN ('string','null')
     OR jsonb_typeof(p_heartbeat->'error_detail') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'invalid solver compact heartbeat';
  END IF;

  IF p_heartbeat->>'contract' IS DISTINCT FROM 'smarter-poker.solver-compact-heartbeat.v1'
     OR p_heartbeat->>'run_id' !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR NOT public.fn_gto_v31_json_safe_integer(
       p_heartbeat->'sequence',0,9007199254740991)
     OR COALESCE(p_heartbeat->>'state','') NOT IN
       ('starting','scanning','building','validating','candidate','active','paused','completed','failed')
     OR COALESCE(p_heartbeat->>'dataset_key','') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR COALESCE(p_heartbeat->>'pipeline_commit','') !~ '^[0-9a-f]{40}$'
     OR COALESCE(p_heartbeat->>'pipeline_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'pipeline_bundle_checksum' = repeat('0',64)
     OR length(p_heartbeat->>'manifest_version') NOT BETWEEN 1 AND 160
     OR p_heartbeat->>'manifest_version' <> btrim(p_heartbeat->>'manifest_version')
     OR COALESCE(p_heartbeat->>'manifest_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'manifest_checksum' = repeat('0',64)
     OR COALESCE(p_heartbeat->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_heartbeat->>'range_bundle_checksum' = repeat('0',64) THEN
    RAISE EXCEPTION 'invalid solver compact heartbeat';
  END IF;
  v_run := (p_heartbeat->>'run_id')::uuid;
  v_sequence := (p_heartbeat->>'sequence')::bigint;
  IF NOT public.fn_gto_v31_json_safe_integer(
       p_heartbeat->'source_rows',0,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(
       p_heartbeat->'receipt_rows',0,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(
       p_heartbeat->'cells',0,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(
       p_heartbeat->'invalid_rows',0,9007199254740991) THEN
    RAISE EXCEPTION 'solver compact heartbeat counters or terminal state are invalid';
  END IF;
  v_source_rows := (p_heartbeat->>'source_rows')::bigint;
  v_receipts := (p_heartbeat->>'receipt_rows')::bigint;
  v_cells := (p_heartbeat->>'cells')::bigint;
  v_invalid := (p_heartbeat->>'invalid_rows')::bigint;
  v_source_max := (p_heartbeat->>'source_max_at')::timestamptz;
  v_compacted := (p_heartbeat->>'compacted_through')::timestamptz;
  IF (v_source_max IS NOT NULL AND NOT isfinite(v_source_max))
     OR (v_compacted IS NOT NULL AND NOT isfinite(v_compacted))
     OR (v_source_max IS NULL AND v_compacted IS NOT NULL)
     OR (v_source_max IS NOT NULL AND v_compacted IS NOT NULL AND v_compacted > v_source_max)
     OR (v_sequence = 0 AND (p_heartbeat->>'state' <> 'starting'
         OR v_source_rows <> 0 OR v_receipts <> 0 OR v_cells <> 0 OR v_invalid <> 0
         OR v_source_max IS NOT NULL OR v_compacted IS NOT NULL
         OR p_heartbeat->'dataset_checksum' <> 'null'::jsonb))
     OR (p_heartbeat->>'state' NOT IN ('candidate','active','completed','failed') AND
         (v_compacted IS NOT NULL OR p_heartbeat->'dataset_checksum' <> 'null'::jsonb))
     OR (p_heartbeat->>'state' IN ('candidate','active','completed') AND
         (v_source_rows = 0 OR v_receipts = 0 OR v_cells = 0 OR v_invalid <> 0
          OR v_source_max IS NULL OR v_compacted IS NULL
          OR v_source_max IS DISTINCT FROM v_compacted))
     OR (p_heartbeat->'dataset_checksum'<>'null'::jsonb AND
         (COALESCE(p_heartbeat->>'dataset_checksum','') !~ '^[0-9a-f]{64}$' OR
          p_heartbeat->>'dataset_checksum'=repeat('0',64)))
     OR (p_heartbeat->>'state' IN ('candidate','active','completed') AND
         p_heartbeat->'dataset_checksum'='null'::jsonb)
     OR (p_heartbeat->>'state'='failed' AND
         (p_heartbeat->'error_detail'='null'::jsonb OR
          length(btrim(p_heartbeat->>'error_detail')) NOT BETWEEN 1 AND 2000))
     OR (p_heartbeat->>'state'<>'failed' AND p_heartbeat->'error_detail'<>'null'::jsonb) THEN
    RAISE EXCEPTION 'solver compact heartbeat counters or terminal state are invalid';
  END IF;
  v_lag := CASE WHEN v_source_max IS NOT NULL AND v_compacted IS NOT NULL
    THEN greatest(0,extract(epoch FROM (v_source_max-v_compacted))::bigint) END;
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
    IF v_current.compact_state IN ('candidate','active','completed','failed') THEN
      RAISE EXCEPTION 'a terminal compact run cannot advance';
    END IF;
    IF v_sequence<=v_current.sequence OR v_source_rows<v_current.source_rows
       OR v_receipts<v_current.receipt_rows OR v_cells<v_current.cells OR v_invalid<v_current.invalid_rows THEN
      RAISE EXCEPTION 'compact heartbeat sequence or counters regressed';
    END IF;
    IF p_heartbeat->>'dataset_key'<>v_current.dataset_key
       OR p_heartbeat->>'pipeline_commit'<>v_current.pipeline_commit
       OR p_heartbeat->>'pipeline_bundle_checksum'<>v_current.pipeline_bundle_checksum
       OR p_heartbeat->>'manifest_version'<>v_current.manifest_version
       OR p_heartbeat->>'manifest_checksum'<>v_current.manifest_checksum
       OR p_heartbeat->>'range_bundle_checksum'<>v_current.range_bundle_checksum THEN
      RAISE EXCEPTION 'compact provenance changed inside a run';
    END IF;
    IF (v_current.source_max_at IS NOT NULL AND
         (v_source_max IS NULL OR v_source_max < v_current.source_max_at))
       OR (v_current.compacted_through IS NOT NULL AND
         (v_compacted IS NULL OR v_compacted < v_current.compacted_through)) THEN
      RAISE EXCEPTION 'compact source watermark regressed within a run';
    END IF;
    IF v_current.dataset_checksum IS NOT NULL AND
       p_heartbeat->>'dataset_checksum' IS DISTINCT FROM v_current.dataset_checksum THEN
      RAISE EXCEPTION 'compact dataset checksum changed inside a run';
    END IF;
    v_started := v_current.run_started_at;
  ELSE
    IF v_sequence<>0 THEN RAISE EXCEPTION 'a new compact run must start at sequence zero'; END IF;
    IF FOUND AND v_current.compact_state NOT IN ('paused','candidate','completed','failed','active')
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

CREATE OR REPLACE FUNCTION public.fn_gto_v31_ingest_source_artifact(
  p_dataset_id uuid,
  p_machine_id text,
  p_artifact jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_matrix jsonb := p_artifact->'strategy_matrix_v2';
  v_node jsonb;
  v_row_id uuid;
  v_solved_at timestamptz;
  v_checksum text;
  v_nodes integer;
  v_inserted integer;
  v_normalized_nodes jsonb := '[]'::jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
  IF p_machine_id NOT IN ('M1','M2') OR NOT (p_machine_id=ANY(v_dataset.machine_ids))
     OR p_artifact IS NULL OR jsonb_typeof(p_artifact)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_artifact))<>7
     OR NOT (p_artifact ?& ARRAY['id','scenario_hash','game_family','stack_depth','street','solved_at','strategy_matrix_v2'])
     OR EXISTS (
       SELECT 1 FROM unnest(ARRAY[
         'id','scenario_hash','game_family','street','solved_at'
       ]) field(key) WHERE jsonb_typeof(p_artifact->field.key)<>'string'
     )
     OR jsonb_typeof(p_artifact->'stack_depth')<>'number'
     OR jsonb_typeof(p_artifact->'strategy_matrix_v2')<>'object'
     OR p_artifact->>'id' !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR length(COALESCE(p_artifact->>'scenario_hash','')) NOT BETWEEN 8 AND 512
     OR COALESCE(p_artifact->>'scenario_hash','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR p_artifact->>'game_family' NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR NOT public.fn_gto_v31_json_safe_integer(p_artifact->'stack_depth',10,150)
     OR (p_artifact->>'stack_depth')::integer NOT IN (10,20,40,80,150)
     OR p_artifact->>'street' NOT IN ('flop','turn','river')
     OR jsonb_typeof(v_matrix)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_matrix))<>3
     OR NOT (v_matrix ?& ARRAY['schema','combo_order','nodes'])
     OR v_matrix->>'schema' IS DISTINCT FROM 'smarter-poker.pio-artifact.v31.1'
     OR v_matrix->>'combo_order' IS DISTINCT FROM
       'card=rank*4+suit; combo=b*(b-1)/2+a; 2c2d=0..AhAs=1325'
     OR jsonb_typeof(v_matrix->'nodes')<>'array'
     OR jsonb_array_length(v_matrix->'nodes') NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'source artifact envelope is invalid';
  END IF;
  v_row_id:=(p_artifact->>'id')::uuid;
  v_solved_at:=(p_artifact->>'solved_at')::timestamptz;
  IF v_solved_at IS NULL OR v_solved_at>now()+interval '5 minutes'
     OR v_solved_at<now()-interval '30 days' THEN
    RAISE EXCEPTION 'source artifact solved_at is outside the admission window';
  END IF;
  v_nodes:=jsonb_array_length(v_matrix->'nodes');
  FOR v_node IN SELECT value FROM jsonb_array_elements(v_matrix->'nodes') LOOP
    -- PostgreSQL owns the canonical node checksum. A worker may omit that one
    -- field, which avoids claiming that Python JSON number rendering is byte
    -- identical to PostgreSQL jsonb. A supplied checksum is still verified
    -- and can never be replaced silently.
    IF jsonb_typeof(v_node)='object'
       AND (SELECT count(*) FROM jsonb_object_keys(v_node))=11
       AND NOT (v_node?'node_checksum')
       AND (v_node ?& ARRAY['schema','node','node_context','line_proof','action_specs',
         'frequencies','policy_evs_bb','action_evs_bb','matchups',
         'source_combo_order_checksum','range_bundle_checksum']) THEN
      v_node:=v_node||jsonb_build_object(
        'node_checksum',public.fn_gto_v31_node_checksum(v_node)
      );
    END IF;
    IF NOT public.fn_gto_v31_source_node_valid(v_node)
       OR v_node#>>'{node_context,game_family}' IS DISTINCT FROM p_artifact->>'game_family'
       OR COALESCE((v_node#>>'{node_context,depth_bucket}')::integer,0)
            IS DISTINCT FROM (p_artifact->>'stack_depth')::integer
       OR v_node#>>'{node_context,street}' IS DISTINCT FROM p_artifact->>'street'
       OR v_node->>'source_combo_order_checksum' IS DISTINCT FROM v_dataset.source_combo_order_checksum
       OR v_node->>'range_bundle_checksum' IS DISTINCT FROM v_dataset.range_bundle_checksum
       OR v_node#>>'{line_proof,manifest_checksum}' IS DISTINCT FROM v_dataset.manifest_checksum THEN
      RAISE EXCEPTION 'source artifact contains an invalid or cross-dataset node';
    END IF;
    v_normalized_nodes:=v_normalized_nodes||jsonb_build_array(v_node);
  END LOOP;
  v_matrix:=jsonb_set(v_matrix,'{nodes}',v_normalized_nodes,false);
  IF (SELECT count(DISTINCT value->>'node') FROM jsonb_array_elements(v_matrix->'nodes'))<>v_nodes THEN
    RAISE EXCEPTION 'source artifact contains duplicate nodes';
  END IF;
  v_checksum:=public.fn_gto_v31_source_artifact_checksum(p_artifact->>'scenario_hash',v_matrix);

  INSERT INTO public.solved_spots_gold (
    id,scenario_hash,game_type,stack_depth,street,strategy_matrix_v2,solved_v2_at,
    solver_version,solver_binary_checksum,machine_id,pipeline_commit,pipeline_bundle_checksum,
    manifest_version,manifest_checksum,source_artifact_checksum,quality_status,audited_at
  ) VALUES (
    v_row_id,p_artifact->>'scenario_hash','gto_v31_'||(p_artifact->>'game_family'),
    (p_artifact->>'stack_depth')::integer,p_artifact->>'street',v_matrix,v_solved_at,
    v_dataset.solver_version,v_dataset.solver_binary_checksum,p_machine_id,
    v_dataset.pipeline_commit,v_dataset.pipeline_bundle_checksum,
    v_dataset.manifest_version,v_dataset.manifest_checksum,
    v_checksum,'validated',clock_timestamp()
  ) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted=0 AND NOT EXISTS (
    SELECT 1 FROM public.solved_spots_gold s
     WHERE s.id=v_row_id AND s.scenario_hash=p_artifact->>'scenario_hash'
       AND s.game_type='gto_v31_'||(p_artifact->>'game_family')
       AND s.stack_depth=(p_artifact->>'stack_depth')::integer
       AND s.street=p_artifact->>'street' AND s.strategy_matrix_v2=v_matrix
       AND s.solved_v2_at=v_solved_at
       AND s.solver_version=v_dataset.solver_version
       AND s.solver_binary_checksum=v_dataset.solver_binary_checksum
       AND s.machine_id=p_machine_id AND s.pipeline_commit=v_dataset.pipeline_commit
       AND s.pipeline_bundle_checksum=v_dataset.pipeline_bundle_checksum
       AND s.manifest_version::text=v_dataset.manifest_version
       AND s.manifest_checksum=v_dataset.manifest_checksum
       AND s.source_artifact_checksum=v_checksum AND s.quality_status='validated'
       AND s.audited_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'source artifact id was reused with another immutable payload';
  END IF;

  INSERT INTO public.gto_v31_source_artifacts (
    dataset_id,source_row_id,machine_id,scenario_hash,game_family,stack_depth,
    street,source_artifact_checksum,node_count,solved_at
  ) VALUES (
    p_dataset_id,v_row_id,p_machine_id,p_artifact->>'scenario_hash',p_artifact->>'game_family',
    (p_artifact->>'stack_depth')::integer,p_artifact->>'street',v_checksum,v_nodes,v_solved_at
  ) ON CONFLICT (dataset_id,source_row_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted=0 AND NOT EXISTS (
    SELECT 1 FROM public.gto_v31_source_artifacts a
     WHERE a.dataset_id=p_dataset_id AND a.source_row_id=v_row_id
       AND a.machine_id=p_machine_id AND a.scenario_hash=p_artifact->>'scenario_hash'
       AND a.game_family=p_artifact->>'game_family'
       AND a.stack_depth=(p_artifact->>'stack_depth')::integer
       AND a.street=p_artifact->>'street' AND a.source_artifact_checksum=v_checksum
       AND a.node_count=v_nodes AND a.solved_at=v_solved_at
  ) THEN
    RAISE EXCEPTION 'source artifact receipt id was reused with another payload';
  END IF;
  RETURN jsonb_build_object('source_row_id',v_row_id,'source_artifact_checksum',v_checksum,
    'node_count',v_nodes,'idempotent',v_inserted=0);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)
  TO service_role;

COMMIT;
