\set ON_ERROR_STOP on
BEGIN;

DO $probe$
DECLARE
  expected_checksum constant text := '91b7ae079daa5100ac80001c50fcca145e5ced8048adf455b4f5e84a5e5aaf51';
  expected_id constant uuid := '91b7ae07-9daa-5100-8c80-001c50fcca14'::uuid;
  bundle jsonb;
  manifest_stub jsonb;
  manifest_checksum text;
  approved_id uuid;
  stored_checksum text;
  dataset_id uuid;
BEGIN
  bundle := jsonb_build_object(
    'bundle_key','phase4.bootstrap.inputs',
    'bundle_version','2',
    'range_bundle_checksum',repeat('e',64),
    'source_combo_order_checksum',repeat('d',64),
    'icm_model_checksum',repeat('f',64),
    'approval_note','bootstrap behavior probe only',
    'files',jsonb_build_array(
      jsonb_build_object('kind','range','path','ranges/test.txt','checksum',repeat('e',64)),
      jsonb_build_object('kind','combo_order','path','combo/order.txt','checksum',repeat('d',64)),
      jsonb_build_object('kind','icm_model','path','icm/model.json','checksum',repeat('f',64)),
      jsonb_build_object('kind','scenario_manifest','path','manifests/phase4.json','checksum',repeat('a',64))
    )
  );

  IF public.fn_gto_v31_input_bundle_checksum(bundle) IS DISTINCT FROM expected_checksum THEN
    RAISE EXCEPTION 'database input identity does not match the cross-language fixture';
  END IF;
  IF public.fn_gto_v31_input_bundle_id(expected_checksum) IS DISTINCT FROM expected_id THEN
    RAISE EXCEPTION 'database input UUID does not match the cross-language fixture';
  END IF;

  BEGIN
    PERFORM public.fn_gto_v31_input_bundle_checksum(
      jsonb_set(bundle,'{bundle_version}',to_jsonb(2),false)
    );
    RAISE EXCEPTION 'numeric bundle version was coerced into the input identity';
  EXCEPTION WHEN others THEN
    IF SQLERRM='numeric bundle version was coerced into the input identity' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_gto_v31_input_bundle_checksum(
      jsonb_set(bundle,'{files,3,path}',to_jsonb(12),false)
    );
    RAISE EXCEPTION 'numeric receipt path was coerced into the input identity';
  EXCEPTION WHEN others THEN
    IF SQLERRM='numeric receipt path was coerced into the input identity' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_gto_v31_input_bundle_checksum(
      jsonb_set(bundle,'{approval_note}',to_jsonb(123),false)
    );
    RAISE EXCEPTION 'numeric approval note was accepted by the input identity';
  EXCEPTION WHEN others THEN
    IF SQLERRM='numeric approval note was accepted by the input identity' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_gto_v31_input_bundle_checksum(
      jsonb_set(bundle,'{approval_note}',to_jsonb(E'\t\n'::text),false)
    );
    RAISE EXCEPTION 'whitespace-only approval note was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM='whitespace-only approval note was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_gto_v31_input_bundle_checksum(
      jsonb_set(bundle,'{files,3,path}',to_jsonb('manifests//phase4.json'::text),false)
    );
    RAISE EXCEPTION 'empty receipt path component was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM='empty receipt path component was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_gto_v31_input_bundle_checksum(
      jsonb_set(bundle,'{files,3,path}',to_jsonb('manifests/./phase4.json'::text),false)
    );
    RAISE EXCEPTION 'dot receipt path component was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM='dot receipt path component was accepted' THEN RAISE; END IF;
  END;

  -- Both manifest inputs are now known before approval. The final manifest
  -- checksum can therefore be inserted into the approval payload without a
  -- fixed-point search or a mutable post-approval update.
  manifest_stub := jsonb_build_object(
    'contract','smarter-poker.horse-solver-v31-manifest.v1',
    'input_bundle_id',expected_id,
    'input_bundle_checksum',expected_checksum
  );
  manifest_checksum := encode(digest(convert_to(
    public.fn_training_canonical_jsonb_text_v1(manifest_stub),
    'UTF8'
  ),'sha256'),'hex');
  bundle := jsonb_set(bundle,'{files,3,checksum}',to_jsonb(manifest_checksum),false);

  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
    AS $auth$ SELECT 'authenticated'::text $auth$;

  BEGIN
    PERFORM public.ca_gto_v31_approve_input_bundle(
      jsonb_set(bundle,'{range_bundle_checksum}',to_jsonb(upper(repeat('e',64))),false)
    );
    RAISE EXCEPTION 'uppercase input checksum was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM='uppercase input checksum was accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.ca_gto_v31_approve_input_bundle(
      jsonb_set(bundle,'{bundle_key}',to_jsonb(123),false)
    );
    RAISE EXCEPTION 'approval coerced a numeric bundle key';
  EXCEPTION WHEN others THEN
    IF SQLERRM='approval coerced a numeric bundle key' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.ca_gto_v31_approve_input_bundle(
      jsonb_set(bundle,'{files,0,path}',to_jsonb('ranges/v1..txt'::text),false)
    );
    RAISE EXCEPTION 'ambiguous input path was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM='ambiguous input path was accepted' THEN RAISE; END IF;
  END;

  approved_id := public.ca_gto_v31_approve_input_bundle(bundle);
  IF public.ca_gto_v31_approve_input_bundle(bundle) IS DISTINCT FROM approved_id THEN
    RAISE EXCEPTION 'an exact approval retry was not idempotent';
  END IF;
  BEGIN
    PERFORM public.ca_gto_v31_approve_input_bundle(
      jsonb_set(bundle,'{approval_note}',to_jsonb('changed review note'::text),false)
    );
    RAISE EXCEPTION 'input identity was reused with a changed approval payload';
  EXCEPTION WHEN others THEN
    IF SQLERRM='input identity was reused with a changed approval payload' THEN RAISE; END IF;
  END;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
    AS $auth$ SELECT 'service_role'::text $auth$;

  SELECT b.bundle_checksum INTO stored_checksum
    FROM public.gto_v31_input_bundles b
   WHERE b.input_bundle_id=approved_id;
  IF approved_id IS DISTINCT FROM expected_id OR stored_checksum IS DISTINCT FROM expected_checksum THEN
    RAISE EXCEPTION 'approved input bundle did not retain its precomputed identity';
  END IF;

  dataset_id := public.fn_gto_v31_register_dataset(jsonb_build_object(
    'dataset_key','phase4.bootstrap.dataset',
    'solver_version','PioSOLVER-edge',
    'solver_binary_checksum',repeat('1',64),
    'pipeline_commit',repeat('2',40),
    'pipeline_bundle_checksum',repeat('3',64),
    'manifest_version','v31.bootstrap',
    'manifest_checksum',manifest_checksum,
    'source_combo_order_checksum',repeat('d',64),
    'range_bundle_checksum',repeat('e',64),
    'icm_model_checksum',repeat('f',64),
    'input_bundle_id',approved_id,
    'input_bundle_checksum',stored_checksum,
    'machine_ids',jsonb_build_array('M1','M2'),
    'declared_coverage',jsonb_build_array(jsonb_build_object(
      'street','flop','game_family','cash','objective','cash_ev',
      'utility_context','cash_ev','table_size',2,'pot_type','srp',
      'hero_position','SB','opponent_position','BB','depth_bucket',80,
      'texture_class','Atud','node_role','open','facing_kind','none',
      'facing_size_bucket','none'
    )),
    'quality_gates',jsonb_build_object(
      'max_frequency_mae',0.10,'max_sizing_mae',0.10,
      'max_policy_ev_mae_bb',0.20,'max_action_regret_bb',0.10,
      'min_regret_coverage',0.80
    )
  ));
  IF dataset_id IS NULL THEN
    RAISE EXCEPTION 'a precomputed input identity could not register its exact manifest';
  END IF;
END;
$probe$;

ROLLBACK;
SELECT 'V31_INPUT_BUNDLE_BOOTSTRAP_OK' AS result;
