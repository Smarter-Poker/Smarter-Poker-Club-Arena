\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT 'authenticated'::text $$;

SELECT public.ca_gto_v31_approve_input_bundle(jsonb_build_object(
  'bundle_key','phase4.hand-key.guard',
  'bundle_version','1',
  'range_bundle_checksum',repeat('a',64),
  'source_combo_order_checksum',repeat('b',64),
  'icm_model_checksum',repeat('c',64),
  'approval_note','migration refusal probe fixture only',
  'files',jsonb_build_array(
    jsonb_build_object('kind','range','path','ranges/guard.txt','checksum',repeat('a',64)),
    jsonb_build_object('kind','combo_order','path','combo/guard.txt','checksum',repeat('b',64)),
    jsonb_build_object('kind','icm_model','path','icm/guard.json','checksum',repeat('c',64)),
    jsonb_build_object('kind','scenario_manifest','path','manifests/guard.json','checksum',repeat('d',64))
  )
)) AS guard_bundle_id \gset

SELECT bundle_checksum AS guard_bundle_checksum
  FROM public.gto_v31_input_bundles
 WHERE input_bundle_id=:'guard_bundle_id'::uuid \gset

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;

SELECT public.fn_gto_v31_register_dataset(jsonb_build_object(
  'dataset_key','phase4.hand-key.guard',
  'solver_version','PioSOLVER-guard',
  'solver_binary_checksum',repeat('e',64),
  'pipeline_commit',repeat('f',40),
  'pipeline_bundle_checksum',repeat('1',64),
  'manifest_version','1',
  'manifest_checksum',repeat('d',64),
  'source_combo_order_checksum',repeat('b',64),
  'range_bundle_checksum',repeat('a',64),
  'icm_model_checksum',repeat('c',64),
  'input_bundle_id',:'guard_bundle_id',
  'input_bundle_checksum',:'guard_bundle_checksum',
  'machine_ids',jsonb_build_array('M1','M2'),
  'declared_coverage',jsonb_build_array(jsonb_build_object('probe',true)),
  'quality_gates',jsonb_build_object(
    'max_frequency_mae',0.10,
    'max_sizing_mae',0.10,
    'max_policy_ev_mae_bb',0.20,
    'max_action_regret_bb',0.10,
    'min_regret_coverage',0.80
  )
));
