-- The signed V31 path must have one numeric meaning in Python, JavaScript and
-- PostgreSQL. PostgreSQL's numeric-to-integer cast rounds fractional values,
-- so a source node declaring table_size 2.4 or solver player 0.4 could pass a
-- type-only check and be compacted under an integer cell. Dataset declarations
-- also need exact JSON types and validated coverage/gate objects at rest.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_json_safe_integer(
  p_value jsonb,
  p_min numeric,
  p_max numeric
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_value numeric;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'number' THEN RETURN false; END IF;
  v_value := (p_value #>> '{}')::numeric;
  RETURN v_value = trunc(v_value) AND v_value BETWEEN p_min AND p_max;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_context_valid(p_context jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_table_size integer;
  v_role text;
  v_facing text;
  v_bucket text;
  v_allowed_positions text[];
  v_key text;
BEGIN
  IF p_context IS NULL OR jsonb_typeof(p_context) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_context)) <> 13
     OR NOT (p_context ?& ARRAY[
       'street','game_family','objective','utility_context','table_size','pot_type',
       'hero_position','opponent_position','depth_bucket','texture_class','node_role',
       'facing_kind','facing_size_bucket'
     ]) THEN
    RETURN false;
  END IF;
  FOREACH v_key IN ARRAY ARRAY[
    'street','game_family','objective','utility_context','pot_type','hero_position',
    'opponent_position','texture_class','node_role','facing_kind','facing_size_bucket'
  ] LOOP
    IF jsonb_typeof(p_context->v_key) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF NOT public.fn_gto_v31_json_safe_integer(p_context->'table_size',2,10)
     OR NOT public.fn_gto_v31_json_safe_integer(p_context->'depth_bucket',10,150)
     OR (p_context->>'depth_bucket')::integer NOT IN (10,20,40,80,150)
     OR p_context->>'street' NOT IN ('flop','turn','river')
     OR p_context->>'game_family' NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR p_context->>'objective' NOT IN ('cash_ev','chip_ev','icm')
     OR p_context->>'utility_context' NOT IN
       ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
     OR p_context->>'pot_type' NOT IN ('limped','srp','3bet','4bet_plus')
     OR p_context->>'texture_class' !~ '^[ABML][mtr][pu][cd]$'
     OR p_context->>'node_role' NOT IN
       ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise',
        'check_raise','bet_raise','all_in') THEN
    RETURN false;
  END IF;
  IF NOT (
       (p_context->>'game_family'='cash' AND p_context->>'objective'='cash_ev'
         AND p_context->>'utility_context'='cash_ev')
    OR (p_context->>'game_family'='spin' AND p_context->>'objective'='chip_ev'
         AND p_context->>'utility_context'='chip_ev')
    OR (p_context->>'game_family'='spin' AND p_context->>'objective'='icm'
         AND p_context->>'utility_context'='spin_ladder')
    OR (p_context->>'game_family'='tourney_ev' AND p_context->>'objective'='chip_ev'
         AND p_context->>'utility_context'='chip_ev')
    OR (p_context->>'game_family'='tourney_icm' AND p_context->>'objective'='icm'
         AND p_context->>'utility_context' IN
           ('satellite','bubble','final_table','in_money','ladder'))
  ) THEN
    RETURN false;
  END IF;

  v_table_size := (p_context->>'table_size')::integer;
  v_allowed_positions := CASE v_table_size
    WHEN 2 THEN ARRAY['SB','BB']
    WHEN 3 THEN ARRAY['SB','BB','BTN']
    WHEN 4 THEN ARRAY['SB','BB','CO','BTN']
    WHEN 5 THEN ARRAY['SB','BB','HJ','CO','BTN']
    WHEN 6 THEN ARRAY['SB','BB','UTG','HJ','CO','BTN']
    WHEN 7 THEN ARRAY['SB','BB','UTG','MP','HJ','CO','BTN']
    WHEN 8 THEN ARRAY['SB','BB','UTG','UTG1','MP','HJ','CO','BTN']
    WHEN 9 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','MP','HJ','CO','BTN']
    WHEN 10 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN']
  END;
  IF NOT (p_context->>'hero_position'=ANY(v_allowed_positions))
     OR NOT (p_context->>'opponent_position'=ANY(v_allowed_positions))
     OR p_context->>'hero_position'=p_context->>'opponent_position' THEN
    RETURN false;
  END IF;

  v_role := p_context->>'node_role';
  v_facing := p_context->>'facing_kind';
  v_bucket := p_context->>'facing_size_bucket';
  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    RETURN v_facing='none' AND v_bucket='none';
  ELSIF v_role='all_in' THEN
    RETURN v_facing='all_in' AND v_bucket='all_in';
  ELSIF v_role='facing_bet' THEN
    RETURN v_facing='bet' AND v_bucket IN ('small','mid','big');
  END IF;
  RETURN v_facing='raise' AND v_bucket IN ('small','mid','big');
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_quality_gates_valid(p_gates jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
BEGIN
  IF p_gates IS NULL OR jsonb_typeof(p_gates) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_gates)) <> 5
     OR NOT (p_gates ?& ARRAY[
       'max_frequency_mae','max_sizing_mae','max_policy_ev_mae_bb',
       'max_action_regret_bb','min_regret_coverage'
     ])
     OR EXISTS (
       SELECT 1 FROM jsonb_each(p_gates) gate
        WHERE jsonb_typeof(gate.value) <> 'number'
     ) THEN
    RETURN false;
  END IF;
  RETURN (p_gates->>'max_frequency_mae')::numeric BETWEEN 0 AND 0.15
     AND (p_gates->>'max_sizing_mae')::numeric BETWEEN 0 AND 0.25
     AND (p_gates->>'max_policy_ev_mae_bb')::numeric BETWEEN 0 AND 0.50
     AND (p_gates->>'max_action_regret_bb')::numeric BETWEEN 0 AND 0.25
     AND (p_gates->>'min_regret_coverage')::numeric BETWEEN 0.50 AND 1;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_declared_coverage_valid(p_coverage jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_context jsonb;
BEGIN
  IF p_coverage IS NULL OR jsonb_typeof(p_coverage) <> 'array'
     OR jsonb_array_length(p_coverage)=0 THEN
    RETURN false;
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_coverage)) <>
     (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_coverage)) THEN
    RETURN false;
  END IF;
  FOR v_context IN SELECT value FROM jsonb_array_elements(p_coverage) LOOP
    IF NOT public.fn_gto_v31_cell_context_valid(v_context) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_json_safe_integer(jsonb,numeric,numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_gto_v31_cell_context_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_gto_v31_quality_gates_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_gto_v31_declared_coverage_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_json_safe_integer(jsonb,numeric,numeric)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_cell_context_valid(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_quality_gates_valid(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_declared_coverage_valid(jsonb) TO service_role;

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

DO $existing_contracts$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_datasets d
     WHERE NOT public.fn_gto_v31_declared_coverage_valid(d.declared_coverage)
        OR NOT public.fn_gto_v31_quality_gates_valid(d.quality_gates)
  ) THEN
    RAISE EXCEPTION 'cannot enforce canonical V31 dataset declarations while invalid datasets exist';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.gto_v31_source_artifacts a
      JOIN public.solved_spots_gold s ON s.id=a.source_row_id
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
     WHERE NOT public.fn_gto_v31_source_node_valid(n.value)
  ) THEN
    RAISE EXCEPTION 'cannot enforce canonical V31 source integers while invalid artifacts exist';
  END IF;
END;
$existing_contracts$;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.gto_v31_datasets'::regclass
       AND conname='gto_v31_datasets_declared_coverage_valid_chk'
  ) THEN
    ALTER TABLE public.gto_v31_datasets
      ADD CONSTRAINT gto_v31_datasets_declared_coverage_valid_chk
      CHECK (public.fn_gto_v31_declared_coverage_valid(declared_coverage)) NOT VALID;
  END IF;
  ALTER TABLE public.gto_v31_datasets
    VALIDATE CONSTRAINT gto_v31_datasets_declared_coverage_valid_chk;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.gto_v31_datasets'::regclass
       AND conname='gto_v31_datasets_quality_gates_valid_chk'
  ) THEN
    ALTER TABLE public.gto_v31_datasets
      ADD CONSTRAINT gto_v31_datasets_quality_gates_valid_chk
      CHECK (public.fn_gto_v31_quality_gates_valid(quality_gates)) NOT VALID;
  END IF;
  ALTER TABLE public.gto_v31_datasets
    VALIDATE CONSTRAINT gto_v31_datasets_quality_gates_valid_chk;
