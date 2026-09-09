-- ============================================================================
-- V31 INPUT IDENTITY REQUIRES JSON STRINGS
--
-- PostgreSQL's ->> operator turns JSON numbers into text. The Python contract
-- deliberately hashes JSON strings. Without an explicit type gate, a payload
-- such as {"bundle_version": 2} could pass the SQL regex but produce a
-- different identity on each side of the signed solver boundary.
--
-- Keep the v2 identity unchanged for every valid bundle, but reject all
-- coercible scalar and receipt values before hashing them.
-- ============================================================================

BEGIN;

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
     OR (SELECT count(*) FROM jsonb_object_keys(p_bundle)) <> 7
     OR NOT (p_bundle ?& ARRAY['bundle_key','bundle_version','range_bundle_checksum',
       'source_combo_order_checksum','icm_model_checksum','files','approval_note'])
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

  RETURN encode(digest(convert_to(
    public.fn_training_canonical_jsonb_text_v1(v_identity),
    'UTF8'
  ),'sha256'),'hex');
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_input_bundle_checksum(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_input_bundle_checksum(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.fn_gto_v31_input_bundle_checksum(jsonb) IS
  'Canonical V31 input identity. Requires real JSON strings, excludes the human note and final scenario-manifest receipt, and binds every immutable input receipt.';

COMMIT;
