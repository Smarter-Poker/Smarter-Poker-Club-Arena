-- Reserved by scripts/new-migration.mjs. TIER 3: additive immutable version and RPC return-contract extension.
-- WHY: rank/suit-count keys conflate materially different board-relative made hands.
-- Preserve old key functions and omitted-version checksum bytes; bind every explicit version.
-- Compatibility: legacy consumers retain every previous RPC column; the nullable column is appended.
-- Rollback prerequisite: disable new version admission/promotion, prove no active versioned dataset.
-- Restore only affected function preimages from immutable migrations 20260908181657,
-- 20260908185700, 20260909024950, 20260909025949, 20260909063025, 20260909071759,
-- 20260909170749, 20260909171644, 20260909172537, 20260909180000 and installed
-- contextual-compaction postimage fc7eb5e3be9a52b6dc83db65900edc50.
-- RPC rollback must DROP only the two service-only RPC signatures, recreate their original
-- result definitions and restore postgres ownership/service_role grants in one transaction.
-- Preserve nullable version columns, immutable triggers and ALL source/cell/receipt rows.
-- Never rewrite versioned rows to NULL or replay whole historical migrations as rollback.
-- Qualification must run this exact transaction in isolated PostgreSQL 17 before installation.
-- EXECUTABLE ROLLBACK: copy the following commented block without its leading '-- '.
-- Run only after admission/promotion is stopped. It restores exact function-only
-- preimages, preserves versioned rows/columns, and never replays historical DDL.
-- BEGIN;
-- SET LOCAL lock_timeout = '2s';
-- SET LOCAL statement_timeout = '60s';
-- LOCK TABLE public.gto_v31_datasets IN SHARE ROW EXCLUSIVE MODE;
-- DO $rollback_guard$ BEGIN
--  IF EXISTS (SELECT 1 FROM public.gto_v31_datasets WHERE state = 'active' AND feature_contract_version IS NOT NULL) THEN RAISE EXCEPTION 'cannot rollback an active versioned dataset'; END IF;
-- END; $rollback_guard$;
-- DROP FUNCTION public.fn_gto_v31_active_cells(integer,integer);
-- DROP FUNCTION public.fn_gto_v31_evaluation_cells(uuid,integer,integer);
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_input_bundle_checksum(p_bundle jsonb)
-- RETURNS text
-- LANGUAGE plpgsql
-- IMMUTABLE
-- CALLED ON NULL INPUT
-- SET search_path = public, extensions
-- AS $fn$
-- DECLARE
--   v_file jsonb;
--   v_files jsonb;
--   v_identity jsonb;
-- BEGIN
--   IF p_bundle IS NULL
--      OR jsonb_typeof(p_bundle) <> 'object'
--      OR (SELECT count(*) FROM jsonb_object_keys(p_bundle)) <> 7
--      OR NOT (p_bundle ?& ARRAY['bundle_key','bundle_version','range_bundle_checksum',
--        'source_combo_order_checksum','icm_model_checksum','files','approval_note'])
--      OR jsonb_typeof(p_bundle->'bundle_key') IS DISTINCT FROM 'string'
--      OR jsonb_typeof(p_bundle->'bundle_version') IS DISTINCT FROM 'string'
--      OR jsonb_typeof(p_bundle->'range_bundle_checksum') IS DISTINCT FROM 'string'
--      OR jsonb_typeof(p_bundle->'source_combo_order_checksum') IS DISTINCT FROM 'string'
--      OR jsonb_typeof(p_bundle->'icm_model_checksum') IS DISTINCT FROM 'string'
--      OR jsonb_typeof(p_bundle->'approval_note') IS DISTINCT FROM 'string'
--      OR jsonb_typeof(p_bundle->'files') IS DISTINCT FROM 'array'
--      OR jsonb_array_length(p_bundle->'files') = 0
--      OR p_bundle->>'bundle_key' !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
--      OR p_bundle->>'bundle_version' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
--      OR p_bundle->>'range_bundle_checksum' !~ '^[0-9a-f]{64}$'
--      OR p_bundle->>'range_bundle_checksum' = repeat('0',64)
--      OR p_bundle->>'source_combo_order_checksum' !~ '^[0-9a-f]{64}$'
--      OR p_bundle->>'source_combo_order_checksum' = repeat('0',64)
--      OR p_bundle->>'icm_model_checksum' !~ '^[0-9a-f]{64}$'
--      OR p_bundle->>'icm_model_checksum' = repeat('0',64)
--      OR p_bundle->>'approval_note' !~ '[^[:space:]]'
--      OR length(p_bundle->>'approval_note') > 2000 THEN
--     RAISE EXCEPTION 'V31 input bundle identity requires canonical JSON strings';
--   END IF;
--
--   FOR v_file IN SELECT value FROM jsonb_array_elements(p_bundle->'files') LOOP
--     IF jsonb_typeof(v_file) <> 'object'
--        OR (SELECT count(*) FROM jsonb_object_keys(v_file)) <> 3
--        OR NOT (v_file ?& ARRAY['kind','path','checksum'])
--        OR jsonb_typeof(v_file->'kind') IS DISTINCT FROM 'string'
--        OR jsonb_typeof(v_file->'path') IS DISTINCT FROM 'string'
--        OR jsonb_typeof(v_file->'checksum') IS DISTINCT FROM 'string'
--        OR v_file->>'kind' NOT IN ('range','combo_order','icm_model','payout_model','scenario_manifest')
--        OR v_file->>'path' !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$'
--        OR position('..' IN v_file->>'path') > 0
--        OR ('/' || (v_file->>'path') || '/') LIKE '%//%'
--        OR ('/' || (v_file->>'path') || '/') LIKE '%/./%'
--        OR v_file->>'checksum' !~ '^[0-9a-f]{64}$'
--        OR v_file->>'checksum' = repeat('0',64) THEN
--       RAISE EXCEPTION 'V31 input bundle identity contains a noncanonical file receipt';
--     END IF;
--   END LOOP;
--
--   IF (SELECT count(DISTINCT value->>'path') FROM jsonb_array_elements(p_bundle->'files'))
--        <> jsonb_array_length(p_bundle->'files')
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='range') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='range'
--          AND f.value->>'checksum'=p_bundle->>'range_bundle_checksum') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='combo_order') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='combo_order'
--          AND f.value->>'checksum'=p_bundle->>'source_combo_order_checksum') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='icm_model') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='icm_model'
--          AND f.value->>'checksum'=p_bundle->>'icm_model_checksum') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='scenario_manifest') <> 1 THEN
--     RAISE EXCEPTION 'V31 input bundle identity does not reconcile its file receipts';
--   END IF;
--
--   SELECT jsonb_agg(
--            value
--            ORDER BY (value->>'kind') COLLATE "C",
--                     (value->>'path') COLLATE "C",
--                     (value->>'checksum') COLLATE "C"
--          )
--     INTO v_files
--     FROM jsonb_array_elements(p_bundle->'files') f(value)
--    WHERE value->>'kind' <> 'scenario_manifest';
--
--   v_identity := jsonb_build_object(
--     'contract','smarter-poker.horse-solver-v31-input-bundle.v2',
--     'bundle_key',p_bundle->'bundle_key',
--     'bundle_version',p_bundle->'bundle_version',
--     'range_bundle_checksum',p_bundle->'range_bundle_checksum',
--     'source_combo_order_checksum',p_bundle->'source_combo_order_checksum',
--     'icm_model_checksum',p_bundle->'icm_model_checksum',
--     'files',v_files
--   );
--
--   RETURN encode(digest(convert_to(
--     public.fn_training_canonical_jsonb_text_v1(v_identity),
--     'UTF8'
--   ),'sha256'),'hex');
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.ca_gto_v31_approve_input_bundle(p_bundle jsonb)
-- RETURNS uuid
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_id uuid;
--   v_checksum text;
--   v_actor uuid := auth.uid();
--   v_file jsonb;
--   v_inserted integer;
-- BEGIN
--   IF COALESCE(auth.role(),'') <> 'authenticated' OR v_actor IS NULL OR NOT public.fn_is_horse_admin() THEN
--     RAISE EXCEPTION 'admin approval required';
--   END IF;
--   IF p_bundle IS NULL OR jsonb_typeof(p_bundle) <> 'object'
--      OR (SELECT count(*) FROM jsonb_object_keys(p_bundle)) <> 7
--      OR NOT (p_bundle ?& ARRAY['bundle_key','bundle_version','range_bundle_checksum',
--        'source_combo_order_checksum','icm_model_checksum','files','approval_note'])
--      OR COALESCE(p_bundle->>'bundle_key','') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
--      OR COALESCE(p_bundle->>'bundle_version','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
--      OR COALESCE(p_bundle->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_bundle->>'range_bundle_checksum' = repeat('0',64)
--      OR COALESCE(p_bundle->>'source_combo_order_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_bundle->>'source_combo_order_checksum' = repeat('0',64)
--      OR COALESCE(p_bundle->>'icm_model_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_bundle->>'icm_model_checksum' = repeat('0',64)
--      OR jsonb_typeof(p_bundle->'files') <> 'array'
--      OR jsonb_array_length(p_bundle->'files') = 0
--      OR nullif(btrim(p_bundle->>'approval_note'),'') IS NULL
--      OR length(p_bundle->>'approval_note') > 2000 THEN
--     RAISE EXCEPTION 'approved input bundle is incomplete';
--   END IF;
--   FOR v_file IN SELECT value FROM jsonb_array_elements(p_bundle->'files') LOOP
--     IF jsonb_typeof(v_file) <> 'object'
--        OR (SELECT count(*) FROM jsonb_object_keys(v_file)) <> 3
--        OR NOT (v_file ?& ARRAY['kind','path','checksum'])
--        OR v_file->>'kind' NOT IN ('range','combo_order','icm_model','payout_model','scenario_manifest')
--        OR COALESCE(v_file->>'path','') !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$'
--        OR position('..' IN v_file->>'path') > 0
--        OR COALESCE(v_file->>'checksum','') !~ '^[0-9a-f]{64}$'
--        OR v_file->>'checksum' = repeat('0',64) THEN
--       RAISE EXCEPTION 'approved input bundle contains an invalid file receipt';
--     END IF;
--   END LOOP;
--   IF (SELECT count(DISTINCT value->>'path') FROM jsonb_array_elements(p_bundle->'files'))
--        <> jsonb_array_length(p_bundle->'files')
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='range' AND
--              f.value->>'checksum'=p_bundle->>'range_bundle_checksum') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='range') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='combo_order' AND
--              f.value->>'checksum'=p_bundle->>'source_combo_order_checksum') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='combo_order') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='icm_model' AND
--              f.value->>'checksum'=p_bundle->>'icm_model_checksum') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='icm_model') <> 1
--      OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
--        WHERE f.value->>'kind'='scenario_manifest') <> 1 THEN
--     RAISE EXCEPTION 'approved input bundle does not reconcile its files';
--   END IF;
--
--   v_checksum := public.fn_gto_v31_input_bundle_checksum(p_bundle);
--   v_id := public.fn_gto_v31_input_bundle_id(v_checksum);
--   INSERT INTO public.gto_v31_input_bundles (
--     input_bundle_id,bundle_key,bundle_checksum,range_bundle_checksum,
--     source_combo_order_checksum,icm_model_checksum,bundle_manifest,approved_by
--   ) VALUES (
--     v_id,p_bundle->>'bundle_key',v_checksum,p_bundle->>'range_bundle_checksum',
--     p_bundle->>'source_combo_order_checksum',p_bundle->>'icm_model_checksum',p_bundle,v_actor
--   ) ON CONFLICT (input_bundle_id) DO NOTHING;
--   GET DIAGNOSTICS v_inserted = ROW_COUNT;
--
--   IF v_inserted = 0 AND NOT EXISTS (
--     SELECT 1
--       FROM public.gto_v31_input_bundles b
--      WHERE b.input_bundle_id=v_id
--        AND b.bundle_key=p_bundle->>'bundle_key'
--        AND b.bundle_checksum=v_checksum
--        AND b.range_bundle_checksum=p_bundle->>'range_bundle_checksum'
--        AND b.source_combo_order_checksum=p_bundle->>'source_combo_order_checksum'
--        AND b.icm_model_checksum=p_bundle->>'icm_model_checksum'
--        AND b.bundle_manifest=p_bundle
--        AND b.approval_status='approved'
--   ) THEN
--     RAISE EXCEPTION 'V31 input bundle identity was reused with another approval payload';
--   END IF;
--   RETURN v_id;
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_register_dataset(p_dataset jsonb)
-- RETURNS uuid
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_id uuid;
--   v_machines text[];
--   v_gates jsonb := p_dataset->'quality_gates';
--   v_bundle public.gto_v31_input_bundles%ROWTYPE;
--   v_key text;
-- BEGIN
--   IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
--     RAISE EXCEPTION 'service_role required';
--   END IF;
--   IF p_dataset IS NULL OR jsonb_typeof(p_dataset) <> 'object'
--      OR (SELECT count(*) FROM jsonb_object_keys(p_dataset)) <> 15
--      OR NOT (p_dataset ?& ARRAY[
--        'dataset_key','solver_version','solver_binary_checksum','pipeline_commit',
--        'pipeline_bundle_checksum','manifest_version','manifest_checksum',
--        'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
--        'input_bundle_id','input_bundle_checksum','machine_ids','declared_coverage','quality_gates'
--      ])
--      OR jsonb_typeof(p_dataset->'machine_ids') <> 'array'
--      OR jsonb_array_length(p_dataset->'machine_ids') <> 2
--      OR EXISTS (
--        SELECT 1 FROM jsonb_array_elements(p_dataset->'machine_ids') item(value)
--         WHERE jsonb_typeof(item.value) <> 'string'
--      )
--      OR NOT public.fn_gto_v31_declared_coverage_valid(p_dataset->'declared_coverage')
--      OR NOT public.fn_gto_v31_quality_gates_valid(v_gates) THEN
--     RAISE EXCEPTION 'invalid certified dataset declaration';
--   END IF;
--   FOREACH v_key IN ARRAY ARRAY[
--     'dataset_key','solver_version','solver_binary_checksum','pipeline_commit',
--     'pipeline_bundle_checksum','manifest_version','manifest_checksum',
--     'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
--     'input_bundle_id','input_bundle_checksum'
--   ] LOOP
--     IF jsonb_typeof(p_dataset->v_key) IS DISTINCT FROM 'string' THEN
--       RAISE EXCEPTION 'invalid certified dataset declaration';
--     END IF;
--   END LOOP;
--
--   SELECT array_agg(value ORDER BY value) INTO v_machines
--     FROM jsonb_array_elements_text(p_dataset->'machine_ids');
--   IF COALESCE(p_dataset->>'dataset_key','') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
--      OR COALESCE(p_dataset->>'solver_version','') = ''
--      OR COALESCE(p_dataset->>'solver_binary_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_dataset->>'solver_binary_checksum' = repeat('0',64)
--      OR COALESCE(p_dataset->>'pipeline_commit','') !~ '^[0-9a-f]{40}$'
--      OR COALESCE(p_dataset->>'pipeline_bundle_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_dataset->>'pipeline_bundle_checksum' = repeat('0',64)
--      OR COALESCE(p_dataset->>'manifest_version','') = ''
--      OR COALESCE(p_dataset->>'manifest_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_dataset->>'manifest_checksum' = repeat('0',64)
--      OR COALESCE(p_dataset->>'source_combo_order_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_dataset->>'source_combo_order_checksum' = repeat('0',64)
--      OR COALESCE(p_dataset->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_dataset->>'range_bundle_checksum' = repeat('0',64)
--      OR COALESCE(p_dataset->>'icm_model_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_dataset->>'icm_model_checksum' = repeat('0',64)
--      OR COALESCE(p_dataset->>'input_bundle_id','') !~
--        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
--      OR COALESCE(p_dataset->>'input_bundle_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_dataset->>'input_bundle_checksum' = repeat('0',64)
--      OR v_machines IS DISTINCT FROM ARRAY['M1','M2']::text[] THEN
--     RAISE EXCEPTION 'invalid certified dataset declaration';
--   END IF;
--
--   SELECT * INTO v_bundle FROM public.gto_v31_input_bundles
--    WHERE input_bundle_id=(p_dataset->>'input_bundle_id')::uuid
--      AND approval_status='approved' FOR SHARE;
--   IF NOT FOUND
--      OR v_bundle.bundle_checksum IS DISTINCT FROM p_dataset->>'input_bundle_checksum'
--      OR v_bundle.range_bundle_checksum IS DISTINCT FROM p_dataset->>'range_bundle_checksum'
--      OR v_bundle.source_combo_order_checksum IS DISTINCT FROM p_dataset->>'source_combo_order_checksum'
--      OR v_bundle.icm_model_checksum IS DISTINCT FROM p_dataset->>'icm_model_checksum' THEN
--     RAISE EXCEPTION 'dataset inputs are not the currently approved bundle';
--   END IF;
--   IF NOT EXISTS (
--     SELECT 1 FROM jsonb_array_elements(v_bundle.bundle_manifest->'files') f(value)
--      WHERE f.value->>'kind'='scenario_manifest'
--        AND f.value->>'checksum'=p_dataset->>'manifest_checksum'
--   ) THEN
--     RAISE EXCEPTION 'dataset manifest is not in the approved input bundle';
--   END IF;
--
--   INSERT INTO public.gto_v31_datasets (
--     dataset_key, solver_version, solver_binary_checksum, pipeline_commit,
--     pipeline_bundle_checksum, manifest_version, manifest_checksum,
--     source_combo_order_checksum, range_bundle_checksum, icm_model_checksum,
--     input_bundle_id, input_bundle_checksum, machine_ids, declared_coverage, quality_gates
--   ) VALUES (
--     p_dataset->>'dataset_key', p_dataset->>'solver_version', p_dataset->>'solver_binary_checksum',
--     p_dataset->>'pipeline_commit', p_dataset->>'pipeline_bundle_checksum',
--     p_dataset->>'manifest_version', p_dataset->>'manifest_checksum',
--     p_dataset->>'source_combo_order_checksum', p_dataset->>'range_bundle_checksum',
--     p_dataset->>'icm_model_checksum', (p_dataset->>'input_bundle_id')::uuid,
--     p_dataset->>'input_bundle_checksum', v_machines, p_dataset->'declared_coverage', v_gates
--   ) RETURNING dataset_id INTO v_id;
--   RETURN v_id;
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_worker_contract(p_dataset_key text)
-- RETURNS jsonb
-- LANGUAGE plpgsql
-- STABLE
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_result jsonb;
-- BEGIN
--   IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
--     RAISE EXCEPTION 'service_role required';
--   END IF;
--   IF COALESCE(p_dataset_key,'') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$' THEN
--     RAISE EXCEPTION 'dataset key is invalid';
--   END IF;
--   SELECT jsonb_build_object(
--     'contract','smarter-poker.gto-v31-worker-contract.v1',
--     'dataset_id',d.dataset_id,'dataset_key',d.dataset_key,'state',d.state,
--     'quality_status',d.quality_status,'dataset_checksum',d.dataset_checksum,
--     'source_artifact_checksum',d.source_artifact_checksum,
--     'solver_version',d.solver_version,
--     'solver_binary_checksum',d.solver_binary_checksum,
--     'pipeline_commit',d.pipeline_commit,
--     'pipeline_bundle_checksum',d.pipeline_bundle_checksum,
--     'manifest_version',d.manifest_version,'manifest_checksum',d.manifest_checksum,
--     'source_combo_order_checksum',d.source_combo_order_checksum,
--     'range_bundle_checksum',d.range_bundle_checksum,
--     'icm_model_checksum',d.icm_model_checksum,
--     'input_bundle_checksum',d.input_bundle_checksum,
--     'input_approval_status',b.approval_status,
--     'machine_ids',d.machine_ids,'declared_cells',jsonb_array_length(d.declared_coverage)
--   ) INTO v_result
--     FROM public.gto_v31_datasets d
--     JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
--    WHERE d.dataset_key=p_dataset_key;
--   RETURN v_result;
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_key_checksum(p_cell jsonb)
-- RETURNS text
-- LANGUAGE sql
-- IMMUTABLE
-- STRICT
-- SET search_path = public
-- AS $fn$
--   SELECT public.fn_gto_v31_json_checksum(jsonb_build_object(
--     'street',p_cell->'street',
--     'game_family',p_cell->'game_family',
--     'objective',p_cell->'objective',
--     'utility_context',p_cell->'utility_context',
--     'table_size',p_cell->'table_size',
--     'pot_type',p_cell->'pot_type',
--     'hero_position',p_cell->'hero_position',
--     'opponent_position',p_cell->'opponent_position',
--     'depth_bucket',p_cell->'depth_bucket',
--     'texture_class',p_cell->'texture_class',
--     'node_role',p_cell->'node_role',
--     'facing_kind',p_cell->'facing_kind',
--     'facing_size_bucket',p_cell->'facing_size_bucket'
--   ));
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_matrix_valid(
--   p_matrix jsonb,
--   p_street text
-- ) RETURNS boolean
-- LANGUAGE plpgsql
-- IMMUTABLE
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_key text;
-- BEGIN
--   IF p_matrix IS NULL OR jsonb_typeof(p_matrix) <> 'object'
--      OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_matrix)) THEN
--     RETURN false;
--   END IF;
--   FOR v_key IN SELECT jsonb_object_keys(p_matrix) LOOP
--     IF NOT public.fn_gto_v31_hand_key_valid(v_key,p_street) THEN RETURN false; END IF;
--   END LOOP;
--   RETURN true;
-- EXCEPTION WHEN OTHERS THEN
--   RETURN false;
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_compact_matrices_valid(
--   p_matrix jsonb,
--   p_specs jsonb,
--   p_policy_evs jsonb,
--   p_action_evs jsonb,
--   p_street text
-- ) RETURNS boolean
-- LANGUAGE plpgsql
-- IMMUTABLE
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_hand record;
--   v_action text;
--   v_value numeric;
--   v_sum numeric;
--   v_action_count integer;
-- BEGIN
--   IF NOT public.fn_gto_v31_action_specs_valid(p_specs)
--      OR NOT public.fn_gto_v31_hand_matrix_valid(p_matrix,p_street)
--      OR jsonb_typeof(p_policy_evs) <> 'object'
--      OR jsonb_typeof(p_action_evs) <> 'object' THEN
--     RETURN false;
--   END IF;
--   v_action_count := (SELECT count(*) FROM jsonb_object_keys(p_specs));
--   IF (SELECT count(*) FROM jsonb_object_keys(p_policy_evs)) <>
--        (SELECT count(*) FROM jsonb_object_keys(p_matrix))
--      OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs)) <>
--        (SELECT count(*) FROM jsonb_object_keys(p_matrix)) THEN
--     RETURN false;
--   END IF;
--
--   FOR v_hand IN SELECT key,value FROM jsonb_each(p_matrix) LOOP
--     IF jsonb_typeof(v_hand.value) <> 'object'
--        OR (SELECT count(*) FROM jsonb_object_keys(v_hand.value)) <> v_action_count
--        OR EXISTS (
--          SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
--           WHERE NOT (v_hand.value ? a.key)
--        )
--        OR NOT (p_policy_evs ? v_hand.key)
--        OR jsonb_typeof(p_policy_evs->v_hand.key) <> 'number'
--        OR NOT (p_action_evs ? v_hand.key)
--        OR jsonb_typeof(p_action_evs->v_hand.key) <> 'object'
--        OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs->v_hand.key)) <> v_action_count
--        OR EXISTS (
--          SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
--           WHERE NOT ((p_action_evs->v_hand.key) ? a.key)
--        ) THEN
--       RETURN false;
--     END IF;
--     v_sum := 0;
--     FOR v_action IN SELECT jsonb_object_keys(p_specs) LOOP
--       IF jsonb_typeof(v_hand.value->v_action) <> 'number'
--          OR jsonb_typeof(p_action_evs->v_hand.key->v_action) <> 'number' THEN
--         RETURN false;
--       END IF;
--       v_value := (v_hand.value->>v_action)::numeric;
--       IF v_value < 0 OR v_value > 1 THEN RETURN false; END IF;
--       v_sum := v_sum + v_value;
--     END LOOP;
--     IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;
--   END LOOP;
--   RETURN true;
-- EXCEPTION WHEN OTHERS THEN
--   RETURN false;
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_payload_valid(p_cell jsonb)
-- RETURNS boolean
-- LANGUAGE plpgsql
-- IMMUTABLE
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_role text := p_cell->>'node_role';
--   v_facing text := p_cell->>'facing_kind';
--   v_bucket text := p_cell->>'facing_size_bucket';
--   v_action record;
--   v_hand record;
--   v_frequency record;
--   v_sum numeric;
--   v_family text;
--   v_unit text;
--   v_size numeric;
--   v_actions jsonb := p_cell->'action_specs';
--   v_matrix jsonb := p_cell->'hand_matrix';
--   v_policy_evs jsonb := COALESCE(p_cell->'policy_ev_matrix', '{}'::jsonb);
--   v_action_evs jsonb := COALESCE(p_cell->'action_ev_matrix', '{}'::jsonb);
--   v_has_check boolean := false;
--   v_has_fold boolean := false;
--   v_has_call boolean := false;
--   v_has_bet boolean := false;
--   v_has_raise boolean := false;
--   v_has_all_in boolean := false;
--   v_table_size integer := COALESCE((p_cell->>'table_size')::integer,0);
--   v_allowed_positions text[];
-- BEGIN
--   IF p_cell IS NULL OR jsonb_typeof(p_cell) <> 'object'
--      OR NOT public.fn_gto_v31_compact_matrices_valid(
--        v_matrix,v_actions,v_policy_evs,v_action_evs,p_cell->>'street'
--      )
--      OR jsonb_typeof(p_cell->'source_rows') IS DISTINCT FROM 'number'
--      OR jsonb_typeof(p_cell->'train_source_rows') IS DISTINCT FROM 'number'
--      OR jsonb_typeof(p_cell->'holdout_source_rows') IS DISTINCT FROM 'number'
--      OR (p_cell->>'source_rows')::integer IS DISTINCT FROM
--         (p_cell->>'train_source_rows')::integer + (p_cell->>'holdout_source_rows')::integer
--      OR COALESCE(p_cell->>'cell_key_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_cell->>'cell_key_checksum' = repeat('0',64)
--      OR p_cell->>'cell_key_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_key_checksum(p_cell)
--      OR COALESCE(p_cell->>'cell_payload_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_cell->>'cell_payload_checksum' = repeat('0',64)
--      OR p_cell->>'cell_payload_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_payload_checksum(p_cell)
--      OR COALESCE(p_cell->>'lineage_checksum','') !~ '^[0-9a-f]{64}$'
--      OR p_cell->>'lineage_checksum' = repeat('0',64)
--      OR COALESCE(p_cell->>'street','') NOT IN ('flop','turn','river')
--      OR COALESCE(p_cell->>'game_family','') NOT IN ('cash','spin','tourney_ev','tourney_icm')
--      OR COALESCE(p_cell->>'objective','') NOT IN ('cash_ev','chip_ev','icm')
--      OR COALESCE(p_cell->>'utility_context','') NOT IN ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
--      OR v_table_size NOT BETWEEN 2 AND 10
--      OR COALESCE(p_cell->>'pot_type','') NOT IN ('limped','srp','3bet','4bet_plus')
--      OR COALESCE(p_cell->>'hero_position','') NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
--      OR COALESCE(p_cell->>'opponent_position','') NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
--      OR p_cell->>'hero_position' = p_cell->>'opponent_position'
--      OR COALESCE((p_cell->>'depth_bucket')::integer,0) NOT IN (10,20,40,80,150)
--      OR COALESCE(p_cell->>'texture_class','') !~ '^[ABML][mtr][pu][cd]$'
--      OR COALESCE(v_role,'') NOT IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')
--      OR COALESCE(v_facing,'') NOT IN ('none','bet','raise','all_in')
--      OR COALESCE(v_bucket,'') NOT IN ('none','small','mid','big','all_in')
--      OR jsonb_typeof(v_actions) <> 'object'
--      OR (SELECT count(*) FROM jsonb_object_keys(v_actions)) < 2
--      OR jsonb_typeof(v_matrix) <> 'object'
--      OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_matrix))
--      OR jsonb_typeof(v_policy_evs) <> 'object'
--      OR jsonb_typeof(v_action_evs) <> 'object'
--      OR COALESCE((p_cell->>'source_rows')::integer,0) <= 0
--      OR COALESCE((p_cell->>'train_source_rows')::integer,0) <= 0
--      OR COALESCE((p_cell->>'holdout_source_rows')::integer,0) <= 0 THEN
--     RETURN false;
--   END IF;
--
--   IF NOT ((p_cell->>'game_family' = 'cash' AND p_cell->>'objective' = 'cash_ev') OR
--           (p_cell->>'game_family' = 'tourney_icm' AND p_cell->>'objective' = 'icm') OR
--           (p_cell->>'game_family' = 'tourney_ev' AND p_cell->>'objective' = 'chip_ev') OR
--           (p_cell->>'game_family' = 'spin' AND p_cell->>'objective' IN ('chip_ev','icm'))) THEN
--     RETURN false;
--   END IF;
--   IF NOT ((p_cell->>'objective' = 'cash_ev' AND p_cell->>'utility_context' = 'cash_ev') OR
--           (p_cell->>'objective' = 'chip_ev' AND p_cell->>'utility_context' = 'chip_ev') OR
--           (p_cell->>'objective' = 'icm' AND p_cell->>'game_family' = 'spin' AND
--            p_cell->>'utility_context' = 'spin_ladder') OR
--           (p_cell->>'objective' = 'icm' AND p_cell->>'game_family' = 'tourney_icm' AND
--            p_cell->>'utility_context' IN ('satellite','bubble','final_table','in_money','ladder'))) THEN
--     RETURN false;
--   END IF;
--
--   v_allowed_positions := CASE v_table_size
--     WHEN 2 THEN ARRAY['SB','BB']
--     WHEN 3 THEN ARRAY['SB','BB','BTN']
--     WHEN 4 THEN ARRAY['SB','BB','CO','BTN']
--     WHEN 5 THEN ARRAY['SB','BB','HJ','CO','BTN']
--     WHEN 6 THEN ARRAY['SB','BB','UTG','HJ','CO','BTN']
--     WHEN 7 THEN ARRAY['SB','BB','UTG','MP','HJ','CO','BTN']
--     WHEN 8 THEN ARRAY['SB','BB','UTG','UTG1','MP','HJ','CO','BTN']
--     WHEN 9 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','MP','HJ','CO','BTN']
--     WHEN 10 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN']
--   END;
--   IF NOT (p_cell->>'hero_position' = ANY(v_allowed_positions))
--      OR NOT (p_cell->>'opponent_position' = ANY(v_allowed_positions)) THEN
--     RETURN false;
--   END IF;
--
--   IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
--     IF v_facing <> 'none' OR v_bucket <> 'none' THEN RETURN false; END IF;
--   ELSIF v_role = 'all_in' THEN
--     IF v_facing <> 'all_in' OR v_bucket <> 'all_in' THEN RETURN false; END IF;
--   ELSIF (v_role = 'facing_bet' AND v_facing <> 'bet')
--      OR (v_role IN ('facing_raise','check_raise','bet_raise') AND v_facing <> 'raise')
--      OR v_bucket NOT IN ('small','mid','big') THEN
--     RETURN false;
--   END IF;
--
--   FOR v_action IN SELECT key, value FROM jsonb_each(v_actions) LOOP
--     IF v_action.key = '' OR jsonb_typeof(v_action.value) <> 'object' THEN RETURN false; END IF;
--     v_family := v_action.value->>'family';
--     v_unit := v_action.value->>'size_unit';
--     IF v_family NOT IN ('check','fold','call','bet','raise','all_in') THEN RETURN false; END IF;
--     IF v_family = 'check' THEN v_has_check := true; END IF;
--     IF v_family = 'fold' THEN v_has_fold := true; END IF;
--     IF v_family = 'call' THEN v_has_call := true; END IF;
--     IF v_family = 'bet' THEN v_has_bet := true; END IF;
--     IF v_family = 'raise' THEN v_has_raise := true; END IF;
--     IF v_family = 'all_in' THEN v_has_all_in := true; END IF;
--     IF v_family IN ('check','fold','call') THEN
--       IF v_unit IS DISTINCT FROM 'none'
--          OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
--          OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN RETURN false; END IF;
--     ELSIF v_family = 'all_in' THEN
--       IF v_unit IS DISTINCT FROM 'all_in'
--          OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
--          OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM true THEN RETURN false; END IF;
--     ELSE
--       BEGIN v_size := (v_action.value->>'size_value')::numeric; EXCEPTION WHEN OTHERS THEN RETURN false; END;
--       IF v_size <= 0 OR v_size > 20 OR COALESCE((v_action.value->>'all_in')::boolean,false)
--          OR (v_family = 'bet' AND v_unit <> 'pot_fraction')
--          OR (v_family = 'raise' AND v_unit <> 'pot_after_call_fraction') THEN RETURN false; END IF;
--     END IF;
--   END LOOP;
--
--   IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
--     IF NOT v_has_check OR v_has_fold OR v_has_call THEN RETURN false; END IF;
--   ELSE
--     IF NOT v_has_fold OR NOT v_has_call OR v_has_check OR v_has_bet THEN RETURN false; END IF;
--     IF v_role = 'all_in' AND (v_has_raise OR v_has_all_in) THEN RETURN false; END IF;
--   END IF;
--
--   FOR v_hand IN SELECT key, value FROM jsonb_each(v_matrix) LOOP
--     IF NOT public.fn_gto_v31_hand_key_valid(v_hand.key,p_cell->>'street')
--        OR jsonb_typeof(v_hand.value) <> 'object'
--        OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_hand.value)) THEN
--       RETURN false;
--     END IF;
--     v_sum := 0;
--     FOR v_frequency IN SELECT key, value FROM jsonb_each(v_hand.value) LOOP
--       IF NOT (v_actions ? v_frequency.key) OR jsonb_typeof(v_frequency.value) <> 'number' THEN RETURN false; END IF;
--       BEGIN v_size := (v_frequency.value #>> '{}')::numeric; EXCEPTION WHEN OTHERS THEN RETURN false; END;
--       IF v_size < 0 OR v_size > 1 THEN RETURN false; END IF;
--       v_sum := v_sum + v_size;
--     END LOOP;
--     IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;
--
--     IF NOT (v_policy_evs ? v_hand.key)
--        OR jsonb_typeof(v_policy_evs -> (v_hand.key)) <> 'number' THEN
--       RETURN false;
--     END IF;
--     IF NOT (v_action_evs ? v_hand.key)
--        OR jsonb_typeof(v_action_evs -> (v_hand.key)) <> 'object'
--        OR (SELECT count(*) FROM jsonb_object_keys(v_action_evs -> (v_hand.key))) <>
--           (SELECT count(*) FROM jsonb_object_keys(v_actions))
--        OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_actions) a(key)
--             WHERE NOT ((v_action_evs -> (v_hand.key)) ? a.key)) THEN
--       RETURN false;
--     END IF;
--     FOR v_frequency IN SELECT key, value FROM jsonb_each(v_action_evs -> (v_hand.key)) LOOP
--       IF NOT (v_actions ? v_frequency.key)
--          OR jsonb_typeof(v_frequency.value) <> 'number' THEN
--         RETURN false;
--       END IF;
--     END LOOP;
--   END LOOP;
--
--   IF EXISTS (
--        SELECT 1 FROM jsonb_object_keys(v_policy_evs) AS k(value) WHERE NOT (v_matrix ? k.value)
--      ) OR EXISTS (
--        SELECT 1 FROM jsonb_object_keys(v_action_evs) AS k(value) WHERE NOT (v_matrix ? k.value)
--      ) THEN
--     RETURN false;
--   END IF;
--   RETURN true;
-- EXCEPTION WHEN OTHERS THEN
--   RETURN false;
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_build_cell(
--   p_dataset_id uuid,
--   p_context jsonb
-- )
-- RETURNS text
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public, extensions
-- AS $fn$
-- DECLARE
--   v_dataset public.gto_v31_datasets%ROWTYPE;
--   v_source_nodes jsonb;
--   v_source_rows integer;
--   v_train_rows integer;
--   v_holdout_rows integer;
--   v_spec_variants integer;
--   v_machine_variants integer;
--   v_cross_split_board_overlaps integer;
--   v_specs jsonb;
--   v_hand_matrix jsonb;
--   v_policy_evs jsonb;
--   v_action_evs jsonb;
--   v_lineage text;
--   v_cell jsonb;
--   v_existing_checksum text;
-- BEGIN
--   IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
--     RAISE EXCEPTION 'service_role required';
--   END IF;
--   SELECT * INTO v_dataset FROM public.gto_v31_datasets
--    WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
--   IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
--   IF p_context IS NULL OR jsonb_typeof(p_context)<>'object'
--      OR (SELECT count(*) FROM jsonb_object_keys(p_context))<>13
--      OR NOT (p_context ?& ARRAY['street','game_family','objective','utility_context',
--        'table_size','pot_type','hero_position','opponent_position','depth_bucket',
--        'texture_class','node_role','facing_kind','facing_size_bucket']) THEN
--     RAISE EXCEPTION 'compact cell context is invalid';
--   END IF;
--   IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
--     WHERE d.value=p_context) THEN
--     RAISE EXCEPTION 'compact cell is not in declared coverage';
--   END IF;
--   SELECT c.cell_key_checksum INTO v_existing_checksum
--     FROM public.gto_v31_runtime_cells c
--    WHERE c.dataset_id=p_dataset_id
--      AND c.street=p_context->>'street'
--      AND c.game_family=p_context->>'game_family'
--      AND c.objective=p_context->>'objective'
--      AND c.utility_context=p_context->>'utility_context'
--      AND c.table_size=(p_context->>'table_size')::smallint
--      AND c.pot_type=p_context->>'pot_type'
--      AND c.hero_position=p_context->>'hero_position'
--      AND c.opponent_position=p_context->>'opponent_position'
--      AND c.depth_bucket=(p_context->>'depth_bucket')::integer
--      AND c.texture_class=p_context->>'texture_class'
--      AND c.node_role=p_context->>'node_role'
--      AND c.facing_kind=p_context->>'facing_kind'
--      AND c.facing_size_bucket=p_context->>'facing_size_bucket';
--   IF v_existing_checksum IS NOT NULL THEN RETURN v_existing_checksum; END IF;
--
--   WITH matching_nodes AS MATERIALIZED (
--     SELECT a.source_row_id,a.machine_id,a.source_artifact_checksum,s.scenario_hash,s.strategy_matrix_v2,n.value AS node,
--            CASE WHEN a.machine_id='M2' THEN 'holdout' ELSE 'train' END AS split
--       FROM public.gto_v31_source_artifacts a
--       JOIN public.solved_spots_gold s ON s.id=a.source_row_id
--        AND s.quality_status='validated' AND s.audited_at IS NOT NULL
--        AND s.source_artifact_checksum=a.source_artifact_checksum
--       CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
--      WHERE a.dataset_id=p_dataset_id
--        AND n.value#>>'{node_context,street}'=p_context->>'street'
--        AND n.value#>>'{node_context,game_family}'=p_context->>'game_family'
--        AND n.value#>>'{node_context,objective}'=p_context->>'objective'
--        AND n.value#>>'{node_context,utility_context}'=p_context->>'utility_context'
--        AND (n.value#>>'{node_context,table_size}')::integer=(p_context->>'table_size')::integer
--        AND n.value#>>'{node_context,pot_type}'=p_context->>'pot_type'
--        AND n.value#>>'{node_context,hero_position}'=p_context->>'hero_position'
--        AND n.value#>>'{node_context,opponent_position}'=p_context->>'opponent_position'
--        AND (n.value#>>'{node_context,depth_bucket}')::integer=(p_context->>'depth_bucket')::integer
--        AND n.value#>>'{node_context,texture_class}'=p_context->>'texture_class'
--        AND n.value#>>'{node_context,node_role}'=p_context->>'node_role'
--        AND n.value#>>'{node_context,facing_kind}'=p_context->>'facing_kind'
--        AND n.value#>>'{node_context,facing_size_bucket}'=p_context->>'facing_size_bucket'
--   ), matching_artifacts AS MATERIALIZED (
--     SELECT DISTINCT source_row_id,source_artifact_checksum,scenario_hash,strategy_matrix_v2
--       FROM matching_nodes
--   ), verified_artifacts AS MATERIALIZED (
--     SELECT source_row_id
--       FROM matching_artifacts
--      WHERE source_artifact_checksum=public.fn_gto_v31_source_artifact_checksum(scenario_hash,strategy_matrix_v2)
--   )
--   SELECT COALESCE(jsonb_agg(jsonb_build_object(
--            'source_row_id',m.source_row_id,'machine_id',m.machine_id,
--            'source_artifact_checksum',m.source_artifact_checksum,'node',m.node,'split',m.split
--          ) ORDER BY m.source_row_id,m.node->>'node'),'[]'::jsonb)
--     INTO v_source_nodes
--     FROM matching_nodes m JOIN verified_artifacts a USING (source_row_id);
--
--   WITH source_nodes AS MATERIALIZED (
--     SELECT * FROM jsonb_to_recordset(v_source_nodes) AS n(
--       source_row_id uuid,machine_id text,source_artifact_checksum text,node jsonb,split text
--     )
--   )
--   SELECT count(*),count(*) FILTER (WHERE split='train'),count(*) FILTER (WHERE split='holdout'),
--          count(DISTINCT node->'action_specs'),count(DISTINCT machine_id),
--          (SELECT count(*) FROM source_nodes train
--            JOIN source_nodes holdout
--              ON public.fn_gto_v31_board_rank_signature(holdout.node#>>'{node_context,board}')=
--                 public.fn_gto_v31_board_rank_signature(train.node#>>'{node_context,board}')
--           WHERE train.split='train' AND holdout.split='holdout'),
--          (array_agg(node->'action_specs'))[1],
--          encode(digest(string_agg(source_row_id::text||':'||(node->>'node')||':'||
--            (node->>'node_checksum'),'' ORDER BY source_row_id::text,node->>'node'),'sha256'),'hex')
--     INTO v_source_rows,v_train_rows,v_holdout_rows,v_spec_variants,v_machine_variants,
--          v_cross_split_board_overlaps,v_specs,v_lineage
--     FROM source_nodes;
--   IF v_source_rows<2 OR v_train_rows<1 OR v_holdout_rows<1 OR v_spec_variants<>1
--      OR v_machine_variants<>2 OR v_cross_split_board_overlaps<>0
--      OR v_specs IS NULL OR v_lineage IS NULL THEN
--     RAISE EXCEPTION 'cell needs M1 and M2, one action topology, and rank-disjoint train and holdout sources';
--   END IF;
--
--   WITH source_nodes AS MATERIALIZED (
--     SELECT * FROM jsonb_to_recordset(v_source_nodes) AS n(
--       source_row_id uuid,machine_id text,source_artifact_checksum text,node jsonb,split text
--     )
--   ), combo_observations AS MATERIALIZED (
--     SELECT public.fn_gto_v31_hand_key(i,n.node#>>'{node_context,board}') AS hand_key,
--            i,(n.node->'matchups'->>i)::numeric AS weight,
--            (n.node->'policy_evs_bb'->>i)::numeric AS policy_ev,n.node
--       FROM source_nodes n CROSS JOIN generate_series(0,1325) i
--      WHERE n.split='train' AND (n.node->'matchups'->>i)::numeric>0
--   ), action_observations AS MATERIALIZED (
--     SELECT o.hand_key,a.key AS action_id,o.weight,
--            (o.node->'frequencies'->a.key->>o.i)::numeric AS frequency,
--            (o.node->'action_evs_bb'->a.key->>o.i)::numeric AS action_ev
--       FROM combo_observations o CROSS JOIN LATERAL jsonb_each(v_specs) a
--   ), action_aggregate AS (
--     SELECT hand_key,action_id,
--            sum(frequency*weight)/sum(weight) AS frequency,
--            sum(action_ev*weight)/sum(weight) AS action_ev
--       FROM action_observations GROUP BY hand_key,action_id
--   ), per_hand AS (
--     SELECT hand_key,
--            jsonb_object_agg(action_id,to_jsonb(round(frequency,6)) ORDER BY action_id) AS mix,
--            jsonb_object_agg(action_id,to_jsonb(round(action_ev,6)) ORDER BY action_id) AS action_evs
--       FROM action_aggregate GROUP BY hand_key
--   ), policy_aggregate AS (
--     SELECT hand_key,sum(policy_ev*weight)/sum(weight) AS policy_ev
--       FROM combo_observations GROUP BY hand_key
--   )
--   SELECT jsonb_object_agg(h.hand_key,h.mix ORDER BY h.hand_key),
--          jsonb_object_agg(h.hand_key,to_jsonb(round(p.policy_ev,6)) ORDER BY h.hand_key),
--          jsonb_object_agg(h.hand_key,h.action_evs ORDER BY h.hand_key)
--     INTO v_hand_matrix,v_policy_evs,v_action_evs
--     FROM per_hand h JOIN policy_aggregate p USING (hand_key);
--   IF v_hand_matrix IS NULL OR v_policy_evs IS NULL OR v_action_evs IS NULL THEN
--     RAISE EXCEPTION 'cell has no live training combinations';
--   END IF;
--
--   v_cell:=p_context||jsonb_build_object(
--     'hand_matrix',v_hand_matrix,'action_specs',v_specs,
--     'policy_ev_matrix',v_policy_evs,'action_ev_matrix',v_action_evs,
--     'source_rows',v_source_rows,'train_source_rows',v_train_rows,
--     'holdout_source_rows',v_holdout_rows,'lineage_checksum',v_lineage
--   );
--   v_cell:=v_cell||jsonb_build_object('cell_key_checksum',public.fn_gto_v31_cell_key_checksum(v_cell));
--   v_cell:=v_cell||jsonb_build_object('cell_payload_checksum',public.fn_gto_v31_cell_payload_checksum(v_cell));
--   IF NOT public.fn_gto_v31_cell_payload_valid(v_cell) THEN
--     RAISE EXCEPTION 'database-computed compact cell failed its release validator';
--   END IF;
--
--   INSERT INTO public.gto_v31_runtime_cells (
--     dataset_id,cell_key_checksum,street,game_family,objective,utility_context,
--     table_size,pot_type,hero_position,opponent_position,depth_bucket,texture_class,
--     node_role,facing_kind,facing_size_bucket,hand_matrix,action_specs,
--     policy_ev_matrix,action_ev_matrix,source_rows,train_source_rows,
--     holdout_source_rows,cell_payload_checksum,lineage_checksum
--   ) VALUES (
--     p_dataset_id,v_cell->>'cell_key_checksum',v_cell->>'street',v_cell->>'game_family',
--     v_cell->>'objective',v_cell->>'utility_context',(v_cell->>'table_size')::smallint,
--     v_cell->>'pot_type',v_cell->>'hero_position',v_cell->>'opponent_position',
--     (v_cell->>'depth_bucket')::integer,v_cell->>'texture_class',v_cell->>'node_role',
--     v_cell->>'facing_kind',v_cell->>'facing_size_bucket',v_cell->'hand_matrix',
--     v_cell->'action_specs',v_cell->'policy_ev_matrix',v_cell->'action_ev_matrix',
--     (v_cell->>'source_rows')::integer,(v_cell->>'train_source_rows')::integer,
--     (v_cell->>'holdout_source_rows')::integer,v_cell->>'cell_payload_checksum',v_cell->>'lineage_checksum'
--   );
--
--   INSERT INTO public.gto_v31_cell_source_receipts (
--     dataset_id,cell_id,source_row_id,source_node,source_node_checksum,
--     source_artifact_checksum,machine_id,split
--   )
--   SELECT p_dataset_id,c.cell_id,n.source_row_id,n.node->>'node',n.node->>'node_checksum',
--          n.source_artifact_checksum,n.machine_id,n.split
--     FROM public.gto_v31_runtime_cells c
--     CROSS JOIN LATERAL jsonb_to_recordset(v_source_nodes) AS n(
--       source_row_id uuid,machine_id text,source_artifact_checksum text,node jsonb,split text
--     )
--    WHERE c.dataset_id=p_dataset_id AND c.cell_key_checksum=v_cell->>'cell_key_checksum';
--   IF NOT FOUND THEN RAISE EXCEPTION 'database-computed cell did not retain source receipts'; END IF;
--   RETURN v_cell->>'cell_key_checksum';
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_heldout_metrics(
--   p_dataset_id uuid,
--   p_game_family text DEFAULT NULL
-- )
-- RETURNS jsonb
-- LANGUAGE sql
-- STABLE
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
--   WITH holdout AS MATERIALIZED (
--     SELECT r.source_row_id,r.source_node,c.cell_id,c.game_family,
--            c.hand_matrix,c.action_specs,c.policy_ev_matrix,n.value AS node,i,
--            public.fn_gto_v31_hand_key(i,n.value#>>'{node_context,board}') AS hand_key,
--            (n.value->'matchups'->>i)::numeric AS weight
--       FROM public.gto_v31_cell_source_receipts r
--       JOIN public.gto_v31_runtime_cells c ON c.cell_id=r.cell_id
--       JOIN public.solved_spots_gold s ON s.id=r.source_row_id
--       CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
--       CROSS JOIN generate_series(0,1325) i
--      WHERE r.dataset_id=p_dataset_id AND r.split='holdout'
--        AND (p_game_family IS NULL OR c.game_family=p_game_family)
--        AND n.value->>'node'=r.source_node
--        AND n.value->>'node_checksum'=r.source_node_checksum
--        AND (n.value->'matchups'->>i)::numeric>0
--   ), action_observations AS MATERIALIZED (
--     SELECT h.*,a.key AS action_id,a.value->>'family' AS action_family,
--            CASE WHEN a.value->>'family' IN ('bet','raise')
--                 THEN (a.value->>'size_value')::numeric ELSE NULL END AS size_value,
--            (h.node->'frequencies'->a.key->>h.i)::numeric AS source_frequency,
--            (h.hand_matrix->h.hand_key->>a.key)::numeric AS compact_frequency,
--            (h.node->'action_evs_bb'->a.key->>h.i)::numeric AS source_action_ev
--       FROM holdout h CROSS JOIN LATERAL jsonb_each(h.action_specs) a
--   ), per_combo AS MATERIALIZED (
--     SELECT source_row_id,source_node,cell_id,game_family,i,hand_key,weight,
--            max((node->'policy_evs_bb'->>i)::numeric) AS source_policy_ev,
--            max((policy_ev_matrix->>hand_key)::numeric) AS compact_policy_ev,
--            sum(source_frequency*COALESCE(size_value,0))
--              FILTER (WHERE size_value IS NOT NULL) AS source_size,
--            sum(compact_frequency*COALESCE(size_value,0))
--              FILTER (WHERE size_value IS NOT NULL) AS compact_size,
--            bool_or(size_value IS NOT NULL) AS sizing_eligible,
--            max(source_action_ev) AS best_action_ev,
--            sum(compact_frequency*source_action_ev) AS compact_mixed_ev,
--            bool_and(compact_frequency IS NOT NULL AND source_action_ev IS NOT NULL)
--              AS regret_eligible
--       FROM action_observations
--      GROUP BY source_row_id,source_node,cell_id,game_family,i,hand_key,weight
--   )
--   SELECT jsonb_build_object(
--     'frequency_mae',(SELECT sum(abs(source_frequency-compact_frequency)*weight)/NULLIF(sum(weight),0)
--       FROM action_observations),
--     'sizing_mae',COALESCE((SELECT sum(abs(source_size-compact_size)*weight)/NULLIF(sum(weight),0)
--       FROM per_combo WHERE sizing_eligible),0),
--     'policy_ev_mae_bb',(SELECT sum(abs(source_policy_ev-compact_policy_ev)*weight)/NULLIF(sum(weight),0)
--       FROM per_combo),
--     'mean_action_regret_bb',(SELECT sum(greatest(0,best_action_ev-compact_mixed_ev)*weight)/NULLIF(sum(weight),0)
--       FROM per_combo WHERE regret_eligible),
--     'regret_coverage',(SELECT count(*)::numeric/NULLIF((SELECT count(*) FROM per_combo),0)
--       FROM per_combo WHERE regret_eligible),
--     'holdout_source_rows',(SELECT count(DISTINCT source_row_id) FROM holdout),
--     'frequency_observations',(SELECT count(*) FROM action_observations),
--     'sizing_observations',(SELECT count(*) FROM per_combo WHERE sizing_eligible),
--     'policy_ev_observations',(SELECT count(*) FROM per_combo),
--     'regret_observations',(SELECT count(*) FROM per_combo WHERE regret_eligible),
--     'live_combo_observations',(SELECT count(*) FROM per_combo),
--     'missing_observations',(SELECT count(*) FROM holdout WHERE hand_matrix->hand_key IS NULL
--       OR policy_ev_matrix->hand_key IS NULL)
--   );
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_seal_build(p_dataset_id uuid)
-- RETURNS text
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public, extensions
-- AS $fn$
-- DECLARE
--   v_dataset public.gto_v31_datasets%ROWTYPE;
--   v_cells bigint;
--   v_source bigint;
--   v_train bigint;
--   v_holdout bigint;
--   v_source_nodes bigint;
--   v_receipts bigint;
--   v_checksum text;
--   v_source_checksum text;
--   v_coverage jsonb;
--   v_metrics jsonb;
--   v_metric_checksum text;
--   v_frequency_mae numeric;
--   v_sizing_mae numeric;
--   v_policy_mae numeric;
--   v_regret numeric;
--   v_regret_coverage numeric;
--   v_frequency_observations bigint;
--   v_sizing_observations bigint;
--   v_policy_observations bigint;
--   v_regret_observations bigint;
--   v_live_observations bigint;
--   v_missing bigint;
--   v_pass boolean;
--   v_family text;
--   v_family_metrics jsonb;
--   v_by_family jsonb := '{}'::jsonb;
-- BEGIN
--   IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
--     RAISE EXCEPTION 'service_role required';
--   END IF;
--   SELECT * INTO v_dataset FROM public.gto_v31_datasets
--    WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
--   IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
--   IF NOT EXISTS (
--     SELECT 1 FROM public.gto_v31_input_bundles b
--      WHERE b.input_bundle_id=v_dataset.input_bundle_id
--        AND b.approval_status='approved' AND b.bundle_checksum=v_dataset.input_bundle_checksum
--        AND b.range_bundle_checksum=v_dataset.range_bundle_checksum
--        AND b.source_combo_order_checksum=v_dataset.source_combo_order_checksum
--        AND b.icm_model_checksum=v_dataset.icm_model_checksum
--   ) THEN RAISE EXCEPTION 'dataset input approval is absent or revoked'; END IF;
--
--   SELECT count(*),COALESCE(sum(source_rows),0),COALESCE(sum(train_source_rows),0),
--          COALESCE(sum(holdout_source_rows),0)
--     INTO v_cells,v_source,v_train,v_holdout
--     FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
--   IF v_cells=0 OR jsonb_array_length(v_dataset.declared_coverage)<>v_cells
--      OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(v_dataset.declared_coverage))<>v_cells
--      OR EXISTS (
--        SELECT 1 FROM public.gto_v31_runtime_cells c
--         WHERE c.dataset_id=p_dataset_id AND NOT EXISTS (
--           SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
--            WHERE d.value=jsonb_build_object(
--              'street',c.street,'game_family',c.game_family,'objective',c.objective,
--              'utility_context',c.utility_context,'table_size',c.table_size,
--              'pot_type',c.pot_type,'hero_position',c.hero_position,
--              'opponent_position',c.opponent_position,'depth_bucket',c.depth_bucket,
--              'texture_class',c.texture_class,'node_role',c.node_role,
--              'facing_kind',c.facing_kind,'facing_size_bucket',c.facing_size_bucket)))
--      OR EXISTS (
--        SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
--         WHERE NOT EXISTS (
--           SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id
--            AND d.value=jsonb_build_object(
--              'street',c.street,'game_family',c.game_family,'objective',c.objective,
--              'utility_context',c.utility_context,'table_size',c.table_size,
--              'pot_type',c.pot_type,'hero_position',c.hero_position,
--              'opponent_position',c.opponent_position,'depth_bucket',c.depth_bucket,
--              'texture_class',c.texture_class,'node_role',c.node_role,
--              'facing_kind',c.facing_kind,'facing_size_bucket',c.facing_size_bucket))) THEN
--     RAISE EXCEPTION 'runtime cells do not exactly equal declared coverage';
--   END IF;
--   IF NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='flop')
--      OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='turn')
--      OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='river')
--      OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='cash' AND objective='cash_ev')
--      OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='spin' AND objective='chip_ev')
--      OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='spin' AND objective='icm')
--      OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='tourney_ev' AND objective='chip_ev')
--      OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='tourney_icm' AND objective='icm')
--      OR EXISTS (
--        SELECT 1
--          FROM (VALUES ('cash','cash_ev'),('spin','chip_ev'),('spin','icm'),
--                       ('tourney_ev','chip_ev'),('tourney_icm','icm'))
--               required_family(game_family,objective)
--          CROSS JOIN unnest(ARRAY['flop','turn','river']) required_street(street)
--         WHERE NOT EXISTS (
--           SELECT 1 FROM public.gto_v31_runtime_cells c
--            WHERE c.dataset_id=p_dataset_id
--              AND c.game_family=required_family.game_family
--              AND c.objective=required_family.objective
--              AND c.street=required_street.street))
--      OR EXISTS (SELECT 1 FROM unnest(ARRAY['limped','srp','3bet','4bet_plus']) required(value)
--        WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.pot_type=required.value))
--      OR EXISTS (SELECT 1 FROM unnest(ARRAY['cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder']) required(value)
--        WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.utility_context=required.value))
--      OR EXISTS (SELECT 1 FROM generate_series(2,10) required(value)
--        WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.table_size=required.value))
--      OR EXISTS (SELECT 1 FROM unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in']) required(value)
--        WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.node_role=required.value)) THEN
--     RAISE EXCEPTION 'required Phase 4 street, family, utility, table, pot, or response coverage is incomplete';
--   END IF;
--   IF EXISTS (
--     SELECT 1 FROM public.gto_v31_runtime_cells c
--      WHERE c.dataset_id=p_dataset_id
--        AND (c.cell_key_checksum<>public.fn_gto_v31_cell_key_checksum(to_jsonb(c))
--          OR c.cell_payload_checksum<>public.fn_gto_v31_cell_payload_checksum(to_jsonb(c))
--          OR c.source_rows<>c.train_source_rows+c.holdout_source_rows
--          OR NOT public.fn_gto_v31_cell_payload_valid(to_jsonb(c)))
--   ) THEN RAISE EXCEPTION 'a compact cell seal or payload no longer validates'; END IF;
--   IF EXISTS (
--     SELECT 1 FROM public.gto_v31_runtime_cells c
--     LEFT JOIN LATERAL (
--       SELECT count(*) n,count(*) FILTER (WHERE r.split='train') train_n,
--              count(*) FILTER (WHERE r.split='holdout') holdout_n,
--              encode(digest(string_agg(r.source_row_id::text||':'||r.source_node||':'||
--                r.source_node_checksum,'' ORDER BY r.source_row_id::text,r.source_node),'sha256'),'hex') lineage
--         FROM public.gto_v31_cell_source_receipts r WHERE r.cell_id=c.cell_id
--     ) x ON true
--      WHERE c.dataset_id=p_dataset_id AND
--        (x.n<>c.source_rows OR x.train_n<>c.train_source_rows OR x.holdout_n<>c.holdout_source_rows
--         OR x.lineage IS DISTINCT FROM c.lineage_checksum)
--   ) THEN RAISE EXCEPTION 'cell source receipts do not reconcile'; END IF;
--   SELECT COALESCE(sum(node_count),0) INTO v_source_nodes
--     FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
--   SELECT count(*) INTO v_receipts FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id;
--   IF v_source_nodes<>v_receipts OR v_source<>v_receipts
--      OR EXISTS (
--        SELECT 1 FROM public.gto_v31_source_artifacts a
--        LEFT JOIN public.solved_spots_gold s ON s.id=a.source_row_id
--         WHERE a.dataset_id=p_dataset_id AND (s.id IS NULL OR s.quality_status<>'validated'
--           OR s.audited_at IS NULL OR s.source_artifact_checksum<>a.source_artifact_checksum
--           OR s.source_artifact_checksum<>public.fn_gto_v31_source_artifact_checksum(s.scenario_hash,s.strategy_matrix_v2)
--           OR s.solver_version<>v_dataset.solver_version
--           OR s.solver_binary_checksum<>v_dataset.solver_binary_checksum
--           OR s.machine_id<>a.machine_id OR s.pipeline_commit<>v_dataset.pipeline_commit
--           OR s.pipeline_bundle_checksum<>v_dataset.pipeline_bundle_checksum
--           OR s.manifest_version::text<>v_dataset.manifest_version
--           OR s.manifest_checksum<>v_dataset.manifest_checksum)) THEN
--     RAISE EXCEPTION 'source artifacts are missing, omitted, quarantined, or changed';
--   END IF;
--   IF NOT EXISTS (SELECT 1 FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id AND machine_id='M1')
--      OR NOT EXISTS (SELECT 1 FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id AND machine_id='M2') THEN
--     RAISE EXCEPTION 'dataset provenance does not include both solver hosts';
--   END IF;
--
--   v_metrics:=public.fn_gto_v31_heldout_metrics(p_dataset_id,NULL);
--   v_frequency_mae:=(v_metrics->>'frequency_mae')::numeric;
--   v_sizing_mae:=(v_metrics->>'sizing_mae')::numeric;
--   v_policy_mae:=(v_metrics->>'policy_ev_mae_bb')::numeric;
--   v_regret:=(v_metrics->>'mean_action_regret_bb')::numeric;
--   v_regret_coverage:=(v_metrics->>'regret_coverage')::numeric;
--   v_frequency_observations:=COALESCE((v_metrics->>'frequency_observations')::bigint,0);
--   v_sizing_observations:=COALESCE((v_metrics->>'sizing_observations')::bigint,0);
--   v_policy_observations:=COALESCE((v_metrics->>'policy_ev_observations')::bigint,0);
--   v_regret_observations:=COALESCE((v_metrics->>'regret_observations')::bigint,0);
--   v_live_observations:=COALESCE((v_metrics->>'live_combo_observations')::bigint,0);
--   v_missing:=COALESCE((v_metrics->>'missing_observations')::bigint,0);
--   IF v_missing<>0 OR v_frequency_observations=0 OR v_sizing_observations=0
--      OR v_policy_observations=0
--      OR v_regret_observations=0 OR v_live_observations=0
--      OR v_frequency_mae IS NULL OR v_sizing_mae IS NULL OR v_policy_mae IS NULL
--      OR v_regret IS NULL OR v_regret_coverage IS NULL THEN
--     RAISE EXCEPTION 'heldout observations are incomplete or absent';
--   END IF;
--   v_pass:=v_frequency_mae<=(v_dataset.quality_gates->>'max_frequency_mae')::numeric
--     AND v_sizing_mae<=(v_dataset.quality_gates->>'max_sizing_mae')::numeric
--     AND v_policy_mae<=(v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
--     AND v_regret<=(v_dataset.quality_gates->>'max_action_regret_bb')::numeric
--     AND v_regret_coverage>=(v_dataset.quality_gates->>'min_regret_coverage')::numeric;
--
--   FOREACH v_family IN ARRAY ARRAY['cash','spin','tourney_ev','tourney_icm'] LOOP
--     v_family_metrics:=public.fn_gto_v31_heldout_metrics(p_dataset_id,v_family);
--     IF COALESCE((v_family_metrics->>'frequency_observations')::bigint,0)=0
--        OR COALESCE((v_family_metrics->>'sizing_observations')::bigint,0)=0
--        OR COALESCE((v_family_metrics->>'policy_ev_observations')::bigint,0)=0
--        OR COALESCE((v_family_metrics->>'regret_observations')::bigint,0)=0
--        OR COALESCE((v_family_metrics->>'missing_observations')::bigint,0)<>0 THEN
--       RAISE EXCEPTION 'heldout observations are incomplete for family %',v_family;
--     END IF;
--     v_family_metrics:=v_family_metrics||jsonb_build_object('validated',
--       (v_family_metrics->>'frequency_mae')::numeric<=(v_dataset.quality_gates->>'max_frequency_mae')::numeric
--       AND (v_family_metrics->>'sizing_mae')::numeric<=(v_dataset.quality_gates->>'max_sizing_mae')::numeric
--       AND (v_family_metrics->>'policy_ev_mae_bb')::numeric<=(v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
--       AND (v_family_metrics->>'mean_action_regret_bb')::numeric<=(v_dataset.quality_gates->>'max_action_regret_bb')::numeric
--       AND (v_family_metrics->>'regret_coverage')::numeric>=(v_dataset.quality_gates->>'min_regret_coverage')::numeric);
--     v_pass:=v_pass AND (v_family_metrics->>'validated')::boolean;
--     v_by_family:=v_by_family||jsonb_build_object(v_family,v_family_metrics);
--   END LOOP;
--
--   v_metrics:=v_metrics||jsonb_build_object('validated',v_pass,'by_family',v_by_family);
--   v_metric_checksum:=public.fn_gto_v31_json_checksum(v_metrics);
--   v_metrics:=v_metrics||jsonb_build_object('metrics_checksum',v_metric_checksum);
--
--   SELECT jsonb_build_object('cells',count(*),'streets',jsonb_agg(DISTINCT street),
--     'families',jsonb_agg(DISTINCT game_family||':'||objective),
--     'utility_contexts',jsonb_agg(DISTINCT utility_context),
--     'table_sizes',jsonb_agg(DISTINCT table_size),'pot_types',jsonb_agg(DISTINCT pot_type),
--     'node_roles',jsonb_agg(DISTINCT node_role),'complete',true)
--     INTO v_coverage FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
--   SELECT encode(digest(string_agg(DISTINCT source_artifact_checksum,'' ORDER BY source_artifact_checksum),'sha256'),'hex')
--     INTO v_source_checksum FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
--   SELECT encode(digest(v_dataset.dataset_key||':'||v_dataset.pipeline_bundle_checksum||':'||
--     v_dataset.manifest_checksum||':'||
--     v_dataset.input_bundle_checksum||':'||string_agg(cell_key_checksum||':'||
--       cell_payload_checksum||':'||lineage_checksum,'' ORDER BY cell_key_checksum),'sha256'),'hex')
--     INTO v_checksum FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
--
--   UPDATE public.gto_v31_datasets SET
--     state=CASE WHEN v_pass THEN 'evaluating' ELSE 'rejected' END,
--     quality_status=CASE WHEN v_pass THEN 'validated' ELSE 'rejected' END,
--     source_rows=v_source,train_source_rows=v_train,holdout_source_rows=v_holdout,
--     invalid_rows=0,source_artifact_checksum=v_source_checksum,dataset_checksum=v_checksum,
--     coverage=v_coverage,heldout_metrics=v_metrics,sealed_at=now(),audited_at=now()
--    WHERE dataset_id=p_dataset_id;
--   INSERT INTO public.gto_v31_release_evaluations (
--     dataset_id,dataset_checksum,evaluation_kind,game_family,verdict,metrics,result_checksum
--   ) VALUES (
--     p_dataset_id,v_checksum,'heldout','all',CASE WHEN v_pass THEN 'pass' ELSE 'fail' END,
--     v_metrics,public.fn_gto_v31_json_checksum(jsonb_build_object(
--       'dataset_checksum',v_checksum,'kind','heldout','family','all','metrics',v_metrics))
--   );
--   RETURN v_checksum;
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_promote_dataset(p_dataset_id uuid)
-- RETURNS text
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_dataset public.gto_v31_datasets%ROWTYPE;
--   v_expected_checksum text;
--   v_expected_source_checksum text;
--   v_paired jsonb;
--   v_league jsonb;
-- BEGIN
--   IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
--     RAISE EXCEPTION 'service_role required';
--   END IF;
--   SELECT * INTO v_dataset FROM public.gto_v31_datasets
--    WHERE dataset_id=p_dataset_id AND state='candidate' FOR UPDATE;
--   IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not a candidate'; END IF;
--   SELECT encode(digest(v_dataset.dataset_key||':'||v_dataset.pipeline_bundle_checksum||':'||
--     v_dataset.manifest_checksum||':'||
--     v_dataset.input_bundle_checksum||':'||string_agg(cell_key_checksum||':'||
--       cell_payload_checksum||':'||lineage_checksum,'' ORDER BY cell_key_checksum),'sha256'),'hex')
--     INTO v_expected_checksum FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
--   SELECT encode(digest(string_agg(DISTINCT source_artifact_checksum,'' ORDER BY source_artifact_checksum),'sha256'),'hex')
--     INTO v_expected_source_checksum FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
--   SELECT jsonb_build_object('verdict','pass',
--       'evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
--     INTO v_paired FROM public.gto_v31_release_evaluations e
--    WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
--      AND e.evaluation_kind='paired_replay' AND e.verdict IN ('win','tie');
--   SELECT jsonb_build_object('verdict','pass',
--       'evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
--     INTO v_league FROM public.gto_v31_release_evaluations e
--    WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
--      AND e.evaluation_kind='league' AND e.verdict IN ('win','tie');
--   IF v_dataset.quality_status <> 'validated' OR v_dataset.invalid_rows <> 0
--      OR v_dataset.dataset_checksum IS NULL OR v_dataset.source_artifact_checksum IS NULL
--      OR v_dataset.dataset_checksum IS DISTINCT FROM v_expected_checksum
--      OR v_dataset.source_artifact_checksum IS DISTINCT FROM v_expected_source_checksum
--      OR COALESCE((v_dataset.coverage->>'complete')::boolean,false) IS NOT true
--      OR COALESCE((v_dataset.heldout_metrics->>'frequency_mae')::numeric,99) > (v_dataset.quality_gates->>'max_frequency_mae')::numeric
--      OR COALESCE((v_dataset.heldout_metrics->>'sizing_mae')::numeric,99) > (v_dataset.quality_gates->>'max_sizing_mae')::numeric
--      OR COALESCE((v_dataset.heldout_metrics->>'sizing_observations')::bigint,0)<=0
--      OR EXISTS (SELECT 1 FROM unnest(ARRAY['cash','spin','tourney_ev','tourney_icm']) family(value)
--        WHERE COALESCE((v_dataset.heldout_metrics#>>ARRAY['by_family',family.value,'sizing_observations'])::bigint,0)<=0)
--      OR COALESCE((v_dataset.heldout_metrics->>'policy_ev_mae_bb')::numeric,99) > (v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
--      OR COALESCE((v_dataset.heldout_metrics->>'mean_action_regret_bb')::numeric,99) > (v_dataset.quality_gates->>'max_action_regret_bb')::numeric
--      OR COALESCE((v_dataset.heldout_metrics->>'regret_coverage')::numeric,-1) < (v_dataset.quality_gates->>'min_regret_coverage')::numeric
--      OR v_dataset.paired_replay IS DISTINCT FROM v_paired
--      OR v_dataset.league_gate IS DISTINCT FROM v_league
--      OR NOT EXISTS (SELECT 1 FROM public.gto_v31_input_bundles b
--        WHERE b.input_bundle_id=v_dataset.input_bundle_id AND b.approval_status='approved'
--          AND b.bundle_checksum=v_dataset.input_bundle_checksum)
--      OR NOT public.fn_gto_v31_candidate_evaluations_valid(
--        p_dataset_id,v_dataset.dataset_checksum)
--      OR EXISTS (
--        SELECT 1
--          FROM unnest(ARRAY['paired_replay','league']) required_kind(value)
--          CROSS JOIN unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel',
--            'facing_bet','facing_raise','check_raise','bet_raise','all_in']) required_role(value)
--         WHERE NOT EXISTS (
--           SELECT 1 FROM public.gto_v31_release_evaluations e
--           CROSS JOIN LATERAL jsonb_array_elements_text(e.metrics->'candidate_node_roles') seen(value)
--            WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
--              AND e.evaluation_kind=required_kind.value AND e.verdict IN ('win','tie')
--              AND seen.value=required_role.value))
--      OR (SELECT count(*) FROM public.gto_v31_release_evaluations e
--        WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
--          AND ((e.evaluation_kind='heldout' AND e.game_family='all' AND e.verdict='pass')
--            OR (e.evaluation_kind IN ('paired_replay','league') AND e.game_family IN
--              ('cash','spin','tourney_ev','tourney_icm') AND e.verdict IN ('win','tie'))))<>9 THEN
--     RAISE EXCEPTION 'candidate does not meet its protected promotion gates';
--   END IF;
--
--   UPDATE public.gto_v31_datasets SET state='retired', retired_at=now()
--    WHERE state='active' AND dataset_id <> p_dataset_id;
--   UPDATE public.gto_v31_datasets SET state='active', promoted_at=now()
--    WHERE dataset_id=p_dataset_id;
--   RETURN v_dataset.dataset_checksum;
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_active_cells(p_offset integer DEFAULT 0, p_limit integer DEFAULT 500)
-- RETURNS TABLE (
--   dataset_id uuid, dataset_key text, dataset_checksum text,
--   solver_version text, solver_binary_checksum text, pipeline_commit text,
--   pipeline_bundle_checksum text,
--   manifest_version text, manifest_checksum text, source_artifact_checksum text,
--   source_combo_order_checksum text, range_bundle_checksum text,
--   icm_model_checksum text, input_bundle_checksum text,
--   cell_key_checksum text, cell_payload_checksum text, lineage_checksum text,
--   quality_status text, dataset_state text, dataset_cells bigint, source_rows bigint,
--   train_source_rows bigint, holdout_source_rows bigint, invalid_rows bigint,
--   audited_at timestamptz, street text, game_family text, objective text,
--   utility_context text, table_size smallint, pot_type text,
--   hero_position text, opponent_position text, depth_bucket integer,
--   texture_class text, node_role text, facing_kind text, facing_size_bucket text,
--   hand_matrix jsonb, action_specs jsonb, policy_ev_matrix jsonb, action_ev_matrix jsonb
-- )
-- LANGUAGE sql
-- STABLE
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
--   SELECT d.dataset_id, d.dataset_key, d.dataset_checksum,
--          d.solver_version, d.solver_binary_checksum, d.pipeline_commit,
--          d.pipeline_bundle_checksum,
--          d.manifest_version, d.manifest_checksum, d.source_artifact_checksum,
--          d.source_combo_order_checksum, d.range_bundle_checksum,
--          d.icm_model_checksum,d.input_bundle_checksum,
--          c.cell_key_checksum, c.cell_payload_checksum, c.lineage_checksum,
--          d.quality_status, d.state, (d.coverage->>'cells')::bigint,
--          d.source_rows, d.train_source_rows, d.holdout_source_rows,
--          d.invalid_rows, d.audited_at,
--          c.street, c.game_family, c.objective, c.utility_context, c.table_size,
--          c.pot_type, c.hero_position, c.opponent_position,
--          c.depth_bucket, c.texture_class, c.node_role, c.facing_kind,
--          c.facing_size_bucket, c.hand_matrix, c.action_specs,
--          c.policy_ev_matrix, c.action_ev_matrix
--     FROM public.gto_v31_datasets d
--     JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
--      AND b.approval_status='approved' AND b.bundle_checksum=d.input_bundle_checksum
--     JOIN public.gto_v31_runtime_cells c ON c.dataset_id=d.dataset_id
--    WHERE d.state='active' AND d.quality_status='validated' AND d.invalid_rows=0
--      AND d.dataset_checksum IS NOT NULL AND d.source_artifact_checksum IS NOT NULL
--    ORDER BY c.street, c.game_family, c.objective, c.utility_context, c.table_size,
--             c.pot_type, c.hero_position, c.opponent_position, c.depth_bucket,
--             c.texture_class, c.node_role,
--             c.facing_kind, c.facing_size_bucket
--    OFFSET greatest(COALESCE(p_offset,0),0)
--    LIMIT greatest(1,least(COALESCE(p_limit,500),500));
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_evaluation_cells(
--   p_dataset_id uuid,
--   p_offset integer DEFAULT 0,
--   p_limit integer DEFAULT 500
-- )
-- RETURNS TABLE (
--   dataset_id uuid, dataset_key text, dataset_checksum text,
--   solver_version text, solver_binary_checksum text, pipeline_commit text,
--   pipeline_bundle_checksum text,
--   manifest_version text, manifest_checksum text, source_artifact_checksum text,
--   source_combo_order_checksum text, range_bundle_checksum text,
--   icm_model_checksum text, input_bundle_checksum text,
--   cell_key_checksum text, cell_payload_checksum text, lineage_checksum text,
--   quality_status text, dataset_state text, dataset_cells bigint, source_rows bigint,
--   train_source_rows bigint, holdout_source_rows bigint, invalid_rows bigint,
--   audited_at timestamptz, street text, game_family text, objective text,
--   utility_context text, table_size smallint, pot_type text,
--   hero_position text, opponent_position text, depth_bucket integer,
--   texture_class text, node_role text, facing_kind text, facing_size_bucket text,
--   hand_matrix jsonb, action_specs jsonb, policy_ev_matrix jsonb, action_ev_matrix jsonb
-- )
-- LANGUAGE sql
-- STABLE
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
--   SELECT d.dataset_id,d.dataset_key,d.dataset_checksum,d.solver_version,
--          d.solver_binary_checksum,d.pipeline_commit,d.pipeline_bundle_checksum,
--          d.manifest_version,
--          d.manifest_checksum,d.source_artifact_checksum,
--          d.source_combo_order_checksum,d.range_bundle_checksum,d.icm_model_checksum,
--          d.input_bundle_checksum,c.cell_key_checksum,c.cell_payload_checksum,
--          c.lineage_checksum,d.quality_status,d.state,(d.coverage->>'cells')::bigint,
--          d.source_rows,d.train_source_rows,d.holdout_source_rows,d.invalid_rows,
--          d.audited_at,c.street,c.game_family,c.objective,c.utility_context,
--          c.table_size,c.pot_type,c.hero_position,c.opponent_position,c.depth_bucket,
--          c.texture_class,c.node_role,c.facing_kind,c.facing_size_bucket,
--          c.hand_matrix,c.action_specs,c.policy_ev_matrix,c.action_ev_matrix
--     FROM public.gto_v31_datasets d
--     JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
--      AND b.approval_status='approved' AND b.bundle_checksum=d.input_bundle_checksum
--     JOIN public.gto_v31_runtime_cells c ON c.dataset_id=d.dataset_id
--    WHERE d.dataset_id=p_dataset_id AND d.state IN ('evaluating','candidate')
--      AND d.quality_status='validated' AND d.invalid_rows=0
--      AND d.dataset_checksum IS NOT NULL AND d.source_artifact_checksum IS NOT NULL
--    ORDER BY c.street,c.game_family,c.objective,c.utility_context,c.table_size,
--      c.pot_type,c.hero_position,c.opponent_position,c.depth_bucket,c.texture_class,
--      c.node_role,c.facing_kind,c.facing_size_bucket
--    OFFSET greatest(COALESCE(p_offset,0),0)
--    LIMIT greatest(1,least(COALESCE(p_limit,500),500));
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_record_evaluation(
--   p_dataset_id uuid,
--   p_evaluation_kind text,
--   p_game_family text,
--   p_source_result_id bigint
-- )
-- RETURNS uuid
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_dataset public.gto_v31_datasets%ROWTYPE;
--   v_result public.horse_league_results%ROWTYPE;
--   v_incumbent text;
--   v_verdict text;
--   v_metrics jsonb;
--   v_checksum text;
--   v_id uuid;
--   v_expected_scenarios text[];
--   v_expected_profile text;
--   v_actual_scenarios text[];
--   v_component_hands bigint;
--   v_component_hits bigint;
--   v_component_mismatches bigint;
--   v_component_duration bigint;
--   v_component_bb100 numeric;
--   v_component_stderr numeric;
--   v_component_roles text[];
--   v_result_roles text[];
-- BEGIN
--   IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
--     RAISE EXCEPTION 'service_role required';
--   END IF;
--   IF p_evaluation_kind NOT IN ('paired_replay','league')
--      OR p_game_family NOT IN ('cash','spin','tourney_ev','tourney_icm') THEN
--     RAISE EXCEPTION 'evaluation kind or family is invalid';
--   END IF;
--   SELECT * INTO v_dataset FROM public.gto_v31_datasets
--    WHERE dataset_id=p_dataset_id AND state='evaluating' FOR UPDATE;
--   IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not awaiting evaluation'; END IF;
--   SELECT COALESCE((SELECT dataset_checksum FROM public.gto_v31_datasets
--     WHERE state='active' AND dataset_id<>p_dataset_id LIMIT 1),'legacy_v30') INTO v_incumbent;
--   SELECT * INTO v_result FROM public.horse_league_results WHERE id=p_source_result_id FOR SHARE;
--   IF NOT FOUND THEN RAISE EXCEPTION 'league result does not exist'; END IF;
--   v_expected_scenarios:=CASE p_game_family
--     WHEN 'cash' THEN ARRAY['cash_ev']::text[]
--     WHEN 'spin' THEN ARRAY['chip_ev','spin_ladder']::text[]
--     WHEN 'tourney_ev' THEN ARRAY['chip_ev']::text[]
--     ELSE ARRAY['satellite','bubble','final_table','in_money','ladder']::text[]
--   END;
--   v_expected_profile:=CASE p_evaluation_kind
--     WHEN 'paired_replay' THEN 'policy_only_duplicate_deals'
--     ELSE 'full_brain_duplicate_deal_league'
--   END;
--
--   IF jsonb_typeof(v_result.config_a)<>'object'
--      OR (SELECT count(*) FROM jsonb_object_keys(v_result.config_a))<>8
--      OR NOT (v_result.config_a ?& ARRAY['evaluation_contract','evaluation_kind',
--        'game_family','dataset_checksum','candidate','evaluation_profile','scenarios',
--        'evaluation_engine_commit']::text[])
--      OR jsonb_typeof(v_result.config_b)<>'object'
--      OR (SELECT count(*) FROM jsonb_object_keys(v_result.config_b))<>2
--      OR NOT (v_result.config_b ?& ARRAY['incumbent_dataset_checksum','candidate']::text[])
--      OR jsonb_typeof(v_result.config_a->'scenarios')<>'array'
--      OR v_result.config_a->'scenarios' IS DISTINCT FROM to_jsonb(v_expected_scenarios)
--      OR v_result.config_a->>'evaluation_profile'<>v_expected_profile
--      OR COALESCE(v_result.config_a->>'evaluation_engine_commit','')!~'^[0-9a-f]{40}$'
--      OR v_result.config_a->>'evaluation_engine_commit'=repeat('0',40) THEN
--     RAISE EXCEPTION 'evaluation configuration is incomplete or aliases another test profile';
--   END IF;
--
--   IF jsonb_array_length(v_result.candidate_benchmark_components)<>array_length(v_expected_scenarios,1)
--      OR EXISTS (
--        SELECT 1 FROM jsonb_array_elements(v_result.candidate_benchmark_components) component(value)
--         WHERE jsonb_typeof(component.value)<>'object'
--           OR (SELECT count(*) FROM jsonb_object_keys(component.value))<>10
--           OR NOT (component.value ?& ARRAY['scenario','hands','bb100','stderr','duration_ms',
--             'illegal_actions','truncated_streets','candidate_policy_hits',
--             'candidate_execution_mismatches','candidate_node_roles']::text[])
--           OR jsonb_typeof(component.value->'scenario')<>'string'
--           OR COALESCE(component.value->>'hands','')!~'^[1-9][0-9]*$'
--           OR jsonb_typeof(component.value->'bb100')<>'number'
--           OR jsonb_typeof(component.value->'stderr')<>'number'
--           OR (component.value->>'stderr')::numeric<0
--           OR COALESCE(component.value->>'duration_ms','')!~'^[1-9][0-9]*$'
--           OR COALESCE(component.value->>'illegal_actions','')!~'^[0-9]+$'
--           OR (component.value->>'illegal_actions')::bigint<>0
--           OR COALESCE(component.value->>'truncated_streets','')!~'^[0-9]+$'
--           OR (component.value->>'truncated_streets')::bigint<>0
--           OR COALESCE(component.value->>'candidate_policy_hits','')!~'^[1-9][0-9]*$'
--           OR COALESCE(component.value->>'candidate_execution_mismatches','')!~'^[0-9]+$'
--           OR (component.value->>'candidate_execution_mismatches')::bigint<>0
--           OR jsonb_typeof(component.value->'candidate_node_roles')<>'array'
--           OR jsonb_array_length(component.value->'candidate_node_roles')=0
--           OR jsonb_array_length(component.value->'candidate_node_roles')<>(
--             SELECT count(DISTINCT role.value)
--               FROM jsonb_array_elements_text(component.value->'candidate_node_roles') role(value))
--           OR EXISTS (
--             SELECT 1 FROM jsonb_array_elements_text(component.value->'candidate_node_roles') role(value)
--              WHERE role.value NOT IN ('open','cbet','probe','delayed_cbet','barrel',
--                'facing_bet','facing_raise','check_raise','bet_raise','all_in'))
--      ) THEN
--     RAISE EXCEPTION 'benchmark components do not carry exact scenario and decision evidence';
--   END IF;
--
--   SELECT array_agg(component.value->>'scenario' ORDER BY component.ordinality),
--          sum((component.value->>'hands')::bigint),
--          sum((component.value->>'candidate_policy_hits')::bigint),
--          sum((component.value->>'candidate_execution_mismatches')::bigint),
--          sum((component.value->>'duration_ms')::bigint),
--          sum((component.value->>'bb100')::numeric*(component.value->>'hands')::numeric)
--            /sum((component.value->>'hands')::numeric),
--          sqrt(sum(power((component.value->>'stderr')::numeric*
--            (component.value->>'hands')::numeric,2)))
--            /sum((component.value->>'hands')::numeric)
--     INTO v_actual_scenarios,v_component_hands,v_component_hits,v_component_mismatches,
--          v_component_duration,
--          v_component_bb100,v_component_stderr
--     FROM jsonb_array_elements(v_result.candidate_benchmark_components)
--       WITH ORDINALITY component(value,ordinality);
--   SELECT array_agg(DISTINCT role.value ORDER BY role.value)
--     INTO v_component_roles
--     FROM jsonb_array_elements(v_result.candidate_benchmark_components) component(value)
--     CROSS JOIN LATERAL jsonb_array_elements_text(component.value->'candidate_node_roles') role(value);
--   SELECT array_agg(DISTINCT role.value ORDER BY role.value) INTO v_result_roles
--     FROM unnest(v_result.candidate_node_roles) role(value);
--
--   IF v_result.run_date<current_date-2 OR v_result.run_date>current_date
--      OR v_result.hands<10000 OR v_result.illegal_actions<>0 OR v_result.truncated_streets<>0
--      OR v_result.candidate_policy_hits<=0 OR v_result.candidate_execution_mismatches<>0
--      OR COALESCE(array_length(v_result.candidate_node_roles,1),0)<=0
--      OR v_actual_scenarios IS DISTINCT FROM v_expected_scenarios
--      OR v_component_hands<>v_result.hands
--      OR v_component_hits<>v_result.candidate_policy_hits
--      OR v_component_mismatches<>v_result.candidate_execution_mismatches
--      OR v_component_duration<>v_result.duration_ms
--      OR abs(v_component_bb100-v_result.bb100)>0.000001
--      OR abs(v_component_stderr-v_result.stderr)>0.000001
--      OR v_component_roles IS DISTINCT FROM v_result_roles
--      OR COALESCE(array_length(v_result.candidate_node_roles,1),0)<>
--         COALESCE(array_length(v_result_roles,1),0)
--      OR EXISTS (SELECT 1 FROM unnest(v_result.candidate_node_roles) role(value)
--        WHERE role.value NOT IN ('open','cbet','probe','delayed_cbet','barrel',
--          'facing_bet','facing_raise','check_raise','bet_raise','all_in'))
--      OR v_result.duration_ms<=0 OR v_result.stderr<0
--      OR v_result.matchup<>'gto_v31_'||p_evaluation_kind||'_'||p_game_family||'_'||v_dataset.dataset_checksum
--      OR v_result.config_a->>'evaluation_contract'<>'gto_v31_candidate.v2'
--      OR v_result.config_a->>'evaluation_kind'<>p_evaluation_kind
--      OR v_result.config_a->>'game_family'<>p_game_family
--      OR v_result.config_a->>'dataset_checksum'<>v_dataset.dataset_checksum
--      OR v_result.config_a->>'candidate'<>'v31_certified'
--      OR v_result.config_b->>'incumbent_dataset_checksum'<>v_incumbent
--      OR v_result.config_b->>'candidate'<>'incumbent' THEN
--     RAISE EXCEPTION 'league result is stale, unsafe, or not bound to this candidate and incumbent';
--   END IF;
--   IF EXISTS (
--     SELECT 1 FROM public.gto_v31_release_evaluations e
--      WHERE e.dataset_id=p_dataset_id
--        AND e.evaluation_kind IN ('paired_replay','league')
--        AND e.metrics#>>'{candidate_config,evaluation_engine_commit}'
--            IS DISTINCT FROM v_result.config_a->>'evaluation_engine_commit'
--   ) THEN
--     RAISE EXCEPTION 'candidate evaluations were produced by different engine commits';
--   END IF;
--
--   v_verdict:=CASE WHEN v_result.bb100>2*v_result.stderr THEN 'win'
--                   WHEN v_result.bb100<(-2*v_result.stderr) THEN 'loss' ELSE 'tie' END;
--   v_metrics:=jsonb_build_object('source_result_id',v_result.id,'run_date',v_result.run_date,
--     'matchup',v_result.matchup,'hands',v_result.hands,'bb100',v_result.bb100,
--     'stderr',v_result.stderr,'illegal_actions',v_result.illegal_actions,
--     'truncated_streets',v_result.truncated_streets,'duration_ms',v_result.duration_ms,
--     'candidate_policy_hits',v_result.candidate_policy_hits,
--     'candidate_execution_mismatches',v_result.candidate_execution_mismatches,
--     'candidate_node_roles',v_result.candidate_node_roles,
--     'benchmark_components',v_result.candidate_benchmark_components,
--     'candidate_config',v_result.config_a,'incumbent_config',v_result.config_b);
--   v_checksum:=public.fn_gto_v31_json_checksum(jsonb_build_object(
--     'dataset_checksum',v_dataset.dataset_checksum,'kind',p_evaluation_kind,
--     'family',p_game_family,'verdict',v_verdict,'metrics',v_metrics));
--   INSERT INTO public.gto_v31_release_evaluations (
--     dataset_id,dataset_checksum,evaluation_kind,game_family,verdict,metrics,
--     source_result_id,result_checksum
--   ) VALUES (
--     p_dataset_id,v_dataset.dataset_checksum,p_evaluation_kind,p_game_family,
--     v_verdict,v_metrics,p_source_result_id,v_checksum
--   ) ON CONFLICT (dataset_id,evaluation_kind,game_family) DO NOTHING
--   RETURNING evaluation_id INTO v_id;
--   IF v_id IS NULL THEN
--     SELECT evaluation_id INTO v_id FROM public.gto_v31_release_evaluations
--      WHERE dataset_id=p_dataset_id AND evaluation_kind=p_evaluation_kind
--        AND game_family=p_game_family AND result_checksum=v_checksum;
--     IF v_id IS NULL THEN RAISE EXCEPTION 'an evaluation receipt already exists with another result'; END IF;
--   END IF;
--   RETURN v_id;
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_candidate_evaluations_valid(
--   p_dataset_id uuid,
--   p_dataset_checksum text
-- )
-- RETURNS boolean
-- LANGUAGE plpgsql
-- VOLATILE
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_incumbent text;
--   v_active_incumbents integer;
--   v_receipts integer;
--   v_engine_commits integer;
-- BEGIN
--   -- Mark-candidate and promotion both call this helper before changing state.
--   -- The transaction-scoped estate lock survives the function return, so the
--   -- incumbent read, receipt validation, and later state transition are one
--   -- serialized release operation even for two different candidate rows.
--   PERFORM pg_advisory_xact_lock(
--     hashtextextended('smarter-poker:gto-v31-release-gate', 0)
--   );
--
--   IF p_dataset_id IS NULL
--      OR COALESCE(p_dataset_checksum,'')!~'^[0-9a-f]{64}$'
--      OR p_dataset_checksum=repeat('0',64) THEN
--     RETURN false;
--   END IF;
--
--   SELECT count(*),max(d.dataset_checksum)
--     INTO v_active_incumbents,v_incumbent
--     FROM public.gto_v31_datasets d
--    WHERE d.state='active' AND d.dataset_id<>p_dataset_id;
--   IF v_active_incumbents=0 THEN
--     v_incumbent:='legacy_v30';
--   ELSIF v_active_incumbents<>1
--      OR COALESCE(v_incumbent,'')!~'^[0-9a-f]{64}$'
--      OR v_incumbent=repeat('0',64) THEN
--     RETURN false;
--   END IF;
--
--   SELECT count(*),
--          count(DISTINCT e.metrics#>>'{candidate_config,evaluation_engine_commit}')
--     INTO v_receipts,v_engine_commits
--     FROM public.gto_v31_release_evaluations e
--     JOIN public.horse_league_results r ON r.id=e.source_result_id
--    WHERE e.dataset_id=p_dataset_id
--      AND e.dataset_checksum=p_dataset_checksum
--      AND e.evaluation_kind IN ('paired_replay','league')
--      AND e.game_family IN ('cash','spin','tourney_ev','tourney_icm');
--
--   IF v_receipts<>8 OR v_engine_commits<>1 THEN
--     RETURN false;
--   END IF;
--
--   RETURN NOT EXISTS (
--     WITH required(evaluation_kind,game_family,evaluation_profile,scenarios) AS (
--       VALUES
--         ('paired_replay','cash','policy_only_duplicate_deals',ARRAY['cash_ev']::text[]),
--         ('paired_replay','spin','policy_only_duplicate_deals',ARRAY['chip_ev','spin_ladder']::text[]),
--         ('paired_replay','tourney_ev','policy_only_duplicate_deals',ARRAY['chip_ev']::text[]),
--         ('paired_replay','tourney_icm','policy_only_duplicate_deals',ARRAY['satellite','bubble','final_table','in_money','ladder']::text[]),
--         ('league','cash','full_brain_duplicate_deal_league',ARRAY['cash_ev']::text[]),
--         ('league','spin','full_brain_duplicate_deal_league',ARRAY['chip_ev','spin_ladder']::text[]),
--         ('league','tourney_ev','full_brain_duplicate_deal_league',ARRAY['chip_ev']::text[]),
--         ('league','tourney_icm','full_brain_duplicate_deal_league',ARRAY['satellite','bubble','final_table','in_money','ladder']::text[])
--     )
--     SELECT 1
--       FROM required q
--       LEFT JOIN public.gto_v31_release_evaluations e
--         ON e.dataset_id=p_dataset_id
--        AND e.dataset_checksum=p_dataset_checksum
--        AND e.evaluation_kind=q.evaluation_kind
--        AND e.game_family=q.game_family
--       LEFT JOIN public.horse_league_results r ON r.id=e.source_result_id
--      WHERE e.evaluation_id IS NULL
--         OR r.id IS NULL
--         OR e.verdict NOT IN ('win','tie')
--         OR e.verdict IS DISTINCT FROM CASE
--              WHEN r.bb100>2*r.stderr THEN 'win'
--              WHEN r.bb100<(-2*r.stderr) THEN 'loss'
--              ELSE 'tie'
--            END
--         OR r.hands<10000
--         OR r.illegal_actions<>0
--         OR r.truncated_streets<>0
--         OR r.candidate_policy_hits<=0
--         OR r.candidate_execution_mismatches<>0
--         OR r.duration_ms<=0
--         OR r.stderr<0
--         OR r.matchup IS DISTINCT FROM
--            'gto_v31_'||q.evaluation_kind||'_'||q.game_family||'_'||p_dataset_checksum
--         OR jsonb_typeof(r.config_a)<>'object'
--         OR CASE WHEN jsonb_typeof(r.config_a)='object'
--              THEN (SELECT count(*) FROM jsonb_object_keys(r.config_a))
--              ELSE -1
--            END<>8
--         OR NOT (r.config_a ?& ARRAY['evaluation_contract','evaluation_kind',
--           'game_family','dataset_checksum','candidate','evaluation_profile','scenarios',
--           'evaluation_engine_commit']::text[])
--         OR r.config_a->>'evaluation_contract'<>'gto_v31_candidate.v2'
--         OR r.config_a->>'evaluation_kind'<>q.evaluation_kind
--         OR r.config_a->>'game_family'<>q.game_family
--         OR r.config_a->>'dataset_checksum'<>p_dataset_checksum
--         OR r.config_a->>'candidate'<>'v31_certified'
--         OR r.config_a->>'evaluation_profile'<>q.evaluation_profile
--         OR r.config_a->'scenarios' IS DISTINCT FROM to_jsonb(q.scenarios)
--         OR COALESCE(r.config_a->>'evaluation_engine_commit','')!~'^[0-9a-f]{40}$'
--         OR r.config_a->>'evaluation_engine_commit'=repeat('0',40)
--         OR jsonb_typeof(r.config_b)<>'object'
--         OR CASE WHEN jsonb_typeof(r.config_b)='object'
--              THEN (SELECT count(*) FROM jsonb_object_keys(r.config_b))
--              ELSE -1
--            END<>2
--         OR NOT (r.config_b ?& ARRAY['incumbent_dataset_checksum','candidate']::text[])
--         OR r.config_b->>'incumbent_dataset_checksum'<>v_incumbent
--         OR r.config_b->>'candidate'<>'incumbent'
--         OR jsonb_typeof(r.candidate_benchmark_components)<>'array'
--         OR jsonb_array_length(r.candidate_benchmark_components)<>array_length(q.scenarios,1)
--         OR EXISTS (
--           SELECT 1
--             FROM jsonb_array_elements(r.candidate_benchmark_components) component(value)
--            WHERE jsonb_typeof(component.value)<>'object'
--               OR component.value->'candidate_execution_mismatches' IS DISTINCT FROM '0'::jsonb
--         )
--         OR e.metrics IS DISTINCT FROM jsonb_build_object(
--           'source_result_id',r.id,'run_date',r.run_date,'matchup',r.matchup,
--           'hands',r.hands,'bb100',r.bb100,'stderr',r.stderr,
--           'illegal_actions',r.illegal_actions,'truncated_streets',r.truncated_streets,
--           'duration_ms',r.duration_ms,'candidate_policy_hits',r.candidate_policy_hits,
--           'candidate_execution_mismatches',r.candidate_execution_mismatches,
--           'candidate_node_roles',r.candidate_node_roles,
--           'benchmark_components',r.candidate_benchmark_components,
--           'candidate_config',r.config_a,'incumbent_config',r.config_b)
--         OR e.result_checksum IS DISTINCT FROM public.fn_gto_v31_json_checksum(
--           jsonb_build_object('dataset_checksum',p_dataset_checksum,
--             'kind',q.evaluation_kind,'family',q.game_family,
--             'verdict',e.verdict,'metrics',e.metrics))
--   );
-- END;
-- $fn$;
-- CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_v31_decision(p_decision jsonb)
-- RETURNS boolean
-- LANGUAGE plpgsql
-- STABLE
-- SECURITY DEFINER
-- SET search_path=public
-- AS $fn$
-- DECLARE
--   v_state jsonb:=p_decision->'decision_state';
--   v_seal jsonb:=p_decision->'source_seal';
--   v_distribution jsonb:=p_decision->'reference_distribution';
--   v_dataset public.gto_v31_datasets%ROWTYPE;
--   v_cell public.gto_v31_runtime_cells%ROWTYPE;
--   v_board_count integer;
--   v_board_text text;
--   v_hole_text text;
--   v_card_one integer;
--   v_card_two integer;
--   v_combo integer;
--   v_expected_hand_key text;
--   v_expected_cell text;
--   v_expected_state_key text;
--   v_spec jsonb;
--   v_action_evs jsonb;
--   v_selected_probability numeric;
--   v_max_probability numeric;
--   v_selected_ev numeric;
--   v_regret numeric;
--   v_expected_sample numeric;
--   v_step numeric;
--   v_amount_preserved boolean;
--   v_executed boolean;
--   v_expected_pure boolean;
-- BEGIN
--   IF p_decision IS NULL OR jsonb_typeof(p_decision)<>'object'
--      OR (SELECT count(*) FROM jsonb_object_keys(p_decision))<>27
--      OR NOT (p_decision ?& ARRAY[
--        'state_key','decision_state','stage','game_family','objective','utility_context',
--        'table_size','pot_type','hero_position','opponent_position','depth_bucket',
--        'texture_class','node_role','facing_kind','facing_size_bucket','cell','hand_key',
--        'sampled_action_id','sampled_action_family','final_action','executed_as_intended',
--        'reference_distribution','chosen_probability','action_regret_bb','regret_eligible',
--        'pure_miss','source_seal'])
--      OR EXISTS (SELECT 1 FROM unnest(ARRAY[
--        'state_key','stage','game_family','objective','utility_context','pot_type',
--        'hero_position','opponent_position','texture_class','node_role','facing_kind',
--        'facing_size_bucket','cell','hand_key','sampled_action_id','sampled_action_family',
--        'final_action'
--      ]) f(key) WHERE jsonb_typeof(p_decision->f.key)<>'string')
--      OR jsonb_typeof(p_decision->'table_size')<>'number'
--      OR jsonb_typeof(p_decision->'depth_bucket')<>'number'
--      OR jsonb_typeof(p_decision->'executed_as_intended')<>'boolean'
--      OR jsonb_typeof(v_distribution)<>'object'
--      OR jsonb_typeof(p_decision->'chosen_probability')<>'number'
--      OR jsonb_typeof(p_decision->'action_regret_bb') NOT IN ('number','null')
--      OR jsonb_typeof(p_decision->'regret_eligible')<>'boolean'
--      OR jsonb_typeof(p_decision->'pure_miss')<>'boolean'
--      OR jsonb_typeof(v_state)<>'object'
--      OR jsonb_typeof(v_seal)<>'object' THEN RETURN false; END IF;
--
--   IF length(p_decision->>'state_key') NOT BETWEEN 8 AND 512
--      OR p_decision->>'stage' NOT IN ('flop','turn','river')
--      OR p_decision->>'game_family' NOT IN ('cash','spin','tourney_ev','tourney_icm')
--      OR p_decision->>'objective' NOT IN ('cash_ev','chip_ev','icm')
--      OR p_decision->>'utility_context' NOT IN ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
--      OR NOT public.fn_gto_v31_json_safe_integer(p_decision->'table_size',2,10)
--      OR p_decision->>'pot_type' NOT IN ('limped','srp','3bet','4bet_plus')
--      OR p_decision->>'hero_position' NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
--      OR p_decision->>'opponent_position' NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
--      OR p_decision->>'hero_position'=p_decision->>'opponent_position'
--      OR NOT public.fn_gto_v31_json_safe_integer(p_decision->'depth_bucket',10,150)
--      OR (p_decision->>'depth_bucket')::integer NOT IN (10,20,40,80,150)
--      OR p_decision->>'texture_class'!~'^[ABML][mtr][pu][cd]$'
--      OR p_decision->>'node_role' NOT IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')
--      OR p_decision->>'facing_kind' NOT IN ('none','bet','raise','all_in')
--      OR p_decision->>'facing_size_bucket' NOT IN ('none','small','mid','big','all_in')
--      OR length(p_decision->>'cell') NOT BETWEEN 20 AND 512
--      OR NOT public.fn_gto_v31_hand_key_valid(p_decision->>'hand_key',p_decision->>'stage')
--      OR p_decision->>'sampled_action_id' !~ '^(c|f|b[1-9][0-9]{0,78})$'
--      OR p_decision->>'sampled_action_family' NOT IN ('check','fold','call','bet','raise','all_in')
--      OR p_decision->>'final_action' NOT IN ('check','fold','call','bet','raise','all_in')
--      OR (p_decision->>'chosen_probability')::numeric NOT BETWEEN 0 AND 1
--      OR (p_decision->'action_regret_bb'<>'null'::jsonb AND
--          (p_decision->>'action_regret_bb')::numeric<0) THEN RETURN false; END IF;
--
--   IF (SELECT count(*) FROM jsonb_object_keys(v_state))<>34
--      OR NOT (v_state ?& ARRAY[
--        'schema_version','street','game_variant','game_family','objective','utility_context',
--        'format','table_size','pot_type','hero_position','opponent_position','stack_bb',
--        'depth_bucket','texture_class','node_role','facing_kind','facing_size_bucket',
--        'hand','hand_key','cell','board','hole_cards','pot','current_bet','to_call',
--        'big_blind','probe_scenario','probe_ordinal','sampled_action_id',
--        'sampled_action_family','sampled_amount','final_action','final_amount',
--        'executed_as_intended'])
--      OR EXISTS (SELECT 1 FROM unnest(ARRAY[
--        'street','game_variant','game_family','objective','utility_context','format','pot_type',
--        'hero_position','opponent_position','texture_class','node_role','facing_kind',
--        'facing_size_bucket','hand','hand_key','cell','probe_scenario','sampled_action_id',
--        'sampled_action_family','final_action'
--      ]) f(key) WHERE jsonb_typeof(v_state->f.key)<>'string')
--      OR EXISTS (SELECT 1 FROM unnest(ARRAY[
--        'schema_version','table_size','stack_bb','depth_bucket','pot','current_bet',
--        'to_call','big_blind','probe_ordinal'
--      ]) f(key) WHERE jsonb_typeof(v_state->f.key)<>'number')
--      OR jsonb_typeof(v_state->'sampled_amount') NOT IN ('number','null')
--      OR jsonb_typeof(v_state->'final_amount') NOT IN ('number','null')
--      OR jsonb_typeof(v_state->'board')<>'array'
--      OR jsonb_typeof(v_state->'hole_cards')<>'array'
--      OR jsonb_typeof(v_state->'executed_as_intended')<>'boolean'
--      OR NOT public.fn_gto_v31_json_safe_integer(v_state->'schema_version',1,1)
--      OR NOT public.fn_gto_v31_json_safe_integer(v_state->'table_size',2,10)
--      OR NOT public.fn_gto_v31_json_safe_integer(v_state->'depth_bucket',10,150)
--      OR NOT public.fn_gto_v31_json_safe_integer(v_state->'probe_ordinal',1,5000)
--      OR (v_state->>'stack_bb')::numeric<=0 OR (v_state->>'stack_bb')::numeric>1000000
--      OR (v_state->>'pot')::numeric<0 OR (v_state->>'pot')::numeric>9007199254740991
--      OR (v_state->>'current_bet')::numeric<0 OR (v_state->>'current_bet')::numeric>9007199254740991
--      OR (v_state->>'to_call')::numeric<0 OR (v_state->>'to_call')::numeric>9007199254740991
--      OR (v_state->>'big_blind')::numeric<=0 OR (v_state->>'big_blind')::numeric>1000000
--      OR (v_state->'sampled_amount'<>'null'::jsonb AND
--          ((v_state->>'sampled_amount')::numeric<0 OR (v_state->>'sampled_amount')::numeric>9007199254740991))
--      OR (v_state->'final_amount'<>'null'::jsonb AND
--          ((v_state->>'final_amount')::numeric<0 OR (v_state->>'final_amount')::numeric>9007199254740991))
--   THEN RETURN false; END IF;
--
--   IF v_state->>'game_variant'<>'nlh'
--      OR v_state->>'street'<>p_decision->>'stage'
--      OR v_state->>'game_family'<>p_decision->>'game_family'
--      OR v_state->>'objective'<>p_decision->>'objective'
--      OR v_state->>'utility_context'<>p_decision->>'utility_context'
--      OR v_state->'table_size'<>p_decision->'table_size'
--      OR v_state->>'pot_type'<>p_decision->>'pot_type'
--      OR v_state->>'hero_position'<>p_decision->>'hero_position'
--      OR v_state->>'opponent_position'<>p_decision->>'opponent_position'
--      OR v_state->'depth_bucket'<>p_decision->'depth_bucket'
--      OR v_state->>'texture_class'<>p_decision->>'texture_class'
--      OR v_state->>'node_role'<>p_decision->>'node_role'
--      OR v_state->>'facing_kind'<>p_decision->>'facing_kind'
--      OR v_state->>'facing_size_bucket'<>p_decision->>'facing_size_bucket'
--      OR v_state->>'hand_key'<>p_decision->>'hand_key'
--      OR v_state->>'cell'<>p_decision->>'cell'
--      OR v_state->>'probe_scenario'<>v_state->>'utility_context'
--      OR v_state->>'sampled_action_id'<>p_decision->>'sampled_action_id'
--      OR v_state->>'sampled_action_family'<>p_decision->>'sampled_action_family'
--      OR v_state->>'final_action'<>p_decision->>'final_action'
--      OR (v_state->>'executed_as_intended')::boolean IS DISTINCT FROM
--         (p_decision->>'executed_as_intended')::boolean
--      OR NOT ((p_decision->>'game_family'='cash' AND p_decision->>'objective'='cash_ev'
--               AND p_decision->>'utility_context'='cash_ev' AND v_state->>'format'='cash')
--        OR (p_decision->>'game_family'='tourney_ev' AND p_decision->>'objective'='chip_ev'
--               AND p_decision->>'utility_context'='chip_ev' AND v_state->>'format'='mtt')
--        OR (p_decision->>'game_family'='spin' AND p_decision->>'objective'='chip_ev'
--               AND p_decision->>'utility_context'='chip_ev' AND v_state->>'format'='spin')
--        OR (p_decision->>'game_family'='spin' AND p_decision->>'objective'='icm'
--               AND p_decision->>'utility_context'='spin_ladder' AND v_state->>'format'='spin')
--        OR (p_decision->>'game_family'='tourney_icm' AND p_decision->>'objective'='icm'
--               AND p_decision->>'utility_context' IN ('satellite','bubble','final_table','in_money','ladder')
--               AND v_state->>'format'='mtt'))
--   THEN RETURN false; END IF;
--
--   v_board_count:=CASE p_decision->>'stage' WHEN 'flop' THEN 3 WHEN 'turn' THEN 4 ELSE 5 END;
--   v_board_text:=public.fn_horse_solver_v31_cards_text(v_state->'board',v_board_count);
--   v_hole_text:=public.fn_horse_solver_v31_cards_text(v_state->'hole_cards',2);
--   IF v_board_text IS NULL OR v_hole_text IS NULL
--      OR EXISTS (
--        SELECT 1 FROM (
--          SELECT public.fn_horse_solver_v31_card_text(value) card
--            FROM jsonb_array_elements((v_state->'board')||(v_state->'hole_cards'))
--        ) cards GROUP BY card HAVING count(*)>1
--      ) THEN RETURN false; END IF;
--
--   v_card_one:=(position(left(v_hole_text,1) IN '23456789TJQKA')-1)*4+
--     position(substr(v_hole_text,2,1) IN 'cdhs')-1;
--   v_card_two:=(position(substr(v_hole_text,3,1) IN '23456789TJQKA')-1)*4+
--     position(substr(v_hole_text,4,1) IN 'cdhs')-1;
--   v_combo:=greatest(v_card_one,v_card_two)*(greatest(v_card_one,v_card_two)-1)/2+
--     least(v_card_one,v_card_two);
--   v_expected_hand_key:=public.fn_gto_v31_hand_key(v_combo,v_board_text);
--   IF v_expected_hand_key IS NULL OR v_state->>'hand_key'<>v_expected_hand_key
--      OR v_state->>'hand'<>split_part(v_expected_hand_key,':',1)
--      OR v_state->>'texture_class'<>public.fn_gto_texture_class_any(v_board_text)
--   THEN RETURN false; END IF;
--
--   v_expected_cell:=concat_ws('|',v_state->>'street',v_state->>'game_family',
--     v_state->>'objective',v_state->>'utility_context',v_state->>'table_size',
--     v_state->>'pot_type',v_state->>'hero_position',v_state->>'opponent_position',
--     v_state->>'depth_bucket',v_state->>'texture_class',v_state->>'node_role',
--     v_state->>'facing_kind',v_state->>'facing_size_bucket');
--   v_expected_state_key:=concat_ws('|','v31',v_expected_cell,v_expected_hand_key,
--     v_state->>'probe_scenario',v_state->>'probe_ordinal');
--   IF v_state->>'cell'<>v_expected_cell OR p_decision->>'state_key'<>v_expected_state_key THEN
--     RETURN false;
--   END IF;
--
--   IF (SELECT count(*) FROM jsonb_object_keys(v_seal))<>25
--      OR NOT (v_seal ?& ARRAY[
--        'dataset_id','dataset_key','dataset_checksum','solver_version',
--        'solver_binary_checksum','pipeline_commit','pipeline_bundle_checksum',
--        'manifest_version','manifest_checksum','source_artifact_checksum',
--        'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
--        'input_bundle_checksum','cell_key_checksum','cell_payload_checksum',
--        'lineage_checksum','quality_status','dataset_state','dataset_cells','source_rows',
--        'train_source_rows','holdout_source_rows','invalid_rows','audited_at'])
--      OR EXISTS (SELECT 1 FROM unnest(ARRAY[
--        'dataset_id','dataset_key','dataset_checksum','solver_version',
--        'solver_binary_checksum','pipeline_commit','pipeline_bundle_checksum',
--        'manifest_version','manifest_checksum','source_artifact_checksum',
--        'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
--        'input_bundle_checksum','cell_key_checksum','cell_payload_checksum',
--        'lineage_checksum','quality_status','dataset_state','audited_at'
--      ]) f(key) WHERE jsonb_typeof(v_seal->f.key)<>'string')
--      OR EXISTS (SELECT 1 FROM unnest(ARRAY[
--        'dataset_cells','source_rows','train_source_rows','holdout_source_rows','invalid_rows'
--      ]) f(key) WHERE jsonb_typeof(v_seal->f.key)<>'number')
--      OR v_seal->>'dataset_id' !~
--        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
--      OR v_seal->>'quality_status'<>'validated'
--      OR v_seal->>'dataset_state'<>'active'
--      OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'dataset_cells',1,9007199254740991)
--      OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'source_rows',1,9007199254740991)
--      OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'train_source_rows',1,9007199254740991)
--      OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'holdout_source_rows',1,9007199254740991)
--      OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'invalid_rows',0,0)
--   THEN RETURN false; END IF;
--
--   SELECT * INTO v_dataset FROM public.gto_v31_datasets d
--    WHERE d.dataset_id=(v_seal->>'dataset_id')::uuid
--      AND d.state='active' AND d.promoted_at IS NOT NULL
--      AND d.quality_status='validated' AND d.invalid_rows=0;
--   IF NOT FOUND OR NOT EXISTS (
--     SELECT 1 FROM public.gto_v31_input_bundles b
--      WHERE b.input_bundle_id=v_dataset.input_bundle_id
--        AND b.approval_status='approved' AND b.bundle_checksum=v_dataset.input_bundle_checksum
--   ) THEN RETURN false; END IF;
--   SELECT * INTO v_cell FROM public.gto_v31_runtime_cells c
--    WHERE c.dataset_id=v_dataset.dataset_id
--      AND c.cell_key_checksum=v_seal->>'cell_key_checksum';
--   IF NOT FOUND THEN RETURN false; END IF;
--
--   IF v_seal->>'dataset_key'<>v_dataset.dataset_key
--      OR v_seal->>'dataset_checksum'<>v_dataset.dataset_checksum
--      OR v_seal->>'solver_version'<>v_dataset.solver_version
--      OR v_seal->>'solver_binary_checksum'<>v_dataset.solver_binary_checksum
--      OR v_seal->>'pipeline_commit'<>v_dataset.pipeline_commit
--      OR v_seal->>'pipeline_bundle_checksum'<>v_dataset.pipeline_bundle_checksum
--      OR v_seal->>'manifest_version'<>v_dataset.manifest_version
--      OR v_seal->>'manifest_checksum'<>v_dataset.manifest_checksum
--      OR v_seal->>'source_artifact_checksum'<>v_dataset.source_artifact_checksum
--      OR v_seal->>'source_combo_order_checksum'<>v_dataset.source_combo_order_checksum
--      OR v_seal->>'range_bundle_checksum'<>v_dataset.range_bundle_checksum
--      OR v_seal->>'icm_model_checksum'<>v_dataset.icm_model_checksum
--      OR v_seal->>'input_bundle_checksum'<>v_dataset.input_bundle_checksum
--      OR v_seal->>'cell_payload_checksum'<>v_cell.cell_payload_checksum
--      OR v_seal->>'lineage_checksum'<>v_cell.lineage_checksum
--      OR (v_seal->>'dataset_cells')::bigint<>(v_dataset.coverage->>'cells')::bigint
--      OR (v_seal->>'source_rows')::bigint<>v_dataset.source_rows
--      OR (v_seal->>'train_source_rows')::bigint<>v_dataset.train_source_rows
--      OR (v_seal->>'holdout_source_rows')::bigint<>v_dataset.holdout_source_rows
--      OR (v_seal->>'audited_at')::timestamptz IS DISTINCT FROM v_dataset.audited_at
--      OR v_cell.street<>p_decision->>'stage'
--      OR v_cell.game_family<>p_decision->>'game_family'
--      OR v_cell.objective<>p_decision->>'objective'
--      OR v_cell.utility_context<>p_decision->>'utility_context'
--      OR v_cell.table_size<>(p_decision->>'table_size')::integer
--      OR v_cell.pot_type<>p_decision->>'pot_type'
--      OR v_cell.hero_position<>p_decision->>'hero_position'
--      OR v_cell.opponent_position<>p_decision->>'opponent_position'
--      OR v_cell.depth_bucket<>(p_decision->>'depth_bucket')::integer
--      OR v_cell.texture_class<>p_decision->>'texture_class'
--      OR v_cell.node_role<>p_decision->>'node_role'
--      OR v_cell.facing_kind<>p_decision->>'facing_kind'
--      OR v_cell.facing_size_bucket<>p_decision->>'facing_size_bucket'
--   THEN RETURN false; END IF;
--
--   v_spec:=v_cell.action_specs->(p_decision->>'sampled_action_id');
--   v_action_evs:=v_cell.action_ev_matrix->(p_decision->>'hand_key');
--   IF jsonb_typeof(v_spec)<>'object'
--      OR v_spec->>'family'<>p_decision->>'sampled_action_family'
--      OR NOT (v_cell.hand_matrix ? (p_decision->>'hand_key'))
--      OR v_distribution<>v_cell.hand_matrix->(p_decision->>'hand_key')
--      OR NOT (v_distribution ? (p_decision->>'sampled_action_id'))
--      OR jsonb_typeof(v_action_evs)<>'object'
--      OR NOT (v_action_evs ? (p_decision->>'sampled_action_id')) THEN RETURN false; END IF;
--   IF EXISTS (SELECT 1 FROM jsonb_each(v_distribution)
--               WHERE jsonb_typeof(value)<>'number' OR (value#>>'{}')::numeric NOT BETWEEN 0 AND 1)
--      OR abs((SELECT sum((value#>>'{}')::numeric) FROM jsonb_each(v_distribution))-1)>0.002
--   THEN RETURN false; END IF;
--
--   v_selected_probability:=(v_distribution->>(p_decision->>'sampled_action_id'))::numeric;
--   SELECT max((value#>>'{}')::numeric) INTO v_max_probability FROM jsonb_each(v_distribution);
--   v_selected_ev:=(v_action_evs->>(p_decision->>'sampled_action_id'))::numeric;
--   SELECT greatest(0,max((value#>>'{}')::numeric)-v_selected_ev)
--     INTO v_regret FROM jsonb_each(v_action_evs);
--
--   IF p_decision->>'sampled_action_family' IN ('check','fold','all_in') THEN
--     IF v_state->'sampled_amount'<>'null'::jsonb THEN RETURN false; END IF;
--   ELSIF p_decision->>'sampled_action_family'='call' THEN
--     v_expected_sample:=(v_state->>'to_call')::numeric;
--   ELSIF p_decision->>'sampled_action_family'='bet' THEN
--     v_expected_sample:=(v_state->>'pot')::numeric*(v_spec->>'size_value')::numeric;
--   ELSE
--     v_expected_sample:=(v_state->>'current_bet')::numeric+
--       ((v_state->>'pot')::numeric+(v_state->>'to_call')::numeric)*(v_spec->>'size_value')::numeric;
--   END IF;
--   IF v_expected_sample IS NOT NULL AND
--      (v_state->'sampled_amount'='null'::jsonb OR
--       abs((v_state->>'sampled_amount')::numeric-v_expected_sample)>0.0001) THEN RETURN false; END IF;
--
--   IF p_decision->>'final_action' IN ('check','fold','all_in') THEN
--     IF v_state->'final_amount'<>'null'::jsonb THEN RETURN false; END IF;
--   ELSIF v_state->'final_amount'='null'::jsonb THEN RETURN false;
--   END IF;
--   v_step:=CASE WHEN (v_state->>'big_blind')::numeric>=1
--                     AND (v_state->>'big_blind')::numeric=trunc((v_state->>'big_blind')::numeric)
--                THEN 1 ELSE 0.01 END;
--   v_amount_preserved:=v_state->'sampled_amount'<>'null'::jsonb
--     AND v_state->'final_amount'<>'null'::jsonb
--     AND abs((v_state->>'sampled_amount')::numeric-(v_state->>'final_amount')::numeric)<=v_step+0.005;
--   v_executed:=CASE p_decision->>'sampled_action_family'
--     WHEN 'call' THEN p_decision->>'final_action'='all_in' OR
--       (p_decision->>'final_action'='call' AND v_amount_preserved)
--     WHEN 'bet' THEN p_decision->>'final_action'='bet' AND v_amount_preserved
--     WHEN 'raise' THEN p_decision->>'final_action'='raise' AND v_amount_preserved
--     ELSE p_decision->>'final_action'=p_decision->>'sampled_action_family' END;
--   v_expected_pure:=v_max_probability>=0.9 AND
--     (NOT v_executed OR v_selected_probability<0.9);
--
--   IF (p_decision->>'executed_as_intended')::boolean IS DISTINCT FROM v_executed
--      OR abs((p_decision->>'chosen_probability')::numeric-
--        CASE WHEN v_executed THEN v_selected_probability ELSE 0 END)>0.000001
--      OR (p_decision->>'regret_eligible')::boolean IS DISTINCT FROM v_executed
--      OR (v_executed AND (p_decision->'action_regret_bb'='null'::jsonb OR
--          abs((p_decision->>'action_regret_bb')::numeric-v_regret)>0.0001))
--      OR (NOT v_executed AND p_decision->'action_regret_bb'<>'null'::jsonb)
--      OR (p_decision->>'pure_miss')::boolean IS DISTINCT FROM v_expected_pure
--   THEN RETURN false; END IF;
--   RETURN true;
-- EXCEPTION WHEN OTHERS THEN
--   RETURN false;
-- END;
-- $fn$;
-- REVOKE ALL ON FUNCTION public.fn_gto_v31_active_cells(integer,integer),public.fn_gto_v31_evaluation_cells(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
-- GRANT EXECUTE ON FUNCTION public.fn_gto_v31_active_cells(integer,integer),public.fn_gto_v31_evaluation_cells(uuid,integer,integer) TO service_role;
-- COMMIT;
-- END EXECUTABLE ROLLBACK
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $preimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure))<>'fc7eb5e3be9a52b6dc83db65900edc50' THEN RAISE EXCEPTION 'qualified contextual compaction preimage differs'; END IF;
END; $preimage$;
CREATE TEMP TABLE v31_feature_legacy_snapshot ON COMMIT DROP AS
 SELECT dataset_id,dataset_checksum,state FROM public.gto_v31_datasets;
CREATE TEMP TABLE v31_feature_legacy_functions ON COMMIT DROP AS
 SELECT oid::regprocedure::text AS signature,md5(pg_get_functiondef(oid)) AS digest
 FROM pg_proc WHERE oid IN ('public.fn_gto_v31_hand_key(integer,text)'::regprocedure,
 'public.fn_gto_v31_hand_key_valid(text,text)'::regprocedure);
CREATE TEMP TABLE v31_feature_rpc_owners ON COMMIT DROP AS
 SELECT oid::regprocedure::text AS signature,proowner FROM pg_proc WHERE oid IN
 ('public.fn_gto_v31_active_cells(integer,integer)'::regprocedure,
 'public.fn_gto_v31_evaluation_cells(uuid,integer,integer)'::regprocedure);


-- Versioned board-relative contract, independently qualified in isolated PostgreSQL 17.
-- Legacy fn_gto_v31_hand_key and its existing stored rows remain unchanged.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_board_relative_key_v2(p_combo_index integer,p_board text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE
  holes text[]; combo_high integer; combo_low integer;
  cards text[]; ranks integer[]:=ARRAY[]::integer[]; suits text[]:=ARRAY[]::text[];
  board_ranks integer[]; all_ranks integer[]; groups integer[]; multiplicities integer[];
  best integer[]:=ARRAY[]::integer[]; score integer[]; unique_ranks integer[];
  chosen integer[]; chosen_cards text[]; chosen_ranks integer[];
  bmult jsonb; hole_tuples jsonb[]:=ARRAY[]::jsonb[]; hole_relations jsonb;
  suit_tuples jsonb[]:=ARRAY[]::jsonb[]; suit_relations jsonb;
  tiebreak jsonb:='[]'::jsonb; tuple jsonb;
  i integer; j integer; a integer; b integer; c integer; d integer; e integer;
  r integer; top integer; contribution integer; min_hole integer:=2; max_hole integer:=0;
  straight integer; complete_ranks integer:=0; complete_cards integer:=0;
  flush_cards integer:=0; board_suit_count integer; hole_suit_count integer;
  unseen integer; adjacent integer:=0; one_gap integer:=0; windows integer:=0;
  suit text; suited_hole integer[]; run integer[]; is_flush boolean; has_straight boolean:=false;
  wire jsonb;
BEGIN
  IF p_combo_index NOT BETWEEN 0 AND 1325 OR length(p_board) NOT IN (6,8,10)
     OR p_board !~ '^([2-9TJQKA][cdhs]){3,5}$' THEN RETURN NULL; END IF;
  combo_high:=floor((1+sqrt(1+8*p_combo_index))/2)::integer;
  WHILE combo_high*(combo_high-1)/2>p_combo_index LOOP combo_high:=combo_high-1; END LOOP;
  WHILE (combo_high+1)*combo_high/2<=p_combo_index LOOP combo_high:=combo_high+1; END LOOP;
  combo_low:=p_combo_index-combo_high*(combo_high-1)/2;
  holes:=ARRAY[
    substr('23456789TJQKA',combo_low/4+1,1)||substr('cdhs',mod(combo_low,4)+1,1),
    substr('23456789TJQKA',combo_high/4+1,1)||substr('cdhs',mod(combo_high,4)+1,1)
  ];
  cards:=holes;
  FOR i IN 0..length(p_board)/2-1 LOOP cards:=array_append(cards,substr(p_board,2*i+1,2)); END LOOP;
  IF (SELECT count(DISTINCT value) FROM unnest(cards) value)<>cardinality(cards) THEN RETURN NULL; END IF;
  FOR i IN 1..cardinality(cards) LOOP
    ranks:=array_append(ranks,strpos('23456789TJQKA',substr(cards[i],1,1))+1);
    suits:=array_append(suits,substr(cards[i],2,1));
  END LOOP;
  SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO board_ranks FROM unnest(ranks[3:cardinality(ranks)]) value;
  SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO all_ranks FROM unnest(ranks) value;
  SELECT jsonb_agg(cnt ORDER BY cnt DESC) INTO bmult FROM (
    SELECT count(*)::integer cnt FROM unnest(ranks[3:cardinality(ranks)]) value GROUP BY value
  ) counted;
  FOR i IN 1..2 LOOP
    hole_tuples:=array_append(hole_tuples,jsonb_build_array(
      (SELECT count(*) FROM unnest(board_ranks) value WHERE value>ranks[i]),
      (SELECT count(*) FROM unnest(ranks[3:cardinality(ranks)]) value WHERE value=ranks[i]),
      CASE WHEN ranks[i]=14 THEN 1 ELSE 0 END));
  END LOOP;
  SELECT jsonb_agg(value ORDER BY (value->>0)::integer,(value->>1)::integer,(value->>2)::integer)
    INTO hole_relations FROM unnest(hole_tuples) value;

  -- Independent best-five enumeration (not the TS full-hand category counter).
  FOR a IN 1..cardinality(cards)-4 LOOP
   FOR b IN a+1..cardinality(cards)-3 LOOP
    FOR c IN b+1..cardinality(cards)-2 LOOP
     FOR d IN c+1..cardinality(cards)-1 LOOP
      FOR e IN d+1..cardinality(cards) LOOP
       chosen:=ARRAY[a,b,c,d,e];
       SELECT array_agg(ranks[x]),array_agg(cards[x]) INTO chosen_ranks,chosen_cards FROM unnest(chosen) x;
       SELECT array_agg(value ORDER BY cnt DESC,value DESC),array_agg(cnt ORDER BY cnt DESC,value DESC)
         INTO groups,multiplicities FROM (SELECT value,count(*)::integer cnt FROM unnest(chosen_ranks) value GROUP BY value) counted;
       SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO unique_ranks FROM unnest(chosen_ranks) value;
       is_flush:=(SELECT count(DISTINCT substr(value,2,1))=1 FROM unnest(chosen_cards) value);
       straight:=0;
       IF cardinality(unique_ranks)=5 THEN
         IF unique_ranks[1]-unique_ranks[5]=4 THEN straight:=unique_ranks[1];
         ELSIF unique_ranks=ARRAY[14,5,4,3,2] THEN straight:=5; END IF;
       END IF;
       IF is_flush AND straight>0 THEN score:=ARRAY[8,straight];
       ELSIF multiplicities[1]=4 THEN score:=ARRAY[7,groups[1],groups[2]];
       ELSIF multiplicities[1]=3 AND multiplicities[2]=2 THEN score:=ARRAY[6,groups[1],groups[2]];
       ELSIF is_flush THEN score:=ARRAY[5]||unique_ranks;
       ELSIF straight>0 THEN score:=ARRAY[4,straight];
       ELSIF multiplicities[1]=3 THEN score:=ARRAY[3]||groups;
       ELSIF multiplicities[1]=2 AND multiplicities[2]=2 THEN score:=ARRAY[2]||groups;
       ELSIF multiplicities[1]=2 THEN score:=ARRAY[1]||groups;
       ELSE score:=ARRAY[0]||unique_ranks; END IF;
       SELECT count(*)::integer INTO contribution FROM unnest(chosen) x WHERE x<=2;
       IF score>best THEN best:=score;min_hole:=contribution;max_hole:=contribution;
       ELSIF score=best THEN min_hole:=least(min_hole,contribution);max_hole:=greatest(max_hole,contribution); END IF;
      END LOOP;
     END LOOP;
    END LOOP;
   END LOOP;
  END LOOP;
  FOR i IN 2..cardinality(best) LOOP
    r:=best[i];
    tiebreak:=tiebreak||jsonb_build_array(jsonb_build_array(
      (SELECT count(*) FROM unnest(ranks[1:2]) value WHERE value=r),
      COALESCE(array_position(board_ranks,r)-1,-1),
      CASE WHEN r=ANY(ranks[1:2]) THEN 14-r ELSE -1 END));
  END LOOP;
  FOREACH suit IN ARRAY ARRAY['c','d','h','s'] LOOP
    SELECT count(*)::integer INTO board_suit_count FROM generate_series(3,cardinality(cards)) x WHERE suits[x]=suit;
    SELECT count(*)::integer INTO hole_suit_count FROM generate_series(1,2) x WHERE suits[x]=suit;
    SELECT array_agg(ranks[x] ORDER BY ranks[x] DESC) INTO suited_hole FROM generate_series(1,2) x WHERE suits[x]=suit;
    tuple:=jsonb_build_array(board_suit_count,hole_suit_count);
    IF suited_hole IS NOT NULL THEN
      FOREACH r IN ARRAY suited_hole LOOP
        SELECT count(*)::integer INTO unseen FROM generate_series(r+1,14) higher
          WHERE NOT EXISTS (SELECT 1 FROM generate_series(1,cardinality(cards)) x WHERE ranks[x]=higher AND suits[x]=suit);
        tuple:=tuple||jsonb_build_array(unseen);
      END LOOP;
    END IF;
    suit_tuples:=array_append(suit_tuples,tuple);
    IF cardinality(cards)<7 AND board_suit_count+hole_suit_count=4 THEN flush_cards:=flush_cards+9; END IF;
  END LOOP;
  SELECT jsonb_agg(value ORDER BY (value->>0)::integer,(value->>1)::integer,
    COALESCE((value->>2)::integer,-1),COALESCE((value->>3)::integer,-1)) INTO suit_relations FROM unnest(suit_tuples) value;
  FOR top IN 5..14 LOOP
    run:=CASE WHEN top=5 THEN ARRAY[14,2,3,4,5] ELSE ARRAY[top-4,top-3,top-2,top-1,top] END;
    IF all_ranks @> run THEN has_straight:=true; END IF;
    IF (SELECT count(*) FROM unnest(run) value WHERE value=ANY(board_ranks))>=4 THEN windows:=windows+1; END IF;
  END LOOP;
  IF cardinality(cards)<7 AND NOT has_straight THEN
    FOR r IN 2..14 LOOP
      IF NOT r=ANY(all_ranks) THEN
        FOR top IN 5..14 LOOP
          run:=CASE WHEN top=5 THEN ARRAY[14,2,3,4,5] ELSE ARRAY[top-4,top-3,top-2,top-1,top] END;
          IF (all_ranks||r) @> run THEN complete_ranks:=complete_ranks+1;complete_cards:=complete_cards+4;EXIT; END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;
  FOR i IN 1..cardinality(board_ranks) LOOP FOR j IN i+1..cardinality(board_ranks) LOOP
    IF board_ranks[i]-board_ranks[j]=1 OR (board_ranks[i]=14 AND board_ranks[j]=2) THEN adjacent:=adjacent+1; END IF;
    IF board_ranks[i]-board_ranks[j]=2 OR (board_ranks[i]=14 AND board_ranks[j]=3) THEN one_gap:=one_gap+1; END IF;
  END LOOP; END LOOP;
  wire:=jsonb_build_array('holdem-board-relative-v2',cardinality(cards)-2,best[1],bmult,hole_relations,
    ranks[1]=ranks[2],complete_ranks,complete_cards,suit_relations,flush_cards,tiebreak,
    jsonb_build_array(min_hole,max_hole),jsonb_build_array(adjacent,one_gap,windows));
  RETURN regexp_replace(wire::text,'\s','','g');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_board_relative_key_v2_valid(p_key text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE
  v jsonb; tuple jsonb; item jsonb; field integer; integer_value integer;
BEGIN
  v:=p_key::jsonb;
  IF jsonb_typeof(v)<>'array' OR jsonb_array_length(v)<>13
     OR v->>0<>'holdem-board-relative-v2' OR regexp_replace(v::text,'\s','','g')<>p_key
     OR jsonb_typeof(v->5)<>'boolean' THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY[1,2,6,7,9] LOOP
    IF jsonb_typeof(v->field)<>'number' OR (v->>field)!~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
  END LOOP;
  IF (v->>1)::integer NOT IN (3,4,5) OR (v->>2)::integer NOT BETWEEN 0 AND 8
     OR (v->>6)::integer>13 OR (v->>7)::integer<>4*(v->>6)::integer
     OR (v->>9)::integer NOT IN (0,9) OR ((v->>1)::integer=5 AND ((v->>6)::integer<>0 OR (v->>9)::integer<>0)) THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY[3,4,8,10,11,12] LOOP
    IF jsonb_typeof(v->field)<>'array' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_array_length(v->3) NOT BETWEEN 1 AND (v->>1)::integer
     OR jsonb_array_length(v->4)<>2 OR jsonb_array_length(v->8)<>4
     OR jsonb_array_length(v->10) NOT BETWEEN 1 AND 5 OR jsonb_array_length(v->11)<>2 OR jsonb_array_length(v->12)<>3 THEN RETURN false; END IF;
  IF jsonb_array_length(v->10)<>(CASE (v->>2)::integer
       WHEN 0 THEN 5 WHEN 1 THEN 4 WHEN 2 THEN 3 WHEN 3 THEN 3
       WHEN 4 THEN 1 WHEN 5 THEN 5 WHEN 6 THEN 2 WHEN 7 THEN 2 ELSE 1 END) THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(v->3) LOOP
    IF jsonb_typeof(item)<>'number' OR item::text !~ '^[1-4]$' THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT sum(value::text::integer) FROM jsonb_array_elements(v->3))<>(v->>1)::integer THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY[4,8,10] LOOP
    FOR tuple IN SELECT value FROM jsonb_array_elements(v->field) LOOP
      IF jsonb_typeof(tuple)<>'array' OR jsonb_array_length(tuple) NOT BETWEEN 2 AND 4
        OR (field IN (4,10) AND jsonb_array_length(tuple)<>3)
        OR (field=8 AND jsonb_array_length(tuple)<>2+(tuple->>1)::integer) THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(tuple) LOOP
        IF jsonb_typeof(item)<>'number' OR item::text !~ '^(-1|0|[1-9][0-9]*)$' THEN RETURN false; END IF;
        integer_value:=item::text::integer;
        IF integer_value NOT BETWEEN (CASE WHEN field=10 THEN -1 ELSE 0 END) AND 12 THEN RETURN false; END IF;
      END LOOP;
      IF field=4 AND ((tuple->>0)::integer>(v->>1)::integer
         OR (tuple->>1)::integer>3 OR (tuple->>2)::integer NOT IN (0,1)) THEN RETURN false; END IF;
      IF field=8 AND ((tuple->>0)::integer>(v->>1)::integer OR (tuple->>1)::integer>2) THEN RETURN false; END IF;
      IF field=10 AND ((tuple->>0)::integer NOT BETWEEN 0 AND 2
         OR (tuple->>1)::integer NOT BETWEEN -1 AND jsonb_array_length(v->3)-1
         OR ((tuple->>0)::integer=0 AND (tuple->>2)::integer<>-1)
         OR ((tuple->>0)::integer>0 AND (tuple->>2)::integer<0)
         OR ((tuple->>0)::integer=0 AND (tuple->>1)::integer=-1)) THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  IF (SELECT sum((value->>0)::integer) FROM jsonb_array_elements(v->8))<>(v->>1)::integer
     OR (SELECT sum((value->>1)::integer) FROM jsonb_array_elements(v->8))<>2
     OR ((v->>5)::boolean AND (v#>'{4,0}'<>v#>'{4,1}' OR (v#>>'{4,0,1}')::integer>2)) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements((v->11)||(v->12)) AS parts(value)
    WHERE jsonb_typeof(parts.value)<>'number' OR parts.value::text !~ '^(0|[1-9][0-9]*)$')
    OR (v#>>'{11,0}')::integer NOT BETWEEN greatest(0,5-(v->>1)::integer) AND 2
    OR (v#>>'{11,1}')::integer NOT BETWEEN (v#>>'{11,0}')::integer AND 2
    OR (v#>>'{12,0}')::integer>10 OR (v#>>'{12,1}')::integer>10 OR (v#>>'{12,2}')::integer>10 THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$fn$;



CREATE OR REPLACE FUNCTION public.fn_gto_v31_feature_identity(p_version text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
BEGIN
 IF p_version IS NULL THEN RETURN '{}'::jsonb; END IF;
 IF p_version NOT IN ('rank-suit-count-v1','holdem-board-relative-v2') THEN RAISE EXCEPTION 'unknown feature contract version'; END IF;
 RETURN jsonb_build_object('feature_contract_version',p_version);
END; $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_feature_request_valid(p_request jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public AS $fn$
 SELECT COALESCE(NOT(p_request ? 'feature_contract_version') OR
 (jsonb_typeof(p_request->'feature_contract_version')='string' AND
 p_request->>'feature_contract_version' IN ('rank-suit-count-v1','holdem-board-relative-v2')),false);
$fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_feature_key(p_combo integer,p_board text,p_version text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
BEGIN
 PERFORM public.fn_gto_v31_feature_identity(p_version);
 IF p_version='holdem-board-relative-v2' THEN RETURN public.fn_gto_v31_board_relative_key_v2(p_combo,p_board); END IF;
 RETURN public.fn_gto_v31_hand_key(p_combo,p_board);
END; $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_feature_key_valid(p_key text,p_street text,p_version text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
BEGIN
 IF p_version='holdem-board-relative-v2' THEN
   RETURN public.fn_gto_v31_board_relative_key_v2_valid(p_key) AND (p_key::jsonb->>1)::integer=CASE p_street WHEN 'flop' THEN 3 WHEN 'turn' THEN 4 WHEN 'river' THEN 5 ELSE -1 END;
 END IF;
 IF p_version IS NOT NULL AND p_version<>'rank-suit-count-v1' THEN RETURN false; END IF;
 RETURN public.fn_gto_v31_hand_key_valid(p_key,p_street);
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $fn$;


ALTER TABLE public.gto_v31_input_bundles ADD COLUMN feature_contract_version text CHECK(feature_contract_version IN ('rank-suit-count-v1','holdem-board-relative-v2'));

ALTER TABLE public.gto_v31_datasets ADD COLUMN feature_contract_version text CHECK(feature_contract_version IN ('rank-suit-count-v1','holdem-board-relative-v2'));

ALTER TABLE public.gto_v31_runtime_cells ADD COLUMN feature_contract_version text CHECK(feature_contract_version IN ('rank-suit-count-v1','holdem-board-relative-v2'));

CREATE OR REPLACE FUNCTION public.fn_gto_v31_feature_binding_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $fn$
BEGIN
 IF NEW.feature_contract_version IS DISTINCT FROM OLD.feature_contract_version THEN RAISE EXCEPTION 'feature contract version is immutable'; END IF;
 RETURN NEW;
END; $fn$;

CREATE TRIGGER gto_v31_input_bundles_feature_binding_immutable BEFORE UPDATE ON public.gto_v31_input_bundles FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_feature_binding_immutable();

CREATE TRIGGER gto_v31_datasets_feature_binding_immutable BEFORE UPDATE ON public.gto_v31_datasets FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_feature_binding_immutable();

CREATE TRIGGER gto_v31_runtime_cells_feature_binding_immutable BEFORE UPDATE ON public.gto_v31_runtime_cells FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_feature_binding_immutable();

CREATE OR REPLACE FUNCTION public.fn_gto_v31_input_bundle_checksum(p_bundle jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
CALLED ON NULL INPUT
SET search_path = public, extensions
AS $fn$
DECLARE
  v_file jsonb;
  v_files jsonb;
  v_identity jsonb;
BEGIN
  IF p_bundle IS NULL
     OR jsonb_typeof(p_bundle) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_bundle)) <> (7 + CASE WHEN p_bundle ? 'feature_contract_version' THEN 1 ELSE 0 END)
     OR NOT (p_bundle ?& ARRAY['bundle_key','bundle_version','range_bundle_checksum',
       'source_combo_order_checksum','icm_model_checksum','files','approval_note'])
     OR NOT public.fn_gto_v31_feature_request_valid(p_bundle)
     OR jsonb_typeof(p_bundle->'bundle_key') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_bundle->'bundle_version') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_bundle->'range_bundle_checksum') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_bundle->'source_combo_order_checksum') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_bundle->'icm_model_checksum') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_bundle->'approval_note') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_bundle->'files') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_bundle->'files') = 0
     OR p_bundle->>'bundle_key' !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR p_bundle->>'bundle_version' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR p_bundle->>'range_bundle_checksum' !~ '^[0-9a-f]{64}$'
     OR p_bundle->>'range_bundle_checksum' = repeat('0',64)
     OR p_bundle->>'source_combo_order_checksum' !~ '^[0-9a-f]{64}$'
     OR p_bundle->>'source_combo_order_checksum' = repeat('0',64)
     OR p_bundle->>'icm_model_checksum' !~ '^[0-9a-f]{64}$'
     OR p_bundle->>'icm_model_checksum' = repeat('0',64)
     OR p_bundle->>'approval_note' !~ '[^[:space:]]'
     OR length(p_bundle->>'approval_note') > 2000 THEN
    RAISE EXCEPTION 'V31 input bundle identity requires canonical JSON strings';
  END IF;

  FOR v_file IN SELECT value FROM jsonb_array_elements(p_bundle->'files') LOOP
    IF jsonb_typeof(v_file) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_file)) <> 3
       OR NOT (v_file ?& ARRAY['kind','path','checksum'])
       OR jsonb_typeof(v_file->'kind') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_file->'path') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_file->'checksum') IS DISTINCT FROM 'string'
       OR v_file->>'kind' NOT IN ('range','combo_order','icm_model','payout_model','scenario_manifest')
       OR v_file->>'path' !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$'
       OR position('..' IN v_file->>'path') > 0
       OR ('/' || (v_file->>'path') || '/') LIKE '%//%'
       OR ('/' || (v_file->>'path') || '/') LIKE '%/./%'
       OR v_file->>'checksum' !~ '^[0-9a-f]{64}$'
       OR v_file->>'checksum' = repeat('0',64) THEN
      RAISE EXCEPTION 'V31 input bundle identity contains a noncanonical file receipt';
    END IF;
  END LOOP;

  IF (SELECT count(DISTINCT value->>'path') FROM jsonb_array_elements(p_bundle->'files'))
       <> jsonb_array_length(p_bundle->'files')
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='range') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='range'
         AND f.value->>'checksum'=p_bundle->>'range_bundle_checksum') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='combo_order') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='combo_order'
         AND f.value->>'checksum'=p_bundle->>'source_combo_order_checksum') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='icm_model') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='icm_model'
         AND f.value->>'checksum'=p_bundle->>'icm_model_checksum') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='scenario_manifest') <> 1 THEN
    RAISE EXCEPTION 'V31 input bundle identity does not reconcile its file receipts';
  END IF;

  SELECT jsonb_agg(
           value
           ORDER BY (value->>'kind') COLLATE "C",
                    (value->>'path') COLLATE "C",
                    (value->>'checksum') COLLATE "C"
         )
    INTO v_files
    FROM jsonb_array_elements(p_bundle->'files') f(value)
   WHERE value->>'kind' <> 'scenario_manifest';

  v_identity := jsonb_build_object(
    'contract','smarter-poker.horse-solver-v31-input-bundle.v2',
    'bundle_key',p_bundle->'bundle_key',
    'bundle_version',p_bundle->'bundle_version',
    'range_bundle_checksum',p_bundle->'range_bundle_checksum',
    'source_combo_order_checksum',p_bundle->'source_combo_order_checksum',
    'icm_model_checksum',p_bundle->'icm_model_checksum',
    'files',v_files
  );

  v_identity := v_identity || public.fn_gto_v31_feature_identity(p_bundle->>'feature_contract_version');
  RETURN encode(digest(convert_to(
    public.fn_training_canonical_jsonb_text_v1(v_identity),
    'UTF8'
  ),'sha256'),'hex');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ca_gto_v31_approve_input_bundle(p_bundle jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id uuid;
  v_checksum text;
  v_actor uuid := auth.uid();
  v_file jsonb;
  v_inserted integer;
BEGIN
  IF COALESCE(auth.role(),'') <> 'authenticated' OR v_actor IS NULL OR NOT public.fn_is_horse_admin() THEN
    RAISE EXCEPTION 'admin approval required';
  END IF;
  IF p_bundle IS NULL OR jsonb_typeof(p_bundle) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_bundle)) <> (7 + CASE WHEN p_bundle ? 'feature_contract_version' THEN 1 ELSE 0 END)
     OR NOT (p_bundle ?& ARRAY['bundle_key','bundle_version','range_bundle_checksum',
       'source_combo_order_checksum','icm_model_checksum','files','approval_note'])
     OR NOT public.fn_gto_v31_feature_request_valid(p_bundle)
     OR COALESCE(p_bundle->>'bundle_key','') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR COALESCE(p_bundle->>'bundle_version','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR COALESCE(p_bundle->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_bundle->>'range_bundle_checksum' = repeat('0',64)
     OR COALESCE(p_bundle->>'source_combo_order_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_bundle->>'source_combo_order_checksum' = repeat('0',64)
     OR COALESCE(p_bundle->>'icm_model_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_bundle->>'icm_model_checksum' = repeat('0',64)
     OR jsonb_typeof(p_bundle->'files') <> 'array'
     OR jsonb_array_length(p_bundle->'files') = 0
     OR nullif(btrim(p_bundle->>'approval_note'),'') IS NULL
     OR length(p_bundle->>'approval_note') > 2000 THEN
    RAISE EXCEPTION 'approved input bundle is incomplete';
  END IF;
  FOR v_file IN SELECT value FROM jsonb_array_elements(p_bundle->'files') LOOP
    IF jsonb_typeof(v_file) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_file)) <> 3
       OR NOT (v_file ?& ARRAY['kind','path','checksum'])
       OR v_file->>'kind' NOT IN ('range','combo_order','icm_model','payout_model','scenario_manifest')
       OR COALESCE(v_file->>'path','') !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$'
       OR position('..' IN v_file->>'path') > 0
       OR COALESCE(v_file->>'checksum','') !~ '^[0-9a-f]{64}$'
       OR v_file->>'checksum' = repeat('0',64) THEN
      RAISE EXCEPTION 'approved input bundle contains an invalid file receipt';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'path') FROM jsonb_array_elements(p_bundle->'files'))
       <> jsonb_array_length(p_bundle->'files')
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='range' AND
             f.value->>'checksum'=p_bundle->>'range_bundle_checksum') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='range') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='combo_order' AND
             f.value->>'checksum'=p_bundle->>'source_combo_order_checksum') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='combo_order') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='icm_model' AND
             f.value->>'checksum'=p_bundle->>'icm_model_checksum') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='icm_model') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='scenario_manifest') <> 1 THEN
    RAISE EXCEPTION 'approved input bundle does not reconcile its files';
  END IF;

  v_checksum := public.fn_gto_v31_input_bundle_checksum(p_bundle);
  v_id := public.fn_gto_v31_input_bundle_id(v_checksum);
  INSERT INTO public.gto_v31_input_bundles (
    input_bundle_id,bundle_key,bundle_checksum,range_bundle_checksum,
    source_combo_order_checksum,icm_model_checksum,bundle_manifest,approved_by,feature_contract_version
  ) VALUES (
    v_id,p_bundle->>'bundle_key',v_checksum,p_bundle->>'range_bundle_checksum',
    p_bundle->>'source_combo_order_checksum',p_bundle->>'icm_model_checksum',p_bundle,v_actor,p_bundle->>'feature_contract_version'
  ) ON CONFLICT (input_bundle_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 AND NOT EXISTS (
    SELECT 1
      FROM public.gto_v31_input_bundles b
     WHERE b.input_bundle_id=v_id
       AND b.bundle_key=p_bundle->>'bundle_key'
       AND b.bundle_checksum=v_checksum
       AND b.range_bundle_checksum=p_bundle->>'range_bundle_checksum'
       AND b.source_combo_order_checksum=p_bundle->>'source_combo_order_checksum'
       AND b.icm_model_checksum=p_bundle->>'icm_model_checksum'
       AND b.bundle_manifest=p_bundle
       AND b.approval_status='approved'
  ) THEN
    RAISE EXCEPTION 'V31 input bundle identity was reused with another approval payload';
  END IF;
  RETURN v_id;
END;
$fn$;

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
     OR (SELECT count(*) FROM jsonb_object_keys(p_dataset)) <> (15 + CASE WHEN p_dataset ? 'feature_contract_version' THEN 1 ELSE 0 END)
     OR NOT (p_dataset ?& ARRAY[
       'dataset_key','solver_version','solver_binary_checksum','pipeline_commit',
       'pipeline_bundle_checksum','manifest_version','manifest_checksum',
       'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
       'input_bundle_id','input_bundle_checksum','machine_ids','declared_coverage','quality_gates'
     ])
     OR NOT public.fn_gto_v31_feature_request_valid(p_dataset)
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
     OR v_bundle.feature_contract_version IS DISTINCT FROM p_dataset->>'feature_contract_version'
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
    input_bundle_id, input_bundle_checksum, machine_ids, declared_coverage, quality_gates, feature_contract_version
  ) VALUES (
    p_dataset->>'dataset_key', p_dataset->>'solver_version', p_dataset->>'solver_binary_checksum',
    p_dataset->>'pipeline_commit', p_dataset->>'pipeline_bundle_checksum',
    p_dataset->>'manifest_version', p_dataset->>'manifest_checksum',
    p_dataset->>'source_combo_order_checksum', p_dataset->>'range_bundle_checksum',
    p_dataset->>'icm_model_checksum', (p_dataset->>'input_bundle_id')::uuid,
    p_dataset->>'input_bundle_checksum', v_machines, p_dataset->'declared_coverage', v_gates,p_dataset->>'feature_contract_version'
  ) RETURNING dataset_id INTO v_id;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_worker_contract(p_dataset_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF COALESCE(p_dataset_key,'') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$' THEN
    RAISE EXCEPTION 'dataset key is invalid';
  END IF;
  SELECT jsonb_build_object(
    'contract','smarter-poker.gto-v31-worker-contract.v1',
    'dataset_id',d.dataset_id,'dataset_key',d.dataset_key,'state',d.state,
    'quality_status',d.quality_status,'dataset_checksum',d.dataset_checksum,
    'source_artifact_checksum',d.source_artifact_checksum,
    'solver_version',d.solver_version,
    'solver_binary_checksum',d.solver_binary_checksum,
    'pipeline_commit',d.pipeline_commit,
    'pipeline_bundle_checksum',d.pipeline_bundle_checksum,
    'manifest_version',d.manifest_version,'manifest_checksum',d.manifest_checksum,
    'source_combo_order_checksum',d.source_combo_order_checksum,
    'range_bundle_checksum',d.range_bundle_checksum,
    'icm_model_checksum',d.icm_model_checksum,
    'input_bundle_checksum',d.input_bundle_checksum,
    'input_approval_status',b.approval_status,
    'machine_ids',d.machine_ids,'declared_cells',jsonb_array_length(d.declared_coverage)
  ) || public.fn_gto_v31_feature_identity(d.feature_contract_version) INTO v_result
    FROM public.gto_v31_datasets d
    JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
   WHERE d.dataset_key=p_dataset_key;
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_key_checksum(p_cell jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
  SELECT public.fn_gto_v31_json_checksum(jsonb_build_object(
    'street',p_cell->'street',
    'game_family',p_cell->'game_family',
    'objective',p_cell->'objective',
    'utility_context',p_cell->'utility_context',
    'table_size',p_cell->'table_size',
    'pot_type',p_cell->'pot_type',
    'hero_position',p_cell->'hero_position',
    'opponent_position',p_cell->'opponent_position',
    'depth_bucket',p_cell->'depth_bucket',
    'texture_class',p_cell->'texture_class',
    'node_role',p_cell->'node_role',
    'facing_kind',p_cell->'facing_kind',
    'facing_size_bucket',p_cell->'facing_size_bucket'
  ) || public.fn_gto_v31_feature_identity(p_cell->>'feature_contract_version'));
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_matrix_valid(
  p_matrix jsonb,
  p_street text,p_version text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_key text;
BEGIN
  IF p_matrix IS NULL OR jsonb_typeof(p_matrix) <> 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_matrix)) THEN
    RETURN false;
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_matrix) LOOP
    IF NOT public.fn_gto_v31_feature_key_valid(v_key,p_street,p_version) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_compact_matrices_valid(
  p_matrix jsonb,
  p_specs jsonb,
  p_policy_evs jsonb,
  p_action_evs jsonb,
  p_street text,p_version text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_hand record;
  v_action text;
  v_value numeric;
  v_sum numeric;
  v_action_count integer;
BEGIN
  IF NOT public.fn_gto_v31_action_specs_valid(p_specs)
     OR NOT public.fn_gto_v31_hand_matrix_valid(p_matrix,p_street,p_version)
     OR jsonb_typeof(p_policy_evs) <> 'object'
     OR jsonb_typeof(p_action_evs) <> 'object' THEN
    RETURN false;
  END IF;
  v_action_count := (SELECT count(*) FROM jsonb_object_keys(p_specs));
  IF (SELECT count(*) FROM jsonb_object_keys(p_policy_evs)) <>
       (SELECT count(*) FROM jsonb_object_keys(p_matrix))
     OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs)) <>
       (SELECT count(*) FROM jsonb_object_keys(p_matrix)) THEN
    RETURN false;
  END IF;

  FOR v_hand IN SELECT key,value FROM jsonb_each(p_matrix) LOOP
    IF jsonb_typeof(v_hand.value) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_hand.value)) <> v_action_count
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
          WHERE NOT (v_hand.value ? a.key)
       )
       OR NOT (p_policy_evs ? v_hand.key)
       OR jsonb_typeof(p_policy_evs->v_hand.key) <> 'number'
       OR NOT (p_action_evs ? v_hand.key)
       OR jsonb_typeof(p_action_evs->v_hand.key) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs->v_hand.key)) <> v_action_count
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
          WHERE NOT ((p_action_evs->v_hand.key) ? a.key)
       ) THEN
      RETURN false;
    END IF;
    v_sum := 0;
    FOR v_action IN SELECT jsonb_object_keys(p_specs) LOOP
      IF jsonb_typeof(v_hand.value->v_action) <> 'number'
         OR jsonb_typeof(p_action_evs->v_hand.key->v_action) <> 'number' THEN
        RETURN false;
      END IF;
      v_value := (v_hand.value->>v_action)::numeric;
      IF v_value < 0 OR v_value > 1 THEN RETURN false; END IF;
      v_sum := v_sum + v_value;
    END LOOP;
    IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_payload_valid(p_cell jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_role text := p_cell->>'node_role';
  v_facing text := p_cell->>'facing_kind';
  v_bucket text := p_cell->>'facing_size_bucket';
  v_action record;
  v_hand record;
  v_frequency record;
  v_sum numeric;
  v_family text;
  v_unit text;
  v_size numeric;
  v_actions jsonb := p_cell->'action_specs';
  v_matrix jsonb := p_cell->'hand_matrix';
  v_policy_evs jsonb := COALESCE(p_cell->'policy_ev_matrix', '{}'::jsonb);
  v_action_evs jsonb := COALESCE(p_cell->'action_ev_matrix', '{}'::jsonb);
  v_has_check boolean := false;
  v_has_fold boolean := false;
  v_has_call boolean := false;
  v_has_bet boolean := false;
  v_has_raise boolean := false;
  v_has_all_in boolean := false;
  v_table_size integer := COALESCE((p_cell->>'table_size')::integer,0);
  v_allowed_positions text[];
BEGIN
  IF p_cell IS NULL OR jsonb_typeof(p_cell) <> 'object'
     OR NOT public.fn_gto_v31_compact_matrices_valid(
       v_matrix,v_actions,v_policy_evs,v_action_evs,p_cell->>'street',p_cell->>'feature_contract_version'
     )
     OR jsonb_typeof(p_cell->'source_rows') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_cell->'train_source_rows') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_cell->'holdout_source_rows') IS DISTINCT FROM 'number'
     OR (p_cell->>'source_rows')::integer IS DISTINCT FROM
        (p_cell->>'train_source_rows')::integer + (p_cell->>'holdout_source_rows')::integer
     OR COALESCE(p_cell->>'cell_key_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_cell->>'cell_key_checksum' = repeat('0',64)
     OR p_cell->>'cell_key_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_key_checksum(p_cell)
     OR COALESCE(p_cell->>'cell_payload_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_cell->>'cell_payload_checksum' = repeat('0',64)
     OR p_cell->>'cell_payload_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_payload_checksum(p_cell)
     OR COALESCE(p_cell->>'lineage_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_cell->>'lineage_checksum' = repeat('0',64)
     OR COALESCE(p_cell->>'street','') NOT IN ('flop','turn','river')
     OR COALESCE(p_cell->>'game_family','') NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR COALESCE(p_cell->>'objective','') NOT IN ('cash_ev','chip_ev','icm')
     OR COALESCE(p_cell->>'utility_context','') NOT IN ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
     OR v_table_size NOT BETWEEN 2 AND 10
     OR COALESCE(p_cell->>'pot_type','') NOT IN ('limped','srp','3bet','4bet_plus')
     OR COALESCE(p_cell->>'hero_position','') NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR COALESCE(p_cell->>'opponent_position','') NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR p_cell->>'hero_position' = p_cell->>'opponent_position'
     OR COALESCE((p_cell->>'depth_bucket')::integer,0) NOT IN (10,20,40,80,150)
     OR COALESCE(p_cell->>'texture_class','') !~ '^[ABML][mtr][pu][cd]$'
     OR COALESCE(v_role,'') NOT IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')
     OR COALESCE(v_facing,'') NOT IN ('none','bet','raise','all_in')
     OR COALESCE(v_bucket,'') NOT IN ('none','small','mid','big','all_in')
     OR jsonb_typeof(v_actions) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_actions)) < 2
     OR jsonb_typeof(v_matrix) <> 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_matrix))
     OR jsonb_typeof(v_policy_evs) <> 'object'
     OR jsonb_typeof(v_action_evs) <> 'object'
     OR COALESCE((p_cell->>'source_rows')::integer,0) <= 0
     OR COALESCE((p_cell->>'train_source_rows')::integer,0) <= 0
     OR COALESCE((p_cell->>'holdout_source_rows')::integer,0) <= 0 THEN
    RETURN false;
  END IF;

  IF NOT ((p_cell->>'game_family' = 'cash' AND p_cell->>'objective' = 'cash_ev') OR
          (p_cell->>'game_family' = 'tourney_icm' AND p_cell->>'objective' = 'icm') OR
          (p_cell->>'game_family' = 'tourney_ev' AND p_cell->>'objective' = 'chip_ev') OR
          (p_cell->>'game_family' = 'spin' AND p_cell->>'objective' IN ('chip_ev','icm'))) THEN
    RETURN false;
  END IF;
  IF NOT ((p_cell->>'objective' = 'cash_ev' AND p_cell->>'utility_context' = 'cash_ev') OR
          (p_cell->>'objective' = 'chip_ev' AND p_cell->>'utility_context' = 'chip_ev') OR
          (p_cell->>'objective' = 'icm' AND p_cell->>'game_family' = 'spin' AND
           p_cell->>'utility_context' = 'spin_ladder') OR
          (p_cell->>'objective' = 'icm' AND p_cell->>'game_family' = 'tourney_icm' AND
           p_cell->>'utility_context' IN ('satellite','bubble','final_table','in_money','ladder'))) THEN
    RETURN false;
  END IF;

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
  IF NOT (p_cell->>'hero_position' = ANY(v_allowed_positions))
     OR NOT (p_cell->>'opponent_position' = ANY(v_allowed_positions)) THEN
    RETURN false;
  END IF;

  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF v_facing <> 'none' OR v_bucket <> 'none' THEN RETURN false; END IF;
  ELSIF v_role = 'all_in' THEN
    IF v_facing <> 'all_in' OR v_bucket <> 'all_in' THEN RETURN false; END IF;
  ELSIF (v_role = 'facing_bet' AND v_facing <> 'bet')
     OR (v_role IN ('facing_raise','check_raise','bet_raise') AND v_facing <> 'raise')
     OR v_bucket NOT IN ('small','mid','big') THEN
    RETURN false;
  END IF;

  FOR v_action IN SELECT key, value FROM jsonb_each(v_actions) LOOP
    IF v_action.key = '' OR jsonb_typeof(v_action.value) <> 'object' THEN RETURN false; END IF;
    v_family := v_action.value->>'family';
    v_unit := v_action.value->>'size_unit';
    IF v_family NOT IN ('check','fold','call','bet','raise','all_in') THEN RETURN false; END IF;
    IF v_family = 'check' THEN v_has_check := true; END IF;
    IF v_family = 'fold' THEN v_has_fold := true; END IF;
    IF v_family = 'call' THEN v_has_call := true; END IF;
    IF v_family = 'bet' THEN v_has_bet := true; END IF;
    IF v_family = 'raise' THEN v_has_raise := true; END IF;
    IF v_family = 'all_in' THEN v_has_all_in := true; END IF;
    IF v_family IN ('check','fold','call') THEN
      IF v_unit IS DISTINCT FROM 'none'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN RETURN false; END IF;
    ELSIF v_family = 'all_in' THEN
      IF v_unit IS DISTINCT FROM 'all_in'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM true THEN RETURN false; END IF;
    ELSE
      BEGIN v_size := (v_action.value->>'size_value')::numeric; EXCEPTION WHEN OTHERS THEN RETURN false; END;
      IF v_size <= 0 OR v_size > 20 OR COALESCE((v_action.value->>'all_in')::boolean,false)
         OR (v_family = 'bet' AND v_unit <> 'pot_fraction')
         OR (v_family = 'raise' AND v_unit <> 'pot_after_call_fraction') THEN RETURN false; END IF;
    END IF;
  END LOOP;

  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF NOT v_has_check OR v_has_fold OR v_has_call THEN RETURN false; END IF;
  ELSE
    IF NOT v_has_fold OR NOT v_has_call OR v_has_check OR v_has_bet THEN RETURN false; END IF;
    IF v_role = 'all_in' AND (v_has_raise OR v_has_all_in) THEN RETURN false; END IF;
  END IF;

  FOR v_hand IN SELECT key, value FROM jsonb_each(v_matrix) LOOP
    IF NOT public.fn_gto_v31_feature_key_valid(v_hand.key,p_cell->>'street',p_cell->>'feature_contract_version')
       OR jsonb_typeof(v_hand.value) <> 'object'
       OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_hand.value)) THEN
      RETURN false;
    END IF;
    v_sum := 0;
    FOR v_frequency IN SELECT key, value FROM jsonb_each(v_hand.value) LOOP
      IF NOT (v_actions ? v_frequency.key) OR jsonb_typeof(v_frequency.value) <> 'number' THEN RETURN false; END IF;
      BEGIN v_size := (v_frequency.value #>> '{}')::numeric; EXCEPTION WHEN OTHERS THEN RETURN false; END;
      IF v_size < 0 OR v_size > 1 THEN RETURN false; END IF;
      v_sum := v_sum + v_size;
    END LOOP;
    IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;

    IF NOT (v_policy_evs ? v_hand.key)
       OR jsonb_typeof(v_policy_evs -> (v_hand.key)) <> 'number' THEN
      RETURN false;
    END IF;
    IF NOT (v_action_evs ? v_hand.key)
       OR jsonb_typeof(v_action_evs -> (v_hand.key)) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_action_evs -> (v_hand.key))) <>
          (SELECT count(*) FROM jsonb_object_keys(v_actions))
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_actions) a(key)
            WHERE NOT ((v_action_evs -> (v_hand.key)) ? a.key)) THEN
      RETURN false;
    END IF;
    FOR v_frequency IN SELECT key, value FROM jsonb_each(v_action_evs -> (v_hand.key)) LOOP
      IF NOT (v_actions ? v_frequency.key)
         OR jsonb_typeof(v_frequency.value) <> 'number' THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_policy_evs) AS k(value) WHERE NOT (v_matrix ? k.value)
     ) OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_action_evs) AS k(value) WHERE NOT (v_matrix ? k.value)
     ) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

