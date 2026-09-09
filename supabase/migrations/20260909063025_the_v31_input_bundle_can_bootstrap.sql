-- ============================================================================
-- THE V31 INPUT BUNDLE CAN BOOTSTRAP
--
-- The original approval contract hashed the complete approval payload and let
-- PostgreSQL generate its UUID.  The scenario-manifest receipt was part of
-- that payload, while the manifest itself had to contain the generated UUID
-- and payload checksum.  Producing either side therefore required knowing the
-- other side first.
--
-- Define one cross-language, manifest-independent input identity instead.
-- Its checksum binds the immutable range/combo-order/ICM receipts and its UUID
-- is deterministically derived from that checksum.  The final manifest can
-- then contain both values before an administrator approves its exact receipt.
-- Dataset registration still requires that approved manifest checksum, so the
-- bootstrap repair removes the cycle without weakening provenance.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_input_bundle_checksum(p_bundle jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $fn$
DECLARE
  v_files jsonb;
  v_identity jsonb;
BEGIN
  IF jsonb_typeof(p_bundle) <> 'object' OR jsonb_typeof(p_bundle->'files') <> 'array' THEN
    RAISE EXCEPTION 'V31 input bundle identity requires an object with file receipts';
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

  IF v_files IS NULL OR jsonb_array_length(v_files) = 0 THEN
    RAISE EXCEPTION 'V31 input bundle identity has no immutable input receipts';
  END IF;

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

CREATE OR REPLACE FUNCTION public.fn_gto_v31_input_bundle_id(p_bundle_checksum text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_hex text;
BEGIN
  IF p_bundle_checksum !~ '^[0-9a-f]{64}$' OR p_bundle_checksum = repeat('0',64) THEN
    RAISE EXCEPTION 'V31 input bundle checksum is invalid';
  END IF;

  -- RFC 4122 version 5 / variant 1 shape over the first 128 checksum bits.
  v_hex := substring(p_bundle_checksum,1,12) || '5' ||
           substring(p_bundle_checksum,14,3) || '8' ||
           substring(p_bundle_checksum,18,15);
  RETURN (
    substring(v_hex,1,8) || '-' || substring(v_hex,9,4) || '-' ||
    substring(v_hex,13,4) || '-' || substring(v_hex,17,4) || '-' ||
    substring(v_hex,21,12)
  )::uuid;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_input_bundle_checksum(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_input_bundle_checksum(jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_gto_v31_input_bundle_id(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_input_bundle_id(text)
  TO service_role;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='public.gto_v31_input_bundles'::regclass
       AND conname='gto_v31_input_bundles_deterministic_id_chk'
  ) THEN
    ALTER TABLE public.gto_v31_input_bundles
      ADD CONSTRAINT gto_v31_input_bundles_deterministic_id_chk
      CHECK (input_bundle_id=public.fn_gto_v31_input_bundle_id(bundle_checksum))
      NOT VALID;
  END IF;
END;
$constraint$;
ALTER TABLE public.gto_v31_input_bundles
  VALIDATE CONSTRAINT gto_v31_input_bundles_deterministic_id_chk;

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
     OR (SELECT count(*) FROM jsonb_object_keys(p_bundle)) <> 7
     OR NOT (p_bundle ?& ARRAY['bundle_key','bundle_version','range_bundle_checksum',
       'source_combo_order_checksum','icm_model_checksum','files','approval_note'])
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
    source_combo_order_checksum,icm_model_checksum,bundle_manifest,approved_by
  ) VALUES (
    v_id,p_bundle->>'bundle_key',v_checksum,p_bundle->>'range_bundle_checksum',
    p_bundle->>'source_combo_order_checksum',p_bundle->>'icm_model_checksum',p_bundle,v_actor
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

REVOKE ALL ON FUNCTION public.ca_gto_v31_approve_input_bundle(jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ca_gto_v31_approve_input_bundle(jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.fn_gto_v31_input_bundle_checksum(jsonb) IS
  'Canonical V31 input identity. Excludes the human note and final scenario-manifest receipt so a manifest can bind this checksum without a hash cycle.';
COMMENT ON FUNCTION public.fn_gto_v31_input_bundle_id(text) IS
  'Deterministically maps one V31 input identity checksum to its RFC 4122-shaped bundle UUID.';
COMMENT ON FUNCTION public.ca_gto_v31_approve_input_bundle(jsonb) IS
  'Horse-admin approval for one exact V31 input bundle and final manifest receipt. The input UUID/checksum are deterministic before approval.';

COMMIT;
