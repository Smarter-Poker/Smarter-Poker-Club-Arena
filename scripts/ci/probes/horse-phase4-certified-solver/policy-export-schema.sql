\set ON_ERROR_STOP on
BEGIN;
DO $probe$
DECLARE b jsonb; v4 jsonb; before_checksum text; id uuid; request jsonb; dataset uuid; failed boolean; value jsonb;
 context jsonb:='{"street":"flop","game_family":"cash","objective":"cash_ev","utility_context":"cash_ev","table_size":2,"pot_type":"limped","hero_position":"BB","opponent_position":"SB","depth_bucket":10,"texture_class":"Arud","node_role":"open","facing_kind":"none","facing_size_bucket":"none"}';
BEGIN
 b:=jsonb_build_object('bundle_key','v4.metadata.fixture','bundle_version','1','range_bundle_checksum',repeat('e',64),'source_combo_order_checksum',repeat('d',64),'icm_model_checksum',repeat('f',64),'approval_note','isolated schema contract fixture','files',jsonb_build_array(jsonb_build_object('kind','range','path','ranges/test.txt','checksum',repeat('e',64)),jsonb_build_object('kind','combo_order','path','combo/order.txt','checksum',repeat('d',64)),jsonb_build_object('kind','icm_model','path','icm/model.json','checksum',repeat('f',64)),jsonb_build_object('kind','scenario_manifest','path','manifests/test.json','checksum',repeat('a',64))));
 before_checksum:=public.v31_metadata_legacy_checksum(b);
 IF public.fn_gto_v31_input_bundle_checksum(b)<>before_checksum THEN RAISE EXCEPTION 'legacy bytes changed'; END IF;
 v4:=b||'{"policy_export_schema":"smarter-poker.pio-policy.v4"}';
 IF public.fn_gto_v31_input_bundle_checksum(v4)=before_checksum THEN RAISE EXCEPTION 'V4 identity unbound'; END IF;
 FOREACH value IN ARRAY ARRAY['null'::jsonb,'"smarter-poker.pio-policy.v3"'::jsonb,'"unknown"'::jsonb,'false'::jsonb] LOOP
  failed:=false; BEGIN PERFORM public.fn_gto_v31_input_bundle_checksum(b||jsonb_build_object('policy_export_schema',value)); EXCEPTION WHEN OTHERS THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'bad schema accepted: %',value; END IF;
 END LOOP;
 CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'authenticated'::text $auth$;
 id:=public.ca_gto_v31_approve_input_bundle(v4);
 IF public.ca_gto_v31_approve_input_bundle(v4)<>id THEN RAISE EXCEPTION 'approval retry not stable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.gto_v31_input_bundles WHERE input_bundle_id=id AND policy_export_schema='smarter-poker.pio-policy.v4') THEN RAISE EXCEPTION 'approval pin absent'; END IF;
 CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'service_role'::text $auth$;
 request:=jsonb_build_object('dataset_key','v4.metadata.dataset','solver_version','PioSOLVER-pro 3.8.0','solver_binary_checksum',repeat('1',64),'pipeline_commit',repeat('2',40),'pipeline_bundle_checksum',repeat('3',64),'manifest_version','fixture','manifest_checksum',repeat('a',64),'source_combo_order_checksum',repeat('d',64),'range_bundle_checksum',repeat('e',64),'icm_model_checksum',repeat('f',64),'input_bundle_id',id,'input_bundle_checksum',public.fn_gto_v31_input_bundle_checksum(v4),'machine_ids',jsonb_build_array('M1','M2'),'declared_coverage',jsonb_build_array(context),'quality_gates',jsonb_build_object('max_frequency_mae',0.05,'max_sizing_mae',0.05,'max_policy_ev_mae_bb',0.05,'max_action_regret_bb',0.05,'min_regret_coverage',0.99));
 failed:=false; BEGIN PERFORM public.fn_gto_v31_register_dataset(request); EXCEPTION WHEN OTHERS THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'mismatched dataset schema accepted'; END IF;
 dataset:=public.fn_gto_v31_register_dataset(request||'{"policy_export_schema":"smarter-poker.pio-policy.v4"}');
 IF public.fn_gto_v31_worker_contract('v4.metadata.dataset')->>'policy_export_schema'<>'smarter-poker.pio-policy.v4' THEN RAISE EXCEPTION 'worker pin absent'; END IF;
 failed:=false; BEGIN UPDATE public.gto_v31_datasets SET policy_export_schema=NULL WHERE dataset_id=dataset; EXCEPTION WHEN OTHERS THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'dataset pin mutable'; END IF;
 failed:=false; BEGIN UPDATE public.gto_v31_input_bundles SET policy_export_schema=NULL WHERE input_bundle_id=id; EXCEPTION WHEN OTHERS THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'approved bundle pin mutable'; END IF;
 CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'authenticated'::text $auth$;
 b:=b||'{"bundle_key":"v3.metadata.fixture"}';
 before_checksum:=public.v31_metadata_legacy_checksum(b);
 id:=public.ca_gto_v31_approve_input_bundle(b);
 CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'service_role'::text $auth$;
 dataset:=public.fn_gto_v31_register_dataset(request||jsonb_build_object('dataset_key','v3.metadata.dataset','input_bundle_id',id,'input_bundle_checksum',before_checksum));
 IF public.fn_gto_v31_worker_contract('v3.metadata.dataset') ? 'policy_export_schema' THEN RAISE EXCEPTION 'legacy worker bytes changed'; END IF;
END; $probe$;
ROLLBACK;
SELECT 'V31_POLICY_METADATA_PARITY_OK';