ALTER TABLE public.gto_v31_runtime_cells DROP CONSTRAINT gto_v31_runtime_cells_hand_keys_match_street_chk, DROP CONSTRAINT gto_v31_runtime_cells_compact_matrices_valid_chk;
ALTER TABLE public.gto_v31_runtime_cells ADD CONSTRAINT gto_v31_runtime_cells_hand_keys_match_street_chk CHECK(public.fn_gto_v31_hand_matrix_valid(hand_matrix,street,feature_contract_version)), ADD CONSTRAINT gto_v31_runtime_cells_compact_matrices_valid_chk CHECK(public.fn_gto_v31_compact_matrices_valid(hand_matrix,action_specs,policy_ev_matrix,action_ev_matrix,street,feature_contract_version));

CREATE OR REPLACE FUNCTION public.fn_gto_v31_build_cell(
  p_dataset_id uuid,
  p_context jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_source_nodes jsonb;
  v_source_rows integer;
  v_train_rows integer;
  v_holdout_rows integer;
  v_spec_variants integer;
  v_machine_variants integer;
  v_cross_split_board_overlaps integer;
  v_specs jsonb;
  v_hand_matrix jsonb;
  v_policy_evs jsonb;
  v_action_evs jsonb;
  v_lineage text;
  v_cell jsonb;
  v_existing_checksum text;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
  IF p_context IS NULL OR jsonb_typeof(p_context)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_context))<>13
     OR NOT (p_context ?& ARRAY['street','game_family','objective','utility_context',
       'table_size','pot_type','hero_position','opponent_position','depth_bucket',
       'texture_class','node_role','facing_kind','facing_size_bucket']) THEN
    RAISE EXCEPTION 'compact cell context is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
    WHERE d.value=p_context) THEN
    RAISE EXCEPTION 'compact cell is not in declared coverage';
  END IF;
  SELECT c.cell_key_checksum INTO v_existing_checksum
    FROM public.gto_v31_runtime_cells c
   WHERE c.dataset_id=p_dataset_id
     AND c.street=p_context->>'street'
     AND c.game_family=p_context->>'game_family'
     AND c.objective=p_context->>'objective'
     AND c.utility_context=p_context->>'utility_context'
     AND c.table_size=(p_context->>'table_size')::smallint
     AND c.pot_type=p_context->>'pot_type'
     AND c.hero_position=p_context->>'hero_position'
     AND c.opponent_position=p_context->>'opponent_position'
     AND c.depth_bucket=(p_context->>'depth_bucket')::integer
     AND c.texture_class=p_context->>'texture_class'
     AND c.node_role=p_context->>'node_role'
     AND c.facing_kind=p_context->>'facing_kind'
     AND c.facing_size_bucket=p_context->>'facing_size_bucket';
  IF v_existing_checksum IS NOT NULL THEN RETURN v_existing_checksum; END IF;

  WITH matching_nodes AS MATERIALIZED (
    SELECT a.source_row_id,a.machine_id,a.source_artifact_checksum,s.scenario_hash,s.strategy_matrix_v2,n.value AS node,
           CASE WHEN a.machine_id='M2' THEN 'holdout' ELSE 'train' END AS split
      FROM public.gto_v31_source_artifacts a
      JOIN public.solved_spots_gold s ON s.id=a.source_row_id
       AND s.quality_status='validated' AND s.audited_at IS NOT NULL
       AND s.source_artifact_checksum=a.source_artifact_checksum
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
     WHERE a.dataset_id=p_dataset_id
       AND n.value#>>'{node_context,street}'=p_context->>'street'
       AND n.value#>>'{node_context,game_family}'=p_context->>'game_family'
       AND n.value#>>'{node_context,objective}'=p_context->>'objective'
       AND n.value#>>'{node_context,utility_context}'=p_context->>'utility_context'
       AND (n.value#>>'{node_context,table_size}')::integer=(p_context->>'table_size')::integer
       AND n.value#>>'{node_context,pot_type}'=p_context->>'pot_type'
       AND n.value#>>'{node_context,hero_position}'=p_context->>'hero_position'
       AND n.value#>>'{node_context,opponent_position}'=p_context->>'opponent_position'
       AND (n.value#>>'{node_context,depth_bucket}')::integer=(p_context->>'depth_bucket')::integer
       AND n.value#>>'{node_context,texture_class}'=p_context->>'texture_class'
       AND n.value#>>'{node_context,node_role}'=p_context->>'node_role'
       AND n.value#>>'{node_context,facing_kind}'=p_context->>'facing_kind'
       AND n.value#>>'{node_context,facing_size_bucket}'=p_context->>'facing_size_bucket'
  ), matching_artifacts AS MATERIALIZED (
    SELECT DISTINCT source_row_id,source_artifact_checksum,scenario_hash,strategy_matrix_v2
      FROM matching_nodes
  ), verified_artifacts AS MATERIALIZED (
    SELECT source_row_id
      FROM matching_artifacts
     WHERE source_artifact_checksum=public.fn_gto_v31_source_artifact_checksum(scenario_hash,strategy_matrix_v2)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'source_row_id',m.source_row_id,'machine_id',m.machine_id,
           'source_artifact_checksum',m.source_artifact_checksum,'node',m.node,'split',m.split
         ) ORDER BY m.source_row_id,m.node->>'node'),'[]'::jsonb)
    INTO v_source_nodes
    FROM matching_nodes m JOIN verified_artifacts a USING (source_row_id);

  WITH source_nodes AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(v_source_nodes) AS n(
      source_row_id uuid,machine_id text,source_artifact_checksum text,node jsonb,split text
    )
  )
  SELECT count(*),count(*) FILTER (WHERE split='train'),count(*) FILTER (WHERE split='holdout'),
         count(DISTINCT node->'action_specs'),count(DISTINCT machine_id),
         (SELECT count(*) FROM source_nodes train
           JOIN source_nodes holdout
             ON public.fn_gto_v31_board_rank_signature(holdout.node#>>'{node_context,board}')=
                public.fn_gto_v31_board_rank_signature(train.node#>>'{node_context,board}')
          WHERE train.split='train' AND holdout.split='holdout'),
         (array_agg(node->'action_specs'))[1],
         encode(digest(string_agg(source_row_id::text||':'||(node->>'node')||':'||
           (node->>'node_checksum'),'' ORDER BY source_row_id::text,node->>'node'),'sha256'),'hex')
    INTO v_source_rows,v_train_rows,v_holdout_rows,v_spec_variants,v_machine_variants,
         v_cross_split_board_overlaps,v_specs,v_lineage
    FROM source_nodes;
  IF v_source_rows<2 OR v_train_rows<1 OR v_holdout_rows<1 OR v_spec_variants<>1
     OR v_machine_variants<>2 OR v_cross_split_board_overlaps<>0
     OR v_specs IS NULL OR v_lineage IS NULL THEN
    RAISE EXCEPTION 'cell needs M1 and M2, one action topology, and rank-disjoint train and holdout sources';
  END IF;

  WITH source_nodes AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(v_source_nodes) AS n(
      source_row_id uuid,machine_id text,source_artifact_checksum text,node jsonb,split text
    )
  ), combo_observations AS MATERIALIZED (
    SELECT public.fn_gto_v31_feature_key(i,n.node#>>'{node_context,board}',v_dataset.feature_contract_version) AS hand_key,
           i,(n.node->'matchups'->>i)::numeric AS weight,
           (n.node->'policy_evs_bb'->>i)::numeric AS policy_ev,n.node
      FROM source_nodes n CROSS JOIN generate_series(0,1325) i
     WHERE n.split='train' AND (n.node->'matchups'->>i)::numeric>0
  ), action_observations AS MATERIALIZED (
    SELECT o.hand_key,a.key AS action_id,o.weight,
           (o.node->'frequencies'->a.key->>o.i)::numeric AS frequency,
           (o.node->'action_evs_bb'->a.key->>o.i)::numeric AS action_ev
      FROM combo_observations o CROSS JOIN LATERAL jsonb_each(v_specs) a
  ), action_aggregate AS (
    SELECT hand_key,action_id,
           sum(frequency*weight)/sum(weight) AS frequency,
           sum(action_ev*weight)/sum(weight) AS action_ev
      FROM action_observations GROUP BY hand_key,action_id
  ), per_hand AS (
    SELECT hand_key,
           jsonb_object_agg(action_id,to_jsonb(round(frequency,6)) ORDER BY action_id) AS mix,
           jsonb_object_agg(action_id,to_jsonb(round(action_ev,6)) ORDER BY action_id) AS action_evs
      FROM action_aggregate GROUP BY hand_key
  ), policy_aggregate AS (
    SELECT hand_key,sum(policy_ev*weight)/sum(weight) AS policy_ev
      FROM combo_observations GROUP BY hand_key
  )
  SELECT jsonb_object_agg(h.hand_key,h.mix ORDER BY h.hand_key),
         jsonb_object_agg(h.hand_key,to_jsonb(round(p.policy_ev,6)) ORDER BY h.hand_key),
         jsonb_object_agg(h.hand_key,h.action_evs ORDER BY h.hand_key)
    INTO v_hand_matrix,v_policy_evs,v_action_evs
    FROM per_hand h JOIN policy_aggregate p USING (hand_key);
  IF v_hand_matrix IS NULL OR v_policy_evs IS NULL OR v_action_evs IS NULL THEN
    RAISE EXCEPTION 'cell has no live training combinations';
  END IF;

  v_cell:=p_context||public.fn_gto_v31_feature_identity(v_dataset.feature_contract_version)||jsonb_build_object(
    'hand_matrix',v_hand_matrix,'action_specs',v_specs,
    'policy_ev_matrix',v_policy_evs,'action_ev_matrix',v_action_evs,
    'source_rows',v_source_rows,'train_source_rows',v_train_rows,
    'holdout_source_rows',v_holdout_rows,'lineage_checksum',v_lineage
  );
  v_cell:=v_cell||jsonb_build_object('cell_key_checksum',public.fn_gto_v31_cell_key_checksum(v_cell));
  v_cell:=v_cell||jsonb_build_object('cell_payload_checksum',public.fn_gto_v31_cell_payload_checksum(v_cell));
  IF NOT public.fn_gto_v31_cell_payload_valid(v_cell) THEN
    RAISE EXCEPTION 'database-computed compact cell failed its release validator';
  END IF;

  INSERT INTO public.gto_v31_runtime_cells (
    dataset_id,cell_key_checksum,street,game_family,objective,utility_context,
    table_size,pot_type,hero_position,opponent_position,depth_bucket,texture_class,
    node_role,facing_kind,facing_size_bucket,hand_matrix,action_specs,
    policy_ev_matrix,action_ev_matrix,source_rows,train_source_rows,
    holdout_source_rows,cell_payload_checksum,lineage_checksum,feature_contract_version
  ) VALUES (
    p_dataset_id,v_cell->>'cell_key_checksum',v_cell->>'street',v_cell->>'game_family',
    v_cell->>'objective',v_cell->>'utility_context',(v_cell->>'table_size')::smallint,
    v_cell->>'pot_type',v_cell->>'hero_position',v_cell->>'opponent_position',
    (v_cell->>'depth_bucket')::integer,v_cell->>'texture_class',v_cell->>'node_role',
    v_cell->>'facing_kind',v_cell->>'facing_size_bucket',v_cell->'hand_matrix',
    v_cell->'action_specs',v_cell->'policy_ev_matrix',v_cell->'action_ev_matrix',
    (v_cell->>'source_rows')::integer,(v_cell->>'train_source_rows')::integer,
    (v_cell->>'holdout_source_rows')::integer,v_cell->>'cell_payload_checksum',v_cell->>'lineage_checksum',v_dataset.feature_contract_version
  );

  INSERT INTO public.gto_v31_cell_source_receipts (
    dataset_id,cell_id,source_row_id,source_node,source_node_checksum,
    source_artifact_checksum,machine_id,split
  )
  SELECT p_dataset_id,c.cell_id,n.source_row_id,n.node->>'node',n.node->>'node_checksum',
         n.source_artifact_checksum,n.machine_id,n.split
    FROM public.gto_v31_runtime_cells c
    CROSS JOIN LATERAL jsonb_to_recordset(v_source_nodes) AS n(
      source_row_id uuid,machine_id text,source_artifact_checksum text,node jsonb,split text
    )
   WHERE c.dataset_id=p_dataset_id AND c.cell_key_checksum=v_cell->>'cell_key_checksum';
  IF NOT FOUND THEN RAISE EXCEPTION 'database-computed cell did not retain source receipts'; END IF;
  RETURN v_cell->>'cell_key_checksum';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_heldout_metrics(
  p_dataset_id uuid,
  p_game_family text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH holdout AS MATERIALIZED (
    SELECT r.source_row_id,r.source_node,c.cell_id,c.game_family,
           c.action_specs,i,k.hand_key,
           c.hand_matrix->k.hand_key AS compact_frequencies,
           (c.policy_ev_matrix->>k.hand_key)::numeric AS compact_policy,
           (n.value->'policy_evs_bb'->>i)::numeric AS source_policy,
           (SELECT jsonb_object_agg(a.key,a.value->i) FROM jsonb_each(n.value->'frequencies') a) AS source_frequencies,
           (SELECT jsonb_object_agg(a.key,a.value->i) FROM jsonb_each(n.value->'action_evs_bb') a) AS source_action_evs,
           (n.value->'matchups'->>i)::numeric AS weight
      FROM public.gto_v31_cell_source_receipts r
      JOIN public.gto_v31_runtime_cells c ON c.cell_id=r.cell_id
      JOIN public.solved_spots_gold s ON s.id=r.source_row_id
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
      CROSS JOIN generate_series(0,1325) i
      CROSS JOIN LATERAL (SELECT public.fn_gto_v31_feature_key(i,n.value#>>'{node_context,board}',c.feature_contract_version) AS hand_key OFFSET 0) k
     WHERE r.dataset_id=p_dataset_id AND r.split='holdout'
       AND (p_game_family IS NULL OR c.game_family=p_game_family)
       AND n.value->>'node'=r.source_node
       AND n.value->>'node_checksum'=r.source_node_checksum
       AND (n.value->'matchups'->>i)::numeric>0
  ), action_observations AS MATERIALIZED (
    SELECT h.*,a.key AS action_id,a.value->>'family' AS action_family,
           CASE WHEN a.value->>'family' IN ('bet','raise')
                THEN (a.value->>'size_value')::numeric ELSE NULL END AS size_value,
           (h.source_frequencies->>a.key)::numeric AS source_frequency,
           (h.compact_frequencies->>a.key)::numeric AS compact_frequency,
           (h.source_action_evs->>a.key)::numeric AS source_action_ev
      FROM holdout h CROSS JOIN LATERAL jsonb_each(h.action_specs) a
  ), per_combo AS MATERIALIZED (
    SELECT source_row_id,source_node,cell_id,game_family,i,hand_key,weight,
           max(source_policy) AS source_policy_ev,
           max(compact_policy) AS compact_policy_ev,
           sum(source_frequency*COALESCE(size_value,0))
             FILTER (WHERE size_value IS NOT NULL) AS source_size,
           sum(compact_frequency*COALESCE(size_value,0))
             FILTER (WHERE size_value IS NOT NULL) AS compact_size,
           bool_or(size_value IS NOT NULL) AS sizing_eligible,
           max(source_action_ev) AS best_action_ev,
           sum(compact_frequency*source_action_ev) AS compact_mixed_ev,
           bool_and(compact_frequency IS NOT NULL AND source_action_ev IS NOT NULL)
             AS regret_eligible
      FROM action_observations
     GROUP BY source_row_id,source_node,cell_id,game_family,i,hand_key,weight
  )
  SELECT jsonb_build_object(
    'frequency_mae',(SELECT sum(abs(source_frequency-compact_frequency)*weight)/NULLIF(sum(weight),0)
      FROM action_observations),
    'sizing_mae',COALESCE((SELECT sum(abs(source_size-compact_size)*weight)/NULLIF(sum(weight),0)
      FROM per_combo WHERE sizing_eligible),0),
    'policy_ev_mae_bb',(SELECT sum(abs(source_policy_ev-compact_policy_ev)*weight)/NULLIF(sum(weight),0)
      FROM per_combo),
    'mean_action_regret_bb',(SELECT sum(greatest(0,best_action_ev-compact_mixed_ev)*weight)/NULLIF(sum(weight),0)
      FROM per_combo WHERE regret_eligible),
    'regret_coverage',(SELECT count(*)::numeric/NULLIF((SELECT count(*) FROM per_combo),0)
      FROM per_combo WHERE regret_eligible),
    'holdout_source_rows',(SELECT count(DISTINCT source_row_id) FROM holdout),
    'frequency_observations',(SELECT count(*) FROM action_observations),
    'sizing_observations',(SELECT count(*) FROM per_combo WHERE sizing_eligible),
    'policy_ev_observations',(SELECT count(*) FROM per_combo),
    'regret_observations',(SELECT count(*) FROM per_combo WHERE regret_eligible),
    'live_combo_observations',(SELECT count(*) FROM per_combo),
    'missing_observations',(SELECT count(*) FROM holdout WHERE compact_frequencies IS NULL OR compact_policy IS NULL)
  );
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_seal_build(p_dataset_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_cells bigint;
  v_source bigint;
  v_train bigint;
  v_holdout bigint;
  v_source_nodes bigint;
  v_receipts bigint;
  v_checksum text;
  v_source_checksum text;
  v_coverage jsonb;
  v_metrics jsonb;
  v_metric_checksum text;
  v_frequency_mae numeric;
  v_sizing_mae numeric;
  v_policy_mae numeric;
  v_regret numeric;
  v_regret_coverage numeric;
  v_frequency_observations bigint;
  v_sizing_observations bigint;
  v_policy_observations bigint;
  v_regret_observations bigint;
  v_live_observations bigint;
  v_missing bigint;
  v_pass boolean;
  v_family text;
  v_family_metrics jsonb;
  v_by_family jsonb := '{}'::jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.feature_contract_version IS DISTINCT FROM v_dataset.feature_contract_version) THEN RAISE EXCEPTION 'cell feature version differs from dataset'; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gto_v31_input_bundles b
     WHERE b.input_bundle_id=v_dataset.input_bundle_id
       AND b.approval_status='approved' AND b.bundle_checksum=v_dataset.input_bundle_checksum
       AND b.feature_contract_version IS NOT DISTINCT FROM v_dataset.feature_contract_version
       AND b.range_bundle_checksum=v_dataset.range_bundle_checksum
       AND b.source_combo_order_checksum=v_dataset.source_combo_order_checksum
       AND b.icm_model_checksum=v_dataset.icm_model_checksum
  ) THEN RAISE EXCEPTION 'dataset input approval is absent or revoked'; END IF;

  SELECT count(*),COALESCE(sum(source_rows),0),COALESCE(sum(train_source_rows),0),
         COALESCE(sum(holdout_source_rows),0)
    INTO v_cells,v_source,v_train,v_holdout
    FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
  IF v_cells=0 OR jsonb_array_length(v_dataset.declared_coverage)<>v_cells
     OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(v_dataset.declared_coverage))<>v_cells
     OR EXISTS (
       SELECT 1 FROM public.gto_v31_runtime_cells c
        WHERE c.dataset_id=p_dataset_id AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
           WHERE d.value=jsonb_build_object(
             'street',c.street,'game_family',c.game_family,'objective',c.objective,
             'utility_context',c.utility_context,'table_size',c.table_size,
             'pot_type',c.pot_type,'hero_position',c.hero_position,
             'opponent_position',c.opponent_position,'depth_bucket',c.depth_bucket,
             'texture_class',c.texture_class,'node_role',c.node_role,
             'facing_kind',c.facing_kind,'facing_size_bucket',c.facing_size_bucket)))
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id
           AND d.value=jsonb_build_object(
             'street',c.street,'game_family',c.game_family,'objective',c.objective,
             'utility_context',c.utility_context,'table_size',c.table_size,
             'pot_type',c.pot_type,'hero_position',c.hero_position,
             'opponent_position',c.opponent_position,'depth_bucket',c.depth_bucket,
             'texture_class',c.texture_class,'node_role',c.node_role,
             'facing_kind',c.facing_kind,'facing_size_bucket',c.facing_size_bucket))) THEN
    RAISE EXCEPTION 'runtime cells do not exactly equal declared coverage';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='flop')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='turn')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='river')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='cash' AND objective='cash_ev')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='spin' AND objective='chip_ev')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='spin' AND objective='icm')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='tourney_ev' AND objective='chip_ev')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='tourney_icm' AND objective='icm')
     OR EXISTS (
       SELECT 1
         FROM (VALUES ('cash','cash_ev'),('spin','chip_ev'),('spin','icm'),
                      ('tourney_ev','chip_ev'),('tourney_icm','icm'))
              required_family(game_family,objective)
         CROSS JOIN unnest(ARRAY['flop','turn','river']) required_street(street)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_runtime_cells c
           WHERE c.dataset_id=p_dataset_id
             AND c.game_family=required_family.game_family
             AND c.objective=required_family.objective
             AND c.street=required_street.street))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['limped','srp','3bet','4bet_plus']) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.pot_type=required.value))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder']) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.utility_context=required.value))
     OR EXISTS (SELECT 1 FROM generate_series(2,10) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.table_size=required.value))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in']) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.node_role=required.value)) THEN
    RAISE EXCEPTION 'required Phase 4 street, family, utility, table, pot, or response coverage is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_runtime_cells c
     WHERE c.dataset_id=p_dataset_id
       AND (c.cell_key_checksum<>public.fn_gto_v31_cell_key_checksum(to_jsonb(c))
         OR c.cell_payload_checksum<>public.fn_gto_v31_cell_payload_checksum(to_jsonb(c))
         OR c.source_rows<>c.train_source_rows+c.holdout_source_rows
         OR NOT public.fn_gto_v31_cell_payload_valid(to_jsonb(c)))
  ) THEN RAISE EXCEPTION 'a compact cell seal or payload no longer validates'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_runtime_cells c
    LEFT JOIN LATERAL (
      SELECT count(*) n,count(*) FILTER (WHERE r.split='train') train_n,
             count(*) FILTER (WHERE r.split='holdout') holdout_n,
             encode(digest(string_agg(r.source_row_id::text||':'||r.source_node||':'||
               r.source_node_checksum,'' ORDER BY r.source_row_id::text,r.source_node),'sha256'),'hex') lineage
        FROM public.gto_v31_cell_source_receipts r WHERE r.cell_id=c.cell_id
    ) x ON true
     WHERE c.dataset_id=p_dataset_id AND
       (x.n<>c.source_rows OR x.train_n<>c.train_source_rows OR x.holdout_n<>c.holdout_source_rows
        OR x.lineage IS DISTINCT FROM c.lineage_checksum)
  ) THEN RAISE EXCEPTION 'cell source receipts do not reconcile'; END IF;
  SELECT COALESCE(sum(node_count),0) INTO v_source_nodes
    FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
  SELECT count(*) INTO v_receipts FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id;
  IF v_source_nodes<>v_receipts OR v_source<>v_receipts
     OR EXISTS (
       SELECT 1 FROM public.gto_v31_source_artifacts a
       LEFT JOIN public.solved_spots_gold s ON s.id=a.source_row_id
        WHERE a.dataset_id=p_dataset_id AND (s.id IS NULL OR s.quality_status<>'validated'
          OR s.audited_at IS NULL OR s.source_artifact_checksum<>a.source_artifact_checksum
          OR s.source_artifact_checksum<>public.fn_gto_v31_source_artifact_checksum(s.scenario_hash,s.strategy_matrix_v2)
          OR s.solver_version<>v_dataset.solver_version
          OR s.solver_binary_checksum<>v_dataset.solver_binary_checksum
          OR s.machine_id<>a.machine_id OR s.pipeline_commit<>v_dataset.pipeline_commit
          OR s.pipeline_bundle_checksum<>v_dataset.pipeline_bundle_checksum
          OR s.manifest_version::text<>v_dataset.manifest_version
          OR s.manifest_checksum<>v_dataset.manifest_checksum)) THEN
    RAISE EXCEPTION 'source artifacts are missing, omitted, quarantined, or changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id AND machine_id='M1')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id AND machine_id='M2') THEN
    RAISE EXCEPTION 'dataset provenance does not include both solver hosts';
  END IF;

  v_metrics:=public.fn_gto_v31_heldout_metrics(p_dataset_id,NULL);
  v_frequency_mae:=(v_metrics->>'frequency_mae')::numeric;
  v_sizing_mae:=(v_metrics->>'sizing_mae')::numeric;
  v_policy_mae:=(v_metrics->>'policy_ev_mae_bb')::numeric;
  v_regret:=(v_metrics->>'mean_action_regret_bb')::numeric;
  v_regret_coverage:=(v_metrics->>'regret_coverage')::numeric;
  v_frequency_observations:=COALESCE((v_metrics->>'frequency_observations')::bigint,0);
  v_sizing_observations:=COALESCE((v_metrics->>'sizing_observations')::bigint,0);
  v_policy_observations:=COALESCE((v_metrics->>'policy_ev_observations')::bigint,0);
  v_regret_observations:=COALESCE((v_metrics->>'regret_observations')::bigint,0);
  v_live_observations:=COALESCE((v_metrics->>'live_combo_observations')::bigint,0);
  v_missing:=COALESCE((v_metrics->>'missing_observations')::bigint,0);
  IF v_missing<>0 OR v_frequency_observations=0 OR v_sizing_observations=0
     OR v_policy_observations=0
     OR v_regret_observations=0 OR v_live_observations=0
     OR v_frequency_mae IS NULL OR v_sizing_mae IS NULL OR v_policy_mae IS NULL
     OR v_regret IS NULL OR v_regret_coverage IS NULL THEN
    RAISE EXCEPTION 'heldout observations are incomplete or absent';
  END IF;
  v_pass:=v_frequency_mae<=(v_dataset.quality_gates->>'max_frequency_mae')::numeric
    AND v_sizing_mae<=(v_dataset.quality_gates->>'max_sizing_mae')::numeric
    AND v_policy_mae<=(v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
    AND v_regret<=(v_dataset.quality_gates->>'max_action_regret_bb')::numeric
    AND v_regret_coverage>=(v_dataset.quality_gates->>'min_regret_coverage')::numeric;

  FOREACH v_family IN ARRAY ARRAY['cash','spin','tourney_ev','tourney_icm'] LOOP
    v_family_metrics:=public.fn_gto_v31_heldout_metrics(p_dataset_id,v_family);
    IF COALESCE((v_family_metrics->>'frequency_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'sizing_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'policy_ev_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'regret_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'missing_observations')::bigint,0)<>0 THEN
      RAISE EXCEPTION 'heldout observations are incomplete for family %',v_family;
    END IF;
    v_family_metrics:=v_family_metrics||jsonb_build_object('validated',
      (v_family_metrics->>'frequency_mae')::numeric<=(v_dataset.quality_gates->>'max_frequency_mae')::numeric
      AND (v_family_metrics->>'sizing_mae')::numeric<=(v_dataset.quality_gates->>'max_sizing_mae')::numeric
      AND (v_family_metrics->>'policy_ev_mae_bb')::numeric<=(v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
      AND (v_family_metrics->>'mean_action_regret_bb')::numeric<=(v_dataset.quality_gates->>'max_action_regret_bb')::numeric
      AND (v_family_metrics->>'regret_coverage')::numeric>=(v_dataset.quality_gates->>'min_regret_coverage')::numeric);
    v_pass:=v_pass AND (v_family_metrics->>'validated')::boolean;
    v_by_family:=v_by_family||jsonb_build_object(v_family,v_family_metrics);
  END LOOP;

  v_metrics:=v_metrics||jsonb_build_object('validated',v_pass,'by_family',v_by_family);
  v_metric_checksum:=public.fn_gto_v31_json_checksum(v_metrics);
  v_metrics:=v_metrics||jsonb_build_object('metrics_checksum',v_metric_checksum);

  SELECT jsonb_build_object('cells',count(*),'streets',jsonb_agg(DISTINCT street),
    'families',jsonb_agg(DISTINCT game_family||':'||objective),
    'utility_contexts',jsonb_agg(DISTINCT utility_context),
    'table_sizes',jsonb_agg(DISTINCT table_size),'pot_types',jsonb_agg(DISTINCT pot_type),
    'node_roles',jsonb_agg(DISTINCT node_role),'complete',true)
    INTO v_coverage FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
  SELECT encode(digest(string_agg(DISTINCT source_artifact_checksum,'' ORDER BY source_artifact_checksum),'sha256'),'hex')
    INTO v_source_checksum FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
  SELECT encode(digest(v_dataset.dataset_key||':'||v_dataset.pipeline_bundle_checksum||':'||
    v_dataset.manifest_checksum||':'||
    v_dataset.input_bundle_checksum||':'||CASE WHEN v_dataset.feature_contract_version IS NULL THEN '' ELSE v_dataset.feature_contract_version||':' END||string_agg(cell_key_checksum||':'||
      cell_payload_checksum||':'||lineage_checksum,'' ORDER BY cell_key_checksum),'sha256'),'hex')
    INTO v_checksum FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;

  UPDATE public.gto_v31_datasets SET
    state=CASE WHEN v_pass THEN 'evaluating' ELSE 'rejected' END,
    quality_status=CASE WHEN v_pass THEN 'validated' ELSE 'rejected' END,
    source_rows=v_source,train_source_rows=v_train,holdout_source_rows=v_holdout,
    invalid_rows=0,source_artifact_checksum=v_source_checksum,dataset_checksum=v_checksum,
    coverage=v_coverage,heldout_metrics=v_metrics,sealed_at=now(),audited_at=now()
   WHERE dataset_id=p_dataset_id;
  INSERT INTO public.gto_v31_release_evaluations (
    dataset_id,dataset_checksum,evaluation_kind,game_family,verdict,metrics,result_checksum
  ) VALUES (
    p_dataset_id,v_checksum,'heldout','all',CASE WHEN v_pass THEN 'pass' ELSE 'fail' END,
    v_metrics,public.fn_gto_v31_json_checksum(jsonb_build_object(
      'dataset_checksum',v_checksum,'kind','heldout','family','all','metrics',v_metrics))
  );
  RETURN v_checksum;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_promote_dataset(p_dataset_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_expected_checksum text;
  v_expected_source_checksum text;
  v_paired jsonb;
  v_league jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='candidate' FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.feature_contract_version IS DISTINCT FROM v_dataset.feature_contract_version) THEN RAISE EXCEPTION 'cell feature version differs from dataset'; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not a candidate'; END IF;
  SELECT encode(digest(v_dataset.dataset_key||':'||v_dataset.pipeline_bundle_checksum||':'||
    v_dataset.manifest_checksum||':'||
    v_dataset.input_bundle_checksum||':'||CASE WHEN v_dataset.feature_contract_version IS NULL THEN '' ELSE v_dataset.feature_contract_version||':' END||string_agg(cell_key_checksum||':'||
      cell_payload_checksum||':'||lineage_checksum,'' ORDER BY cell_key_checksum),'sha256'),'hex')
    INTO v_expected_checksum FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
  SELECT encode(digest(string_agg(DISTINCT source_artifact_checksum,'' ORDER BY source_artifact_checksum),'sha256'),'hex')
    INTO v_expected_source_checksum FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
  SELECT jsonb_build_object('verdict','pass',
      'evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
    INTO v_paired FROM public.gto_v31_release_evaluations e
   WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
     AND e.evaluation_kind='paired_replay' AND e.verdict IN ('win','tie');
  SELECT jsonb_build_object('verdict','pass',
      'evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
    INTO v_league FROM public.gto_v31_release_evaluations e
   WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
     AND e.evaluation_kind='league' AND e.verdict IN ('win','tie');
  IF v_dataset.quality_status <> 'validated' OR v_dataset.invalid_rows <> 0
     OR v_dataset.dataset_checksum IS NULL OR v_dataset.source_artifact_checksum IS NULL
     OR v_dataset.dataset_checksum IS DISTINCT FROM v_expected_checksum
     OR v_dataset.source_artifact_checksum IS DISTINCT FROM v_expected_source_checksum
     OR COALESCE((v_dataset.coverage->>'complete')::boolean,false) IS NOT true
     OR COALESCE((v_dataset.heldout_metrics->>'frequency_mae')::numeric,99) > (v_dataset.quality_gates->>'max_frequency_mae')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'sizing_mae')::numeric,99) > (v_dataset.quality_gates->>'max_sizing_mae')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'sizing_observations')::bigint,0)<=0
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['cash','spin','tourney_ev','tourney_icm']) family(value)
       WHERE COALESCE((v_dataset.heldout_metrics#>>ARRAY['by_family',family.value,'sizing_observations'])::bigint,0)<=0)
     OR COALESCE((v_dataset.heldout_metrics->>'policy_ev_mae_bb')::numeric,99) > (v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'mean_action_regret_bb')::numeric,99) > (v_dataset.quality_gates->>'max_action_regret_bb')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'regret_coverage')::numeric,-1) < (v_dataset.quality_gates->>'min_regret_coverage')::numeric
     OR v_dataset.paired_replay IS DISTINCT FROM v_paired
     OR v_dataset.league_gate IS DISTINCT FROM v_league
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_input_bundles b
       WHERE b.input_bundle_id=v_dataset.input_bundle_id AND b.approval_status='approved'
         AND b.bundle_checksum=v_dataset.input_bundle_checksum
       AND b.feature_contract_version IS NOT DISTINCT FROM v_dataset.feature_contract_version)
     OR NOT public.fn_gto_v31_candidate_evaluations_valid(
       p_dataset_id,v_dataset.dataset_checksum)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY['paired_replay','league']) required_kind(value)
         CROSS JOIN unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel',
           'facing_bet','facing_raise','check_raise','bet_raise','all_in']) required_role(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_release_evaluations e
          CROSS JOIN LATERAL jsonb_array_elements_text(e.metrics->'candidate_node_roles') seen(value)
           WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
             AND e.evaluation_kind=required_kind.value AND e.verdict IN ('win','tie')
             AND seen.value=required_role.value))
     OR (SELECT count(*) FROM public.gto_v31_release_evaluations e
       WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
         AND ((e.evaluation_kind='heldout' AND e.game_family='all' AND e.verdict='pass')
           OR (e.evaluation_kind IN ('paired_replay','league') AND e.game_family IN
             ('cash','spin','tourney_ev','tourney_icm') AND e.verdict IN ('win','tie'))))<>9 THEN
    RAISE EXCEPTION 'candidate does not meet its protected promotion gates';
  END IF;

  UPDATE public.gto_v31_datasets SET state='retired', retired_at=now()
   WHERE state='active' AND dataset_id <> p_dataset_id;
  UPDATE public.gto_v31_datasets SET state='active', promoted_at=now()
   WHERE dataset_id=p_dataset_id;
  RETURN v_dataset.dataset_checksum;