END;
$constraints$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_register_dataset(p_dataset jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id uuid;
  v_machines text[];
  v_gates jsonb := p_dataset->'quality_gates';
  v_bundle public.gto_v31_input_bundles%ROWTYPE;
  v_key text;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_dataset IS NULL OR jsonb_typeof(p_dataset) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_dataset)) <> 15
     OR NOT (p_dataset ?& ARRAY[
       'dataset_key','solver_version','solver_binary_checksum','pipeline_commit',
       'pipeline_bundle_checksum','manifest_version','manifest_checksum',
       'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
       'input_bundle_id','input_bundle_checksum','machine_ids','declared_coverage','quality_gates'
     ])
     OR jsonb_typeof(p_dataset->'machine_ids') <> 'array'
     OR jsonb_array_length(p_dataset->'machine_ids') <> 2
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_dataset->'machine_ids') item(value)
        WHERE jsonb_typeof(item.value) <> 'string'
     )
     OR NOT public.fn_gto_v31_declared_coverage_valid(p_dataset->'declared_coverage')
     OR NOT public.fn_gto_v31_quality_gates_valid(v_gates) THEN
    RAISE EXCEPTION 'invalid certified dataset declaration';
  END IF;
  FOREACH v_key IN ARRAY ARRAY[
    'dataset_key','solver_version','solver_binary_checksum','pipeline_commit',
    'pipeline_bundle_checksum','manifest_version','manifest_checksum',
    'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
    'input_bundle_id','input_bundle_checksum'
  ] LOOP
    IF jsonb_typeof(p_dataset->v_key) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid certified dataset declaration';
    END IF;
  END LOOP;

  SELECT array_agg(value ORDER BY value) INTO v_machines
    FROM jsonb_array_elements_text(p_dataset->'machine_ids');
  IF COALESCE(p_dataset->>'dataset_key','') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR COALESCE(p_dataset->>'solver_version','') = ''
     OR COALESCE(p_dataset->>'solver_binary_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'solver_binary_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'pipeline_commit','') !~ '^[0-9a-f]{40}$'
     OR COALESCE(p_dataset->>'pipeline_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'pipeline_bundle_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'manifest_version','') = ''
     OR COALESCE(p_dataset->>'manifest_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'manifest_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'source_combo_order_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'source_combo_order_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'range_bundle_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'icm_model_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'icm_model_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'input_bundle_id','') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR COALESCE(p_dataset->>'input_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'input_bundle_checksum' = repeat('0',64)
     OR v_machines IS DISTINCT FROM ARRAY['M1','M2']::text[] THEN
    RAISE EXCEPTION 'invalid certified dataset declaration';
  END IF;

  SELECT * INTO v_bundle FROM public.gto_v31_input_bundles
   WHERE input_bundle_id=(p_dataset->>'input_bundle_id')::uuid
     AND approval_status='approved' FOR SHARE;
  IF NOT FOUND
     OR v_bundle.bundle_checksum IS DISTINCT FROM p_dataset->>'input_bundle_checksum'
     OR v_bundle.range_bundle_checksum IS DISTINCT FROM p_dataset->>'range_bundle_checksum'
     OR v_bundle.source_combo_order_checksum IS DISTINCT FROM p_dataset->>'source_combo_order_checksum'
     OR v_bundle.icm_model_checksum IS DISTINCT FROM p_dataset->>'icm_model_checksum' THEN
    RAISE EXCEPTION 'dataset inputs are not the currently approved bundle';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_bundle.bundle_manifest->'files') f(value)
     WHERE f.value->>'kind'='scenario_manifest'
       AND f.value->>'checksum'=p_dataset->>'manifest_checksum'
  ) THEN
    RAISE EXCEPTION 'dataset manifest is not in the approved input bundle';
  END IF;

  INSERT INTO public.gto_v31_datasets (
    dataset_key, solver_version, solver_binary_checksum, pipeline_commit,
    pipeline_bundle_checksum, manifest_version, manifest_checksum,
    source_combo_order_checksum, range_bundle_checksum, icm_model_checksum,
    input_bundle_id, input_bundle_checksum, machine_ids, declared_coverage, quality_gates
  ) VALUES (
    p_dataset->>'dataset_key', p_dataset->>'solver_version', p_dataset->>'solver_binary_checksum',
    p_dataset->>'pipeline_commit', p_dataset->>'pipeline_bundle_checksum',
    p_dataset->>'manifest_version', p_dataset->>'manifest_checksum',
    p_dataset->>'source_combo_order_checksum', p_dataset->>'range_bundle_checksum',
    p_dataset->>'icm_model_checksum', (p_dataset->>'input_bundle_id')::uuid,
    p_dataset->>'input_bundle_checksum', v_machines, p_dataset->'declared_coverage', v_gates
  ) RETURNING dataset_id INTO v_id;
  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_register_dataset(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_register_dataset(jsonb) TO service_role;

DO $contract_assertions$
DECLARE
  v_context jsonb := jsonb_build_object(
    'street','flop','game_family','cash','objective','cash_ev','utility_context','cash_ev',
    'table_size',2,'pot_type','limped','hero_position','SB','opponent_position','BB',
    'depth_bucket',80,'texture_class','Atpc','node_role','open','facing_kind','none',
    'facing_size_bucket','none'
  );
  v_gates jsonb := jsonb_build_object(
    'max_frequency_mae',0.10,'max_sizing_mae',0.10,'max_policy_ev_mae_bb',0.20,
    'max_action_regret_bb',0.10,'min_regret_coverage',0.80
  );
BEGIN
  IF NOT public.fn_gto_v31_cell_context_valid(v_context)
     OR NOT public.fn_gto_v31_declared_coverage_valid(jsonb_build_array(v_context))
     OR NOT public.fn_gto_v31_quality_gates_valid(v_gates)
     OR public.fn_gto_v31_cell_context_valid(
       jsonb_set(v_context,'{table_size}','2.4'::jsonb)
     )
     OR public.fn_gto_v31_declared_coverage_valid(
       jsonb_build_array(v_context,v_context)
     )
     OR public.fn_gto_v31_quality_gates_valid(
       jsonb_set(v_gates,'{max_frequency_mae}','"0.10"'::jsonb)
     )
     OR NOT public.fn_gto_v31_json_safe_integer('9007199254740991'::jsonb,0,9007199254740991)
     OR public.fn_gto_v31_json_safe_integer('9007199254740992'::jsonb,0,9007199254740991) THEN
    RAISE EXCEPTION 'V31 canonical dataset declaration helpers disagree with the contract';
  END IF;
END;
$contract_assertions$;

COMMIT;
