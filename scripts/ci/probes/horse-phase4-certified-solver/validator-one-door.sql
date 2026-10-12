\set ON_ERROR_STOP on
DO $probe$ DECLARE
 legacy jsonb:='{"AKo:21":{"c":0.4,"b50":0.6}}';
 specs jsonb:='{"c":{"family":"check","size_unit":"none","size_value":null,"all_in":false},"b50":{"family":"bet","size_unit":"pot_fraction","size_value":0.5,"all_in":false}}';
 policy jsonb:='{"AKo:21":1}'; action_evs jsonb:='{"AKo:21":{"c":0,"b50":2}}'; v2 text;
BEGIN
 IF NOT public.fn_gto_v31_hand_matrix_valid(p_matrix=>legacy,p_street=>'flop')
 OR NOT public.fn_gto_v31_hand_matrix_valid(legacy,'flop',NULL)
 OR NOT public.fn_gto_v31_hand_matrix_valid(legacy,'flop','rank-suit-count-v1')
 OR NOT public.fn_gto_v31_compact_matrices_valid(p_matrix=>legacy,p_specs=>specs,p_policy_evs=>policy,p_action_evs=>action_evs,p_street=>'flop')
 OR NOT public.fn_gto_v31_compact_matrices_valid(legacy,specs,policy,action_evs,'flop',NULL)
 THEN RAISE EXCEPTION 'legacy positional/named/default caller changed'; END IF;
 v2:=public.fn_gto_v31_feature_key(1169,'Qs8d3c','holdem-board-relative-v2');
 IF NOT public.fn_gto_v31_hand_matrix_valid(jsonb_build_object(v2,'{"c":1}'::jsonb),'flop','holdem-board-relative-v2')
 OR public.fn_gto_v31_hand_matrix_valid(legacy,'flop','unknown')
 OR public.fn_gto_v31_feature_request_valid('{"feature_contract_version":null}')
 OR public.fn_gto_v31_feature_request_valid('{"feature_contract_version":"unknown"}')
 THEN RAISE EXCEPTION 'V2/invalid request contract changed'; END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.gto_v31_runtime_cells'::regclass
 AND conname IN ('gto_v31_runtime_cells_hand_keys_match_street_chk','gto_v31_runtime_cells_compact_matrices_valid_chk')
 AND convalidated AND pg_get_constraintdef(oid) LIKE '%feature_contract_version%')<>2
 THEN RAISE EXCEPTION 'connected versioned constraints changed'; END IF;
 IF has_function_privilege('anon','public.fn_gto_v31_hand_matrix_valid(jsonb,text,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'validator browser admission broadened'; END IF;
END; $probe$;
SELECT 'V31_VALIDATOR_ONE_DOOR_OK' AS result;
