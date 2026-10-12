\set ON_ERROR_STOP on
BEGIN;
DO $probe$
DECLARE
 v_key text;
 v_version text;
 v_context jsonb:=jsonb_build_object('street','flop','game_family','cash','objective','cash_ev','utility_context','cash_ev','table_size',2,'pot_type','srp','hero_position','SB','opponent_position','BB','depth_bucket',80,'texture_class','Atuc','node_role','open','facing_kind','none','facing_size_bucket','none');
 v_expected text;
 v_specs jsonb:='{"c":{"family":"check","size_unit":"none","size_value":null,"all_in":false},"b50":{"family":"bet","size_unit":"pot_fraction","size_value":0.5,"all_in":false}}';
 v_cell jsonb;
 v_bundle jsonb; v_bundle_id uuid; v_dataset uuid; v_request jsonb; v_failed boolean;
BEGIN
 IF public.fn_gto_v31_feature_request_valid('{"feature_contract_version":null}')
    OR public.fn_gto_v31_feature_request_valid('{"feature_contract_version":false}')
    OR public.fn_gto_v31_feature_request_valid('{"feature_contract_version":"unknown"}')
    OR NOT public.fn_gto_v31_feature_request_valid('{}') THEN RAISE EXCEPTION 'feature request admission failed'; END IF;
 v_expected:=public.fn_gto_v31_json_checksum(v_context);
 IF public.fn_gto_v31_cell_key_checksum(v_context)<>v_expected
    OR public.fn_gto_v31_cell_key_checksum(v_context||'{"feature_contract_version":null}')<>v_expected THEN RAISE EXCEPTION 'legacy cell identity changed'; END IF;
 FOREACH v_version IN ARRAY ARRAY['rank-suit-count-v1','holdem-board-relative-v2'] LOOP
   IF public.fn_gto_v31_cell_key_checksum(v_context||jsonb_build_object('feature_contract_version',v_version))=v_expected THEN RAISE EXCEPTION 'explicit feature identity not bound'; END IF;
 END LOOP;
 -- Ac/Qd canonical triangular index is 48*47/2+41; compute independently.
 v_key:=public.fn_gto_v31_feature_key(48*47/2+41,'Qs8d3c','holdem-board-relative-v2');
 IF NOT public.fn_gto_v31_feature_key_valid(v_key,'flop','holdem-board-relative-v2')
    OR public.fn_gto_v31_feature_key_valid(v_key,'turn','holdem-board-relative-v2')
    OR public.fn_gto_v31_feature_key_valid(v_key,'flop',NULL)
    OR public.fn_gto_v31_feature_key_valid(v_key,'flop','unknown') THEN RAISE EXCEPTION 'version/street key dispatch failed'; END IF;
 IF public.fn_gto_v31_feature_key(48*47/2+41,'Qs8d3c',NULL) IS DISTINCT FROM public.fn_gto_v31_hand_key(48*47/2+41,'Qs8d3c')
    OR public.fn_gto_v31_feature_key(48*47/2+41,'Qs8d3c','rank-suit-count-v1') IS DISTINCT FROM public.fn_gto_v31_hand_key(48*47/2+41,'Qs8d3c') THEN RAISE EXCEPTION 'legacy key semantics changed'; END IF;
 BEGIN
   PERFORM public.fn_gto_v31_feature_key(48*47/2+41,'Qs8d3c','unknown');
   RAISE EXCEPTION 'unknown feature dispatch accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='unknown feature dispatch accepted' THEN RAISE; END IF; END;
 v_cell:=v_context||jsonb_build_object('feature_contract_version','holdem-board-relative-v2','hand_matrix',jsonb_build_object(v_key,'{"c":0.4,"b50":0.6}'::jsonb),'action_specs',v_specs,'policy_ev_matrix',jsonb_build_object(v_key,1),'action_ev_matrix',jsonb_build_object(v_key,'{"c":0,"b50":2}'::jsonb),'source_rows',2,'train_source_rows',1,'holdout_source_rows',1,'lineage_checksum',repeat('a',64));
 v_cell:=v_cell||jsonb_build_object('cell_key_checksum',public.fn_gto_v31_cell_key_checksum(v_cell));
 v_cell:=v_cell||jsonb_build_object('cell_payload_checksum',public.fn_gto_v31_cell_payload_checksum(v_cell));
 IF NOT public.fn_gto_v31_cell_payload_valid(v_cell)
    OR public.fn_gto_v31_cell_payload_valid(v_cell-'feature_contract_version') THEN RAISE EXCEPTION 'versioned compact admission failed'; END IF;
 IF NOT public.fn_gto_v31_compact_matrices_valid(v_cell->'hand_matrix',v_specs,v_cell->'policy_ev_matrix',v_cell->'action_ev_matrix','flop','holdem-board-relative-v2')
    OR public.fn_gto_v31_compact_matrices_valid(v_cell->'hand_matrix',v_specs,v_cell->'policy_ev_matrix',v_cell->'action_ev_matrix','flop',NULL) THEN RAISE EXCEPTION 'versioned matrix constraints failed'; END IF;
 IF has_function_privilege('anon','public.fn_gto_v31_feature_key(integer,text,text)','execute')
    OR has_function_privilege('authenticated','public.fn_gto_v31_feature_key(integer,text,text)','execute') THEN RAISE EXCEPTION 'feature helper privilege broadened'; END IF;
 FOREACH v_version IN ARRAY ARRAY['rank-suit-count-v1','holdem-board-relative-v2'] LOOP
   v_bundle:=jsonb_build_object('bundle_key','feature.contract.fixture.'||v_version,'bundle_version','2','range_bundle_checksum',repeat('e',64),'source_combo_order_checksum',repeat('d',64),'icm_model_checksum',repeat('f',64),'approval_note','isolated feature contract fixture','feature_contract_version',v_version,'files',jsonb_build_array(jsonb_build_object('kind','range','path','ranges/test.txt','checksum',repeat('e',64)),jsonb_build_object('kind','combo_order','path','combo/order.txt','checksum',repeat('d',64)),jsonb_build_object('kind','icm_model','path','icm/model.json','checksum',repeat('f',64)),jsonb_build_object('kind','scenario_manifest','path','manifests/phase4.json','checksum',repeat('a',64))));
   CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'authenticated'::text $auth$;
   v_bundle_id:=public.ca_gto_v31_approve_input_bundle(v_bundle);
   IF public.ca_gto_v31_approve_input_bundle(v_bundle) IS DISTINCT FROM v_bundle_id THEN RAISE EXCEPTION 'versioned approval retry changed identity'; END IF;
   CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'service_role'::text $auth$;
   v_request:=jsonb_build_object('dataset_key','feature.dataset.fixture.'||v_version,'solver_version','PioSOLVER-edge','solver_binary_checksum',repeat('1',64),'pipeline_commit',repeat('2',40),'pipeline_bundle_checksum',repeat('3',64),'manifest_version','v31.fixture','manifest_checksum',repeat('a',64),'source_combo_order_checksum',repeat('d',64),'range_bundle_checksum',repeat('e',64),'icm_model_checksum',repeat('f',64),'input_bundle_id',v_bundle_id,'input_bundle_checksum',public.fn_gto_v31_input_bundle_checksum(v_bundle),'machine_ids',jsonb_build_array('M1','M2'),'declared_coverage',jsonb_build_array(v_context),'quality_gates',jsonb_build_object('max_frequency_mae',0.05,'max_sizing_mae',0.05,'max_policy_ev_mae_bb',0.05,'max_action_regret_bb',0.05,'min_regret_coverage',0.99),'feature_contract_version',v_version);
   v_failed:=false; BEGIN PERFORM public.fn_gto_v31_register_dataset(v_request-'feature_contract_version'); EXCEPTION WHEN OTHERS THEN v_failed:=true; END;
   IF NOT v_failed THEN RAISE EXCEPTION 'dataset omitted approved explicit feature version'; END IF;
   v_dataset:=public.fn_gto_v31_register_dataset(v_request);
   IF public.fn_gto_v31_worker_contract(v_request->>'dataset_key')->>'feature_contract_version' IS DISTINCT FROM v_version THEN RAISE EXCEPTION 'worker version binding missing'; END IF;
   v_failed:=false; BEGIN UPDATE public.gto_v31_datasets SET feature_contract_version=NULL WHERE dataset_id=v_dataset; EXCEPTION WHEN OTHERS THEN v_failed:=true; END;
   IF NOT v_failed THEN RAISE EXCEPTION 'dataset feature identity was mutable'; END IF;
 END LOOP;
END;
$probe$;
ROLLBACK;
SELECT 'V31_FEATURE_CONTRACT_V2_OK' AS result;