END;
$fn$;

DROP FUNCTION public.fn_gto_v31_active_cells(integer,integer);

CREATE OR REPLACE FUNCTION public.fn_gto_v31_active_cells(p_offset integer DEFAULT 0, p_limit integer DEFAULT 500)
RETURNS TABLE (
  dataset_id uuid, dataset_key text, dataset_checksum text,
  solver_version text, solver_binary_checksum text, pipeline_commit text,
  pipeline_bundle_checksum text,
  manifest_version text, manifest_checksum text, source_artifact_checksum text,
  source_combo_order_checksum text, range_bundle_checksum text,
  icm_model_checksum text, input_bundle_checksum text,
  cell_key_checksum text, cell_payload_checksum text, lineage_checksum text,
  quality_status text, dataset_state text, dataset_cells bigint, source_rows bigint,
  train_source_rows bigint, holdout_source_rows bigint, invalid_rows bigint,
  audited_at timestamptz, street text, game_family text, objective text,
  utility_context text, table_size smallint, pot_type text,
  hero_position text, opponent_position text, depth_bucket integer,
  texture_class text, node_role text, facing_kind text, facing_size_bucket text,
  hand_matrix jsonb, action_specs jsonb, policy_ev_matrix jsonb, action_ev_matrix jsonb,feature_contract_version text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT d.dataset_id, d.dataset_key, d.dataset_checksum,
         d.solver_version, d.solver_binary_checksum, d.pipeline_commit,
         d.pipeline_bundle_checksum,
         d.manifest_version, d.manifest_checksum, d.source_artifact_checksum,
         d.source_combo_order_checksum, d.range_bundle_checksum,
         d.icm_model_checksum,d.input_bundle_checksum,
         c.cell_key_checksum, c.cell_payload_checksum, c.lineage_checksum,
         d.quality_status, d.state, (d.coverage->>'cells')::bigint,
         d.source_rows, d.train_source_rows, d.holdout_source_rows,
         d.invalid_rows, d.audited_at,
         c.street, c.game_family, c.objective, c.utility_context, c.table_size,
         c.pot_type, c.hero_position, c.opponent_position,
         c.depth_bucket, c.texture_class, c.node_role, c.facing_kind,
         c.facing_size_bucket, c.hand_matrix, c.action_specs,
         c.policy_ev_matrix,c.action_ev_matrix,d.feature_contract_version
    FROM public.gto_v31_datasets d
    JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
     AND b.approval_status='approved' AND b.bundle_checksum=d.input_bundle_checksum
     AND b.feature_contract_version IS NOT DISTINCT FROM d.feature_contract_version
    JOIN public.gto_v31_runtime_cells c ON c.dataset_id=d.dataset_id AND c.feature_contract_version IS NOT DISTINCT FROM d.feature_contract_version
   WHERE d.state='active' AND d.quality_status='validated' AND d.invalid_rows=0
     AND d.dataset_checksum IS NOT NULL AND d.source_artifact_checksum IS NOT NULL
   ORDER BY c.street, c.game_family, c.objective, c.utility_context, c.table_size,
            c.pot_type, c.hero_position, c.opponent_position, c.depth_bucket,
            c.texture_class, c.node_role,
            c.facing_kind, c.facing_size_bucket
   OFFSET greatest(COALESCE(p_offset,0),0)
   LIMIT greatest(1,least(COALESCE(p_limit,500),500));
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_active_cells(integer,integer) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_gto_v31_active_cells(integer,integer) TO service_role;

DROP FUNCTION public.fn_gto_v31_evaluation_cells(uuid,integer,integer);

CREATE OR REPLACE FUNCTION public.fn_gto_v31_evaluation_cells(
  p_dataset_id uuid,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  dataset_id uuid, dataset_key text, dataset_checksum text,
  solver_version text, solver_binary_checksum text, pipeline_commit text,
  pipeline_bundle_checksum text,
  manifest_version text, manifest_checksum text, source_artifact_checksum text,
  source_combo_order_checksum text, range_bundle_checksum text,
  icm_model_checksum text, input_bundle_checksum text,
  cell_key_checksum text, cell_payload_checksum text, lineage_checksum text,
  quality_status text, dataset_state text, dataset_cells bigint, source_rows bigint,
  train_source_rows bigint, holdout_source_rows bigint, invalid_rows bigint,
  audited_at timestamptz, street text, game_family text, objective text,
  utility_context text, table_size smallint, pot_type text,
  hero_position text, opponent_position text, depth_bucket integer,
  texture_class text, node_role text, facing_kind text, facing_size_bucket text,
  hand_matrix jsonb, action_specs jsonb, policy_ev_matrix jsonb, action_ev_matrix jsonb,feature_contract_version text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT d.dataset_id,d.dataset_key,d.dataset_checksum,d.solver_version,
         d.solver_binary_checksum,d.pipeline_commit,d.pipeline_bundle_checksum,
         d.manifest_version,
         d.manifest_checksum,d.source_artifact_checksum,
         d.source_combo_order_checksum,d.range_bundle_checksum,d.icm_model_checksum,
         d.input_bundle_checksum,c.cell_key_checksum,c.cell_payload_checksum,
         c.lineage_checksum,d.quality_status,d.state,(d.coverage->>'cells')::bigint,
         d.source_rows,d.train_source_rows,d.holdout_source_rows,d.invalid_rows,
         d.audited_at,c.street,c.game_family,c.objective,c.utility_context,
         c.table_size,c.pot_type,c.hero_position,c.opponent_position,c.depth_bucket,
         c.texture_class,c.node_role,c.facing_kind,c.facing_size_bucket,
         c.hand_matrix,c.action_specs,c.policy_ev_matrix,c.action_ev_matrix,d.feature_contract_version
    FROM public.gto_v31_datasets d
    JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
     AND b.approval_status='approved' AND b.bundle_checksum=d.input_bundle_checksum
     AND b.feature_contract_version IS NOT DISTINCT FROM d.feature_contract_version
    JOIN public.gto_v31_runtime_cells c ON c.dataset_id=d.dataset_id AND c.feature_contract_version IS NOT DISTINCT FROM d.feature_contract_version
   WHERE d.dataset_id=p_dataset_id AND d.state IN ('evaluating','candidate')
     AND d.quality_status='validated' AND d.invalid_rows=0
     AND d.dataset_checksum IS NOT NULL AND d.source_artifact_checksum IS NOT NULL
   ORDER BY c.street,c.game_family,c.objective,c.utility_context,c.table_size,
     c.pot_type,c.hero_position,c.opponent_position,c.depth_bucket,c.texture_class,
     c.node_role,c.facing_kind,c.facing_size_bucket
   OFFSET greatest(COALESCE(p_offset,0),0)
   LIMIT greatest(1,least(COALESCE(p_limit,500),500));
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_evaluation_cells(uuid,integer,integer) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_gto_v31_evaluation_cells(uuid,integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_record_evaluation(
  p_dataset_id uuid,
  p_evaluation_kind text,
  p_game_family text,
  p_source_result_id bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_result public.horse_league_results%ROWTYPE;
  v_incumbent text;
  v_verdict text;
  v_metrics jsonb;
  v_checksum text;
  v_id uuid;
  v_expected_scenarios text[];
  v_expected_profile text;
  v_actual_scenarios text[];
  v_component_hands bigint;
  v_component_hits bigint;
  v_component_mismatches bigint;
  v_component_duration bigint;
  v_component_bb100 numeric;
  v_component_stderr numeric;
  v_component_roles text[];
  v_result_roles text[];
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_evaluation_kind NOT IN ('paired_replay','league')
     OR p_game_family NOT IN ('cash','spin','tourney_ev','tourney_icm') THEN
    RAISE EXCEPTION 'evaluation kind or family is invalid';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='evaluating' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not awaiting evaluation'; END IF;
  SELECT COALESCE((SELECT dataset_checksum FROM public.gto_v31_datasets
    WHERE state='active' AND dataset_id<>p_dataset_id LIMIT 1),'legacy_v30') INTO v_incumbent;
  SELECT * INTO v_result FROM public.horse_league_results WHERE id=p_source_result_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'league result does not exist'; END IF;
  v_expected_scenarios:=CASE p_game_family
    WHEN 'cash' THEN ARRAY['cash_ev']::text[]
    WHEN 'spin' THEN ARRAY['chip_ev','spin_ladder']::text[]
    WHEN 'tourney_ev' THEN ARRAY['chip_ev']::text[]
    ELSE ARRAY['satellite','bubble','final_table','in_money','ladder']::text[]
  END;
  v_expected_profile:=CASE p_evaluation_kind
    WHEN 'paired_replay' THEN 'policy_only_duplicate_deals'
    ELSE 'full_brain_duplicate_deal_league'
  END;

  IF jsonb_typeof(v_result.config_a)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_result.config_a))<> (8 + CASE WHEN v_dataset.feature_contract_version IS NULL THEN 0 ELSE 1 END)
     OR NOT (v_result.config_a ?& ARRAY['evaluation_contract','evaluation_kind',
       'game_family','dataset_checksum','candidate','evaluation_profile','scenarios',
       'evaluation_engine_commit']::text[])
     OR NOT public.fn_gto_v31_feature_request_valid(v_result.config_a)
     OR v_result.config_a->>'feature_contract_version' IS DISTINCT FROM v_dataset.feature_contract_version
     OR jsonb_typeof(v_result.config_b)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_result.config_b))<>2
     OR NOT (v_result.config_b ?& ARRAY['incumbent_dataset_checksum','candidate']::text[])
     OR jsonb_typeof(v_result.config_a->'scenarios')<>'array'
     OR v_result.config_a->'scenarios' IS DISTINCT FROM to_jsonb(v_expected_scenarios)
     OR v_result.config_a->>'evaluation_profile'<>v_expected_profile
     OR COALESCE(v_result.config_a->>'evaluation_engine_commit','')!~'^[0-9a-f]{40}$'
     OR v_result.config_a->>'evaluation_engine_commit'=repeat('0',40) THEN
    RAISE EXCEPTION 'evaluation configuration is incomplete or aliases another test profile';
  END IF;

  IF jsonb_array_length(v_result.candidate_benchmark_components)<>array_length(v_expected_scenarios,1)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_result.candidate_benchmark_components) component(value)
        WHERE jsonb_typeof(component.value)<>'object'
          OR (SELECT count(*) FROM jsonb_object_keys(component.value))<>10
          OR NOT (component.value ?& ARRAY['scenario','hands','bb100','stderr','duration_ms',
            'illegal_actions','truncated_streets','candidate_policy_hits',
            'candidate_execution_mismatches','candidate_node_roles']::text[])
          OR jsonb_typeof(component.value->'scenario')<>'string'
          OR COALESCE(component.value->>'hands','')!~'^[1-9][0-9]*$'
          OR jsonb_typeof(component.value->'bb100')<>'number'
          OR jsonb_typeof(component.value->'stderr')<>'number'
          OR (component.value->>'stderr')::numeric<0
          OR COALESCE(component.value->>'duration_ms','')!~'^[1-9][0-9]*$'
          OR COALESCE(component.value->>'illegal_actions','')!~'^[0-9]+$'
          OR (component.value->>'illegal_actions')::bigint<>0
          OR COALESCE(component.value->>'truncated_streets','')!~'^[0-9]+$'
          OR (component.value->>'truncated_streets')::bigint<>0
          OR COALESCE(component.value->>'candidate_policy_hits','')!~'^[1-9][0-9]*$'
          OR COALESCE(component.value->>'candidate_execution_mismatches','')!~'^[0-9]+$'
          OR (component.value->>'candidate_execution_mismatches')::bigint<>0
          OR jsonb_typeof(component.value->'candidate_node_roles')<>'array'
          OR jsonb_array_length(component.value->'candidate_node_roles')=0
          OR jsonb_array_length(component.value->'candidate_node_roles')<>(
            SELECT count(DISTINCT role.value)
              FROM jsonb_array_elements_text(component.value->'candidate_node_roles') role(value))
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(component.value->'candidate_node_roles') role(value)
             WHERE role.value NOT IN ('open','cbet','probe','delayed_cbet','barrel',
               'facing_bet','facing_raise','check_raise','bet_raise','all_in'))
     ) THEN
    RAISE EXCEPTION 'benchmark components do not carry exact scenario and decision evidence';
  END IF;

  SELECT array_agg(component.value->>'scenario' ORDER BY component.ordinality),
         sum((component.value->>'hands')::bigint),
         sum((component.value->>'candidate_policy_hits')::bigint),
         sum((component.value->>'candidate_execution_mismatches')::bigint),
         sum((component.value->>'duration_ms')::bigint),
         sum((component.value->>'bb100')::numeric*(component.value->>'hands')::numeric)
           /sum((component.value->>'hands')::numeric),
         sqrt(sum(power((component.value->>'stderr')::numeric*
           (component.value->>'hands')::numeric,2)))
           /sum((component.value->>'hands')::numeric)
    INTO v_actual_scenarios,v_component_hands,v_component_hits,v_component_mismatches,
         v_component_duration,
         v_component_bb100,v_component_stderr
    FROM jsonb_array_elements(v_result.candidate_benchmark_components)
      WITH ORDINALITY component(value,ordinality);
  SELECT array_agg(DISTINCT role.value ORDER BY role.value)
    INTO v_component_roles
    FROM jsonb_array_elements(v_result.candidate_benchmark_components) component(value)
    CROSS JOIN LATERAL jsonb_array_elements_text(component.value->'candidate_node_roles') role(value);
  SELECT array_agg(DISTINCT role.value ORDER BY role.value) INTO v_result_roles
    FROM unnest(v_result.candidate_node_roles) role(value);

  IF v_result.run_date<current_date-2 OR v_result.run_date>current_date
     OR v_result.hands<10000 OR v_result.illegal_actions<>0 OR v_result.truncated_streets<>0
     OR v_result.candidate_policy_hits<=0 OR v_result.candidate_execution_mismatches<>0
     OR COALESCE(array_length(v_result.candidate_node_roles,1),0)<=0
     OR v_actual_scenarios IS DISTINCT FROM v_expected_scenarios
     OR v_component_hands<>v_result.hands
     OR v_component_hits<>v_result.candidate_policy_hits
     OR v_component_mismatches<>v_result.candidate_execution_mismatches
     OR v_component_duration<>v_result.duration_ms
     OR abs(v_component_bb100-v_result.bb100)>0.000001
     OR abs(v_component_stderr-v_result.stderr)>0.000001
     OR v_component_roles IS DISTINCT FROM v_result_roles
     OR COALESCE(array_length(v_result.candidate_node_roles,1),0)<>
        COALESCE(array_length(v_result_roles,1),0)
     OR EXISTS (SELECT 1 FROM unnest(v_result.candidate_node_roles) role(value)
       WHERE role.value NOT IN ('open','cbet','probe','delayed_cbet','barrel',
         'facing_bet','facing_raise','check_raise','bet_raise','all_in'))
     OR v_result.duration_ms<=0 OR v_result.stderr<0
     OR v_result.matchup<>'gto_v31_'||p_evaluation_kind||'_'||p_game_family||'_'||v_dataset.dataset_checksum
     OR v_result.config_a->>'evaluation_contract'<>'gto_v31_candidate.v2'
     OR v_result.config_a->>'evaluation_kind'<>p_evaluation_kind
     OR v_result.config_a->>'game_family'<>p_game_family
     OR v_result.config_a->>'dataset_checksum'<>v_dataset.dataset_checksum
     OR v_result.config_a->>'candidate'<>'v31_certified'
     OR v_result.config_b->>'incumbent_dataset_checksum'<>v_incumbent
     OR v_result.config_b->>'candidate'<>'incumbent' THEN
    RAISE EXCEPTION 'league result is stale, unsafe, or not bound to this candidate and incumbent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_release_evaluations e
     WHERE e.dataset_id=p_dataset_id
       AND e.evaluation_kind IN ('paired_replay','league')
       AND e.metrics#>>'{candidate_config,evaluation_engine_commit}'
           IS DISTINCT FROM v_result.config_a->>'evaluation_engine_commit'
  ) THEN
    RAISE EXCEPTION 'candidate evaluations were produced by different engine commits';
  END IF;

  v_verdict:=CASE WHEN v_result.bb100>2*v_result.stderr THEN 'win'
                  WHEN v_result.bb100<(-2*v_result.stderr) THEN 'loss' ELSE 'tie' END;
  v_metrics:=jsonb_build_object('source_result_id',v_result.id,'run_date',v_result.run_date,
    'matchup',v_result.matchup,'hands',v_result.hands,'bb100',v_result.bb100,
    'stderr',v_result.stderr,'illegal_actions',v_result.illegal_actions,
    'truncated_streets',v_result.truncated_streets,'duration_ms',v_result.duration_ms,
    'candidate_policy_hits',v_result.candidate_policy_hits,
    'candidate_execution_mismatches',v_result.candidate_execution_mismatches,
    'candidate_node_roles',v_result.candidate_node_roles,
    'benchmark_components',v_result.candidate_benchmark_components,
    'candidate_config',v_result.config_a,'incumbent_config',v_result.config_b);
  v_checksum:=public.fn_gto_v31_json_checksum(jsonb_build_object(
    'dataset_checksum',v_dataset.dataset_checksum,'kind',p_evaluation_kind,
    'family',p_game_family,'verdict',v_verdict,'metrics',v_metrics));
  INSERT INTO public.gto_v31_release_evaluations (
    dataset_id,dataset_checksum,evaluation_kind,game_family,verdict,metrics,
    source_result_id,result_checksum
  ) VALUES (
    p_dataset_id,v_dataset.dataset_checksum,p_evaluation_kind,p_game_family,
    v_verdict,v_metrics,p_source_result_id,v_checksum
  ) ON CONFLICT (dataset_id,evaluation_kind,game_family) DO NOTHING
  RETURNING evaluation_id INTO v_id;
  IF v_id IS NULL THEN
    SELECT evaluation_id INTO v_id FROM public.gto_v31_release_evaluations
     WHERE dataset_id=p_dataset_id AND evaluation_kind=p_evaluation_kind
       AND game_family=p_game_family AND result_checksum=v_checksum;
    IF v_id IS NULL THEN RAISE EXCEPTION 'an evaluation receipt already exists with another result'; END IF;
  END IF;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_candidate_evaluations_valid(
  p_dataset_id uuid,
  p_dataset_checksum text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_incumbent text;
  v_active_incumbents integer;
  v_receipts integer;
  v_engine_commits integer;
  v_feature_version text;
BEGIN
  -- Mark-candidate and promotion both call this helper before changing state.
  -- The transaction-scoped estate lock survives the function return, so the
  -- incumbent read, receipt validation, and later state transition are one
  -- serialized release operation even for two different candidate rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('smarter-poker:gto-v31-release-gate', 0)
  );

  IF p_dataset_id IS NULL
     OR COALESCE(p_dataset_checksum,'')!~'^[0-9a-f]{64}$'
     OR p_dataset_checksum=repeat('0',64) THEN
    RETURN false;
  END IF;

  SELECT feature_contract_version INTO v_feature_version FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id;
  SELECT count(*),max(d.dataset_checksum)
    INTO v_active_incumbents,v_incumbent
    FROM public.gto_v31_datasets d
   WHERE d.state='active' AND d.dataset_id<>p_dataset_id;
  IF v_active_incumbents=0 THEN
    v_incumbent:='legacy_v30';
  ELSIF v_active_incumbents<>1
     OR COALESCE(v_incumbent,'')!~'^[0-9a-f]{64}$'
     OR v_incumbent=repeat('0',64) THEN
    RETURN false;
  END IF;

  SELECT count(*),
         count(DISTINCT e.metrics#>>'{candidate_config,evaluation_engine_commit}')
    INTO v_receipts,v_engine_commits
    FROM public.gto_v31_release_evaluations e
    JOIN public.horse_league_results r ON r.id=e.source_result_id
   WHERE e.dataset_id=p_dataset_id
     AND e.dataset_checksum=p_dataset_checksum
     AND e.evaluation_kind IN ('paired_replay','league')
     AND e.game_family IN ('cash','spin','tourney_ev','tourney_icm');

  IF v_receipts<>8 OR v_engine_commits<>1 THEN
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    WITH required(evaluation_kind,game_family,evaluation_profile,scenarios) AS (
      VALUES
        ('paired_replay','cash','policy_only_duplicate_deals',ARRAY['cash_ev']::text[]),
        ('paired_replay','spin','policy_only_duplicate_deals',ARRAY['chip_ev','spin_ladder']::text[]),
        ('paired_replay','tourney_ev','policy_only_duplicate_deals',ARRAY['chip_ev']::text[]),
        ('paired_replay','tourney_icm','policy_only_duplicate_deals',ARRAY['satellite','bubble','final_table','in_money','ladder']::text[]),
        ('league','cash','full_brain_duplicate_deal_league',ARRAY['cash_ev']::text[]),
        ('league','spin','full_brain_duplicate_deal_league',ARRAY['chip_ev','spin_ladder']::text[]),
        ('league','tourney_ev','full_brain_duplicate_deal_league',ARRAY['chip_ev']::text[]),
        ('league','tourney_icm','full_brain_duplicate_deal_league',ARRAY['satellite','bubble','final_table','in_money','ladder']::text[])
    )
    SELECT 1
      FROM required q
      LEFT JOIN public.gto_v31_release_evaluations e
        ON e.dataset_id=p_dataset_id
       AND e.dataset_checksum=p_dataset_checksum
       AND e.evaluation_kind=q.evaluation_kind
       AND e.game_family=q.game_family
      LEFT JOIN public.horse_league_results r ON r.id=e.source_result_id
     WHERE e.evaluation_id IS NULL
        OR r.id IS NULL
        OR e.verdict NOT IN ('win','tie')
        OR e.verdict IS DISTINCT FROM CASE
             WHEN r.bb100>2*r.stderr THEN 'win'
             WHEN r.bb100<(-2*r.stderr) THEN 'loss'
             ELSE 'tie'
           END
        OR r.hands<10000
        OR r.illegal_actions<>0
        OR r.truncated_streets<>0
        OR r.candidate_policy_hits<=0
        OR r.candidate_execution_mismatches<>0
        OR r.duration_ms<=0
        OR r.stderr<0
        OR r.matchup IS DISTINCT FROM
           'gto_v31_'||q.evaluation_kind||'_'||q.game_family||'_'||p_dataset_checksum
        OR jsonb_typeof(r.config_a)<>'object'
        OR CASE WHEN jsonb_typeof(r.config_a)='object'
             THEN (SELECT count(*) FROM jsonb_object_keys(r.config_a))
             ELSE -1
           END<> (8 + CASE WHEN v_feature_version IS NULL THEN 0 ELSE 1 END)
        OR NOT (r.config_a ?& ARRAY['evaluation_contract','evaluation_kind',
          'game_family','dataset_checksum','candidate','evaluation_profile','scenarios',
          'evaluation_engine_commit']::text[])
        OR NOT public.fn_gto_v31_feature_request_valid(r.config_a)
        OR r.config_a->>'feature_contract_version' IS DISTINCT FROM v_feature_version
        OR r.config_a->>'evaluation_contract'<>'gto_v31_candidate.v2'
        OR r.config_a->>'evaluation_kind'<>q.evaluation_kind
        OR r.config_a->>'game_family'<>q.game_family
        OR r.config_a->>'dataset_checksum'<>p_dataset_checksum
        OR r.config_a->>'candidate'<>'v31_certified'
        OR r.config_a->>'evaluation_profile'<>q.evaluation_profile
        OR r.config_a->'scenarios' IS DISTINCT FROM to_jsonb(q.scenarios)
        OR COALESCE(r.config_a->>'evaluation_engine_commit','')!~'^[0-9a-f]{40}$'
        OR r.config_a->>'evaluation_engine_commit'=repeat('0',40)
        OR jsonb_typeof(r.config_b)<>'object'
        OR CASE WHEN jsonb_typeof(r.config_b)='object'
             THEN (SELECT count(*) FROM jsonb_object_keys(r.config_b))
             ELSE -1
           END<>2
        OR NOT (r.config_b ?& ARRAY['incumbent_dataset_checksum','candidate']::text[])
        OR r.config_b->>'incumbent_dataset_checksum'<>v_incumbent
        OR r.config_b->>'candidate'<>'incumbent'
        OR jsonb_typeof(r.candidate_benchmark_components)<>'array'
        OR jsonb_array_length(r.candidate_benchmark_components)<>array_length(q.scenarios,1)
        OR EXISTS (
          SELECT 1
            FROM jsonb_array_elements(r.candidate_benchmark_components) component(value)
           WHERE jsonb_typeof(component.value)<>'object'
              OR component.value->'candidate_execution_mismatches' IS DISTINCT FROM '0'::jsonb
        )
        OR e.metrics IS DISTINCT FROM jsonb_build_object(
          'source_result_id',r.id,'run_date',r.run_date,'matchup',r.matchup,
          'hands',r.hands,'bb100',r.bb100,'stderr',r.stderr,
          'illegal_actions',r.illegal_actions,'truncated_streets',r.truncated_streets,
          'duration_ms',r.duration_ms,'candidate_policy_hits',r.candidate_policy_hits,
          'candidate_execution_mismatches',r.candidate_execution_mismatches,
          'candidate_node_roles',r.candidate_node_roles,
          'benchmark_components',r.candidate_benchmark_components,
          'candidate_config',r.config_a,'incumbent_config',r.config_b)
        OR e.result_checksum IS DISTINCT FROM public.fn_gto_v31_json_checksum(
          jsonb_build_object('dataset_checksum',p_dataset_checksum,
            'kind',q.evaluation_kind,'family',q.game_family,
            'verdict',e.verdict,'metrics',e.metrics))
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_v31_decision(p_decision jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=public
AS $fn$
DECLARE
  v_state jsonb:=p_decision->'decision_state';
  v_seal jsonb:=p_decision->'source_seal';
  v_distribution jsonb:=p_decision->'reference_distribution';
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_cell public.gto_v31_runtime_cells%ROWTYPE;
  v_board_count integer;
  v_board_text text;
  v_hole_text text;
  v_card_one integer;
  v_card_two integer;
  v_combo integer;
  v_expected_hand_key text;
  v_expected_cell text;
  v_expected_state_key text;
  v_spec jsonb;
  v_action_evs jsonb;
  v_selected_probability numeric;
  v_max_probability numeric;
  v_selected_ev numeric;
  v_regret numeric;
  v_expected_sample numeric;
  v_step numeric;
  v_amount_preserved boolean;
  v_executed boolean;
  v_expected_pure boolean;
BEGIN
  IF p_decision IS NULL OR jsonb_typeof(p_decision)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_decision))<>27
     OR NOT (p_decision ?& ARRAY[
       'state_key','decision_state','stage','game_family','objective','utility_context',
       'table_size','pot_type','hero_position','opponent_position','depth_bucket',
       'texture_class','node_role','facing_kind','facing_size_bucket','cell','hand_key',
       'sampled_action_id','sampled_action_family','final_action','executed_as_intended',
       'reference_distribution','chosen_probability','action_regret_bb','regret_eligible',
       'pure_miss','source_seal'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'state_key','stage','game_family','objective','utility_context','pot_type',
       'hero_position','opponent_position','texture_class','node_role','facing_kind',
       'facing_size_bucket','cell','hand_key','sampled_action_id','sampled_action_family',
       'final_action'
     ]) f(key) WHERE jsonb_typeof(p_decision->f.key)<>'string')
     OR jsonb_typeof(p_decision->'table_size')<>'number'
     OR jsonb_typeof(p_decision->'depth_bucket')<>'number'
     OR jsonb_typeof(p_decision->'executed_as_intended')<>'boolean'
     OR jsonb_typeof(v_distribution)<>'object'
     OR jsonb_typeof(p_decision->'chosen_probability')<>'number'
     OR jsonb_typeof(p_decision->'action_regret_bb') NOT IN ('number','null')
     OR jsonb_typeof(p_decision->'regret_eligible')<>'boolean'
     OR jsonb_typeof(p_decision->'pure_miss')<>'boolean'
     OR jsonb_typeof(v_state)<>'object'
     OR jsonb_typeof(v_seal)<>'object' THEN RETURN false; END IF;

  IF length(p_decision->>'state_key') NOT BETWEEN 8 AND 512
     OR p_decision->>'stage' NOT IN ('flop','turn','river')
     OR p_decision->>'game_family' NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR p_decision->>'objective' NOT IN ('cash_ev','chip_ev','icm')
     OR p_decision->>'utility_context' NOT IN ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
     OR NOT public.fn_gto_v31_json_safe_integer(p_decision->'table_size',2,10)
     OR p_decision->>'pot_type' NOT IN ('limped','srp','3bet','4bet_plus')
     OR p_decision->>'hero_position' NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR p_decision->>'opponent_position' NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR p_decision->>'hero_position'=p_decision->>'opponent_position'
     OR NOT public.fn_gto_v31_json_safe_integer(p_decision->'depth_bucket',10,150)
     OR (p_decision->>'depth_bucket')::integer NOT IN (10,20,40,80,150)
     OR p_decision->>'texture_class'!~'^[ABML][mtr][pu][cd]$'
     OR p_decision->>'node_role' NOT IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')
     OR p_decision->>'facing_kind' NOT IN ('none','bet','raise','all_in')
     OR p_decision->>'facing_size_bucket' NOT IN ('none','small','mid','big','all_in')
     OR length(p_decision->>'cell') NOT BETWEEN 20 AND 512
     OR NOT public.fn_gto_v31_feature_key_valid(p_decision->>'hand_key',p_decision->>'stage',v_seal->>'feature_contract_version')
     OR p_decision->>'sampled_action_id' !~ '^(c|f|b[1-9][0-9]{0,78})$'
     OR p_decision->>'sampled_action_family' NOT IN ('check','fold','call','bet','raise','all_in')
     OR p_decision->>'final_action' NOT IN ('check','fold','call','bet','raise','all_in')
     OR (p_decision->>'chosen_probability')::numeric NOT BETWEEN 0 AND 1
     OR (p_decision->'action_regret_bb'<>'null'::jsonb AND
         (p_decision->>'action_regret_bb')::numeric<0) THEN RETURN false; END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(v_state))<>34
     OR NOT (v_state ?& ARRAY[
       'schema_version','street','game_variant','game_family','objective','utility_context',
       'format','table_size','pot_type','hero_position','opponent_position','stack_bb',
       'depth_bucket','texture_class','node_role','facing_kind','facing_size_bucket',
       'hand','hand_key','cell','board','hole_cards','pot','current_bet','to_call',
       'big_blind','probe_scenario','probe_ordinal','sampled_action_id',
       'sampled_action_family','sampled_amount','final_action','final_amount',
       'executed_as_intended'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'street','game_variant','game_family','objective','utility_context','format','pot_type',
       'hero_position','opponent_position','texture_class','node_role','facing_kind',
       'facing_size_bucket','hand','hand_key','cell','probe_scenario','sampled_action_id',
       'sampled_action_family','final_action'
     ]) f(key) WHERE jsonb_typeof(v_state->f.key)<>'string')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'schema_version','table_size','stack_bb','depth_bucket','pot','current_bet',
       'to_call','big_blind','probe_ordinal'
     ]) f(key) WHERE jsonb_typeof(v_state->f.key)<>'number')
     OR jsonb_typeof(v_state->'sampled_amount') NOT IN ('number','null')
     OR jsonb_typeof(v_state->'final_amount') NOT IN ('number','null')
     OR jsonb_typeof(v_state->'board')<>'array'
     OR jsonb_typeof(v_state->'hole_cards')<>'array'
     OR jsonb_typeof(v_state->'executed_as_intended')<>'boolean'
     OR NOT public.fn_gto_v31_json_safe_integer(v_state->'schema_version',1,1)
     OR NOT public.fn_gto_v31_json_safe_integer(v_state->'table_size',2,10)
     OR NOT public.fn_gto_v31_json_safe_integer(v_state->'depth_bucket',10,150)
     OR NOT public.fn_gto_v31_json_safe_integer(v_state->'probe_ordinal',1,5000)
     OR (v_state->>'stack_bb')::numeric<=0 OR (v_state->>'stack_bb')::numeric>1000000
     OR (v_state->>'pot')::numeric<0 OR (v_state->>'pot')::numeric>9007199254740991
     OR (v_state->>'current_bet')::numeric<0 OR (v_state->>'current_bet')::numeric>9007199254740991
     OR (v_state->>'to_call')::numeric<0 OR (v_state->>'to_call')::numeric>9007199254740991
     OR (v_state->>'big_blind')::numeric<=0 OR (v_state->>'big_blind')::numeric>1000000
     OR (v_state->'sampled_amount'<>'null'::jsonb AND
         ((v_state->>'sampled_amount')::numeric<0 OR (v_state->>'sampled_amount')::numeric>9007199254740991))
     OR (v_state->'final_amount'<>'null'::jsonb AND
         ((v_state->>'final_amount')::numeric<0 OR (v_state->>'final_amount')::numeric>9007199254740991))
  THEN RETURN false; END IF;

  IF v_state->>'game_variant'<>'nlh'
     OR v_state->>'street'<>p_decision->>'stage'
     OR v_state->>'game_family'<>p_decision->>'game_family'
     OR v_state->>'objective'<>p_decision->>'objective'
     OR v_state->>'utility_context'<>p_decision->>'utility_context'
     OR v_state->'table_size'<>p_decision->'table_size'
     OR v_state->>'pot_type'<>p_decision->>'pot_type'
     OR v_state->>'hero_position'<>p_decision->>'hero_position'
     OR v_state->>'opponent_position'<>p_decision->>'opponent_position'
     OR v_state->'depth_bucket'<>p_decision->'depth_bucket'
     OR v_state->>'texture_class'<>p_decision->>'texture_class'
     OR v_state->>'node_role'<>p_decision->>'node_role'
     OR v_state->>'facing_kind'<>p_decision->>'facing_kind'
     OR v_state->>'facing_size_bucket'<>p_decision->>'facing_size_bucket'
     OR v_state->>'hand_key'<>p_decision->>'hand_key'
     OR v_state->>'cell'<>p_decision->>'cell'
     OR v_state->>'probe_scenario'<>v_state->>'utility_context'
     OR v_state->>'sampled_action_id'<>p_decision->>'sampled_action_id'
     OR v_state->>'sampled_action_family'<>p_decision->>'sampled_action_family'
     OR v_state->>'final_action'<>p_decision->>'final_action'
     OR (v_state->>'executed_as_intended')::boolean IS DISTINCT FROM
        (p_decision->>'executed_as_intended')::boolean
     OR NOT ((p_decision->>'game_family'='cash' AND p_decision->>'objective'='cash_ev'
              AND p_decision->>'utility_context'='cash_ev' AND v_state->>'format'='cash')
       OR (p_decision->>'game_family'='tourney_ev' AND p_decision->>'objective'='chip_ev'
              AND p_decision->>'utility_context'='chip_ev' AND v_state->>'format'='mtt')
       OR (p_decision->>'game_family'='spin' AND p_decision->>'objective'='chip_ev'
              AND p_decision->>'utility_context'='chip_ev' AND v_state->>'format'='spin')
       OR (p_decision->>'game_family'='spin' AND p_decision->>'objective'='icm'
              AND p_decision->>'utility_context'='spin_ladder' AND v_state->>'format'='spin')
       OR (p_decision->>'game_family'='tourney_icm' AND p_decision->>'objective'='icm'
              AND p_decision->>'utility_context' IN ('satellite','bubble','final_table','in_money','ladder')
              AND v_state->>'format'='mtt'))
  THEN RETURN false; END IF;

  v_board_count:=CASE p_decision->>'stage' WHEN 'flop' THEN 3 WHEN 'turn' THEN 4 ELSE 5 END;
  v_board_text:=public.fn_horse_solver_v31_cards_text(v_state->'board',v_board_count);
  v_hole_text:=public.fn_horse_solver_v31_cards_text(v_state->'hole_cards',2);
  IF v_board_text IS NULL OR v_hole_text IS NULL
     OR EXISTS (
       SELECT 1 FROM (
         SELECT public.fn_horse_solver_v31_card_text(value) card
           FROM jsonb_array_elements((v_state->'board')||(v_state->'hole_cards'))
       ) cards GROUP BY card HAVING count(*)>1
     ) THEN RETURN false; END IF;

  v_card_one:=(position(left(v_hole_text,1) IN '23456789TJQKA')-1)*4+
    position(substr(v_hole_text,2,1) IN 'cdhs')-1;
  v_card_two:=(position(substr(v_hole_text,3,1) IN '23456789TJQKA')-1)*4+
    position(substr(v_hole_text,4,1) IN 'cdhs')-1;
  v_combo:=greatest(v_card_one,v_card_two)*(greatest(v_card_one,v_card_two)-1)/2+
    least(v_card_one,v_card_two);
  v_expected_hand_key:=public.fn_gto_v31_feature_key(v_combo,v_board_text,v_seal->>'feature_contract_version');
  IF v_expected_hand_key IS NULL OR v_state->>'hand_key'<>v_expected_hand_key
     OR v_state->>'hand'<>split_part(public.fn_gto_v31_hand_key(v_combo,v_board_text),':',1)
     OR v_state->>'texture_class'<>public.fn_gto_texture_class_any(v_board_text)
  THEN RETURN false; END IF;

  v_expected_cell:=concat_ws('|',v_state->>'street',v_state->>'game_family',
    v_state->>'objective',v_state->>'utility_context',v_state->>'table_size',
    v_state->>'pot_type',v_state->>'hero_position',v_state->>'opponent_position',
    v_state->>'depth_bucket',v_state->>'texture_class',v_state->>'node_role',
    v_state->>'facing_kind',v_state->>'facing_size_bucket');
  v_expected_state_key:=concat_ws('|','v31',v_expected_cell,v_expected_hand_key,
    v_state->>'probe_scenario',v_state->>'probe_ordinal');
  IF v_state->>'cell'<>v_expected_cell OR p_decision->>'state_key'<>v_expected_state_key THEN
    RETURN false;
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(v_seal))<> (25 + CASE WHEN v_seal ? 'feature_contract_version' THEN 1 ELSE 0 END)
     OR NOT public.fn_gto_v31_feature_request_valid(v_seal)
     OR NOT (v_seal ?& ARRAY[
       'dataset_id','dataset_key','dataset_checksum','solver_version',
       'solver_binary_checksum','pipeline_commit','pipeline_bundle_checksum',
       'manifest_version','manifest_checksum','source_artifact_checksum',
       'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
       'input_bundle_checksum','cell_key_checksum','cell_payload_checksum',
       'lineage_checksum','quality_status','dataset_state','dataset_cells','source_rows',
       'train_source_rows','holdout_source_rows','invalid_rows','audited_at'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'dataset_id','dataset_key','dataset_checksum','solver_version',
       'solver_binary_checksum','pipeline_commit','pipeline_bundle_checksum',
       'manifest_version','manifest_checksum','source_artifact_checksum',
       'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
       'input_bundle_checksum','cell_key_checksum','cell_payload_checksum',
       'lineage_checksum','quality_status','dataset_state','audited_at'
     ]) f(key) WHERE jsonb_typeof(v_seal->f.key)<>'string')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'dataset_cells','source_rows','train_source_rows','holdout_source_rows','invalid_rows'
     ]) f(key) WHERE jsonb_typeof(v_seal->f.key)<>'number')
     OR v_seal->>'dataset_id' !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR v_seal->>'quality_status'<>'validated'
     OR v_seal->>'dataset_state'<>'active'
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'dataset_cells',1,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'source_rows',1,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'train_source_rows',1,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'holdout_source_rows',1,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'invalid_rows',0,0)
  THEN RETURN false; END IF;

  SELECT * INTO v_dataset FROM public.gto_v31_datasets d
   WHERE d.dataset_id=(v_seal->>'dataset_id')::uuid
     AND d.state='active' AND d.promoted_at IS NOT NULL
     AND d.quality_status='validated' AND d.invalid_rows=0;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.gto_v31_input_bundles b
     WHERE b.input_bundle_id=v_dataset.input_bundle_id
       AND b.approval_status='approved' AND b.bundle_checksum=v_dataset.input_bundle_checksum
  ) THEN RETURN false; END IF;
  SELECT * INTO v_cell FROM public.gto_v31_runtime_cells c
   WHERE c.dataset_id=v_dataset.dataset_id
     AND c.cell_key_checksum=v_seal->>'cell_key_checksum';
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_seal->>'dataset_key'<>v_dataset.dataset_key
     OR v_seal->>'dataset_checksum'<>v_dataset.dataset_checksum
     OR v_seal->>'solver_version'<>v_dataset.solver_version
     OR v_seal->>'solver_binary_checksum'<>v_dataset.solver_binary_checksum
     OR v_seal->>'pipeline_commit'<>v_dataset.pipeline_commit
     OR v_seal->>'feature_contract_version' IS DISTINCT FROM v_dataset.feature_contract_version
     OR v_seal->>'pipeline_bundle_checksum'<>v_dataset.pipeline_bundle_checksum
     OR v_seal->>'manifest_version'<>v_dataset.manifest_version
     OR v_seal->>'manifest_checksum'<>v_dataset.manifest_checksum
     OR v_seal->>'source_artifact_checksum'<>v_dataset.source_artifact_checksum
     OR v_seal->>'source_combo_order_checksum'<>v_dataset.source_combo_order_checksum
     OR v_seal->>'range_bundle_checksum'<>v_dataset.range_bundle_checksum
     OR v_seal->>'icm_model_checksum'<>v_dataset.icm_model_checksum
     OR v_seal->>'input_bundle_checksum'<>v_dataset.input_bundle_checksum
     OR v_seal->>'cell_payload_checksum'<>v_cell.cell_payload_checksum
     OR v_seal->>'lineage_checksum'<>v_cell.lineage_checksum
     OR (v_seal->>'dataset_cells')::bigint<>(v_dataset.coverage->>'cells')::bigint
     OR (v_seal->>'source_rows')::bigint<>v_dataset.source_rows
     OR (v_seal->>'train_source_rows')::bigint<>v_dataset.train_source_rows
     OR (v_seal->>'holdout_source_rows')::bigint<>v_dataset.holdout_source_rows
     OR (v_seal->>'audited_at')::timestamptz IS DISTINCT FROM v_dataset.audited_at
     OR v_cell.street<>p_decision->>'stage'
     OR v_cell.game_family<>p_decision->>'game_family'
     OR v_cell.objective<>p_decision->>'objective'
     OR v_cell.utility_context<>p_decision->>'utility_context'
     OR v_cell.table_size<>(p_decision->>'table_size')::integer
     OR v_cell.pot_type<>p_decision->>'pot_type'
     OR v_cell.hero_position<>p_decision->>'hero_position'
     OR v_cell.opponent_position<>p_decision->>'opponent_position'
     OR v_cell.depth_bucket<>(p_decision->>'depth_bucket')::integer
     OR v_cell.texture_class<>p_decision->>'texture_class'
     OR v_cell.node_role<>p_decision->>'node_role'
     OR v_cell.facing_kind<>p_decision->>'facing_kind'
     OR v_cell.facing_size_bucket<>p_decision->>'facing_size_bucket'
  THEN RETURN false; END IF;

  v_spec:=v_cell.action_specs->(p_decision->>'sampled_action_id');
  v_action_evs:=v_cell.action_ev_matrix->(p_decision->>'hand_key');
  IF jsonb_typeof(v_spec)<>'object'
     OR v_spec->>'family'<>p_decision->>'sampled_action_family'
     OR NOT (v_cell.hand_matrix ? (p_decision->>'hand_key'))
     OR v_distribution<>v_cell.hand_matrix->(p_decision->>'hand_key')
     OR NOT (v_distribution ? (p_decision->>'sampled_action_id'))
     OR jsonb_typeof(v_action_evs)<>'object'
     OR NOT (v_action_evs ? (p_decision->>'sampled_action_id')) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(v_distribution)
              WHERE jsonb_typeof(value)<>'number' OR (value#>>'{}')::numeric NOT BETWEEN 0 AND 1)
     OR abs((SELECT sum((value#>>'{}')::numeric) FROM jsonb_each(v_distribution))-1)>0.002
  THEN RETURN false; END IF;

  v_selected_probability:=(v_distribution->>(p_decision->>'sampled_action_id'))::numeric;
  SELECT max((value#>>'{}')::numeric) INTO v_max_probability FROM jsonb_each(v_distribution);
  v_selected_ev:=(v_action_evs->>(p_decision->>'sampled_action_id'))::numeric;
  SELECT greatest(0,max((value#>>'{}')::numeric)-v_selected_ev)
    INTO v_regret FROM jsonb_each(v_action_evs);

  IF p_decision->>'sampled_action_family' IN ('check','fold','all_in') THEN
    IF v_state->'sampled_amount'<>'null'::jsonb THEN RETURN false; END IF;
  ELSIF p_decision->>'sampled_action_family'='call' THEN
    v_expected_sample:=(v_state->>'to_call')::numeric;
  ELSIF p_decision->>'sampled_action_family'='bet' THEN
    v_expected_sample:=(v_state->>'pot')::numeric*(v_spec->>'size_value')::numeric;
  ELSE
    v_expected_sample:=(v_state->>'current_bet')::numeric+
      ((v_state->>'pot')::numeric+(v_state->>'to_call')::numeric)*(v_spec->>'size_value')::numeric;
  END IF;
  IF v_expected_sample IS NOT NULL AND
     (v_state->'sampled_amount'='null'::jsonb OR
      abs((v_state->>'sampled_amount')::numeric-v_expected_sample)>0.0001) THEN RETURN false; END IF;

  IF p_decision->>'final_action' IN ('check','fold','all_in') THEN
    IF v_state->'final_amount'<>'null'::jsonb THEN RETURN false; END IF;
  ELSIF v_state->'final_amount'='null'::jsonb THEN RETURN false;
  END IF;
  v_step:=CASE WHEN (v_state->>'big_blind')::numeric>=1
                    AND (v_state->>'big_blind')::numeric=trunc((v_state->>'big_blind')::numeric)
               THEN 1 ELSE 0.01 END;
  v_amount_preserved:=v_state->'sampled_amount'<>'null'::jsonb
    AND v_state->'final_amount'<>'null'::jsonb
    AND abs((v_state->>'sampled_amount')::numeric-(v_state->>'final_amount')::numeric)<=v_step+0.005;
  v_executed:=CASE p_decision->>'sampled_action_family'
    WHEN 'call' THEN p_decision->>'final_action'='all_in' OR
      (p_decision->>'final_action'='call' AND v_amount_preserved)
    WHEN 'bet' THEN p_decision->>'final_action'='bet' AND v_amount_preserved
    WHEN 'raise' THEN p_decision->>'final_action'='raise' AND v_amount_preserved
    ELSE p_decision->>'final_action'=p_decision->>'sampled_action_family' END;
  v_expected_pure:=v_max_probability>=0.9 AND
    (NOT v_executed OR v_selected_probability<0.9);

  IF (p_decision->>'executed_as_intended')::boolean IS DISTINCT FROM v_executed
     OR abs((p_decision->>'chosen_probability')::numeric-
       CASE WHEN v_executed THEN v_selected_probability ELSE 0 END)>0.000001
     OR (p_decision->>'regret_eligible')::boolean IS DISTINCT FROM v_executed
     OR (v_executed AND (p_decision->'action_regret_bb'='null'::jsonb OR
         abs((p_decision->>'action_regret_bb')::numeric-v_regret)>0.0001))
     OR (NOT v_executed AND p_decision->'action_regret_bb'<>'null'::jsonb)
     OR (p_decision->>'pure_miss')::boolean IS DISTINCT FROM v_expected_pure
  THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_feature_binding_immutable() FROM PUBLIC,anon,authenticated,service_role;
-- Restate the existing service-only ACLs for each replaced definer helper.
REVOKE ALL ON FUNCTION public.fn_gto_v31_heldout_metrics(uuid,text),public.fn_gto_v31_candidate_evaluations_valid(uuid,text),public.fn_horse_solver_agreement_v31_decision(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_gto_v31_candidate_evaluations_valid(uuid,text),public.fn_horse_solver_agreement_v31_decision(jsonb) FROM service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_heldout_metrics(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_gto_v31_board_relative_key_v2(integer,text),public.fn_gto_v31_board_relative_key_v2_valid(text),public.fn_gto_v31_feature_identity(text),public.fn_gto_v31_feature_request_valid(jsonb),public.fn_gto_v31_feature_key(integer,text,text),public.fn_gto_v31_feature_key_valid(text,text,text),public.fn_gto_v31_hand_matrix_valid(jsonb,text,text),public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_feature_identity(text),public.fn_gto_v31_feature_request_valid(jsonb),public.fn_gto_v31_feature_key(integer,text,text),public.fn_gto_v31_feature_key_valid(text,text,text),public.fn_gto_v31_hand_matrix_valid(jsonb,text,text),public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text) TO service_role;
DO $postassert$ DECLARE v_rpc regprocedure; BEGIN
 IF EXISTS (SELECT 1 FROM v31_feature_legacy_snapshot s FULL JOIN public.gto_v31_datasets d USING(dataset_id)
  WHERE s.dataset_id IS NULL OR d.dataset_id IS NULL OR d.dataset_checksum IS DISTINCT FROM s.dataset_checksum
  OR d.state IS DISTINCT FROM s.state OR d.feature_contract_version IS NOT NULL) THEN
  RAISE EXCEPTION 'migration changed an existing dataset identity or state'; END IF;
 IF EXISTS (SELECT 1 FROM v31_feature_legacy_functions WHERE
  md5(pg_get_functiondef(signature::regprocedure)) IS DISTINCT FROM digest) THEN
  RAISE EXCEPTION 'legacy hand-key function changed'; END IF;
 IF public.fn_gto_v31_feature_identity(NULL) <> '{}'::jsonb
  OR public.fn_gto_v31_feature_request_valid('{"feature_contract_version":null}'::jsonb)
  OR public.fn_gto_v31_feature_request_valid('{"feature_contract_version":"unknown"}'::jsonb)
  OR NOT public.fn_gto_v31_feature_request_valid('{"feature_contract_version":"holdem-board-relative-v2"}'::jsonb)
  THEN RAISE EXCEPTION 'immutable feature request contract failed'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
  AND table_name IN ('gto_v31_input_bundles','gto_v31_datasets','gto_v31_runtime_cells')
  AND column_name='feature_contract_version' AND is_nullable='YES' AND data_type='text')<>3 THEN
  RAISE EXCEPTION 'nullable immutable feature metadata is missing'; END IF;
 FOREACH v_rpc IN ARRAY ARRAY['public.fn_gto_v31_active_cells(integer,integer)'::regprocedure,
  'public.fn_gto_v31_evaluation_cells(uuid,integer,integer)'::regprocedure] LOOP
  IF NOT (SELECT prosecdef AND proowner=(SELECT s.proowner FROM v31_feature_rpc_owners s WHERE s.signature=v_rpc::text)
    AND proconfig @> ARRAY['search_path=public']
    AND proargnames[array_length(proargnames,1)]='feature_contract_version' FROM pg_proc WHERE oid=v_rpc)
   OR NOT has_function_privilege('service_role',v_rpc,'EXECUTE')
   OR has_function_privilege('anon',v_rpc,'EXECUTE')
   OR has_function_privilege('authenticated',v_rpc,'EXECUTE') THEN
   RAISE EXCEPTION 'versioned RPC identity, security or grants differ: %',v_rpc; END IF;
 END LOOP;
END; $postassert$;
COMMIT;
